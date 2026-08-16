#!/usr/bin/env node

const { Pool } = require('pg');
const path = require('node:path');
const { loadLocalEnv } = require('./load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

const production = process.env.NODE_ENV === 'production';
const connectionString = process.env.COMMERCE_CONTROL_MAINTENANCE_DATABASE_URL
  || (production ? undefined : process.env.COMMERCE_DATABASE_URL || process.env.DATABASE_URL);
if (!connectionString) {
  console.error('COMMERCE_CONTROL_MAINTENANCE_DATABASE_URL is required in production.');
  process.exit(1);
}

const retentionRaw = process.env.COMMERCE_RETENTION_DAYS?.trim();
if (production && !retentionRaw) {
  console.error('COMMERCE_RETENTION_DAYS must be explicitly configured in production.');
  process.exit(1);
}
const retentionDays = Number.parseInt(retentionRaw || '90', 10);
if (!Number.isSafeInteger(retentionDays) || retentionDays < 7 || retentionDays > 3650) {
  console.error('COMMERCE_RETENTION_DAYS must be an integer from 7 to 3650.');
  process.exit(1);
}
const workerStaleMs = Number.parseInt(process.env.COMMERCE_WORKER_STALE_MS || '30000', 10);
if (!Number.isSafeInteger(workerStaleMs) || workerStaleMs < 5_000 || workerStaleMs > 300_000) {
  console.error('COMMERCE_WORKER_STALE_MS must be an integer from 5000 to 300000.');
  process.exit(1);
}

const sslEnabled = /^(?:1|true|yes|on)$/i.test(process.env.COMMERCE_PG_SSL || '');
const rejectUnauthorized = !/^(?:0|false|no|off)$/i.test(
  process.env.COMMERCE_PG_REJECT_UNAUTHORIZED || 'true',
);
const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/g, '\n').trim();
if (production && (!sslEnabled || !rejectUnauthorized)) {
  console.error('Production cleanup requires verified PostgreSQL TLS.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 60_000,
  application_name: 'commerce-retention-cleanup',
  ...(sslEnabled ? { ssl: { rejectUnauthorized, ...(ca ? { ca } : {}) } } : {}),
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('commerce.control_maintenance', 'on', true)");
    const expiredRuns = await client.query(
      `UPDATE commerce_agent_runs
       SET status = 'failed', error_code = 'RUN_LEASE_EXPIRED',
           error_message = 'Run lease expired before retention cleanup.', completed_at = NOW(),
           generation = generation + 1
       WHERE status = 'running' AND lease_expires_at < NOW()`,
    );
    // commerce_reap_expired_jobs() is the same function the Worker's claim() path uses:
    // a lease-expired running Job is dead-lettered or requeued by one shared rule, instead
    // of cleanup unilaterally marking it failed and racing with a Worker that reclaims it.
    const jobsReaped = await client.query(
      'SELECT dead_lettered_count, requeued_count FROM commerce_reap_expired_jobs()',
    );
    const expiredQueuedCandidates = await client.query(
      `SELECT id, tenant_id, user_id
       FROM commerce_agent_jobs
       WHERE status = 'queued'
         AND created_at < NOW() - ($1::integer * INTERVAL '1 day')
       ORDER BY id
       FOR UPDATE SKIP LOCKED`,
      [retentionDays],
    );
    let expiredQueuedJobs = 0;
    for (const job of expiredQueuedCandidates.rows) {
      const expired = await client.query(
        `UPDATE commerce_agent_jobs
         SET status = 'failed', error_code = 'JOB_QUEUE_EXPIRED',
             error_message = 'Queued job exceeded the configured retention window.',
             completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $1
           AND status = 'queued'
           AND created_at < NOW() - ($2::integer * INTERVAL '1 day')`,
        [job.id, retentionDays],
      );
      if (!expired.rowCount) continue;
      expiredQueuedJobs += expired.rowCount;
      await client.query(
        'SELECT public.commerce_settle_model_budget($1, NULL, NULL)',
        [job.id],
      );

      const correctionCandidates = await client.query(
        `SELECT DISTINCT feedback_id
         FROM commerce_agent_feedback_events
         WHERE tenant_id = $1
           AND job_id = $2
           AND event_type = 'correction_enqueued'`,
        [job.tenant_id, job.id],
      );
      for (const correction of correctionCandidates.rows) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
          [`commerce-feedback:${job.tenant_id}:${correction.feedback_id}`],
        );
        await client.query(
          `INSERT INTO commerce_agent_feedback_events
             (feedback_id, tenant_id, actor_user_id, actor_display_name, event_type,
              version, note, idempotency_key, request_sha256, job_id)
           SELECT correction.feedback_id, correction.tenant_id,
                  'system:commerce-worker', 'Commerce Agent Worker', 'correction_failed',
                  correction.version + 1,
                  'JOB_QUEUE_EXPIRED: Queued job exceeded the configured retention window.',
                  'correction-terminal:' || $2 || ':failed',
                  'sha256:' || encode(sha256(convert_to(json_build_object(
                    'feedbackId', correction.feedback_id,
                    'jobId', $2,
                    'eventType', 'correction_failed',
                    'runId', NULL::text,
                    'errorCode', 'JOB_QUEUE_EXPIRED'
                  )::text, 'UTF8')), 'hex'),
                  $2
           FROM commerce_agent_feedback_events AS correction
           WHERE correction.tenant_id = $1
             AND correction.feedback_id = $3
             AND correction.job_id = $2
             AND correction.event_type = 'correction_enqueued'
             AND NOT EXISTS (
               SELECT 1
               FROM commerce_agent_feedback_events AS newer
               WHERE newer.tenant_id = correction.tenant_id
                 AND newer.feedback_id = correction.feedback_id
                 AND newer.version > correction.version
             )
           ON CONFLICT DO NOTHING`,
          [job.tenant_id, job.id, correction.feedback_id],
        );
      }
    }
    const jobs = await client.query(
      `DELETE FROM commerce_agent_jobs
       WHERE status IN ('completed', 'failed', 'dead_letter')
         AND completed_at < NOW() - ($1::integer * INTERVAL '1 day')
         AND NOT EXISTS (
           SELECT 1 FROM commerce_action_review_schedules AS review_schedule
           WHERE review_schedule.job_id = commerce_agent_jobs.id
             AND review_schedule.tenant_id = commerce_agent_jobs.tenant_id
             AND review_schedule.user_id = commerce_agent_jobs.user_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM commerce_weekly_diagnosis_runs AS weekly_diagnosis
           WHERE weekly_diagnosis.agent_job_id = commerce_agent_jobs.id
             AND weekly_diagnosis.tenant_id = commerce_agent_jobs.tenant_id
             AND weekly_diagnosis.user_id = commerce_agent_jobs.user_id
         )`,
      [retentionDays],
    );
    // Capability tokens are useful only while active. Remove expired links immediately and
    // retain revoked rows only briefly so the table cannot become an unbounded secret index.
    const reportShares = await client.query(
      `DELETE FROM commerce_agent_report_shares
       WHERE expires_at <= clock_timestamp()
          OR revoked_at < NOW() - INTERVAL '7 days'`,
    );
    // Feedback has the same retention boundary as its parent conversation and is removed by
    // ON DELETE CASCADE, preserving audit records for the full configured conversation window.
    const conversations = await client.query(
      `DELETE FROM commerce_agent_conversations AS conversation
       WHERE conversation.updated_at < NOW() - ($1::integer * INTERVAL '1 day')
         AND NOT EXISTS (
           SELECT 1
           FROM commerce_agent_runs AS run
           WHERE run.conversation_id = conversation.id
             AND run.tenant_id = conversation.tenant_id
             AND run.status = 'running'
             AND run.lease_expires_at >= clock_timestamp()
         )
         AND NOT EXISTS (
           SELECT 1
           FROM commerce_agent_jobs AS job
           WHERE job.conversation_id = conversation.id
             AND job.tenant_id = conversation.tenant_id
             AND job.status IN ('queued', 'running')
         )
         AND NOT EXISTS (
           SELECT 1
           FROM commerce_weekly_diagnosis_runs AS weekly_diagnosis
           WHERE weekly_diagnosis.result_conversation_id = conversation.id
             AND weekly_diagnosis.tenant_id = conversation.tenant_id
             AND weekly_diagnosis.user_id = conversation.user_id
         )`,
      [retentionDays],
    );
    const windows = await client.query(
      `DELETE FROM commerce_agent_rate_limits
       WHERE window_start < NOW() - INTERVAL '1 day'`,
    );
    const staleWorkers = await client.query(
      `UPDATE commerce_agent_workers
       SET status = 'stopped', stopped_at = COALESCE(stopped_at, heartbeat_at)
       WHERE status = 'running'
         AND heartbeat_at < NOW() - ($1::integer * INTERVAL '1 millisecond')`,
      [workerStaleMs],
    );
    const workers = await client.query(
      `DELETE FROM commerce_agent_workers
       WHERE status = 'stopped'
         AND COALESCE(stopped_at, heartbeat_at) < NOW() - INTERVAL '7 days'`,
    );
    await client.query('COMMIT');
    console.log(JSON.stringify({
      expiredRuns: expiredRuns.rowCount,
      deadLetteredJobs: jobsReaped.rows[0]?.dead_lettered_count ?? 0,
      requeuedJobs: jobsReaped.rows[0]?.requeued_count ?? 0,
      expiredQueuedJobs,
      deletedJobs: jobs.rowCount,
      deletedReportShares: reportShares.rowCount,
      deletedConversations: conversations.rowCount,
      deletedRateWindows: windows.rowCount,
      stoppedStaleWorkers: staleWorkers.rowCount,
      deletedWorkers: workers.rowCount,
      retentionDays,
    }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Commerce retention cleanup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

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

const retentionDays = Number.parseInt(process.env.COMMERCE_RETENTION_DAYS || '90', 10);
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
    const expiredRuns = await client.query(
      `UPDATE commerce_agent_runs
       SET status = 'failed', error_code = 'RUN_LEASE_EXPIRED',
           error_message = 'Run lease expired before retention cleanup.', completed_at = NOW()
       WHERE status = 'running' AND lease_expires_at < NOW()`,
    );
    const expiredJobs = await client.query(
      `UPDATE commerce_agent_jobs
       SET status = 'failed', error_code = 'JOB_LEASE_EXPIRED',
           error_message = 'Job lease expired before retention cleanup.',
           completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
       WHERE status = 'running' AND lease_expires_at < NOW()`,
    );
    const expiredQueuedJobs = await client.query(
      `UPDATE commerce_agent_jobs
       SET status = 'failed', error_code = 'JOB_QUEUE_EXPIRED',
           error_message = 'Queued job exceeded the configured retention window.',
           completed_at = NOW(), updated_at = NOW()
       WHERE status = 'queued'
         AND created_at < NOW() - ($1::integer * INTERVAL '1 day')`,
      [retentionDays],
    );
    const jobs = await client.query(
      `DELETE FROM commerce_agent_jobs
       WHERE status IN ('completed', 'failed')
         AND completed_at < NOW() - ($1::integer * INTERVAL '1 day')`,
      [retentionDays],
    );
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
      expiredJobs: expiredJobs.rowCount,
      expiredQueuedJobs: expiredQueuedJobs.rowCount,
      deletedJobs: jobs.rowCount,
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

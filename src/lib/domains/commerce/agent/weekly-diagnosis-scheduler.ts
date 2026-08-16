import { randomUUID } from 'node:crypto';

import {
  canonicalWeeklyDiagnosisKey,
  commerceLocalMidnightUtc,
} from './action-orchestration';
import {
  addCommerceBusinessDays,
  previousCompleteCommerceWeek,
} from './diagnostics';
import type { CommerceDatabase, CommerceSqlClient } from './database';
import {
  getCommerceAnalyticsDatabase,
  getCommerceControlDatabase,
  withCommerceControlSystem,
} from './database';
import {
  PostgresCommerceJobStore,
  terminalizeSupersededCommerceJobWithClient,
} from './job-store';
import {
  commerceCoverageDate,
  readCommerceSchedulerTenantCoverage,
} from './scheduler-tenant-coverage';
import type { CommerceAgentRunResponse, CommerceIdentity } from './types';

export interface CommerceWeeklyDiagnosisWindow {
  weekStart: string;
  weekEnd: string;
  eligibleAt: string;
  canonicalSha256: string;
}

function businessDate(instant: Date, timeZone: string): string {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(instant).flatMap((part) => (
    part.type === 'literal' ? [] : [[part.type, part.value]]
  )));
  return `${values.year}-${values.month}-${values.day}`;
}

function endBoundaryUtc(weekEnd: string, timeZone: string): Date {
  const [year, month, day] = weekEnd.split('-').map(Number) as [number, number, number];
  return commerceLocalMidnightUtc(year, month, day, timeZone);
}

export function eligibleCommerceWeeklyDiagnosisWindows(input: {
  tenantId: string;
  now: Date;
  timezone: string;
  coverageEnd: string;
  lateToleranceHours?: number;
  existingWeekStarts?: readonly string[];
  recoveryLimit?: number;
}): { runnable: CommerceWeeklyDiagnosisWindow[]; skippedBacklog: CommerceWeeklyDiagnosisWindow[] } {
  const coverageEnd = commerceCoverageDate(input.coverageEnd);
  if (!coverageEnd) return { runnable: [], skippedBacklog: [] };
  const lateToleranceMs = (input.lateToleranceHours ?? 26) * 3_600_000;
  const recoveryLimit = Math.max(1, Math.min(input.recoveryLimit ?? 2, 8));
  const existing = new Set(input.existingWeekStarts ?? []);
  const referenceDate = businessDate(input.now, input.timezone);
  const mostRecent = previousCompleteCommerceWeek(referenceDate);
  const candidates = Array.from({ length: 12 }, (_, index) => {
    const weekStart = addCommerceBusinessDays(mostRecent.start, -index * 7);
    const weekEnd = addCommerceBusinessDays(weekStart, 7);
    const boundary = endBoundaryUtc(weekEnd, input.timezone);
    const eligibleAt = new Date(boundary.getTime() + lateToleranceMs);
    return {
      weekStart,
      weekEnd,
      eligibleAt: eligibleAt.toISOString(),
      canonicalSha256: canonicalWeeklyDiagnosisKey({
        tenantId: input.tenantId,
        objective: 'diagnose_previous_complete_week',
        weekStart,
        weekEnd,
      }),
      ready: input.now.getTime() >= eligibleAt.getTime()
        && coverageEnd >= addCommerceBusinessDays(weekEnd, -1),
    };
  }).filter((candidate) => candidate.ready && !existing.has(candidate.weekStart))
    .map(({ ready: _ready, ...candidate }) => candidate)
    .reverse();
  return {
    runnable: candidates.slice(-recoveryLimit),
    skippedBacklog: candidates.slice(0, Math.max(0, candidates.length - recoveryLimit)),
  };
}

interface RunRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  user_id: string;
  week_start?: unknown;
  week_end?: unknown;
  revision: unknown;
  canonical_sha256: string;
  policy_version: string;
  status: string;
  supersedes_run_id: string | null;
  agent_job_id?: string | null;
  result_conversation_id?: string | null;
  result_run_id?: string | null;
  result_message_id?: string | null;
  is_current?: unknown;
  created_at: unknown;
}

interface WeeklyJobEnqueuer {
  enqueueWithClient(
    client: CommerceSqlClient,
    input: Parameters<PostgresCommerceJobStore['enqueueWithClient']>[1],
  ): ReturnType<PostgresCommerceJobStore['enqueueWithClient']>;
}

export type CommerceWeeklyDiagnosisJobClaim =
  | { kind: 'not_weekly_diagnosis' }
  | {
      kind: 'weekly_diagnosis';
      status: 'running' | 'completed' | 'superseded';
      run: ReturnType<typeof publicRun>;
    };

function publicRun(row: RunRow) {
  return {
    id: row.id,
    weekStart: row.week_start ? String(row.week_start).slice(0, 10) : null,
    weekEnd: row.week_end ? String(row.week_end).slice(0, 10) : null,
    revision: Number(row.revision),
    canonicalSha256: row.canonical_sha256,
    policyVersion: row.policy_version,
    status: row.status,
    supersedesRunId: row.supersedes_run_id,
    agentJobId: row.agent_job_id ?? null,
    resultConversationId: row.result_conversation_id ?? null,
    resultRunId: row.result_run_id ?? null,
    resultMessageId: row.result_message_id ?? null,
    createdAt: new Date(String(row.created_at)).toISOString(),
  };
}

const RUN_COLUMNS = `id, tenant_id, user_id, week_start, week_end, revision, canonical_sha256,
  policy_version, status, is_current, supersedes_run_id, agent_job_id,
  result_conversation_id, result_run_id, result_message_id, created_at`;

function diagnosisQuestion(window: CommerceWeeklyDiagnosisWindow): string {
  const inclusiveEnd = addCommerceBusinessDays(window.weekEnd, -1);
  return `诊断上一完整周（${window.weekStart} 至 ${inclusiveEnd}）的经营表现。`;
}

function weeklyIdentity(tenantId: string): CommerceIdentity {
  return {
    tenantId,
    userId: 'system:weekly-diagnosis',
    displayName: 'Commerce 周诊断调度器',
    authMode: 'trusted_proxy',
    scopes: ['commerce:read'],
  };
}

export class PostgresCommerceWeeklyDiagnosisScheduler {
  private readonly jobs: WeeklyJobEnqueuer;

  constructor(
    private readonly database: CommerceDatabase,
    private readonly analytics: CommerceDatabase | null = null,
    jobs?: WeeklyJobEnqueuer,
  ) {
    this.jobs = jobs ?? new PostgresCommerceJobStore(database);
  }

  ensureCanonical(input: {
    tenantId: string;
    userId: string;
    timezone: string;
    window: CommerceWeeklyDiagnosisWindow;
    policyVersion: string;
    status?: 'waiting' | 'queued' | 'skipped_backlog';
  }): Promise<{ created: boolean; run: ReturnType<typeof publicRun> }> {
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `commerce-weekly-diagnosis:${input.tenantId}:${input.window.weekStart}`,
      ]);
      const existing = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
         FROM commerce_weekly_diagnosis_runs
         WHERE tenant_id = $1 AND objective = 'diagnose_previous_complete_week'
           AND week_start = $2::date AND week_end = $3::date AND is_current
         LIMIT 1`,
        [input.tenantId, input.window.weekStart, input.window.weekEnd],
      );
      if (existing.rows[0]) return { created: false, run: publicRun(existing.rows[0]) };
      const inserted = await client.query<RunRow>(
        `INSERT INTO commerce_weekly_diagnosis_runs
           (id, tenant_id, user_id, week_start, week_end, tenant_timezone,
            revision, policy_version, canonical_sha256, status)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, 1, $7, $8, $9)
         RETURNING ${RUN_COLUMNS}`,
        [
          `weekly_diagnosis_${randomUUID()}`,
          input.tenantId,
          input.userId,
          input.window.weekStart,
          input.window.weekEnd,
          input.timezone,
          input.policyVersion,
          input.window.canonicalSha256,
          input.status ?? 'waiting',
        ],
      );
      return { created: true, run: publicRun(inserted.rows[0]) };
    }));
  }

  enqueueCanonical(input: {
    tenantId: string;
    userId?: string;
    timezone: string;
    window: CommerceWeeklyDiagnosisWindow;
    policyVersion: string;
    model: string;
    maxQueuedPerUser?: number;
    maxAttempts?: number;
    recoverFailed?: boolean;
  }): Promise<{
    created: boolean;
    jobCreated: boolean;
    run: ReturnType<typeof publicRun>;
  }> {
    let identity = input.userId
      ? { ...weeklyIdentity(input.tenantId), userId: input.userId }
      : weeklyIdentity(input.tenantId);
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `commerce-weekly-diagnosis:${input.tenantId}:${input.window.weekStart}`,
      ]);
      const existing = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
         FROM commerce_weekly_diagnosis_runs
         WHERE tenant_id = $1 AND objective = 'diagnose_previous_complete_week'
           AND week_start = $2::date AND week_end = $3::date AND is_current
         FOR UPDATE`,
        [input.tenantId, input.window.weekStart, input.window.weekEnd],
      );
      let created = false;
      let row = existing.rows[0];
      if (!row) {
        const inserted = await client.query<RunRow>(
          `INSERT INTO commerce_weekly_diagnosis_runs
             (id, tenant_id, user_id, week_start, week_end, tenant_timezone,
              revision, policy_version, canonical_sha256, status)
           VALUES ($1, $2, $3, $4::date, $5::date, $6, 1, $7, $8, 'waiting')
           RETURNING ${RUN_COLUMNS}`,
          [
            `weekly_diagnosis_${randomUUID()}`,
            input.tenantId,
            identity.userId,
            input.window.weekStart,
            input.window.weekEnd,
            input.timezone,
            input.policyVersion,
            input.window.canonicalSha256,
          ],
        );
        row = inserted.rows[0];
        created = true;
      }
      if (!row) throw new Error('Weekly diagnosis canonical row was not persisted.');
      if (row.user_id && row.user_id !== identity.userId) {
        identity = { ...identity, userId: row.user_id };
      }
      let jobRequestId = `weekly:${input.window.canonicalSha256.slice(7)}:r${Number(row.revision)}`;
      if (row.agent_job_id) {
        if (row.status === 'failed' && input.recoverFailed) {
          // Keep the exhausted physical Job immutable for audit. Recovery binds a fresh
          // physical Job to the same canonical logical run; it does not create revision 2.
          jobRequestId = `weekly-recovery:${row.id}:${randomUUID()}`;
          row = { ...row, agent_job_id: null, status: 'waiting' };
        } else {
          return { created, jobCreated: false, run: publicRun(row) };
        }
      }
      if (row.status === 'completed' || row.status === 'skipped_backlog') {
        return { created, jobCreated: false, run: publicRun(row) };
      }
      const job = await this.jobs.enqueueWithClient(client, {
        identity,
        kind: 'create_conversation',
        requestId: jobRequestId,
        model: input.model,
        message: diagnosisQuestion(input.window),
        maxQueuedPerUser: input.maxQueuedPerUser ?? 2,
        maxAttempts: input.maxAttempts ?? 3,
      });
      const updated = await client.query<RunRow>(
        `UPDATE commerce_weekly_diagnosis_runs
         SET status = 'queued', agent_job_id = $2, updated_at = NOW()
         WHERE id = $1 AND is_current
         RETURNING ${RUN_COLUMNS}`,
        [row.id, job.id],
      );
      if (!updated.rows[0]) throw new Error('Weekly diagnosis lost its canonical queue claim.');
      return { created, jobCreated: true, run: publicRun(updated.rows[0]) };
    }));
  }

  async runDue(input: {
    model: string;
    policyVersion: string;
    now?: Date;
    recoveryLimit?: number;
    maxQueuedPerUser?: number;
    maxAttempts?: number;
  }): Promise<{ queued: number; backlog: number }> {
    if (!this.analytics) return { queued: 0, backlog: 0 };
    // Tenant discovery belongs to the trusted Control plane. Analytics FORCE RLS deliberately
    // prevents this scheduler from discovering other tenants by scanning an Analytics table.
    const tenants = await withCommerceControlSystem(() => this.database.query<{ tenant_id: string }>(
      `SELECT tenant_id
       FROM (
         SELECT tenant_id FROM commerce_agent_conversations
         UNION
         SELECT tenant_id FROM commerce_tenant_members WHERE active
         UNION
         SELECT tenant_id FROM commerce_weekly_diagnosis_runs
       ) AS scheduler_tenant_registry
       ORDER BY tenant_id`,
    ));
    let queued = 0;
    let backlog = 0;
    const now = input.now ?? new Date();
    for (const registeredTenant of tenants.rows) {
      const tenant = await readCommerceSchedulerTenantCoverage(
        this.analytics,
        registeredTenant.tenant_id,
      );
      if (!tenant) continue;
      const existing = await withCommerceControlSystem(() => this.database.query<{
        week_start: unknown;
        status: string;
        agent_job_id: string | null;
      }>(
        `SELECT week_start, status, agent_job_id
         FROM commerce_weekly_diagnosis_runs
         WHERE tenant_id = $1 AND objective = 'diagnose_previous_complete_week'
           AND is_current`,
        [tenant.tenantId],
      ));
      const windows = eligibleCommerceWeeklyDiagnosisWindows({
        tenantId: tenant.tenantId,
        now,
        timezone: tenant.timezone,
        coverageEnd: tenant.coverageEnd,
        existingWeekStarts: existing.rows
          .filter((row) => row.status !== 'waiting' || Boolean(row.agent_job_id))
          .map((row) => String(row.week_start).slice(0, 10)),
        recoveryLimit: input.recoveryLimit,
      });
      for (const window of windows.skippedBacklog) {
        const result = await this.ensureCanonical({
          tenantId: tenant.tenantId,
          userId: weeklyIdentity(tenant.tenantId).userId,
          timezone: tenant.timezone,
          window,
          policyVersion: input.policyVersion,
          status: 'skipped_backlog',
        });
        if (result.created) backlog += 1;
      }
      for (const window of windows.runnable) {
        const result = await this.enqueueCanonical({
          tenantId: tenant.tenantId,
          timezone: tenant.timezone,
          window,
          policyVersion: input.policyVersion,
          model: input.model,
          maxQueuedPerUser: input.maxQueuedPerUser,
          maxAttempts: input.maxAttempts,
        });
        if (result.jobCreated) queued += 1;
      }
    }
    return { queued, backlog };
  }

  supersedeForCorrection(input: {
    tenantId: string;
    userId: string;
    timezone: string;
    window: CommerceWeeklyDiagnosisWindow;
    policyVersion: string;
  }): Promise<ReturnType<typeof publicRun>> {
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `commerce-weekly-diagnosis:${input.tenantId}:${input.window.weekStart}`,
      ]);
      const current = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
         FROM commerce_weekly_diagnosis_runs
         WHERE tenant_id = $1 AND objective = 'diagnose_previous_complete_week'
           AND week_start = $2::date AND week_end = $3::date AND is_current
         FOR UPDATE`,
        [input.tenantId, input.window.weekStart, input.window.weekEnd],
      );
      if (!current.rows[0]) throw new Error('Cannot supersede a missing weekly diagnosis.');
      await client.query(
        `UPDATE commerce_weekly_diagnosis_runs
         SET is_current = FALSE,
             status = CASE
               WHEN status IN ('waiting', 'queued', 'running') THEN 'superseded'
               ELSE status
             END,
             updated_at = NOW()
         WHERE id = $1 AND is_current`,
        [current.rows[0].id],
      );
      if (current.rows[0].agent_job_id) {
        await terminalizeSupersededCommerceJobWithClient(client, {
          jobId: current.rows[0].agent_job_id,
          tenantId: current.rows[0].tenant_id,
          userId: current.rows[0].user_id,
        });
      }
      const revision = Number(current.rows[0].revision) + 1;
      const inserted = await client.query<RunRow>(
        `INSERT INTO commerce_weekly_diagnosis_runs
           (id, tenant_id, user_id, week_start, week_end, tenant_timezone,
            revision, policy_version, canonical_sha256, status, supersedes_run_id)
         VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, $9, 'waiting', $10)
         RETURNING ${RUN_COLUMNS}`,
        [
          `weekly_diagnosis_${randomUUID()}`,
          input.tenantId,
          current.rows[0].user_id,
          input.window.weekStart,
          input.window.weekEnd,
          input.timezone,
          revision,
          input.policyVersion,
          input.window.canonicalSha256,
          current.rows[0].id,
        ],
      );
      return publicRun(inserted.rows[0]);
    }));
  }

  async supersedeForCorrectionAndEnqueue(input: {
    tenantId: string;
    userId: string;
    timezone: string;
    window: CommerceWeeklyDiagnosisWindow;
    policyVersion: string;
    model: string;
    maxQueuedPerUser?: number;
    maxAttempts?: number;
  }): Promise<ReturnType<typeof publicRun>> {
    await this.supersedeForCorrection(input);
    const queued = await this.enqueueCanonical(input);
    return queued.run;
  }

  claimJob(jobId: string): Promise<CommerceWeeklyDiagnosisJobClaim> {
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const selected = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
         FROM commerce_weekly_diagnosis_runs
         WHERE agent_job_id = $1
         FOR UPDATE`,
        [jobId],
      );
      const row = selected.rows[0];
      if (!row) return { kind: 'not_weekly_diagnosis' };
      if (row.is_current !== true || row.status === 'superseded') {
        if (row.is_current !== true && ['waiting', 'queued', 'running'].includes(row.status)) {
          await client.query(
            `UPDATE commerce_weekly_diagnosis_runs
             SET status = 'superseded', updated_at = NOW()
             WHERE id = $1 AND NOT is_current
               AND status IN ('waiting', 'queued', 'running')`,
            [row.id],
          );
        }
        await terminalizeSupersededCommerceJobWithClient(client, {
          jobId,
          tenantId: row.tenant_id,
          userId: row.user_id,
        });
        return { kind: 'weekly_diagnosis', status: 'superseded', run: publicRun(row) };
      }
      if (row.status === 'completed') {
        return { kind: 'weekly_diagnosis', status: 'completed', run: publicRun(row) };
      }
      const running = await client.query<RunRow>(
        `UPDATE commerce_weekly_diagnosis_runs AS diagnosis
         SET status = 'running', updated_at = NOW()
         WHERE diagnosis.id = $1 AND diagnosis.is_current
           AND diagnosis.status IN ('queued', 'running')
           AND EXISTS (
             SELECT 1 FROM commerce_agent_jobs AS job
             WHERE job.id = diagnosis.agent_job_id
               AND job.tenant_id = diagnosis.tenant_id
               AND job.user_id = diagnosis.user_id
               AND job.status = 'running'
           )
         RETURNING ${RUN_COLUMNS}`,
        [row.id],
      );
      if (!running.rows[0]) {
        throw new Error('Weekly diagnosis Job lost its canonical execution claim.');
      }
      return {
        kind: 'weekly_diagnosis',
        status: 'running',
        run: publicRun(running.rows[0]),
      };
    }));
  }

  completeJob(
    jobId: string,
    result: CommerceAgentRunResponse,
  ): Promise<'completed' | 'already_completed' | 'superseded'> {
    const resultRunId = result.assistantMessage.runId;
    if (!resultRunId) {
      throw new Error('Weekly diagnosis result is missing its durable assistant Run identifier.');
    }
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const selected = await client.query<RunRow>(
        `SELECT ${RUN_COLUMNS}
         FROM commerce_weekly_diagnosis_runs
         WHERE agent_job_id = $1
         FOR UPDATE`,
        [jobId],
      );
      const row = selected.rows[0];
      if (!row) throw new Error('Weekly diagnosis Job is not bound to a canonical run.');
      if (row.status === 'completed') return 'already_completed';
      if (row.is_current !== true || row.status === 'superseded') {
        await terminalizeSupersededCommerceJobWithClient(client, {
          jobId,
          tenantId: row.tenant_id,
          userId: row.user_id,
        });
        return 'superseded';
      }
      const updated = await client.query(
        `UPDATE commerce_weekly_diagnosis_runs
         SET status = 'completed', result_conversation_id = $2,
             result_run_id = $3, result_message_id = $4, updated_at = NOW()
         WHERE id = $1 AND is_current AND status = 'running'
         RETURNING id`,
        [row.id, result.conversation.id, resultRunId, result.assistantMessage.id],
      );
      if (!updated.rowCount) throw new Error('Weekly diagnosis lost its completion fence.');
      return 'completed';
    }));
  }

  markJobFailed(jobId: string): Promise<void> {
    return withCommerceControlSystem(async () => {
      await this.database.query(
        `UPDATE commerce_weekly_diagnosis_runs
         SET status = 'failed', updated_at = NOW()
         WHERE agent_job_id = $1 AND is_current AND status IN ('queued', 'running')`,
        [jobId],
      );
    });
  }
}

let singleton: PostgresCommerceWeeklyDiagnosisScheduler | null = null;

export function getCommerceWeeklyDiagnosisScheduler(): PostgresCommerceWeeklyDiagnosisScheduler {
  if (!singleton || process.env.NODE_ENV === 'test') {
    singleton = new PostgresCommerceWeeklyDiagnosisScheduler(
      getCommerceControlDatabase(),
      getCommerceAnalyticsDatabase(),
    );
  }
  return singleton;
}

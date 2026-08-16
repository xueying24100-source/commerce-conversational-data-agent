import { createHash, randomUUID } from 'node:crypto';

import {
  commerceModelBudgetPolicy,
  getCommerceAgentRuntimeConfig,
  type CommerceModelBudgetPolicy,
} from './config';
import type { CommerceDatabase, CommerceSqlClient } from './database';
import { withCommerceControlIdentity, withCommerceControlSystem } from './database';
import { isValidCommerceMessage } from './limits';
import type {
  CommerceAgentJob,
  CommerceAgentJobEvent,
  CommerceAgentJobKind,
  CommerceAgentRunResponse,
  CommerceIdentity,
} from './types';

type JobRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  user_id: string;
  user_display_name: string;
  auth_mode: CommerceIdentity['authMode'];
  scopes: string[];
  kind: CommerceAgentJobKind;
  conversation_id: string | null;
  request_id: string;
  request_sha256: string;
  model: string;
  message: string;
  required_revision: string;
  executed_by_worker_id: string | null;
  status: CommerceAgentJob['status'];
  attempt_count: unknown;
  max_attempts: unknown;
  available_at: unknown;
  result_json: unknown;
  error_code: string | null;
  error_message: string | null;
  created_at: unknown;
  started_at: unknown;
  completed_at: unknown;
};

export interface ClaimedCommerceAgentJob extends CommerceAgentJob {
  identity: CommerceIdentity;
  message: string;
  leaseOwner: string;
}

export type CommerceJobRetryOutcome = 'requeued' | 'dead_letter';

export class CommerceJobConflictError extends Error {
  readonly code = 'COMMERCE_JOB_CONFLICT';

  constructor() {
    super('相同 requestId 已用于不同的异步任务。');
    this.name = 'CommerceJobConflictError';
  }
}

export class CommerceJobQueueFullError extends Error {
  readonly code = 'COMMERCE_JOB_QUEUE_FULL';

  constructor() {
    super('当前用户的待处理任务已达到上限，请等待已有任务完成。');
    this.name = 'CommerceJobQueueFullError';
  }
}

export class CommerceJobRateLimitError extends Error {
  readonly code = 'COMMERCE_DIAGNOSIS_RATE_LIMITED';
  readonly status = 429;

  constructor(readonly scope: 'account' | 'ip') {
    super(scope === 'account'
      ? '当前账号本小时诊断次数已达上限。'
      : '当前网络来源本小时诊断次数已达上限。');
    this.name = 'CommerceJobRateLimitError';
  }
}

export class CommerceJobInvalidMessageError extends Error {
  readonly code = 'INVALID_MESSAGE';
  readonly status = 400;

  constructor() {
    super('问题长度必须在 2 到 2000 个字符之间。');
    this.name = 'CommerceJobInvalidMessageError';
  }
}

export class CommerceJobEnqueueDisabledError extends Error {
  readonly code = 'COMMERCE_GLOBAL_KILL_SWITCH';
  readonly status = 503;

  constructor() {
    super('系统已暂停新的模型调用；当前请求未入队。');
    this.name = 'CommerceJobEnqueueDisabledError';
  }
}

export class CommerceModelBudgetExceededError extends Error {
  readonly code = 'COMMERCE_DAILY_MODEL_BUDGET_EXCEEDED';
  readonly status = 429;

  constructor() {
    super('今日模型调用预算已用完，请在下一个 UTC 预算日后重试。');
    this.name = 'CommerceModelBudgetExceededError';
  }
}

export class CommerceJobNotFoundError extends Error {
  readonly code = 'COMMERCE_JOB_NOT_FOUND';

  constructor() {
    super('异步任务不存在或不属于当前用户。');
    this.name = 'CommerceJobNotFoundError';
  }
}

function timestamp(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function optionalTimestamp(value: unknown): string | null {
  return value ? timestamp(value) : null;
}

function finiteInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function jobError(error: unknown): { code: string; message: string } {
  const visited = new Set<unknown>();
  const pending = [error];
  let message = error instanceof Error ? error.message : 'Commerce Agent job failed.';
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    if (!(current instanceof Error)) continue;
    message = current.message || message;
    const candidate = current as Error & {
      code?: unknown;
      cause?: unknown;
      originalError?: unknown;
    };
    if (typeof candidate.code === 'string' && candidate.code) {
      return { code: candidate.code.slice(0, 120), message: message.slice(0, 1_000) };
    }
    pending.push(candidate.originalError, candidate.cause);
  }
  return { code: 'COMMERCE_JOB_FAILED', message: message.slice(0, 1_000) };
}

function publicJobError(codeValue: string, messageValue: string | null): { code: string; message: string } {
  const code = codeValue.replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 120)
    || 'COMMERCE_JOB_FAILED';
  const diagnostic = `${code} ${String(messageValue || '')}`;
  const message = /(?:TIMEOUT|TIMEDOUT|HEADERS_TIMEOUT)/iu.test(diagnostic)
    ? '模型或数据查询响应超时，本次分析未完成。'
    : /(?:RATE_LIMIT|TOO_MANY_REQUESTS|\b429\b)/iu.test(diagnostic)
      ? '上游服务触发限流，本次分析未完成。'
      : /(?:DATABASE|DATA_UNAVAILABLE|ECONNREFUSED|CONNECTION|relation .* does not exist)/iu.test(diagnostic)
        ? '经营数据服务暂时不可用，本次分析未完成。'
        : /(?:LEASE|ABORT|CANCEL|WORKER)/iu.test(diagnostic)
          ? '后台任务被中断或租约失效，本次分析未完成。'
          : /(?:MODEL|PROVIDER|HTTP|UND_ERR)/iu.test(diagnostic)
            ? '模型服务暂时不可用，本次分析未完成。'
            : '本次分析未完成，失败记录已保留。';
  return { code, message };
}

function publicJob(row: JobRow): CommerceAgentJob {
  return {
    id: row.id,
    kind: row.kind,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    model: row.model,
    message: row.message,
    requiredRevision: row.required_revision,
    executedByWorkerId: row.executed_by_worker_id,
    status: row.status,
    attemptCount: finiteInteger(row.attempt_count),
    maxAttempts: finiteInteger(row.max_attempts),
    availableAt: timestamp(row.available_at),
    createdAt: timestamp(row.created_at),
    startedAt: optionalTimestamp(row.started_at),
    completedAt: optionalTimestamp(row.completed_at),
    result: row.result_json as CommerceAgentRunResponse | null,
    error: row.error_code ? publicJobError(row.error_code, row.error_message) : null,
  };
}

function fingerprint(input: {
  kind: CommerceAgentJobKind;
  conversationId: string | null;
  message: string;
  model: string;
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

const JOB_COLUMNS = `id, tenant_id, user_id, user_display_name, auth_mode, scopes,
  kind, conversation_id, request_id, request_sha256, model, message, status,
  required_revision, executed_by_worker_id,
  attempt_count, max_attempts, available_at, result_json, error_code, error_message,
  created_at, started_at, completed_at`;

async function appendEvent(
  client: CommerceSqlClient,
  input: {
    jobId: string;
    identity: Pick<CommerceIdentity, 'tenantId' | 'userId'>;
    type: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO commerce_agent_job_events
       (job_id, tenant_id, user_id, event_type, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.jobId,
      input.identity.tenantId,
      input.identity.userId,
      input.type,
      JSON.stringify(input.payload ?? {}),
    ],
  );
}

type CorrectionFeedbackCandidateRow = Record<string, unknown> & {
  feedback_id: string;
  version: unknown;
  original_run_id: string;
};

export interface CommerceJobEnqueueInput {
  identity: CommerceIdentity;
  kind: CommerceAgentJobKind;
  conversationId?: string | null;
  requestId: string;
  model: string;
  message: string;
  maxQueuedPerUser: number;
  maxAttempts: number;
  accountHourlyLimit?: number;
  ipHourlyLimit?: number;
  ipHash?: string | null;
  modelBudgetPolicy?: CommerceModelBudgetPolicy;
}

function budgetDateText(value: unknown): string {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    throw new Error('Commerce model budget ledger returned an invalid UTC date.');
  }
  return text;
}

async function reserveModelBudget(
  client: CommerceSqlClient,
  policy: CommerceModelBudgetPolicy,
): Promise<string> {
  const reserved = await client.query<{ budget_date: unknown }>(
    `INSERT INTO commerce_agent_model_budget_daily
       (budget_date, reserved_usd, spent_usd)
     SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date, $1::numeric, 0
     WHERE $1::numeric <= $2::numeric
     ON CONFLICT (budget_date) DO UPDATE
     SET reserved_usd = commerce_agent_model_budget_daily.reserved_usd
                        + EXCLUDED.reserved_usd,
         updated_at = NOW()
     WHERE commerce_agent_model_budget_daily.reserved_usd
           + commerce_agent_model_budget_daily.spent_usd
           + EXCLUDED.reserved_usd <= $2::numeric
     RETURNING budget_date`,
    [policy.reservationUsd, policy.dailyLimitUsd],
  );
  if (!reserved.rows[0]) throw new CommerceModelBudgetExceededError();
  return budgetDateText(reserved.rows[0].budget_date);
}

async function settleModelBudget(
  client: CommerceSqlClient,
  jobId: string,
  usage: CommerceAgentRunResponse['usage'] | null,
): Promise<void> {
  await client.query(
    'SELECT public.commerce_settle_model_budget($1, $2::bigint, $3::bigint)',
    [jobId, usage?.inputTokens ?? null, usage?.outputTokens ?? null],
  );
}

export const COMMERCE_WEEKLY_DIAGNOSIS_SUPERSEDED_CODE = 'WEEKLY_DIAGNOSIS_SUPERSEDED';
const COMMERCE_WEEKLY_DIAGNOSIS_SUPERSEDED_MESSAGE =
  'Weekly diagnosis revision was superseded before this Job completed.';

/**
 * Terminalize an obsolete physical Job in the caller's transaction. The weekly scheduler uses
 * this at correction time, while claim() uses it to heal rows left by an older application
 * revision. Settling the reservation here prevents an abandoned queued/running Job from
 * retaining daily budget indefinitely.
 */
export async function terminalizeSupersededCommerceJobWithClient(
  client: CommerceSqlClient,
  input: { jobId: string; tenantId: string; userId: string },
): Promise<boolean> {
  const updated = await client.query<{ id: string }>(
    `UPDATE commerce_agent_jobs
     SET status = 'failed', error_code = $4, error_message = $5,
         last_error_code = $4, last_error_message = $5,
         completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL,
         updated_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND user_id = $3
       AND status IN ('queued', 'running')
     RETURNING id`,
    [
      input.jobId,
      input.tenantId,
      input.userId,
      COMMERCE_WEEKLY_DIAGNOSIS_SUPERSEDED_CODE,
      COMMERCE_WEEKLY_DIAGNOSIS_SUPERSEDED_MESSAGE,
    ],
  );
  if (!updated.rowCount) return false;
  await settleModelBudget(client, input.jobId, null);
  await appendEvent(client, {
    jobId: input.jobId,
    identity: { tenantId: input.tenantId, userId: input.userId },
    type: 'failed',
    payload: {
      status: 'failed',
      code: COMMERCE_WEEKLY_DIAGNOSIS_SUPERSEDED_CODE,
      reason: 'weekly_diagnosis_superseded',
    },
  });
  return true;
}

async function reconcileSupersededWeeklyDiagnosisJobs(
  client: CommerceSqlClient,
): Promise<void> {
  // This first update heals the pre-terminal-state schema. It is deliberately global because
  // Job claiming is also a trusted, global FIFO operation.
  await client.query(
    `UPDATE commerce_weekly_diagnosis_runs
     SET status = 'superseded', updated_at = NOW()
     WHERE NOT is_current AND status IN ('waiting', 'queued', 'running')`,
  );
  const stale = await client.query<{
    job_id: string;
    tenant_id: string;
    user_id: string;
  }>(
    `SELECT diagnosis.agent_job_id AS job_id, diagnosis.tenant_id, diagnosis.user_id
     FROM commerce_weekly_diagnosis_runs AS diagnosis
     JOIN commerce_agent_jobs AS job
       ON job.id = diagnosis.agent_job_id
      AND job.tenant_id = diagnosis.tenant_id
      AND job.user_id = diagnosis.user_id
     WHERE NOT diagnosis.is_current
       AND job.status IN ('queued', 'running')
     ORDER BY diagnosis.id
     FOR UPDATE OF job SKIP LOCKED`,
  );
  for (const row of stale.rows) {
    await terminalizeSupersededCommerceJobWithClient(client, {
      jobId: row.job_id,
      tenantId: row.tenant_id,
      userId: row.user_id,
    });
  }
}

type CorrectionFeedbackIdRow = Record<string, unknown> & {
  feedback_id: string;
};

const CORRECTION_WORKER_ACTOR_ID = 'system:commerce-worker';
const CORRECTION_WORKER_ACTOR_NAME = 'Commerce Agent Worker';

async function appendCorrectionFeedbackTerminalEvent(
  client: CommerceSqlClient,
  input: {
    jobId: string;
    tenantId: string;
    eventType: 'correction_completed' | 'correction_failed';
    runId?: string | null;
    error?: { code: string; message: string };
  },
): Promise<void> {
  // First discover candidate feedback records, then serialize each one with the same
  // advisory lock used by reviewer transitions. The second read after the lock is
  // intentional: a reviewer may have appended a newer event while this transaction
  // was waiting, in which case this terminal callback must become a no-op.
  const candidateIds = await client.query<CorrectionFeedbackIdRow>(
    `SELECT DISTINCT event.feedback_id
     FROM commerce_agent_feedback_events AS event
     WHERE event.tenant_id = $1
       AND event.job_id = $2
       AND event.event_type = 'correction_enqueued'`,
    [input.tenantId, input.jobId],
  );
  for (const candidateId of candidateIds.rows) {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      [`commerce-feedback:${input.tenantId}:${candidateId.feedback_id}`],
    );
    const current = await client.query<CorrectionFeedbackCandidateRow>(
      `SELECT event.feedback_id, event.version, feedback.run_id AS original_run_id
       FROM commerce_agent_feedback_events AS event
       JOIN commerce_agent_feedback AS feedback
         ON feedback.id = event.feedback_id
        AND feedback.tenant_id = event.tenant_id
       WHERE event.tenant_id = $1
         AND event.feedback_id = $2
         AND event.job_id = $3
         AND event.event_type = 'correction_enqueued'
         AND NOT EXISTS (
           SELECT 1
           FROM commerce_agent_feedback_events AS newer
           WHERE newer.tenant_id = event.tenant_id
             AND newer.feedback_id = event.feedback_id
             AND newer.version > event.version
         )
       FOR UPDATE OF event`,
      [input.tenantId, candidateId.feedback_id, input.jobId],
    );
    const candidate = current.rows[0];
    if (!candidate) continue;
    if (input.eventType === 'correction_completed') {
      if (!input.runId) {
        throw new Error('Correction job completed without a persisted assistant Run.');
      }
      if (input.runId === candidate.original_run_id) {
        throw new Error('Correction job must produce a new Run without overwriting the original.');
      }
    }
    const note = input.eventType === 'correction_failed' && input.error
      ? `${input.error.code}: ${input.error.message}`.slice(0, 1_000)
      : null;
    const eventPayload = {
      feedbackId: candidate.feedback_id,
      jobId: input.jobId,
      eventType: input.eventType,
      runId: input.runId ?? null,
      errorCode: input.eventType === 'correction_failed' ? input.error?.code ?? null : null,
    };
    const digest = createHash('sha256').update(JSON.stringify(eventPayload)).digest('hex');
    const terminalKind = input.eventType === 'correction_completed' ? 'completed' : 'failed';
    const idempotencyKey = `correction-terminal:${input.jobId}:${terminalKind}`;
    await client.query(
      `INSERT INTO commerce_agent_feedback_events
         (feedback_id, tenant_id, actor_user_id, actor_display_name, event_type,
          version, note, idempotency_key, request_sha256, job_id, run_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (tenant_id, actor_user_id, idempotency_key) DO NOTHING`,
      [
        candidate.feedback_id,
        input.tenantId,
        CORRECTION_WORKER_ACTOR_ID,
        CORRECTION_WORKER_ACTOR_NAME,
        input.eventType,
        finiteInteger(candidate.version) + 1,
        note,
        idempotencyKey,
        `sha256:${digest}`,
        input.jobId,
        input.runId ?? null,
      ],
    );
  }
}

export class PostgresCommerceJobStore {
  constructor(private readonly database: CommerceDatabase) {}

  async enqueueWithClient(
    client: CommerceSqlClient,
    input: CommerceJobEnqueueInput,
  ): Promise<CommerceAgentJob> {
    // This is the shared enqueue boundary used by routes, correction jobs, reviews and
    // weekly schedulers. Enforce the kill switch here as well as at callers so a flag
    // transition between their check and this transaction cannot create a model Job.
    if (getCommerceAgentRuntimeConfig().globalKillSwitch) {
      throw new CommerceJobEnqueueDisabledError();
    }
    if (!isValidCommerceMessage(input.message)) throw new CommerceJobInvalidMessageError();
    const normalized = {
      kind: input.kind,
      conversationId: input.conversationId ?? null,
      message: input.message.trim(),
      model: input.model,
    };
    const requestSha256 = fingerprint(normalized);
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`commerce-job-user:${input.identity.tenantId}:${input.identity.userId}`],
    );
    const existing = await client.query<JobRow>(
      `SELECT ${JOB_COLUMNS}
       FROM commerce_agent_jobs
       WHERE tenant_id = $1 AND user_id = $2 AND request_id = $3
       FOR UPDATE`,
      [input.identity.tenantId, input.identity.userId, input.requestId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].request_sha256 !== requestSha256) {
        throw new CommerceJobConflictError();
      }
      return publicJob(existing.rows[0]);
    }
    if (normalized.kind === 'conversation_turn') {
      const owned = await client.query<{ id: string }>(
        `SELECT id FROM commerce_agent_conversations
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [normalized.conversationId, input.identity.tenantId, input.identity.userId],
      );
      if (!owned.rowCount) throw new CommerceJobNotFoundError();
    }
    const consumeLimit = async (
      scope: 'account' | 'ip',
      scopeKey: string,
      maximum: number,
    ) => {
      const consumed = await client.query<{ request_count: unknown }>(
        `INSERT INTO commerce_agent_rate_limits (scope_key, window_start, request_count)
         VALUES ($1, date_trunc('hour', NOW()), 1)
         ON CONFLICT (scope_key, window_start) DO UPDATE
         SET request_count = commerce_agent_rate_limits.request_count + 1
         WHERE commerce_agent_rate_limits.request_count < $2
         RETURNING request_count`,
        [scopeKey, maximum],
      );
      if (!consumed.rowCount) throw new CommerceJobRateLimitError(scope);
    };
    if (input.accountHourlyLimit) {
      await consumeLimit(
        'account',
        `diagnosis:account:${input.identity.tenantId}:${input.identity.userId}`,
        input.accountHourlyLimit,
      );
    }
    if (input.ipHourlyLimit && input.ipHash) {
      await consumeLimit('ip', `diagnosis:ip:${input.ipHash}`, input.ipHourlyLimit);
    }
    const active = await client.query<{ count: unknown }>(
      `SELECT COUNT(*)::integer AS count
       FROM commerce_agent_jobs
       WHERE tenant_id = $1 AND user_id = $2 AND status IN ('queued', 'running')`,
      [input.identity.tenantId, input.identity.userId],
    );
    if (finiteInteger(active.rows[0]?.count) >= input.maxQueuedPerUser) {
      throw new CommerceJobQueueFullError();
    }
    const id = `job_${randomUUID()}`;
    // Low-level schedulers also enqueue directly through this store. Deriving the
    // policy here prevents a new model Job path from accidentally bypassing the
    // global budget simply because its caller omitted an optional argument.
    const effectiveBudgetPolicy = input.modelBudgetPolicy ?? commerceModelBudgetPolicy();
    const budgetDate = effectiveBudgetPolicy
      ? await reserveModelBudget(client, effectiveBudgetPolicy)
      : null;
    const requiredRevision = process.env.COMMERCE_RELEASE_REVISION || 'unversioned';
    const inserted = await client.query<JobRow>(
      `INSERT INTO commerce_agent_jobs
         (id, tenant_id, user_id, user_display_name, auth_mode, scopes, kind,
          conversation_id, request_id, request_sha256, model, message, required_revision,
          status, max_attempts)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12, $13,
               'queued', $14)
       RETURNING ${JOB_COLUMNS}`,
      [
        id,
        input.identity.tenantId,
        input.identity.userId,
        input.identity.displayName,
        input.identity.authMode,
        input.identity.scopes,
        normalized.kind,
        normalized.conversationId,
        input.requestId,
        requestSha256,
        input.model,
        normalized.message,
        requiredRevision,
        input.maxAttempts,
      ],
    );
    if (budgetDate && effectiveBudgetPolicy) {
      await client.query(
        `INSERT INTO commerce_agent_model_budget_reservations
           (job_id, budget_date, reserved_usd, input_usd_per_million_tokens,
            output_usd_per_million_tokens)
         VALUES ($1, $2::date, $3::numeric, $4::numeric, $5::numeric)`,
        [
          id,
          budgetDate,
          effectiveBudgetPolicy.reservationUsd,
          effectiveBudgetPolicy.inputUsdPerMillionTokens,
          effectiveBudgetPolicy.outputUsdPerMillionTokens,
        ],
      );
    }
    await appendEvent(client, {
      jobId: id,
      identity: input.identity,
      type: 'queued',
      payload: { status: 'queued' },
    });
    return publicJob(inserted.rows[0]);
  }

  async heartbeatWorker(workerId: string): Promise<void> {
    await withCommerceControlSystem(() => this.database.query(
      `INSERT INTO commerce_agent_workers (id, revision, status, started_at, heartbeat_at)
       VALUES ($1, $2, 'running', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET revision = EXCLUDED.revision,
         status = 'running', heartbeat_at = NOW(), stopped_at = NULL`,
      [workerId, process.env.COMMERCE_RELEASE_REVISION || 'unversioned'],
    ));
  }

  async stopWorker(workerId: string): Promise<void> {
    await withCommerceControlSystem(() => this.database.query(
      `UPDATE commerce_agent_workers
       SET status = 'stopped', stopped_at = NOW(), heartbeat_at = NOW()
       WHERE id = $1`,
      [workerId],
    ));
  }

  async enqueue(input: CommerceJobEnqueueInput): Promise<CommerceAgentJob> {
    return withCommerceControlIdentity(input.identity, () => this.database.transaction(
      (client) => this.enqueueWithClient(client, input),
    ));
  }

  async get(identity: CommerceIdentity, jobId: string): Promise<CommerceAgentJob> {
    const result = await withCommerceControlIdentity(identity, () => this.database.query<JobRow>(
      `SELECT ${JOB_COLUMNS}
       FROM commerce_agent_jobs
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [jobId, identity.tenantId, identity.userId],
    ));
    if (!result.rows[0]) throw new CommerceJobNotFoundError();
    return publicJob(result.rows[0]);
  }

  async listActive(
    identity: CommerceIdentity,
    limit = 10,
  ): Promise<CommerceAgentJob[]> {
    const boundedLimit = Math.max(1, Math.min(20, Math.trunc(limit)));
    const result = await withCommerceControlIdentity(identity, () => this.database.query<JobRow>(
      `SELECT ${JOB_COLUMNS}
       FROM commerce_agent_jobs
       WHERE tenant_id = $1 AND user_id = $2
         AND status IN ('queued', 'running')
       ORDER BY created_at DESC
       LIMIT $3`,
      [identity.tenantId, identity.userId, boundedLimit],
    ));
    return result.rows.map(publicJob);
  }

  async events(
    identity: CommerceIdentity,
    jobId: string,
    afterId: number,
  ): Promise<CommerceAgentJobEvent[]> {
    return withCommerceControlIdentity(identity, async () => {
    await this.get(identity, jobId);
    const result = await this.database.query<{
      id: unknown;
      event_type: string;
      payload: Record<string, unknown>;
      created_at: unknown;
    }>(
      `SELECT id, event_type, payload, created_at
       FROM commerce_agent_job_events
       WHERE job_id = $1 AND tenant_id = $2 AND user_id = $3 AND id > $4
       ORDER BY id ASC LIMIT 100`,
      [jobId, identity.tenantId, identity.userId, afterId],
    );
    return result.rows.map((row) => ({
      id: finiteInteger(row.id),
      type: row.event_type,
      payload: row.payload ?? {},
      createdAt: timestamp(row.created_at),
    }));
    });
  }

  async claim(input: {
    workerId: string;
    leaseMs: number;
    revision?: string;
  }): Promise<ClaimedCommerceAgentJob | null> {
    const revision = input.revision || process.env.COMMERCE_RELEASE_REVISION || 'unversioned';
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      await reconcileSupersededWeeklyDiagnosisJobs(client);
      // commerce_reap_expired_jobs() is the single source of truth for resolving a
      // lease-expired running Job (dead-letter vs requeue, plus its job_events row); the
      // retention cleanup script calls the same function so the two paths can never disagree.
      await client.query('SELECT dead_lettered_count, requeued_count FROM commerce_reap_expired_jobs()');
      const selected = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS}
         FROM commerce_agent_jobs
         WHERE status = 'queued' AND required_revision = $1
           AND available_at <= clock_timestamp()
           AND NOT EXISTS (
             SELECT 1
             FROM commerce_weekly_diagnosis_runs AS diagnosis
             WHERE diagnosis.agent_job_id = commerce_agent_jobs.id
               AND diagnosis.tenant_id = commerce_agent_jobs.tenant_id
               AND diagnosis.user_id = commerce_agent_jobs.user_id
               AND (NOT diagnosis.is_current OR diagnosis.status = 'superseded')
           )
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 1`,
        [revision],
      );
      const row = selected.rows[0];
      if (!row) return null;
      const claimed = await client.query<JobRow>(
        `UPDATE commerce_agent_jobs
         SET status = 'running', attempt_count = attempt_count + 1,
             lease_owner = $1,
             executed_by_worker_id = $1,
             lease_expires_at = clock_timestamp() + ($2::integer * INTERVAL '1 millisecond'),
             started_at = COALESCE(started_at, NOW()), updated_at = NOW()
         WHERE id = $3
         RETURNING ${JOB_COLUMNS}`,
        [input.workerId, input.leaseMs, row.id],
      );
      await appendEvent(client, {
        jobId: row.id,
        identity: { tenantId: row.tenant_id, userId: row.user_id },
        type: 'running',
        payload: { status: 'running', attempt: finiteInteger(claimed.rows[0].attempt_count) },
      });
      return {
        ...publicJob(claimed.rows[0]),
        identity: {
          tenantId: row.tenant_id,
          userId: row.user_id,
          displayName: row.user_display_name,
          scopes: row.scopes,
          authMode: row.auth_mode,
        },
        message: row.message,
        leaseOwner: input.workerId,
      };
    }));
  }

  async renew(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await withCommerceControlSystem(() => this.database.query<{ id: string }>(
      `UPDATE commerce_agent_jobs
       SET lease_expires_at = clock_timestamp() + ($1::integer * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = $2 AND status = 'running' AND lease_owner = $3
         AND lease_expires_at >= clock_timestamp()
       RETURNING id`,
      [leaseMs, jobId, workerId],
    ));
    return result.rowCount === 1;
  }

  async complete(
    job: ClaimedCommerceAgentJob,
    result: CommerceAgentRunResponse,
  ): Promise<void> {
    await withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE commerce_agent_jobs
         SET status = 'completed', result_json = $1::jsonb, error_code = NULL,
             error_message = NULL, last_error_code = NULL, last_error_message = NULL,
             completed_at = NOW(), executed_by_worker_id = $3, lease_owner = NULL,
             lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $2 AND status = 'running' AND lease_owner = $3
         RETURNING id`,
        [JSON.stringify(result), job.id, job.leaseOwner],
      );
      if (!updated.rowCount) throw new Error('Commerce job lease ownership was lost before completion.');
      await settleModelBudget(client, job.id, result.usage);
      await appendEvent(client, {
        jobId: job.id,
        identity: job.identity,
        type: 'completed',
        payload: {
          status: 'completed',
          conversationId: result.conversation.id,
        },
      });
      await appendCorrectionFeedbackTerminalEvent(client, {
        jobId: job.id,
        tenantId: job.identity.tenantId,
        eventType: 'correction_completed',
        runId: result.assistantMessage.runId,
      });
    }));
  }

  async fail(
    job: ClaimedCommerceAgentJob,
    error: unknown,
  ): Promise<void> {
    const { code, message } = jobError(error);
    await withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE commerce_agent_jobs
         SET status = 'failed', error_code = $1, error_message = $2,
             last_error_code = $1, last_error_message = $2,
             completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $3 AND status = 'running' AND lease_owner = $4
         RETURNING id`,
        [code, message, job.id, job.leaseOwner],
      );
      if (!updated.rowCount) return;
      await settleModelBudget(client, job.id, null);
      await appendEvent(client, {
        jobId: job.id,
        identity: job.identity,
        type: 'failed',
        payload: { status: 'failed', code },
      });
      await appendCorrectionFeedbackTerminalEvent(client, {
        jobId: job.id,
        tenantId: job.identity.tenantId,
        eventType: 'correction_failed',
        error: { code, message },
      });
    }));
  }

  async retryOrDeadLetter(
    job: ClaimedCommerceAgentJob,
    error: unknown,
    delayMs: number,
  ): Promise<CommerceJobRetryOutcome> {
    const { code, message } = jobError(error);
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const requeued = await client.query<{ id: string; available_at: unknown }>(
        `UPDATE commerce_agent_jobs
         SET status = 'queued', available_at = clock_timestamp() + ($1::integer * INTERVAL '1 millisecond'),
             lease_owner = NULL, lease_expires_at = NULL, completed_at = NULL,
             error_code = NULL, error_message = NULL,
             last_error_code = $2, last_error_message = $3, updated_at = NOW()
         WHERE id = $4 AND status = 'running' AND lease_owner = $5
           AND attempt_count < max_attempts
         RETURNING id, available_at`,
        [delayMs, code, message, job.id, job.leaseOwner],
      );
      if (requeued.rows[0]) {
        await appendEvent(client, {
          jobId: job.id,
          identity: job.identity,
          type: 'requeued',
          payload: {
            status: 'queued',
            reason: 'retryable_execution_error',
            code,
            attempt: job.attemptCount,
            availableAt: timestamp(requeued.rows[0].available_at),
          },
        });
        return 'requeued';
      }
      const deadLettered = await client.query<{ id: string }>(
        `UPDATE commerce_agent_jobs
         SET status = 'dead_letter', error_code = $1, error_message = $2,
             last_error_code = $1, last_error_message = $2,
             completed_at = NOW(), lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $3 AND status = 'running' AND lease_owner = $4
         RETURNING id`,
        [code, message, job.id, job.leaseOwner],
      );
      if (!deadLettered.rowCount) {
        throw new Error('Commerce job lease ownership was lost before retry handling.');
      }
      await settleModelBudget(client, job.id, null);
      await appendEvent(client, {
        jobId: job.id,
        identity: job.identity,
        type: 'dead_lettered',
        payload: {
          status: 'dead_letter',
          code,
          attempts: job.attemptCount,
        },
      });
      await appendCorrectionFeedbackTerminalEvent(client, {
        jobId: job.id,
        tenantId: job.identity.tenantId,
        eventType: 'correction_failed',
        error: { code, message },
      });
      return 'dead_letter';
    }));
  }
}

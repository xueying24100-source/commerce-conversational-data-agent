import { createHash, randomUUID } from 'node:crypto';

import type { CommerceDatabase, CommerceSqlClient } from './database';
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

function publicJob(row: JobRow): CommerceAgentJob {
  return {
    id: row.id,
    kind: row.kind,
    conversationId: row.conversation_id,
    requestId: row.request_id,
    model: row.model,
    status: row.status,
    attemptCount: finiteInteger(row.attempt_count),
    maxAttempts: finiteInteger(row.max_attempts),
    availableAt: timestamp(row.available_at),
    createdAt: timestamp(row.created_at),
    startedAt: optionalTimestamp(row.started_at),
    completedAt: optionalTimestamp(row.completed_at),
    result: row.result_json as CommerceAgentRunResponse | null,
    error: row.error_code
      ? { code: row.error_code, message: row.error_message || 'Commerce Agent job failed.' }
      : null,
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

export class PostgresCommerceJobStore {
  constructor(private readonly database: CommerceDatabase) {}

  async heartbeatWorker(workerId: string): Promise<void> {
    await this.database.query(
      `INSERT INTO commerce_agent_workers (id, revision, status, started_at, heartbeat_at)
       VALUES ($1, $2, 'running', NOW(), NOW())
       ON CONFLICT (id) DO UPDATE SET status = 'running', heartbeat_at = NOW(), stopped_at = NULL`,
      [workerId, process.env.COMMERCE_RELEASE_REVISION || 'unversioned'],
    );
  }

  async stopWorker(workerId: string): Promise<void> {
    await this.database.query(
      `UPDATE commerce_agent_workers
       SET status = 'stopped', stopped_at = NOW(), heartbeat_at = NOW()
       WHERE id = $1`,
      [workerId],
    );
  }

  async enqueue(input: {
    identity: CommerceIdentity;
    kind: CommerceAgentJobKind;
    conversationId?: string | null;
    requestId: string;
    model: string;
    message: string;
    maxQueuedPerUser: number;
    maxAttempts: number;
  }): Promise<CommerceAgentJob> {
    const normalized = {
      kind: input.kind,
      conversationId: input.conversationId ?? null,
      message: input.message.trim(),
      model: input.model,
    };
    const requestSha256 = fingerprint(normalized);
    return this.database.transaction(async (client) => {
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
      const inserted = await client.query<JobRow>(
        `INSERT INTO commerce_agent_jobs
           (id, tenant_id, user_id, user_display_name, auth_mode, scopes, kind,
            conversation_id, request_id, request_sha256, model, message, status, max_attempts)
         VALUES ($1, $2, $3, $4, $5, $6::text[], $7, $8, $9, $10, $11, $12, 'queued', $13)
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
          input.maxAttempts,
        ],
      );
      await appendEvent(client, {
        jobId: id,
        identity: input.identity,
        type: 'queued',
        payload: { status: 'queued' },
      });
      return publicJob(inserted.rows[0]);
    });
  }

  async get(identity: CommerceIdentity, jobId: string): Promise<CommerceAgentJob> {
    const result = await this.database.query<JobRow>(
      `SELECT ${JOB_COLUMNS}
       FROM commerce_agent_jobs
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [jobId, identity.tenantId, identity.userId],
    );
    if (!result.rows[0]) throw new CommerceJobNotFoundError();
    return publicJob(result.rows[0]);
  }

  async events(
    identity: CommerceIdentity,
    jobId: string,
    afterId: number,
  ): Promise<CommerceAgentJobEvent[]> {
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
  }

  async claim(input: {
    workerId: string;
    leaseMs: number;
  }): Promise<ClaimedCommerceAgentJob | null> {
    return this.database.transaction(async (client) => {
      const exhausted = await client.query<{ id: string; tenant_id: string; user_id: string }>(
        `UPDATE commerce_agent_jobs
         SET status = 'dead_letter', error_code = 'JOB_LEASE_EXHAUSTED',
             error_message = 'Worker lease expired too many times.', completed_at = NOW(), updated_at = NOW()
         WHERE status = 'running' AND lease_expires_at < clock_timestamp()
           AND attempt_count >= max_attempts
         RETURNING id, tenant_id, user_id`,
      );
      for (const row of exhausted.rows) {
        await appendEvent(client, {
          jobId: row.id,
          identity: { tenantId: row.tenant_id, userId: row.user_id },
          type: 'dead_lettered',
          payload: { status: 'dead_letter', code: 'JOB_LEASE_EXHAUSTED' },
        });
      }
      const reclaimed = await client.query<{ id: string; tenant_id: string; user_id: string }>(
        `UPDATE commerce_agent_jobs
         SET status = 'queued', lease_owner = NULL, lease_expires_at = NULL,
             available_at = NOW(), updated_at = NOW()
         WHERE status = 'running' AND lease_expires_at < clock_timestamp()
           AND attempt_count < max_attempts
         RETURNING id, tenant_id, user_id`,
      );
      for (const row of reclaimed.rows) {
        await appendEvent(client, {
          jobId: row.id,
          identity: { tenantId: row.tenant_id, userId: row.user_id },
          type: 'requeued',
          payload: { status: 'queued', reason: 'lease_expired' },
        });
      }
      const selected = await client.query<JobRow>(
        `SELECT ${JOB_COLUMNS}
         FROM commerce_agent_jobs
         WHERE status = 'queued' AND available_at <= clock_timestamp()
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      const row = selected.rows[0];
      if (!row) return null;
      const claimed = await client.query<JobRow>(
        `UPDATE commerce_agent_jobs
         SET status = 'running', attempt_count = attempt_count + 1,
             lease_owner = $1,
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
    });
  }

  async renew(jobId: string, workerId: string, leaseMs: number): Promise<boolean> {
    const result = await this.database.query<{ id: string }>(
      `UPDATE commerce_agent_jobs
       SET lease_expires_at = clock_timestamp() + ($1::integer * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE id = $2 AND status = 'running' AND lease_owner = $3
         AND lease_expires_at >= clock_timestamp()
       RETURNING id`,
      [leaseMs, jobId, workerId],
    );
    return result.rowCount === 1;
  }

  async complete(
    job: ClaimedCommerceAgentJob,
    result: CommerceAgentRunResponse,
  ): Promise<void> {
    await this.database.transaction(async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE commerce_agent_jobs
         SET status = 'completed', result_json = $1::jsonb, error_code = NULL,
             error_message = NULL, last_error_code = NULL, last_error_message = NULL,
             completed_at = NOW(), lease_owner = NULL,
             lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $2 AND status = 'running' AND lease_owner = $3
         RETURNING id`,
        [JSON.stringify(result), job.id, job.leaseOwner],
      );
      if (!updated.rowCount) throw new Error('Commerce job lease ownership was lost before completion.');
      await appendEvent(client, {
        jobId: job.id,
        identity: job.identity,
        type: 'completed',
        payload: {
          status: 'completed',
          conversationId: result.conversation.id,
        },
      });
    });
  }

  async fail(
    job: ClaimedCommerceAgentJob,
    error: unknown,
  ): Promise<void> {
    const { code, message } = jobError(error);
    await this.database.transaction(async (client) => {
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
      await appendEvent(client, {
        jobId: job.id,
        identity: job.identity,
        type: 'failed',
        payload: { status: 'failed', code },
      });
    });
  }

  async retryOrDeadLetter(
    job: ClaimedCommerceAgentJob,
    error: unknown,
    delayMs: number,
  ): Promise<CommerceJobRetryOutcome> {
    const { code, message } = jobError(error);
    return this.database.transaction(async (client) => {
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
      return 'dead_letter';
    });
  }
}

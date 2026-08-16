import { createHash, randomUUID } from 'node:crypto';

import type { MoAgentTokenUsage } from '@/lib/agent/types';
import type { CommerceDatabase, CommerceSqlClient } from './database';
import {
  buildReportArtifact,
  insertReportArtifact,
  newCommerceReportId,
} from './report-store';
import {
  commerceAgentAnswerSchema,
  commerceActionCommitmentSchema,
  type CommerceActionState,
  type CommerceActionCommitment,
  type CommerceAgentAnswer,
  type CommerceConversation,
  type CommerceConversationMessage,
  type CommerceConversationSummary,
  type CommerceIdentity,
  type CommerceToolTrace,
} from './types';

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Database returned an invalid timestamp.');
  return date.toISOString();
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function titleFromMessage(message: string): string {
  const normalized = message.replace(/\s+/gu, ' ').trim();
  return normalized.length > 42 ? `${normalized.slice(0, 42)}…` : normalized;
}

function assertRequestSha256(value: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error('Commerce request fingerprint is invalid.');
  }
  return value;
}

function postgresConstraint(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === '23505' && typeof candidate.constraint === 'string'
    ? candidate.constraint
    : null;
}

export function commerceRateLimitScopeKey(
  kind: 'tenant' | 'user',
  identity: Pick<CommerceIdentity, 'tenantId' | 'userId'>,
): string {
  const parts = kind === 'tenant'
    ? { kind, tenantId: identity.tenantId }
    : { kind, tenantId: identity.tenantId, userId: identity.userId };
  return `${kind}:sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

interface ConversationRow extends Record<string, unknown> {
  id: string;
  title: string;
  model: string;
  created_at: unknown;
  updated_at: unknown;
}

interface MessageRow extends Record<string, unknown> {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer_json: unknown;
  run_id: string | null;
  run_status: 'running' | 'completed' | 'failed' | null;
  run_error_code?: string | null;
  run_error_message?: string | null;
  report_available: boolean;
  created_at: unknown;
}

function publicRunFailure(
  codeValue: string | null | undefined,
  messageValue: string | null | undefined,
): CommerceConversationMessage['runError'] {
  const code = String(codeValue || 'COMMERCE_AGENT_FAILED')
    .replace(/[^A-Za-z0-9_.:-]/gu, '_')
    .slice(0, 120) || 'COMMERCE_AGENT_FAILED';
  const diagnostic = `${code} ${String(messageValue || '')}`;
  const message = /(?:TIMEOUT|TIMEDOUT|HEADERS_TIMEOUT)/iu.test(diagnostic)
    ? '模型或数据查询响应超时，本次没有生成回答。'
    : /(?:RATE_LIMIT|TOO_MANY_REQUESTS|\b429\b)/iu.test(diagnostic)
      ? '上游服务触发限流，本次分析未完成。'
      : /(?:DATABASE|DATA_UNAVAILABLE|ECONNREFUSED|CONNECTION|relation .* does not exist)/iu.test(diagnostic)
        ? '经营数据服务暂时不可用，本次分析未完成。'
        : /(?:LEASE|ABORT|CANCEL|WORKER)/iu.test(diagnostic)
          ? '后台任务被中断或租约失效，本次分析未完成。'
          : /(?:MODEL|PROVIDER|HTTP|UND_ERR)/iu.test(diagnostic)
            ? '模型服务暂时不可用，本次分析未完成。'
            : '本次分析未完成，原问题和失败记录已保留。';
  return { code, message, retryable: true };
}

interface EvidenceRow extends Record<string, unknown> {
  id: string;
  run_id: string;
  operation: string;
  request_sha256: string;
  response_sha256: string;
  source_watermark: unknown;
  request_json: unknown;
  row_count: unknown;
  preview_json: unknown;
  preview_truncated: boolean;
  fetched_at: unknown;
}

interface ActionEventRow extends Record<string, unknown> {
  message_id: string;
  action_id: string;
  event_type: 'confirmed' | 'started' | 'blocked' | 'resumed' | 'completed' | 'cancelled' | 'reopened';
  version: unknown;
  details_json: unknown;
  created_at: unknown;
}

interface RequestRunRow extends Record<string, unknown> {
  id: string;
  status: string;
  request_sha256: string;
}

function summary(row: ConversationRow): CommerceConversationSummary {
  return {
    id: row.id,
    title: row.title,
    model: row.model,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function tracesByRun(rows: EvidenceRow[]): Map<string, CommerceToolTrace[]> {
  const output = new Map<string, CommerceToolTrace[]>();
  for (const row of rows) {
    const trace: CommerceToolTrace = {
      evidenceId: row.id,
      operation: row.operation,
      fetchedAt: iso(row.fetched_at),
      rowCount: Number(row.row_count),
      requestSha256: row.request_sha256,
      responseSha256: row.response_sha256,
      sourceWatermark: row.source_watermark ? iso(row.source_watermark) : null,
      request: parseJson(row.request_json),
      preview: parseJson(row.preview_json),
      previewTruncated: row.preview_truncated === true,
    };
    output.set(row.run_id, [...(output.get(row.run_id) ?? []), trace]);
  }
  return output;
}

function actionStatesByMessage(rows: ActionEventRow[]): Map<string, CommerceActionState[]> {
  const output = new Map<string, CommerceActionState[]>();
  for (const row of rows) {
    const status: CommerceActionState['status'] = row.event_type === 'confirmed'
      ? 'confirmed'
      : row.event_type === 'started' || row.event_type === 'resumed' || row.event_type === 'reopened'
        ? 'in_progress'
        : row.event_type === 'blocked'
          ? 'blocked'
          : row.event_type === 'cancelled'
            ? 'cancelled'
            : 'completed';
    const detailsValue = parseJson(row.details_json);
    const details = detailsValue && typeof detailsValue === 'object' && !Array.isArray(detailsValue)
      ? detailsValue as Record<string, unknown>
      : {};
    const commitment = commerceActionCommitmentSchema.safeParse(details.commitment);
    const note = typeof details.note === 'string' && details.note.trim().length > 0
      ? details.note.trim().slice(0, 1_000)
      : null;
    const actionState: CommerceActionState = {
      actionId: row.action_id,
      status,
      version: Number(row.version),
      updatedAt: iso(row.created_at),
      commitment: commitment.success ? (commitment.data as CommerceActionCommitment) : null,
      lastNote: note,
    };
    output.set(row.message_id, [...(output.get(row.message_id) ?? []), actionState]);
  }
  return output;
}

function message(
  row: MessageRow,
  traces: Map<string, CommerceToolTrace[]>,
  actionStates: Map<string, CommerceActionState[]> = new Map(),
): CommerceConversationMessage {
  const parsedAnswer = row.answer_json === null
    ? null
    : commerceAgentAnswerSchema.safeParse(parseJson(row.answer_json));
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    answer: parsedAnswer && parsedAnswer.success ? parsedAnswer.data : null,
    runId: row.run_id,
    runStatus: row.run_status,
    runError: row.run_status === 'failed'
      ? publicRunFailure(row.run_error_code, row.run_error_message)
      : null,
    actionStates: actionStates.get(row.id) ?? [],
    reportAvailable: row.report_available === true,
    traces: row.run_id ? traces.get(row.run_id) ?? [] : [],
    createdAt: iso(row.created_at),
  };
}

export type BeginTurnResult =
  | { created: true; runId: string; userMessageId: string; generation: number }
  | {
      created: false;
      reason: 'existing';
      runId: string;
      userMessageId: string;
      status: string;
    }
  | {
      created: false;
      reason: 'rate_limited' | 'concurrency_limited';
      runId: string;
      userMessageId: string;
    };

export type BeginConversationTurnResult =
  | (Extract<BeginTurnResult, { created: true }> & {
      conversation: CommerceConversationSummary;
    })
  | Exclude<BeginTurnResult, { created: true }>;

export type RetryFailedTurnResult = {
  runId: string;
  conversationId: string;
  generation: number;
};

export class CommerceIdempotencyConflictError extends Error {
  readonly code = 'COMMERCE_IDEMPOTENCY_CONFLICT';

  constructor() {
    super('相同 Idempotency-Key 已用于不同的请求内容。');
    this.name = 'CommerceIdempotencyConflictError';
  }
}

export class CommerceConversationBusyError extends Error {
  readonly code = 'COMMERCE_CONVERSATION_BUSY';

  constructor() {
    super('该会话已有一个运行中的请求，请稍后使用相同 Idempotency-Key 重试。');
    this.name = 'CommerceConversationBusyError';
  }
}

export interface CompleteTurnInput {
  identity: CommerceIdentity;
  conversationId: string;
  runId: string;
  generation: number;
  assistantMessageId: string;
  answer: CommerceAgentAnswer;
  usage: MoAgentTokenUsage;
  traces: CommerceToolTrace[];
}

export interface CommerceConversationStore {
  createConversationAndBeginTurn(input: {
    identity: CommerceIdentity;
    model: string;
    provider: string;
    userMessage: string;
    requestId: string;
    requestSha256: string;
    runId: string;
    rateLimit: number;
    tenantRateLimit: number;
    globalConcurrencyLimit: number;
    tenantConcurrencyLimit: number;
    leaseMs: number;
  }): Promise<BeginConversationTurnResult>;
  listConversations(identity: CommerceIdentity, limit?: number): Promise<CommerceConversationSummary[]>;
  getConversation(identity: CommerceIdentity, conversationId: string, historyLimit?: number): Promise<CommerceConversation | null>;
  getModelHistory(
    identity: CommerceIdentity,
    conversationId: string,
    completedRunLimit?: number,
  ): Promise<CommerceConversationMessage[]>;
  beginTurn(input: {
    identity: CommerceIdentity;
    conversationId: string;
    requestId: string;
    model: string;
    provider: string;
    userMessage: string;
    requestSha256: string;
    rateLimit: number;
    tenantRateLimit: number;
    globalConcurrencyLimit: number;
    tenantConcurrencyLimit: number;
    leaseMs: number;
    runId?: string;
  }): Promise<BeginTurnResult>;
  retryFailedTurn?(input: {
    identity: CommerceIdentity;
    requestId: string;
    requestSha256: string;
    globalConcurrencyLimit: number;
    tenantConcurrencyLimit: number;
    leaseMs: number;
  }): Promise<RetryFailedTurnResult | null>;
  completeTurn(input: CompleteTurnInput): Promise<void>;
  appendEvidence(input: {
    identity: CommerceIdentity;
    conversationId: string;
    runId: string;
    generation: number;
    trace: CommerceToolTrace;
  }): Promise<void>;
  renewRunLease(input: {
    identity: CommerceIdentity;
    runId: string;
    generation: number;
    leaseMs: number;
  }): Promise<boolean>;
  failTurn(input: {
    identity: CommerceIdentity;
    runId: string;
    generation: number;
    code: string;
    message: string;
    usage?: MoAgentTokenUsage | null;
    traces?: CommerceToolTrace[];
  }): Promise<void>;
  findRunMessages(identity: CommerceIdentity, requestId: string, requestSha256?: string): Promise<{
    conversation: CommerceConversationSummary;
    userMessage: CommerceConversationMessage;
    assistantMessage: CommerceConversationMessage;
    usage: MoAgentTokenUsage;
  } | null>;
}

export class PostgresCommerceConversationStore implements CommerceConversationStore {
  constructor(private readonly database: CommerceDatabase) {}

  private async existingRequest(
    client: CommerceSqlClient,
    identity: CommerceIdentity,
    requestId: string,
    requestSha256: string,
  ): Promise<RequestRunRow | null> {
    const result = await client.query<RequestRunRow>(
      `SELECT id, status, request_sha256
       FROM commerce_agent_runs
       WHERE tenant_id = $1 AND user_id = $2 AND request_id = $3`,
      [identity.tenantId, identity.userId, requestId],
    );
    const existing = result.rows[0] ?? null;
    if (existing && existing.request_sha256 !== requestSha256) {
      throw new CommerceIdempotencyConflictError();
    }
    return existing;
  }

  private async consumeRateLimitInTransaction(
    client: CommerceSqlClient,
    identity: CommerceIdentity,
    limit: number,
    tenantLimit: number,
  ): Promise<boolean> {
    let allowed = true;
    const scopes: Array<[string, number]> = [
      [commerceRateLimitScopeKey('user', identity), limit],
      [commerceRateLimitScopeKey('tenant', identity), tenantLimit],
    ];
    for (const [scope, scopeLimit] of scopes) {
      const result = await client.query<{ request_count: unknown }>(
        `INSERT INTO commerce_agent_rate_limits (scope_key, window_start, request_count)
         VALUES ($1, date_trunc('minute', NOW()), 1)
         ON CONFLICT (scope_key, window_start)
         DO UPDATE SET request_count = LEAST(
           commerce_agent_rate_limits.request_count + 1,
           $2::integer + 1
         )
         RETURNING request_count`,
        [scope, scopeLimit],
      );
      allowed = allowed && Number(result.rows[0]?.request_count ?? scopeLimit + 1) <= scopeLimit;
    }
    return allowed;
  }

  private async capacityAvailable(
    client: CommerceSqlClient,
    tenantId: string,
    globalLimit: number,
    tenantLimit: number,
  ): Promise<boolean> {
    // Capacity is deliberately cross-user/cross-tenant. Temporarily enter the explicit
    // control-system RLS context for only these aggregate/locking queries, then restore the
    // identity context before any tenant data mutation continues in this transaction.
    await client.query("SELECT set_config('commerce.control_system', 'on', true)");
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('commerce-agent:global', 72451)
       )`,
    );
    const globalActive = await client.query<{ active_count: unknown }>(
      `SELECT COUNT(*)::integer AS active_count
       FROM commerce_agent_runs
       WHERE status = 'running'
         AND lease_expires_at >= clock_timestamp()`,
    );
    if (Number(globalActive.rows[0]?.active_count ?? globalLimit) >= globalLimit) {
      await client.query("SELECT set_config('commerce.control_system', 'off', true)");
      return false;
    }
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('commerce-agent:' || $1::text, 72451)
       )`,
      [tenantId],
    );
    const active = await client.query<{ active_count: unknown }>(
      `SELECT COUNT(*)::integer AS active_count
       FROM commerce_agent_runs
       WHERE tenant_id = $1 AND status = 'running'
         AND lease_expires_at >= clock_timestamp()`,
      [tenantId],
    );
    const available = Number(active.rows[0]?.active_count ?? tenantLimit) < tenantLimit;
    await client.query("SELECT set_config('commerce.control_system', 'off', true)");
    return available;
  }

  private async ownedConversation(
    client: CommerceSqlClient,
    identity: CommerceIdentity,
    conversationId: string,
  ): Promise<ConversationRow | null> {
    const result = await client.query<ConversationRow>(
      `SELECT id, title, model, created_at, updated_at
       FROM commerce_agent_conversations
       WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
      [conversationId, identity.tenantId, identity.userId],
    );
    return result.rows[0] ?? null;
  }

  async createConversationAndBeginTurn(input: {
    identity: CommerceIdentity;
    model: string;
    provider: string;
    userMessage: string;
    requestId: string;
    requestSha256: string;
    runId: string;
    rateLimit: number;
    tenantRateLimit: number;
    globalConcurrencyLimit: number;
    tenantConcurrencyLimit: number;
    leaseMs: number;
  }): Promise<BeginConversationTurnResult> {
    const requestSha256 = assertRequestSha256(input.requestSha256);
    const conversationId = `conv_${randomUUID()}`;
    const userMessageId = `msg_${randomUUID()}`;
    try {
      return await this.database.transaction(async (client) => {
        await client.query(
          `UPDATE commerce_agent_runs
           SET status = 'failed', error_code = 'RUN_LEASE_EXPIRED',
               error_message = 'The previous worker lease expired.', completed_at = NOW(),
               generation = generation + 1
           WHERE tenant_id = $1 AND user_id = $2
             AND status = 'running' AND lease_expires_at < clock_timestamp()`,
          [input.identity.tenantId, input.identity.userId],
        );
        const existing = await this.existingRequest(
          client,
          input.identity,
          input.requestId,
          requestSha256,
        );
        if (existing) {
          return {
            created: false,
            reason: 'existing',
            runId: existing.id,
            userMessageId,
            status: existing.status,
          };
        }
        const capacityAvailable = await this.capacityAvailable(
          client,
          input.identity.tenantId,
          input.globalConcurrencyLimit,
          input.tenantConcurrencyLimit,
        );
        if (!capacityAvailable) {
          return {
            created: false,
            reason: 'concurrency_limited',
            runId: input.runId,
            userMessageId,
          };
        }
        const allowed = await this.consumeRateLimitInTransaction(
          client,
          input.identity,
          input.rateLimit,
          input.tenantRateLimit,
        );
        if (!allowed) {
          return {
            created: false,
            reason: 'rate_limited',
            runId: input.runId,
            userMessageId,
          };
        }
        const conversationResult = await client.query<ConversationRow>(
          `INSERT INTO commerce_agent_conversations (id, tenant_id, user_id, title, model)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id, title, model, created_at, updated_at`,
          [
            conversationId,
            input.identity.tenantId,
            input.identity.userId,
            titleFromMessage(input.userMessage),
            input.model,
          ],
        );
        await client.query(
          `INSERT INTO commerce_agent_runs
             (id, conversation_id, tenant_id, user_id, request_id, request_sha256,
              model, provider, status, lease_expires_at, lease_owner, generation)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running',
                   clock_timestamp() + ($9::integer * INTERVAL '1 millisecond'), $10, 1)`,
          [
            input.runId,
            conversationId,
            input.identity.tenantId,
            input.identity.userId,
            input.requestId,
            requestSha256,
            input.model,
            input.provider,
            input.leaseMs,
            `attempt_${randomUUID()}`,
          ],
        );
        await client.query(
          `INSERT INTO commerce_agent_messages
             (id, conversation_id, tenant_id, user_id, role, content, run_id)
           VALUES ($1, $2, $3, $4, 'user', $5, $6)`,
          [
            userMessageId,
            conversationId,
            input.identity.tenantId,
            input.identity.userId,
            input.userMessage,
            input.runId,
          ],
        );
        return {
          created: true,
          runId: input.runId,
          userMessageId,
          generation: 1,
          conversation: summary(conversationResult.rows[0]),
        };
      });
    } catch (error) {
      if (postgresConstraint(error) === 'commerce_agent_runs_request_idx') {
        const existing = await this.existingRequest(
          this.database,
          input.identity,
          input.requestId,
          requestSha256,
        );
        if (existing) {
          return {
            created: false,
            reason: 'existing',
            runId: existing.id,
            userMessageId,
            status: existing.status,
          };
        }
      }
      if (postgresConstraint(error) === 'commerce_agent_one_active_user_turn_idx') {
        throw new CommerceConversationBusyError();
      }
      throw error;
    }
  }

  async retryFailedTurn(input: {
    identity: CommerceIdentity;
    requestId: string;
    requestSha256: string;
    globalConcurrencyLimit: number;
    tenantConcurrencyLimit: number;
    leaseMs: number;
  }): Promise<RetryFailedTurnResult | null> {
    const requestSha256 = assertRequestSha256(input.requestSha256);
    try {
      return await this.database.transaction(async (client) => {
        const existing = await this.existingRequest(
          client,
          input.identity,
          input.requestId,
          requestSha256,
        );
        // A completed run has nothing to retry. Anything else (failed, or running) is worth
        // attempting to reclaim: the UPDATE below is the single authoritative check — for a
        // 'running' row it only succeeds if the lease has actually expired, so a genuinely
        // still-in-flight run is correctly left untouched and this returns null for it too.
        if (!existing || existing.status === 'completed') return null;
        const available = await this.capacityAvailable(
          client,
          input.identity.tenantId,
          input.globalConcurrencyLimit,
          input.tenantConcurrencyLimit,
        );
        if (!available) throw new CommerceConversationBusyError();
        const reclaimed = await client.query<{ id: string; conversation_id: string; generation: number }>(
          `UPDATE commerce_agent_runs
           SET status = 'running', error_code = NULL, error_message = NULL,
               input_tokens = 0, output_tokens = 0, total_tokens = 0,
               started_at = NOW(), completed_at = NULL,
               lease_expires_at = clock_timestamp() + ($1::integer * INTERVAL '1 millisecond'),
               lease_owner = $7, generation = generation + 1
           WHERE id = $2 AND tenant_id = $3 AND user_id = $4
             AND request_id = $5 AND request_sha256 = $6
             AND (status = 'failed' OR (status = 'running' AND lease_expires_at < clock_timestamp()))
           RETURNING id, conversation_id, generation`,
          [
            input.leaseMs,
            existing.id,
            input.identity.tenantId,
            input.identity.userId,
            input.requestId,
            requestSha256,
            `attempt_${randomUUID()}`,
          ],
        );
        const row = reclaimed.rows[0];
        if (!row) return null;
        await client.query(
          `DELETE FROM commerce_agent_evidence
           WHERE run_id = $1 AND tenant_id = $2`,
          [row.id, input.identity.tenantId],
        );
        return { runId: row.id, conversationId: row.conversation_id, generation: row.generation };
      });
    } catch (error) {
      if (postgresConstraint(error) === 'commerce_agent_one_active_user_turn_idx') {
        throw new CommerceConversationBusyError();
      }
      throw error;
    }
  }

  async listConversations(
    identity: CommerceIdentity,
    limit = 30,
  ): Promise<CommerceConversationSummary[]> {
    const boundedLimit = Math.max(1, Math.min(100, limit));
    const result = await this.database.query<ConversationRow>(
      `SELECT id, title, model, created_at, updated_at
       FROM commerce_agent_conversations
       WHERE tenant_id = $1 AND user_id = $2
       ORDER BY updated_at DESC
       LIMIT $3`,
      [identity.tenantId, identity.userId, boundedLimit],
    );
    return result.rows.map(summary);
  }

  async getConversation(
    identity: CommerceIdentity,
    conversationId: string,
    historyLimit = 80,
  ): Promise<CommerceConversation | null> {
    const conversation = await this.ownedConversation(this.database, identity, conversationId);
    if (!conversation) return null;
    const boundedLimit = Math.max(2, Math.min(200, historyLimit));
    const messagesResult = await this.database.query<MessageRow>(
      `SELECT id, role, content, answer_json, run_id, run_status,
              run_error_code, run_error_message, report_available, created_at
       FROM (
         SELECT message.id, message.role, message.content, message.answer_json,
                message.run_id, run.status AS run_status,
                run.error_code AS run_error_code, run.error_message AS run_error_message,
                EXISTS (
                  SELECT 1
                  FROM commerce_agent_reports AS report
                  WHERE report.message_id = message.id
                    AND report.tenant_id = message.tenant_id
                    AND report.user_id = message.user_id
                ) AS report_available,
                message.created_at
         FROM commerce_agent_messages AS message
         LEFT JOIN commerce_agent_runs AS run
           ON run.id = message.run_id AND run.tenant_id = message.tenant_id
         WHERE message.conversation_id = $1
           AND message.tenant_id = $2 AND message.user_id = $3
         ORDER BY message.created_at DESC
         LIMIT $4
       ) recent
       ORDER BY created_at ASC`,
      [conversationId, identity.tenantId, identity.userId, boundedLimit],
    );
    const runIds = Array.from(new Set(
      messagesResult.rows.map((row) => row.run_id).filter((value): value is string => Boolean(value)),
    ));
    const messageIds = messagesResult.rows.map((row) => row.id);
    const [evidenceResult, actionResult] = await Promise.all([
      runIds.length ? this.database.query<EvidenceRow>(
          `SELECT id, run_id, operation, request_sha256, response_sha256, source_watermark, request_json,
                  row_count, preview_json, preview_truncated, fetched_at
           FROM commerce_agent_evidence
           WHERE tenant_id = $1 AND run_id = ANY($2::text[])
           ORDER BY created_at ASC`,
          [identity.tenantId, runIds],
        ) : Promise.resolve({ rows: [], rowCount: 0 }),
      messageIds.length ? this.database.query<ActionEventRow>(
        `SELECT DISTINCT ON (message_id, action_id)
                message_id, action_id, event_type, version, details_json, created_at
         FROM commerce_agent_action_events
         WHERE tenant_id = $1 AND user_id = $2 AND message_id = ANY($3::text[])
         ORDER BY message_id, action_id, version DESC`,
        [identity.tenantId, identity.userId, messageIds],
      ) : Promise.resolve({ rows: [], rowCount: 0 }),
    ]);
    const traces = tracesByRun(evidenceResult.rows);
    const actionStates = actionStatesByMessage(actionResult.rows);
    return {
      ...summary(conversation),
      messages: messagesResult.rows.map((row) => message(row, traces, actionStates)),
    };
  }

  async getModelHistory(
    identity: CommerceIdentity,
    conversationId: string,
    completedRunLimit = 12,
  ): Promise<CommerceConversationMessage[]> {
    const boundedLimit = Math.max(1, Math.min(40, completedRunLimit));
    const result = await this.database.query<MessageRow>(
      `WITH recent_completed_runs AS (
         SELECT id, completed_at, started_at
         FROM commerce_agent_runs
         WHERE conversation_id = $1 AND tenant_id = $2 AND user_id = $3
           AND status = 'completed'
           AND EXISTS (
             SELECT 1 FROM commerce_agent_messages AS user_message
             WHERE user_message.run_id = commerce_agent_runs.id
               AND user_message.conversation_id = $1
               AND user_message.tenant_id = $2 AND user_message.user_id = $3
               AND user_message.role = 'user'
           )
           AND EXISTS (
             SELECT 1 FROM commerce_agent_messages AS assistant_message
             WHERE assistant_message.run_id = commerce_agent_runs.id
               AND assistant_message.conversation_id = $1
               AND assistant_message.tenant_id = $2 AND assistant_message.user_id = $3
               AND assistant_message.role = 'assistant'
           )
         ORDER BY completed_at DESC NULLS LAST, started_at DESC, id DESC
         LIMIT $4
       )
       SELECT message.id, message.role, message.content, message.answer_json,
              message.run_id, 'completed'::text AS run_status,
              NULL::text AS run_error_code, NULL::text AS run_error_message,
              false AS report_available, message.created_at
       FROM recent_completed_runs AS recent
       JOIN commerce_agent_messages AS message
         ON message.run_id = recent.id
        AND message.conversation_id = $1
        AND message.tenant_id = $2
        AND message.user_id = $3
       ORDER BY recent.completed_at ASC NULLS FIRST,
                recent.started_at ASC, message.created_at ASC, message.id ASC`,
      [conversationId, identity.tenantId, identity.userId, boundedLimit],
    );
    return result.rows.map((row) => message(row, new Map()));
  }

  async beginTurn(input: {
    identity: CommerceIdentity;
    conversationId: string;
    requestId: string;
    model: string;
    provider: string;
    userMessage: string;
    requestSha256: string;
    rateLimit: number;
    tenantRateLimit: number;
    globalConcurrencyLimit: number;
    tenantConcurrencyLimit: number;
    leaseMs: number;
    runId?: string;
  }): Promise<BeginTurnResult> {
    const runId = input.runId ?? `run_${randomUUID()}`;
    const userMessageId = `msg_${randomUUID()}`;
    const requestSha256 = assertRequestSha256(input.requestSha256);
    try {
      return await this.database.transaction(async (client) => {
        const conversation = await this.ownedConversation(
          client,
          input.identity,
          input.conversationId,
        );
        if (!conversation) throw new Error('Commerce conversation was not found.');
        await client.query(
          `UPDATE commerce_agent_runs
           SET status = 'failed', error_code = 'RUN_LEASE_EXPIRED',
               error_message = 'The previous worker lease expired.', completed_at = NOW(),
               generation = generation + 1
           WHERE tenant_id = $1 AND user_id = $2
             AND status = 'running' AND lease_expires_at < clock_timestamp()`,
          [input.identity.tenantId, input.identity.userId],
        );
        const existingBeforeRate = await this.existingRequest(
          client,
          input.identity,
          input.requestId,
          requestSha256,
        );
        if (existingBeforeRate) {
          return {
            created: false,
            reason: 'existing',
            runId: existingBeforeRate.id,
            userMessageId,
            status: existingBeforeRate.status,
          };
        }
        const capacityAvailable = await this.capacityAvailable(
          client,
          input.identity.tenantId,
          input.globalConcurrencyLimit,
          input.tenantConcurrencyLimit,
        );
        if (!capacityAvailable) {
          return {
            created: false,
            reason: 'concurrency_limited',
            runId,
            userMessageId,
          };
        }
        const allowed = await this.consumeRateLimitInTransaction(
          client,
          input.identity,
          input.rateLimit,
          input.tenantRateLimit,
        );
        if (!allowed) {
          return {
            created: false,
            reason: 'rate_limited',
            runId,
            userMessageId,
          };
        }
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO commerce_agent_runs
             (id, conversation_id, tenant_id, user_id, request_id, request_sha256,
              model, provider, status, lease_expires_at, lease_owner, generation)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running',
                   clock_timestamp() + ($9::integer * INTERVAL '1 millisecond'), $10, 1)
           ON CONFLICT (tenant_id, user_id, request_id) DO NOTHING
           RETURNING id`,
          [
            runId,
            input.conversationId,
            input.identity.tenantId,
            input.identity.userId,
            input.requestId,
            requestSha256,
            input.model,
            input.provider,
            input.leaseMs,
            `attempt_${randomUUID()}`,
          ],
        );
        if (!inserted.rowCount) {
          const existing = await this.existingRequest(
            client,
            input.identity,
            input.requestId,
            requestSha256,
          );
          return {
            created: false,
            reason: 'existing',
            runId: existing?.id ?? runId,
            userMessageId,
            status: existing?.status ?? 'running',
          };
        }
        await client.query(
          `INSERT INTO commerce_agent_messages
             (id, conversation_id, tenant_id, user_id, role, content, run_id)
           VALUES ($1, $2, $3, $4, 'user', $5, $6)`,
          [
            userMessageId,
            input.conversationId,
            input.identity.tenantId,
            input.identity.userId,
            input.userMessage,
            runId,
          ],
        );
        await client.query(
          `UPDATE commerce_agent_conversations
           SET updated_at = NOW()
           WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
          [input.conversationId, input.identity.tenantId, input.identity.userId],
        );
        return { created: true, runId, userMessageId, generation: 1 };
      });
    } catch (error) {
      if (
        postgresConstraint(error) === 'commerce_agent_one_active_turn_idx'
        || postgresConstraint(error) === 'commerce_agent_one_active_user_turn_idx'
      ) {
        throw new CommerceConversationBusyError();
      }
      throw error;
    }
  }

  async completeTurn(input: CompleteTurnInput): Promise<void> {
    await this.database.transaction(async (client) => {
      const run = await client.query<{
        id: string;
        request_id: string;
        request_sha256: string;
        model: string;
        provider: string;
        started_at: unknown;
        completed_at: unknown;
      }>(
        `UPDATE commerce_agent_runs
         SET status = 'completed', input_tokens = $1, output_tokens = $2,
             total_tokens = $3, completed_at = NOW()
         WHERE id = $4 AND tenant_id = $5 AND user_id = $6 AND status = 'running'
           AND lease_expires_at >= clock_timestamp() AND generation = $7
         RETURNING id, request_id, request_sha256, model, provider, started_at, completed_at`,
        [
          input.usage.inputTokens,
          input.usage.outputTokens,
          input.usage.totalTokens,
          input.runId,
          input.identity.tenantId,
          input.identity.userId,
          input.generation,
        ],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new Error('Commerce run was not active or did not belong to the caller.');
      const source = await client.query<{
        title: string;
        question_id: string;
        question_content: string;
        question_created_at: unknown;
      }>(
        `SELECT conversation.title, question.id AS question_id,
                question.content AS question_content,
                question.created_at AS question_created_at
         FROM commerce_agent_conversations AS conversation
         JOIN commerce_agent_messages AS question
           ON question.conversation_id = conversation.id
          AND question.tenant_id = conversation.tenant_id
          AND question.user_id = conversation.user_id
          AND question.run_id = $2 AND question.role = 'user'
         WHERE conversation.id = $1 AND conversation.tenant_id = $3
           AND conversation.user_id = $4`,
        [input.conversationId, input.runId, input.identity.tenantId, input.identity.userId],
      );
      const sourceRow = source.rows[0];
      if (!sourceRow) throw new Error('Commerce report source message was not found.');
      const assistant = await client.query<{ created_at: unknown }>(
        `INSERT INTO commerce_agent_messages
           (id, conversation_id, tenant_id, user_id, role, content, answer_json, run_id)
         VALUES ($1, $2, $3, $4, 'assistant', $5, $6::jsonb, $7)
         RETURNING created_at`,
        [
          input.assistantMessageId,
          input.conversationId,
          input.identity.tenantId,
          input.identity.userId,
          input.answer.answer,
          JSON.stringify(input.answer),
          input.runId,
        ],
      );
      if (!assistant.rows[0]) throw new Error('Commerce assistant message was not persisted.');
      for (const trace of input.traces) {
        await client.query(
          `INSERT INTO commerce_agent_evidence
             (id, run_id, conversation_id, tenant_id, operation, request_sha256,
              response_sha256, source_watermark, request_json, row_count, preview_json,
              preview_truncated, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10,
                   $11::jsonb, $12, $13::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [
            trace.evidenceId,
            input.runId,
            input.conversationId,
            input.identity.tenantId,
            trace.operation,
            trace.requestSha256,
            trace.responseSha256,
            trace.sourceWatermark,
            JSON.stringify(trace.request),
            trace.rowCount,
            JSON.stringify(trace.preview),
            trace.previewTruncated === true,
            trace.fetchedAt,
          ],
        );
      }
      const completedAt = iso(runRow.completed_at);
      const report = buildReportArtifact({
        reportId: newCommerceReportId(),
        releaseRevision: process.env.COMMERCE_RELEASE_REVISION || 'unversioned',
        createdAt: completedAt,
        identity: input.identity,
        conversation: { id: input.conversationId, title: sourceRow.title },
        run: {
          id: input.runId,
          requestId: runRow.request_id,
          requestSha256: runRow.request_sha256,
          model: runRow.model,
          provider: runRow.provider,
          startedAt: iso(runRow.started_at),
          completedAt,
        },
        question: {
          messageId: sourceRow.question_id,
          content: sourceRow.question_content,
          createdAt: iso(sourceRow.question_created_at),
        },
        answer: {
          messageId: input.assistantMessageId,
          content: input.answer.answer,
          structured: input.answer,
          createdAt: iso(assistant.rows[0].created_at),
        },
        traces: input.traces.map((trace) => ({
          ...trace,
          previewTruncated: trace.previewTruncated !== false,
        })),
      });
      await insertReportArtifact(client, report);
      await client.query(
        `UPDATE commerce_agent_conversations
         SET updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [input.conversationId, input.identity.tenantId, input.identity.userId],
      );
    });
  }

  async appendEvidence(input: {
    identity: CommerceIdentity;
    conversationId: string;
    runId: string;
    generation: number;
    trace: CommerceToolTrace;
  }): Promise<void> {
    const trace = input.trace;
    const inserted = await this.database.query<{ id: string }>(
      `INSERT INTO commerce_agent_evidence
         (id, run_id, conversation_id, tenant_id, operation, request_sha256,
          response_sha256, source_watermark, request_json, row_count, preview_json,
          preview_truncated, fetched_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10,
              $11::jsonb, $12, $13::timestamptz
       FROM commerce_agent_runs
       WHERE id = $2 AND conversation_id = $3 AND tenant_id = $4
         AND user_id = $14 AND status = 'running'
         AND lease_expires_at >= clock_timestamp() AND generation = $15
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        trace.evidenceId,
        input.runId,
        input.conversationId,
        input.identity.tenantId,
        trace.operation,
        trace.requestSha256,
        trace.responseSha256,
        trace.sourceWatermark,
        JSON.stringify(trace.request),
        trace.rowCount,
        JSON.stringify(trace.preview),
        trace.previewTruncated === true,
        trace.fetchedAt,
        input.identity.userId,
        input.generation,
      ],
    );
    if (!inserted.rowCount) {
      throw new Error('Evidence could not be attached to the active Commerce run.');
    }
  }

  async renewRunLease(input: {
    identity: CommerceIdentity;
    runId: string;
    generation: number;
    leaseMs: number;
  }): Promise<boolean> {
    const renewed = await this.database.query<{ id: string }>(
      `UPDATE commerce_agent_runs
       SET lease_expires_at = clock_timestamp() + ($1::integer * INTERVAL '1 millisecond')
       WHERE id = $2 AND tenant_id = $3 AND user_id = $4 AND status = 'running'
         AND lease_expires_at >= clock_timestamp() AND generation = $5
       RETURNING id`,
      [input.leaseMs, input.runId, input.identity.tenantId, input.identity.userId, input.generation],
    );
    return renewed.rowCount === 1;
  }

  async failTurn(input: {
    identity: CommerceIdentity;
    runId: string;
    generation: number;
    code: string;
    message: string;
    usage?: MoAgentTokenUsage | null;
    traces?: CommerceToolTrace[];
  }): Promise<void> {
    await this.database.transaction(async (client) => {
      const usage = input.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      const failed = await client.query<{ conversation_id: string }>(
        `UPDATE commerce_agent_runs
         SET status = 'failed', error_code = $1, error_message = $2,
             input_tokens = $3, output_tokens = $4, total_tokens = $5,
             completed_at = NOW()
         WHERE id = $6 AND tenant_id = $7 AND user_id = $8 AND status = 'running'
           AND generation = $9
         RETURNING conversation_id`,
        [
          input.code,
          input.message.slice(0, 2_000),
          usage.inputTokens,
          usage.outputTokens,
          usage.totalTokens,
          input.runId,
          input.identity.tenantId,
          input.identity.userId,
          input.generation,
        ],
      );
      const conversationId = failed.rows[0]?.conversation_id;
      if (!conversationId) return;
      for (const trace of input.traces ?? []) {
        await client.query(
          `INSERT INTO commerce_agent_evidence
             (id, run_id, conversation_id, tenant_id, operation, request_sha256,
              response_sha256, source_watermark, request_json, row_count, preview_json,
              preview_truncated, fetched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::jsonb, $10,
                   $11::jsonb, $12, $13::timestamptz)
           ON CONFLICT (id) DO NOTHING`,
          [
            trace.evidenceId,
            input.runId,
            conversationId,
            input.identity.tenantId,
            trace.operation,
            trace.requestSha256,
            trace.responseSha256,
            trace.sourceWatermark,
            JSON.stringify(trace.request),
            trace.rowCount,
            JSON.stringify(trace.preview),
            trace.previewTruncated === true,
            trace.fetchedAt,
          ],
        );
      }
    });
  }

  async findRunMessages(
    identity: CommerceIdentity,
    requestId: string,
    requestSha256?: string,
  ): Promise<{
    conversation: CommerceConversationSummary;
    userMessage: CommerceConversationMessage;
    assistantMessage: CommerceConversationMessage;
    usage: MoAgentTokenUsage;
  } | null> {
    const runResult = await this.database.query<{
      id: string;
      conversation_id: string;
      status: string;
      input_tokens: unknown;
      output_tokens: unknown;
      total_tokens: unknown;
      request_sha256: string;
    }>(
      `SELECT id, conversation_id, status, input_tokens, output_tokens, total_tokens,
              request_sha256
       FROM commerce_agent_runs
       WHERE tenant_id = $1 AND user_id = $2 AND request_id = $3`,
      [identity.tenantId, identity.userId, requestId],
    );
    const run = runResult.rows[0];
    if (run && requestSha256 && run.request_sha256 !== assertRequestSha256(requestSha256)) {
      throw new CommerceIdempotencyConflictError();
    }
    if (!run || run.status !== 'completed') return null;
    const conversation = await this.ownedConversation(
      this.database,
      identity,
      run.conversation_id,
    );
    if (!conversation) return null;
    const [messagesResult, evidenceResult] = await Promise.all([
      this.database.query<MessageRow>(
        `SELECT message.id, message.role, message.content, message.answer_json,
                message.run_id, run.status AS run_status,
                run.error_code AS run_error_code, run.error_message AS run_error_message,
                EXISTS (
                  SELECT 1
                  FROM commerce_agent_reports AS report
                  WHERE report.message_id = message.id
                    AND report.tenant_id = message.tenant_id
                    AND report.user_id = message.user_id
                ) AS report_available,
                message.created_at
         FROM commerce_agent_messages AS message
         JOIN commerce_agent_runs AS run
           ON run.id = message.run_id AND run.tenant_id = message.tenant_id
         WHERE message.run_id = $1 AND message.conversation_id = $2
           AND message.tenant_id = $3 AND message.user_id = $4
         ORDER BY message.created_at ASC`,
        [run.id, run.conversation_id, identity.tenantId, identity.userId],
      ),
      this.database.query<EvidenceRow>(
        `SELECT id, run_id, operation, request_sha256, response_sha256, source_watermark, request_json,
                row_count, preview_json, preview_truncated, fetched_at
         FROM commerce_agent_evidence
         WHERE run_id = $1 AND conversation_id = $2 AND tenant_id = $3
         ORDER BY created_at ASC`,
        [run.id, run.conversation_id, identity.tenantId],
      ),
    ]);
    const traces = tracesByRun(evidenceResult.rows);
    const turnMessages = messagesResult.rows.map((row) => message(row, traces));
    const userMessage = turnMessages.find((entry) => entry.role === 'user');
    const assistantMessage = turnMessages.find((entry) => entry.role === 'assistant');
    if (!userMessage || !assistantMessage) return null;
    return {
      conversation: summary(conversation),
      userMessage,
      assistantMessage,
      usage: {
        inputTokens: Number(run.input_tokens),
        outputTokens: Number(run.output_tokens),
        totalTokens: Number(run.total_tokens),
      },
    };
  }
}

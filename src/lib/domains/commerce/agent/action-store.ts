import { createHash } from 'node:crypto';

import type { CommerceDatabase } from './database';
import { getCommerceControlDatabase, withCommerceControlIdentity } from './database';
import { canTransitionCommerceAction } from './action-orchestration';
import {
  commerceAgentAnswerSchema,
  commerceActionCommitmentSchema,
  commerceActionRecommendationSchema,
  commerceFiltersSchema,
  type CommerceActionCommitment,
  type CommerceActionListFilter,
  type CommerceActionListItem,
  type CommerceActionStatus,
  type CommerceActionState,
  type CommerceActionTransitionInput,
  type CommerceIdentity,
} from './types';

type SourceRow = Record<string, unknown> & {
  answer_json: unknown;
  run_id: string;
  describe_preview: unknown;
};

type EventRow = Record<string, unknown> & {
  event_type: 'confirmed' | 'ignored' | 'snoozed' | 'reminder_due' | 'started' | 'blocked' | 'resumed' | 'completed' | 'cancelled' | 'reopened' | 'reviewed';
  version: unknown;
  request_sha256: string;
  created_at: unknown;
  details_json: unknown;
};

type ListRow = Record<string, unknown> & {
  conversation_id: string;
  conversation_title: string;
  message_id: string;
  recommendation: unknown;
  action_status: CommerceActionState['status'];
  version: unknown;
  updated_at: unknown;
  proposed_at: unknown;
  baseline_request: unknown;
  action_details: unknown;
  last_review_run_id: string | null;
  last_review_message_id: string | null;
  last_reviewed_at: unknown;
};

export class CommerceActionNotFoundError extends Error {
  readonly code = 'COMMERCE_ACTION_NOT_FOUND';

  constructor() {
    super('行动卡不存在、回答尚未完成，或不属于当前用户。');
    this.name = 'CommerceActionNotFoundError';
  }
}

export class CommerceActionVersionConflictError extends Error {
  readonly code = 'COMMERCE_ACTION_VERSION_CONFLICT';

  constructor() {
    super('行动卡状态已更新，请刷新后重试。');
    this.name = 'CommerceActionVersionConflictError';
  }
}

export class CommerceActionInvalidTransitionError extends Error {
  readonly code = 'COMMERCE_ACTION_INVALID_TRANSITION';

  constructor(message = '当前行动卡状态不允许执行此操作。') {
    super(message);
    this.name = 'CommerceActionInvalidTransitionError';
  }
}

export class CommerceActionIdempotencyConflictError extends Error {
  readonly code = 'COMMERCE_ACTION_IDEMPOTENCY_CONFLICT';

  constructor() {
    super('相同 requestId 已用于不同的行动卡操作。');
    this.name = 'CommerceActionIdempotencyConflictError';
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function version(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('Database returned an invalid Action version.');
  }
  return parsed;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Database returned an invalid timestamp.');
  return date.toISOString();
}

function sourceFilters(value: unknown): CommerceActionListItem['sourceFilters'] {
  const request = parseJson(value);
  if (!request || typeof request !== 'object' || Array.isArray(request)) return null;
  const parsed = commerceFiltersSchema.safeParse((request as Record<string, unknown>).filters);
  return parsed.success ? parsed.data : null;
}

function actionDetails(value: unknown): {
  commitment: CommerceActionCommitment | null;
  note: string | null;
  reminder: NonNullable<CommerceActionState['reminder']>;
} {
  const parsed = parseJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { commitment: null, note: null, reminder: { status: 'none', snoozeUntil: null } };
  }
  const record = parsed as Record<string, unknown>;
  const commitment = commerceActionCommitmentSchema.safeParse(record.commitment);
  const note = typeof record.note === 'string' && record.note.trim().length > 0
    ? record.note.trim().slice(0, 1_000)
    : null;
  const reminderRecord = record.reminder && typeof record.reminder === 'object'
    && !Array.isArray(record.reminder)
    ? record.reminder as Record<string, unknown>
    : null;
  const reminderStatus = reminderRecord?.status;
  const reminder = {
    status: ['none', 'snoozed', 'due', 'cancelled'].includes(String(reminderStatus))
      ? reminderStatus as NonNullable<CommerceActionState['reminder']>['status']
      : 'none' as const,
    snoozeUntil: typeof reminderRecord?.snoozeUntil === 'string'
      ? reminderRecord.snoozeUntil
      : null,
  };
  return { commitment: commitment.success ? commitment.data : null, note, reminder };
}

function completionClock(describePreview: unknown): {
  completedAt: string;
  clockType: 'wall' | 'virtual';
  timezone: string;
} {
  const preview = parseJson(describePreview);
  const previewRecord = preview && typeof preview === 'object' && !Array.isArray(preview)
    ? preview as Record<string, unknown>
    : null;
  const coverage = previewRecord?.coverage && typeof previewRecord.coverage === 'object'
    && !Array.isArray(previewRecord.coverage)
    ? previewRecord.coverage as Record<string, unknown>
    : null;
  const timezone = typeof previewRecord?.timezone === 'string' && previewRecord.timezone.trim()
    ? previewRecord.timezone
    : 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  } catch {
    throw new CommerceActionInvalidTransitionError('诊断证据中的业务时区无效。');
  }
  if (coverage?.dataMode === 'snapshot') {
    const virtualAsOf = typeof coverage.virtualAsOf === 'string' ? coverage.virtualAsOf : '';
    if (!Number.isFinite(Date.parse(virtualAsOf))) {
      throw new CommerceActionInvalidTransitionError('历史快照缺少已冻结的虚拟时钟，不能完成行动。');
    }
    return {
      completedAt: new Date(virtualAsOf).toISOString(),
      clockType: 'virtual',
      timezone,
    };
  }
  return { completedAt: new Date().toISOString(), clockType: 'wall', timezone };
}

function statusFromEvent(eventType: EventRow['event_type']): CommerceActionStatus {
  if (eventType === 'confirmed') return 'confirmed';
  if (eventType === 'started' || eventType === 'resumed') return 'in_progress';
  if (eventType === 'blocked') return 'blocked';
  if (eventType === 'cancelled') return 'cancelled';
  if (eventType === 'ignored') return 'ignored';
  if (eventType === 'reopened') return 'reopened';
  if (eventType === 'reviewed') return 'reviewed';
  if (eventType === 'snoozed' || eventType === 'reminder_due') return 'proposed';
  return 'completed';
}

function state(actionId: string, row: EventRow): CommerceActionState {
  const details = actionDetails(row.details_json);
  return {
    actionId,
    status: statusFromEvent(row.event_type),
    version: version(row.version),
    updatedAt: iso(row.created_at),
    commitment: details.commitment,
    lastNote: details.note,
    reminder: details.reminder,
  };
}

function transitionEvent(input: CommerceActionTransitionInput['action']): EventRow['event_type'] {
  if (input === 'confirm') return 'confirmed';
  if (input === 'ignore') return 'ignored';
  if (input === 'snooze') return 'snoozed';
  if (input === 'start') return 'started';
  if (input === 'block') return 'blocked';
  if (input === 'resume') return 'resumed';
  if (input === 'complete') return 'completed';
  if (input === 'cancel') return 'cancelled';
  if (input === 'reopen') return 'reopened';
  return 'reviewed';
}

function transitionHash(input: {
  conversationId: string;
  messageId: string;
  actionId: string;
  action: CommerceActionTransitionInput['action'];
  expectedVersion: number;
  commitment?: CommerceActionTransitionInput['commitment'];
  note?: CommerceActionTransitionInput['note'];
  snoozeUntil?: CommerceActionTransitionInput['snoozeUntil'];
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    ...input,
    commitment: input.commitment ?? null,
    note: input.note ?? null,
    snoozeUntil: input.snoozeUntil ?? null,
  })).digest('hex')}`;
}

export class PostgresCommerceActionStore {
  constructor(private readonly database: CommerceDatabase) {}

  list(
    identity: CommerceIdentity,
    input: { status?: CommerceActionListFilter; limit?: number } = {},
  ): Promise<CommerceActionListItem[]> {
    const status = input.status ?? 'open';
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    return withCommerceControlIdentity(identity, async () => {
      const result = await this.database.query<ListRow>(
         `WITH latest_events AS (
           SELECT DISTINCT ON (message_id, action_id)
                  message_id, action_id, event_type, version, created_at, details_json
           FROM commerce_agent_action_events
           WHERE tenant_id = $1 AND user_id = $2
           ORDER BY message_id, action_id, version DESC
         ), latest_reviews AS (
           SELECT DISTINCT ON (source_message_id, action_id)
                  source_message_id, action_id, review_run_id, review_message_id, created_at
           FROM commerce_agent_action_reviews
           WHERE tenant_id = $1 AND user_id = $2
           ORDER BY source_message_id, action_id, created_at DESC, id DESC
         ), actions AS (
           SELECT conversation.id AS conversation_id,
                  conversation.title AS conversation_title,
                  message.id AS message_id,
                  recommendation.value AS recommendation,
                   CASE latest.event_type
                     WHEN 'confirmed' THEN 'confirmed'
                     WHEN 'ignored' THEN 'ignored'
                     WHEN 'snoozed' THEN 'proposed'
                     WHEN 'reminder_due' THEN 'proposed'
                     WHEN 'started' THEN 'in_progress'
                     WHEN 'resumed' THEN 'in_progress'
                     WHEN 'reopened' THEN 'reopened'
                     WHEN 'blocked' THEN 'blocked'
                     WHEN 'completed' THEN 'completed'
                     WHEN 'reviewed' THEN 'reviewed'
                     WHEN 'cancelled' THEN 'cancelled'
                     ELSE 'proposed'
                   END AS action_status,
                  COALESCE(latest.version, 0) AS version,
                  latest.created_at AS updated_at,
                  latest.details_json AS action_details,
                  review.review_run_id AS last_review_run_id,
                  review.review_message_id AS last_review_message_id,
                  review.created_at AS last_reviewed_at,
                  message.created_at AS proposed_at,
                  baseline_evidence.request_json AS baseline_request
           FROM commerce_agent_messages AS message
           JOIN commerce_agent_conversations AS conversation
             ON conversation.id = message.conversation_id
            AND conversation.tenant_id = message.tenant_id
            AND conversation.user_id = message.user_id
           JOIN commerce_agent_runs AS run
             ON run.id = message.run_id
            AND run.tenant_id = message.tenant_id
            AND run.user_id = message.user_id
            AND run.status = 'completed'
           CROSS JOIN LATERAL jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(message.answer_json->'recommendations') = 'array'
                 THEN message.answer_json->'recommendations'
               ELSE '[]'::jsonb
             END
           ) AS recommendation(value)
           LEFT JOIN latest_events AS latest
             ON latest.message_id = message.id
            AND latest.action_id = recommendation.value->>'id'
           LEFT JOIN latest_reviews AS review
             ON review.source_message_id = message.id
            AND review.action_id = recommendation.value->>'id'
           LEFT JOIN commerce_agent_evidence AS baseline_evidence
             ON baseline_evidence.id = recommendation.value #>> '{successMetric,baselineClaim,evidenceId}'
            AND baseline_evidence.run_id = message.run_id
            AND baseline_evidence.conversation_id = message.conversation_id
            AND baseline_evidence.tenant_id = message.tenant_id
           WHERE message.tenant_id = $1
             AND message.user_id = $2
             AND message.role = 'assistant'
             AND recommendation.value->>'id' ~ '^action_[a-f0-9]{24}$'
         )
         SELECT conversation_id, conversation_title, message_id, recommendation,
                action_status, version, updated_at, proposed_at, baseline_request, action_details,
                last_review_run_id, last_review_message_id, last_reviewed_at
         FROM actions
         WHERE ($3 = 'open' AND action_status NOT IN ('completed', 'reviewed', 'ignored', 'cancelled')) OR action_status = $3
         ORDER BY
           CASE action_status
             WHEN 'in_progress' THEN 0
             WHEN 'blocked' THEN 1
             WHEN 'confirmed' THEN 1
             WHEN 'proposed' THEN 2
             ELSE 3
           END,
           CASE recommendation->>'priority'
             WHEN 'high' THEN 0
             WHEN 'medium' THEN 1
             WHEN 'low' THEN 2
             ELSE 3
           END,
           COALESCE(
             NULLIF(action_details #>> '{commitment,dueDate}', ''),
             NULLIF(recommendation->>'deadline', '')
           ) ASC NULLS LAST,
           proposed_at DESC,
           recommendation->>'id'
         LIMIT $4`,
        [identity.tenantId, identity.userId, status, limit],
      );
      return result.rows.flatMap((row) => {
        const parsed = commerceActionRecommendationSchema.safeParse(parseJson(row.recommendation));
        if (!parsed.success || !parsed.data.id) return [];
        const details = actionDetails(row.action_details);
        const item: CommerceActionListItem = {
          conversationId: row.conversation_id,
          conversationTitle: row.conversation_title,
          messageId: row.message_id,
          actionId: parsed.data.id,
          action: parsed.data.action,
          rationale: parsed.data.rationale,
          priority: parsed.data.priority,
          ownerRole: parsed.data.ownerRole,
          deadline: parsed.data.deadline ?? null,
          successMetric: parsed.data.successMetric,
          guardrails: parsed.data.guardrails,
          sourceFilters: sourceFilters(row.baseline_request),
          lastReview: row.last_review_run_id && row.last_review_message_id && row.last_reviewed_at
            ? {
                runId: row.last_review_run_id,
                messageId: row.last_review_message_id,
                createdAt: iso(row.last_reviewed_at),
              }
            : null,
          commitment: details.commitment,
          lastNote: details.note,
          reminder: details.reminder,
          status: row.action_status,
          version: Number(row.version) === 0 ? 0 : version(row.version),
          updatedAt: row.updated_at == null ? null : iso(row.updated_at),
          proposedAt: iso(row.proposed_at),
        };
        return [item];
      });
    });
  }

  transition(
    identity: CommerceIdentity,
    input: CommerceActionTransitionInput & {
      conversationId: string;
      messageId: string;
      actionId: string;
    },
  ): Promise<CommerceActionState> {
    return withCommerceControlIdentity(identity, () => this.database.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`commerce-action-request:${identity.tenantId}:${identity.userId}:${input.requestId}`],
      );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`commerce-action:${identity.tenantId}:${identity.userId}:${input.messageId}:${input.actionId}`],
      );
      const source = await client.query<SourceRow>(
        `SELECT message.answer_json, message.run_id, describe.preview_json AS describe_preview
         FROM commerce_agent_messages AS message
         JOIN commerce_agent_runs AS run
           ON run.id = message.run_id AND run.tenant_id = message.tenant_id
         LEFT JOIN LATERAL (
           SELECT evidence.preview_json
           FROM commerce_agent_evidence AS evidence
           WHERE evidence.run_id = message.run_id
             AND evidence.tenant_id = message.tenant_id
             AND evidence.operation = 'commerce.describe_data'
           ORDER BY evidence.fetched_at DESC, evidence.id DESC
           LIMIT 1
         ) AS describe ON TRUE
         WHERE message.id = $1 AND message.conversation_id = $2
           AND message.tenant_id = $3 AND message.user_id = $4
           AND message.role = 'assistant' AND run.status = 'completed'`,
        [input.messageId, input.conversationId, identity.tenantId, identity.userId],
      );
      const parsed = commerceAgentAnswerSchema.safeParse(parseJson(source.rows[0]?.answer_json));
      if (
        !source.rows[0]
        || !parsed.success
        || !parsed.data.recommendations.some((recommendation) => recommendation.id === input.actionId)
      ) {
        throw new CommerceActionNotFoundError();
      }
      const requestSha256 = transitionHash(input);
      const replay = await client.query<EventRow>(
        `SELECT event_type, version, request_sha256, created_at, details_json
         FROM commerce_agent_action_events
         WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3`,
        [identity.tenantId, identity.userId, input.requestId],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_sha256 !== requestSha256) {
          throw new CommerceActionIdempotencyConflictError();
        }
        return state(input.actionId, replay.rows[0]);
      }
      const latest = await client.query<EventRow>(
        `SELECT event_type, version, request_sha256, created_at, details_json
         FROM commerce_agent_action_events
         WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3 AND action_id = $4
         ORDER BY version DESC LIMIT 1`,
        [identity.tenantId, identity.userId, input.messageId, input.actionId],
      );
      const currentVersion = latest.rows[0] ? version(latest.rows[0].version) : 0;
      if (currentVersion !== input.expectedVersion) throw new CommerceActionVersionConflictError();
      const currentStatus: CommerceActionStatus = latest.rowCount
        ? statusFromEvent(latest.rows[0].event_type)
        : 'proposed';
      const eventType = transitionEvent(input.action);
      if (!canTransitionCommerceAction(currentStatus, input.action)) {
        throw new CommerceActionInvalidTransitionError();
      }
      const currentDetails = latest.rows[0]
        ? actionDetails(latest.rows[0].details_json)
        : { commitment: null, note: null, reminder: { status: 'none' as const, snoozeUntil: null } };
      const commitment = input.commitment ?? currentDetails.commitment;
      if (['started', 'resumed', 'reopened'].includes(eventType) && !commitment) {
        throw new CommerceActionInvalidTransitionError('开始执行前必须补充负责人和截止日。');
      }
      if (eventType === 'snoozed' && Date.parse(input.snoozeUntil ?? '') <= Date.now()) {
        throw new CommerceActionInvalidTransitionError('稍后提醒时间必须晚于当前时间。');
      }
      const reminder = eventType === 'snoozed'
        ? { status: 'snoozed' as const, snoozeUntil: input.snoozeUntil! }
        : ['confirmed', 'ignored', 'cancelled'].includes(eventType)
          ? { status: 'cancelled' as const, snoozeUntil: null }
          : currentDetails.reminder;
      const completion = eventType === 'completed'
        ? completionClock(source.rows[0].describe_preview)
        : null;
      const inserted = await client.query<EventRow>(
        `INSERT INTO commerce_agent_action_events
           (tenant_id, user_id, conversation_id, message_id, run_id, action_id,
            event_type, version, actor_user_id, actor_display_name,
            idempotency_key, request_sha256, details_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $2, $9, $10, $11, $12::jsonb)
         RETURNING event_type, version, request_sha256, created_at, details_json`,
        [
          identity.tenantId,
          identity.userId,
          input.conversationId,
          input.messageId,
          source.rows[0].run_id,
          input.actionId,
          eventType,
          currentVersion + 1,
          identity.displayName,
          input.requestId,
          requestSha256,
          JSON.stringify({
            commitment,
            note: input.note ?? currentDetails.note,
            reminder,
            ...(completion ? { completion } : {}),
          }),
        ],
      );
      return state(input.actionId, inserted.rows[0]);
    }));
  }
}

let singleton: PostgresCommerceActionStore | null = null;

export function getCommerceActionStore(): PostgresCommerceActionStore {
  if (!singleton || process.env.NODE_ENV === 'test') {
    singleton = new PostgresCommerceActionStore(getCommerceControlDatabase());
  }
  return singleton;
}

import { createHash, randomUUID } from 'node:crypto';

import type { CommerceDatabase } from './database';
import { getCommerceControlDatabase, withCommerceControlIdentity } from './database';
import {
  commerceActionReviewPlanSchema,
  commerceAgentAnswerSchema,
  type CommerceActionReviewPlan,
  type CommerceActionReviewReceipt,
  type CommerceActionReviewSubmission,
  type CommerceIdentity,
} from './types';

type SourceRow = Record<string, unknown> & {
  answer_json: unknown;
  run_id: string;
};

type ReviewTargetRow = Record<string, unknown> & {
  id: string;
  run_id: string;
};

type LatestActionRow = Record<string, unknown> & {
  event_type: string;
  version: unknown;
  details_json: unknown;
};

type ExistingReviewRow = Record<string, unknown> & {
  id: string;
  conversation_id: string;
  source_message_id: string;
  action_id: string;
  review_run_id: string;
  review_message_id: string;
  request_id: string;
  request_sha256: string;
  question: string;
  plan_json: unknown;
  created_at: unknown;
};

export class CommerceActionReviewTargetNotFoundError extends Error {
  readonly code = 'COMMERCE_ACTION_REVIEW_TARGET_NOT_FOUND';

  constructor() {
    super('行动或复盘回答不存在、尚未完成，或不属于当前用户。');
    this.name = 'CommerceActionReviewTargetNotFoundError';
  }
}

export class CommerceActionReviewInvalidError extends Error {
  readonly code = 'COMMERCE_ACTION_REVIEW_INVALID';

  constructor(message = '只有已完成行动可以记录效果复盘。') {
    super(message);
    this.name = 'CommerceActionReviewInvalidError';
  }
}

export class CommerceActionReviewIdempotencyConflictError extends Error {
  readonly code = 'COMMERCE_ACTION_REVIEW_IDEMPOTENCY_CONFLICT';

  constructor() {
    super('相同复盘 requestId 已用于不同内容。');
    this.name = 'CommerceActionReviewIdempotencyConflictError';
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

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Database returned an invalid timestamp.');
  return date.toISOString();
}

function reviewPlan(value: unknown): CommerceActionReviewPlan {
  const parsed = commerceActionReviewPlanSchema.safeParse(parseJson(value));
  if (!parsed.success) throw new Error('Database returned an invalid Action review plan.');
  return parsed.data;
}

function receipt(row: ExistingReviewRow): CommerceActionReviewReceipt {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sourceMessageId: row.source_message_id,
    actionId: row.action_id,
    runId: row.review_run_id,
    reviewMessageId: row.review_message_id,
    requestId: row.request_id,
    question: row.question,
    plan: reviewPlan(row.plan_json),
    createdAt: iso(row.created_at),
  };
}

function requestHash(input: {
  conversationId: string;
  sourceMessageId: string;
  actionId: string;
  submission: CommerceActionReviewSubmission;
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

const REVIEW_COLUMNS = `id, conversation_id, source_message_id, action_id,
  review_run_id, review_message_id, request_id, request_sha256, question, plan_json, created_at`;

export class PostgresCommerceActionReviewStore {
  constructor(private readonly database: CommerceDatabase) {}

  async recordCompletedReview(input: {
    identity: CommerceIdentity;
    conversationId: string;
    sourceMessageId: string;
    actionId: string;
    submission: CommerceActionReviewSubmission;
  }): Promise<CommerceActionReviewReceipt> {
    const hash = requestHash({
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      actionId: input.actionId,
      submission: input.submission,
    });
    return withCommerceControlIdentity(input.identity, () => this.database.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`commerce-action-review-request:${input.identity.tenantId}:${input.identity.userId}:${input.submission.requestId}`],
      );
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`commerce-action:${input.identity.tenantId}:${input.identity.userId}:${input.sourceMessageId}:${input.actionId}`],
      );
      const existing = await client.query<ExistingReviewRow>(
        `SELECT ${REVIEW_COLUMNS}
         FROM commerce_agent_action_reviews
         WHERE tenant_id = $1 AND user_id = $2 AND request_id = $3`,
        [input.identity.tenantId, input.identity.userId, input.submission.requestId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].request_sha256 !== hash) {
          throw new CommerceActionReviewIdempotencyConflictError();
        }
        return receipt(existing.rows[0]);
      }

      const source = await client.query<SourceRow>(
        `SELECT message.answer_json, message.run_id
         FROM commerce_agent_messages AS message
         JOIN commerce_agent_runs AS run
           ON run.id = message.run_id AND run.tenant_id = message.tenant_id
         WHERE message.id = $1 AND message.conversation_id = $2
           AND message.tenant_id = $3 AND message.user_id = $4
           AND message.role = 'assistant' AND run.status = 'completed'`,
        [input.sourceMessageId, input.conversationId, input.identity.tenantId, input.identity.userId],
      );
      const answer = commerceAgentAnswerSchema.safeParse(parseJson(source.rows[0]?.answer_json));
      if (
        !source.rows[0]
        || !answer.success
        || !answer.data.recommendations.some((candidate) => candidate.id === input.actionId)
      ) {
        throw new CommerceActionReviewTargetNotFoundError();
      }

      const latestAction = await client.query<LatestActionRow>(
        `SELECT event_type, version, details_json
         FROM commerce_agent_action_events
         WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3 AND action_id = $4
         ORDER BY version DESC LIMIT 1
         FOR UPDATE`,
        [input.identity.tenantId, input.identity.userId, input.sourceMessageId, input.actionId],
      );
      if (latestAction.rows[0]?.event_type !== 'completed') {
        throw new CommerceActionReviewInvalidError();
      }

      const target = await client.query<ReviewTargetRow>(
        `SELECT message.id, message.run_id
         FROM commerce_agent_messages AS message
         JOIN commerce_agent_runs AS run
           ON run.id = message.run_id AND run.tenant_id = message.tenant_id
         WHERE message.id = $1 AND message.run_id = $2
           AND message.conversation_id = $3 AND message.tenant_id = $4
           AND message.user_id = $5 AND message.role = 'assistant'
           AND run.status = 'completed'`,
        [
          input.submission.reviewMessageId,
          input.submission.runId,
          input.conversationId,
          input.identity.tenantId,
          input.identity.userId,
        ],
      );
      if (!target.rows[0]) throw new CommerceActionReviewTargetNotFoundError();

      const inserted = await client.query<ExistingReviewRow>(
        `INSERT INTO commerce_agent_action_reviews
           (id, tenant_id, user_id, conversation_id, source_message_id, action_id,
            source_run_id, review_run_id, review_message_id, request_id, request_sha256,
            question, plan_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
         RETURNING ${REVIEW_COLUMNS}`,
        [
          `review_${randomUUID()}`,
          input.identity.tenantId,
          input.identity.userId,
          input.conversationId,
          input.sourceMessageId,
          input.actionId,
          source.rows[0].run_id,
          input.submission.runId,
          input.submission.reviewMessageId,
          input.submission.requestId,
          hash,
          input.submission.question,
          JSON.stringify(input.submission.plan),
        ],
      );
      if (!inserted.rows[0]) throw new Error('Action review receipt was not persisted.');
      const currentVersion = Number(latestAction.rows[0].version);
      if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
        throw new Error('Database returned an invalid completed Action version.');
      }
      const previousDetails = parseJson(latestAction.rows[0].details_json);
      const details = previousDetails && typeof previousDetails === 'object'
        && !Array.isArray(previousDetails)
        ? previousDetails as Record<string, unknown>
        : {};
      const reviewEvent = {
        receiptId: inserted.rows[0].id,
        runId: input.submission.runId,
        messageId: input.submission.reviewMessageId,
      };
      const reviewEventSha256 = `sha256:${createHash('sha256').update(
        JSON.stringify(reviewEvent),
      ).digest('hex')}`;
      await client.query(
        `INSERT INTO commerce_agent_action_events
           (tenant_id, user_id, conversation_id, message_id, run_id, action_id,
            event_type, version, actor_user_id, actor_display_name,
            idempotency_key, request_sha256, details_json)
         VALUES ($1, $2, $3, $4, $5, $6, 'reviewed', $7, $2, $8, $9, $10, $11::jsonb)`,
        [
          input.identity.tenantId,
          input.identity.userId,
          input.conversationId,
          input.sourceMessageId,
          source.rows[0].run_id,
          input.actionId,
          currentVersion + 1,
          input.identity.displayName,
          `manual-reviewed:${inserted.rows[0].id}`,
          reviewEventSha256,
          JSON.stringify({ ...details, review: reviewEvent }),
        ],
      );
      return receipt(inserted.rows[0]);
    }));
  }
}

let singleton: PostgresCommerceActionReviewStore | null = null;

export function getCommerceActionReviewStore(): PostgresCommerceActionReviewStore {
  if (!singleton || process.env.NODE_ENV === 'test') {
    singleton = new PostgresCommerceActionReviewStore(getCommerceControlDatabase());
  }
  return singleton;
}

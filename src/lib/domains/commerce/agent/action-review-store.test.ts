import { describe, expect, it } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import {
  CommerceActionReviewInvalidError,
  PostgresCommerceActionReviewStore,
} from './action-review-store';
import type { CommerceActionReviewSubmission, CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_review',
  userId: 'operator_review',
  displayName: 'Review operator',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};
const conversationId = 'conv_1234567890123456';
const sourceMessageId = 'msg_1234567890123456';
const actionId = `action_${'a'.repeat(24)}`;
const submission: CommerceActionReviewSubmission = {
  runId: 'run_1234567890123456',
  reviewMessageId: 'msg_abcdefghijklmnop',
  question: '复盘行动效果。',
  plan: {
    status: 'ready',
    message: '复盘窗口与数据覆盖完整。',
    question: '复盘行动效果。',
    current: { start: '2026-08-02', end: '2026-08-08' },
    baseline: { start: '2026-07-25', end: '2026-07-31' },
    reviewEnd: '2026-08-08',
    unavailableGuardrails: [],
  },
  requestId: 'review:req-1001',
};
const answer = {
  status: 'answered' as const,
  answer: '经营结论。',
  answerClaims: [],
  findings: [],
  recommendations: [{
    id: actionId,
    action: '调整投放',
    rationale: '提升转化。',
    claims: [],
    status: 'proposed' as const,
  }],
  followUps: [],
};

function result(rows: Record<string, unknown>[] = []): CommerceQueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length };
}

class ScriptedDatabase implements CommerceDatabase {
  constructor(private readonly execute: (
    text: string,
    values: readonly unknown[],
  ) => CommerceQueryResult<Record<string, unknown>>) {}

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    return Promise.resolve(this.execute(text, values) as CommerceQueryResult<Row>);
  }

  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> { return work(this); }
  async ping(): Promise<void> {}
}

describe('completed Action review receipts', () => {
  it('persists an immutable Action-to-review Run association', async () => {
    let reviewedEventInserted = false;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_action_reviews')) return result();
      if (text.includes('SELECT message.answer_json')) {
        return result([{ answer_json: answer, run_id: 'run_source_12345678' }]);
      }
      if (text.includes('FROM commerce_agent_action_events')) {
        return result([{
          event_type: 'completed',
          version: 5,
          details_json: { commitment: null, reminder: { status: 'none', snoozeUntil: null } },
        }]);
      }
      if (text.includes('SELECT message.id, message.run_id')) {
        return result([{ id: submission.reviewMessageId, run_id: submission.runId }]);
      }
      if (text.includes('INSERT INTO commerce_agent_action_reviews')) {
        expect(values.slice(1, 13)).toEqual([
          identity.tenantId,
          identity.userId,
          conversationId,
          sourceMessageId,
          actionId,
          'run_source_12345678',
          submission.runId,
          submission.reviewMessageId,
          submission.requestId,
          expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
          submission.question,
          JSON.stringify(submission.plan),
        ]);
        return result([{
          id: 'review_1234567890123456',
          conversation_id: conversationId,
          source_message_id: sourceMessageId,
          action_id: actionId,
          review_run_id: submission.runId,
          review_message_id: submission.reviewMessageId,
          request_id: submission.requestId,
          request_sha256: values[10],
          question: submission.question,
          plan_json: submission.plan,
          created_at: new Date('2026-08-13T08:00:00.000Z'),
        }]);
      }
      if (text.includes('INSERT INTO commerce_agent_action_events')) {
        reviewedEventInserted = true;
        expect(values.slice(0, 10)).toEqual([
          identity.tenantId,
          identity.userId,
          conversationId,
          sourceMessageId,
          'run_source_12345678',
          actionId,
          6,
          identity.displayName,
          'manual-reviewed:review_1234567890123456',
          expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
        ]);
        expect(JSON.parse(String(values[10]))).toMatchObject({
          review: {
            receiptId: 'review_1234567890123456',
            runId: submission.runId,
            messageId: submission.reviewMessageId,
          },
        });
        return result();
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(new PostgresCommerceActionReviewStore(database).recordCompletedReview({
      identity,
      conversationId,
      sourceMessageId,
      actionId,
      submission,
    })).resolves.toEqual({
      id: 'review_1234567890123456',
      conversationId,
      sourceMessageId,
      actionId,
      runId: submission.runId,
      reviewMessageId: submission.reviewMessageId,
      requestId: submission.requestId,
      question: submission.question,
      plan: submission.plan,
      createdAt: '2026-08-13T08:00:00.000Z',
    });
    expect(reviewedEventInserted).toBe(true);
  });

  it('rejects a review when the Action is no longer completed', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_action_reviews')) return result();
      if (text.includes('SELECT message.answer_json')) {
        return result([{ answer_json: answer, run_id: 'run_source_12345678' }]);
      }
      if (text.includes('FROM commerce_agent_action_events')) {
        return result([{ event_type: 'reopened', version: 6, details_json: {} }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(new PostgresCommerceActionReviewStore(database).recordCompletedReview({
      identity,
      conversationId,
      sourceMessageId,
      actionId,
      submission,
    })).rejects.toBeInstanceOf(CommerceActionReviewInvalidError);
  });
});

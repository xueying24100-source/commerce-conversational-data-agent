import { describe, expect, it } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import {
  CommerceFeedbackClaimNotFoundError,
  CommerceFeedbackIdempotencyConflictError,
  CommerceFeedbackInvalidTransitionError,
  CommerceFeedbackTargetNotFoundError,
  CommerceFeedbackVersionConflictError,
  PostgresCommerceFeedbackStore,
} from './feedback-store';
import type { CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_feedback',
  userId: 'operator_feedback',
  displayName: 'Feedback operator',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};

const reviewer: CommerceIdentity = {
  tenantId: 'tenant_feedback',
  userId: 'reviewer_feedback',
  displayName: 'Feedback reviewer',
  scopes: ['commerce:data:read', 'commerce:feedback:review'],
  authMode: 'trusted_proxy',
};

const answer = {
  status: 'answered' as const,
  answer: 'GMV 是 100 元。',
  answerClaims: [{
    evidenceId: 'evidence_1', path: '/totals/gmv', metric: 'gmv' as const,
    value: 100, unit: 'currency' as const,
  }],
  findings: [], recommendations: [], followUps: [],
};

function result(rows: Record<string, unknown>[] = []): CommerceQueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length };
}

class ScriptedDatabase implements CommerceDatabase {
  readonly calls: Array<{
    text: string;
    values: readonly unknown[];
    transactionDepth: number;
  }> = [];
  transactionCount = 0;
  private transactionDepth = 0;

  constructor(private readonly execute: (text: string, values: readonly unknown[]) => CommerceQueryResult<Record<string, unknown>>) {}
  query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []): Promise<CommerceQueryResult<Row>> {
    this.calls.push({ text, values, transactionDepth: this.transactionDepth });
    return Promise.resolve(this.execute(text, values) as CommerceQueryResult<Row>);
  }
  async transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.transactionDepth += 1;
    try {
      return await work(this);
    } finally {
      this.transactionDepth -= 1;
    }
  }
  async ping(): Promise<void> {}
}

function insertedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'feedback_1', conversation_id: 'conv_1234567890123456',
    message_id: 'msg_assistant_1', run_id: 'run_00000001', evidence_id: 'evidence_1',
    claim_path: '/totals/gmv', category: 'wrong_metric', comment: '指标含义不对',
    status: 'received', request_sha256: `sha256:${'a'.repeat(64)}`,
    created_at: new Date('2026-08-13T00:00:00.000Z'), ...overrides,
  };
}

describe('Commerce feedback store', () => {
  it('derives ownership from a completed assistant message and validates its claim evidence', async () => {
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('SELECT message.answer_json')) {
        expect(values).toEqual(['msg_assistant_1', 'run_00000001', 'conv_1234567890123456', identity.tenantId, identity.userId]);
        expect(text).toContain("message.role = 'assistant'");
        expect(text).toContain("run.status = 'completed'");
        return result([{ answer_json: answer }]);
      }
      if (text.includes('INSERT INTO commerce_agent_feedback')) {
        expect(text).toContain('ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING');
        expect(text).toContain('evidence.run_id = $6');
        expect(text).toContain('evidence.conversation_id = $4');
        expect(values.slice(1, 10)).toEqual([
          identity.tenantId, identity.userId, 'conv_1234567890123456', 'msg_assistant_1',
          'run_00000001', 'evidence_1', '/totals/gmv', 'wrong_metric', '指标含义不对',
        ]);
        return result([insertedRow()]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeedbackStore(database);

    await expect(store.submit(identity, 'conv_1234567890123456', {
      messageId: 'msg_assistant_1', runId: 'run_00000001', evidenceId: 'evidence_1',
      claimPath: '/totals/gmv', category: 'wrong_metric', comment: '指标含义不对',
      requestId: 'feedback:req-0001',
    })).resolves.toMatchObject({ id: 'feedback_1', status: 'received', evidenceId: 'evidence_1' });
  });

  it('fails closed for a message outside the authenticated owner scope', async () => {
    const database = new ScriptedDatabase(() => result());
    const store = new PostgresCommerceFeedbackStore(database);
    await expect(store.submit(identity, 'conv_1234567890123456', {
      messageId: 'msg_other_user', runId: 'run_other_user', category: 'data_issue',
      requestId: 'feedback:req-0002',
    })).rejects.toBeInstanceOf(CommerceFeedbackTargetNotFoundError);
    expect(database.calls.some((call) => call.text.includes('INSERT INTO commerce_agent_feedback'))).toBe(false);
  });

  it('rejects a claim path that was not present in the persisted answer', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('SELECT message.answer_json')) return result([{ answer_json: answer }]);
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeedbackStore(database);
    await expect(store.submit(identity, 'conv_1234567890123456', {
      messageId: 'msg_assistant_1', runId: 'run_00000001', evidenceId: 'evidence_1',
      claimPath: '/totals/net_revenue', category: 'wrong_metric', requestId: 'feedback:req-0003',
    })).rejects.toBeInstanceOf(CommerceFeedbackClaimNotFoundError);
  });

  it('replays an identical request but rejects idempotency-key payload drift', async () => {
    const baseInput = { messageId: 'msg_assistant_1', runId: 'run_00000001', category: 'other' as const, requestId: 'feedback:req-0004' };
    let storedHash: string | null = null;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('SELECT message.answer_json')) return result([{ answer_json: answer }]);
      if (text.includes('INSERT INTO commerce_agent_feedback')) {
        if (!storedHash) {
          storedHash = String(values[11]);
          return result([insertedRow({ evidence_id: null, claim_path: null, category: 'other', comment: null, request_sha256: storedHash })]);
        }
        return result();
      }
      if (text.includes('FROM commerce_agent_feedback')) return result([insertedRow({
        evidence_id: null, claim_path: null, category: 'other', comment: null, request_sha256: storedHash,
      })]);
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeedbackStore(database);
    const first = await store.submit(identity, 'conv_1234567890123456', baseInput);
    await expect(store.submit(identity, 'conv_1234567890123456', baseInput)).resolves.toEqual(first);
    await expect(store.submit(identity, 'conv_1234567890123456', { ...baseInput, comment: '不同内容' }))
      .rejects.toBeInstanceOf(CommerceFeedbackIdempotencyConflictError);
  });

  it('lists a tenant-wide review queue with projected state and bounded pagination', async () => {
    const database = new ScriptedDatabase((text, values) => {
      expect(text).toContain('FROM commerce_agent_feedback AS feedback');
      expect(text).toContain("COALESCE(latest.event_type, 'received')");
      expect(values).toEqual([reviewer.tenantId, 'reviewed', null, null, null, 3]);
      return result([{...insertedRow(), user_id: 'operator_other', status: 'reviewed', version: 1,
        question: 'GMV 如何？', answer: 'GMV 是 100 元。', updated_at: new Date('2026-08-13T00:01:00.000Z') }]);
    });
    const store = new PostgresCommerceFeedbackStore(database);

    await expect(store.listForReview(reviewer, { status: 'reviewed', limit: 2 }))
      .resolves.toEqual(expect.objectContaining({
        nextCursor: null,
        items: [expect.objectContaining({ userId: 'operator_other', status: 'reviewed', version: 1 })],
      }));
  });

  it('refuses tenant-wide review access when the store is called without reviewer scope', async () => {
    const database = new ScriptedDatabase(() => result());
    const store = new PostgresCommerceFeedbackStore(database);
    await expect(store.listForReview(identity)).rejects.toMatchObject({
      code: 'COMMERCE_SCOPE_REQUIRED', status: 403,
    });
    expect(database.calls).toHaveLength(0);
  });

  it('appends a legal versioned review event and never updates the original feedback', async () => {
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{ locked: true }]);
      if (text.includes('actor_user_id = $2')) return result();
      if (text.includes('COALESCE(latest.event_type')) {
        return result([{ id: 'feedback_1', status: 'received', version: 0 }]);
      }
      if (text.includes('INSERT INTO commerce_agent_feedback_events')) {
        expect(values.slice(0, 8)).toEqual([
          'feedback_1', reviewer.tenantId, reviewer.userId, reviewer.displayName,
          'reviewed', 1, '已核查来源', 'feedback-review:req-0001',
        ]);
        return result([{ id: 1, version: 1, event_type: 'reviewed', note: '已核查来源',
          actor_user_id: reviewer.userId, actor_display_name: reviewer.displayName,
          job_id: null, run_id: null, request_sha256: values[8],
          created_at: new Date('2026-08-13T00:02:00.000Z') }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeedbackStore(database);

    await expect(store.appendReviewEvent(reviewer, 'feedback_1', {
      action: 'review', note: '已核查来源', requestId: 'feedback-review:req-0001', expectedVersion: 0,
    })).resolves.toMatchObject({ type: 'reviewed', status: 'reviewed', version: 1 });
    expect(database.calls.some((call) => /UPDATE\s+commerce_agent_feedback/u.test(call.text))).toBe(false);
  });

  it('atomically enqueues a correction from persisted source data and replays the same Job', async () => {
    let storedEvent: Record<string, unknown> | null = null;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{ locked: true }]);
      if (text.includes('actor_user_id = $2')) return storedEvent ? result([storedEvent]) : result();
      if (text.includes('COALESCE(latest.event_type')) {
        return result([{ id: 'feedback_1', status: 'reviewed', version: 1 }]);
      }
      if (text.includes('run.request_id AS run_request_id')) {
        return result([{
          user_id: identity.userId,
          conversation_id: 'conv_1234567890123456',
          run_id: 'run_00000001',
          run_request_id: 'original-run:req-0001',
          model: 'deepseek-v4-flash',
          question: '数据库中保存的原问题：最近一周 GMV 为什么下降？',
          evidence_id: 'evidence_1',
          claim_path: '/totals/gmv',
          category: 'wrong_metric',
          comment: '数据库中保存的反馈：GMV 口径不正确',
        }]);
      }
      if (text.includes("set_config('commerce.tenant_id'")) return result();
      if (text.includes('SELECT user_display_name, auth_mode, scopes')) {
        expect(values).toEqual([reviewer.tenantId, identity.userId, 'original-run:req-0001']);
        return result([{
          user_display_name: identity.displayName,
          auth_mode: identity.authMode,
          scopes: identity.scopes,
        }]);
      }
      if (text.includes('FROM commerce_agent_jobs') && text.includes('FOR UPDATE')) return result();
      if (text.includes('SELECT id FROM commerce_agent_conversations')) {
        expect(values).toEqual(['conv_1234567890123456', reviewer.tenantId, identity.userId]);
        return result([{ id: 'conv_1234567890123456' }]);
      }
      if (text.includes('SELECT COUNT(*)::integer AS count')) return result([{ count: 0 }]);
      if (text.includes('INSERT INTO commerce_agent_jobs')) {
        const prompt = String(values[11]);
        expect(values[2]).toBe(identity.userId);
        expect(values[6]).toBe('conversation_turn');
        expect(values[7]).toBe('conv_1234567890123456');
        expect(String(values[8])).toMatch(/^feedback-correction:[a-f0-9]{48}$/u);
        expect(prompt).toContain('数据库中保存的原问题：最近一周 GMV 为什么下降？');
        expect(prompt).toContain('数据库中保存的反馈：GMV 口径不正确');
        expect(prompt).toContain('审核备注：请重新核对定义');
        expect(prompt).toContain('run_00000001');
        return result([{
          id: 'job_correction_0001', tenant_id: reviewer.tenantId, user_id: identity.userId,
          user_display_name: identity.displayName, auth_mode: identity.authMode,
          scopes: identity.scopes, kind: 'conversation_turn',
          conversation_id: 'conv_1234567890123456', request_id: values[8],
          request_sha256: values[9], model: values[10], message: prompt,
          required_revision: values[12], executed_by_worker_id: null, status: 'queued',
          attempt_count: 0, max_attempts: values[13],
          available_at: new Date('2026-08-13T00:04:00.000Z'), result_json: null,
          error_code: null, error_message: null,
          created_at: new Date('2026-08-13T00:04:00.000Z'), started_at: null,
          completed_at: null,
        }]);
      }
      if (text.includes('INSERT INTO commerce_agent_job_events')) return result();
      if (text.includes('INSERT INTO commerce_agent_feedback_events')) {
        expect(values.slice(0, 8)).toEqual([
          'feedback_1', reviewer.tenantId, reviewer.userId, reviewer.displayName,
          'correction_enqueued', 2, '审核备注：请重新核对定义',
          'feedback-review:req-correction-0001',
        ]);
        expect(values[9]).toBe('job_correction_0001');
        storedEvent = {
          id: 9, version: 2, event_type: 'correction_enqueued',
          note: '审核备注：请重新核对定义', actor_user_id: reviewer.userId,
          actor_display_name: reviewer.displayName, job_id: 'job_correction_0001',
          run_id: null, request_sha256: values[8],
          created_at: new Date('2026-08-13T00:04:01.000Z'),
        };
        return result([storedEvent]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeedbackStore(database);
    const input = {
      action: 'request_correction' as const,
      note: '审核备注：请重新核对定义',
      requestId: 'feedback-review:req-correction-0001',
      expectedVersion: 1,
    };

    const first = await store.appendReviewEvent(reviewer, 'feedback_1', input);
    await expect(store.appendReviewEvent(reviewer, 'feedback_1', input)).resolves.toEqual(first);

    expect(first).toMatchObject({
      type: 'correction_enqueued', version: 2, jobId: 'job_correction_0001', runId: null,
    });
    expect(database.transactionCount).toBe(2);
    expect(database.calls.filter((call) => call.text.includes('INSERT INTO commerce_agent_jobs')))
      .toHaveLength(1);
    const atomicInserts = database.calls.filter((call) => (
      call.text.includes('INSERT INTO commerce_agent_jobs')
      || call.text.includes('INSERT INTO commerce_agent_feedback_events')
    ));
    expect(atomicInserts).toHaveLength(2);
    expect(atomicInserts.every((call) => call.transactionDepth === 1)).toBe(true);
    expect(database.calls.some((call) => /UPDATE\s+commerce_agent_(?:messages|runs)/u.test(call.text)))
      .toBe(false);
  });

  it('rejects stale versions and illegal terminal transitions', async () => {
    let status: 'reviewed' | 'correction_completed' | 'resolved' = 'reviewed';
    let version = 2;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{ locked: true }]);
      if (text.includes('actor_user_id = $2')) return result();
      if (text.includes('COALESCE(latest.event_type')) return result([{ id: 'feedback_1', status, version }]);
      if (text.includes('INSERT INTO commerce_agent_feedback_events')) {
        return result([{
          id: 10, version: values[5], event_type: values[4], note: values[6],
          actor_user_id: reviewer.userId, actor_display_name: reviewer.displayName,
          job_id: null, run_id: null, request_sha256: values[8],
          created_at: new Date('2026-08-13T00:05:00.000Z'),
        }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeedbackStore(database);

    await expect(store.appendReviewEvent(reviewer, 'feedback_1', {
      action: 'resolve', requestId: 'feedback-review:req-0002', expectedVersion: 1,
    })).rejects.toBeInstanceOf(CommerceFeedbackVersionConflictError);

    await expect(store.appendReviewEvent(reviewer, 'feedback_1', {
      action: 'resolve', requestId: 'feedback-review:req-0003', expectedVersion: 2,
    })).rejects.toBeInstanceOf(CommerceFeedbackInvalidTransitionError);

    status = 'correction_completed';
    version = 3;
    await expect(store.appendReviewEvent(reviewer, 'feedback_1', {
      action: 'resolve', requestId: 'feedback-review:req-0004', expectedVersion: 3,
    })).resolves.toMatchObject({ type: 'resolved', version: 4 });

    status = 'resolved';
    version = 4;
    await expect(store.appendReviewEvent(reviewer, 'feedback_1', {
      action: 'dismiss', requestId: 'feedback-review:req-0005', expectedVersion: 4,
    })).rejects.toBeInstanceOf(CommerceFeedbackInvalidTransitionError);
  });

  it('replays an identical review action and rejects idempotency payload drift', async () => {
    let storedHash: string | null = null;
    const eventRow = (hash: string | null) => ({ id: 7, version: 1, event_type: 'reviewed', note: null,
      actor_user_id: reviewer.userId, actor_display_name: reviewer.displayName,
      job_id: null, run_id: null, request_sha256: hash,
      created_at: new Date('2026-08-13T00:03:00.000Z') });
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{ locked: true }]);
      if (text.includes('actor_user_id = $2')) return storedHash ? result([eventRow(storedHash)]) : result();
      if (text.includes('COALESCE(latest.event_type')) return result([{ id: 'feedback_1', status: 'received', version: 0 }]);
      if (text.includes('INSERT INTO commerce_agent_feedback_events')) {
        storedHash = String(values[8]);
        return result([eventRow(storedHash)]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceFeedbackStore(database);
    const input = { action: 'review' as const, requestId: 'feedback-review:req-0004', expectedVersion: 0 };
    const first = await store.appendReviewEvent(reviewer, 'feedback_1', input);
    await expect(store.appendReviewEvent(reviewer, 'feedback_1', input)).resolves.toEqual(first);
    await expect(store.appendReviewEvent(reviewer, 'feedback_1', { ...input, note: 'changed' }))
      .rejects.toBeInstanceOf(CommerceFeedbackIdempotencyConflictError);
  });
});

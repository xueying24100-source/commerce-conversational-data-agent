import { describe, expect, it } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import {
  CommerceActionInvalidTransitionError,
  CommerceActionVersionConflictError,
  PostgresCommerceActionStore,
} from './action-store';
import type { CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_action',
  userId: 'operator_action',
  displayName: 'Action operator',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};

const actionId = `action_${'a'.repeat(24)}`;
const commitment = {
  assignee: '运营团队',
  dueDate: '2026-08-20',
  target: null,
  evaluationWindowDays: 7,
};
const answer = {
  status: 'answered' as const,
  answer: '经营结论。',
  answerClaims: [],
  findings: [],
  recommendations: [{
    id: actionId,
    action: '检查流量结构',
    rationale: '定位经营驱动。',
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
    if (text.includes("set_config('commerce.")) return Promise.resolve(result() as CommerceQueryResult<Row>);
    return Promise.resolve(this.execute(text, values) as CommerceQueryResult<Row>);
  }

  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> { return work(this); }
  async ping(): Promise<void> {}
}

function input(
  action: 'confirm' | 'ignore' | 'snooze' | 'start' | 'block' | 'resume' | 'complete' | 'cancel' | 'reopen' | 'review',
  expectedVersion: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    conversationId: 'conv_1234567890123456',
    messageId: 'msg_1234567890123456',
    actionId,
    action,
    expectedVersion,
    requestId: `action-request-${action}-12345678`,
    ...(action === 'confirm' ? { commitment } : {}),
    ...(['block', 'complete', 'cancel', 'reopen'].includes(action) ? { note: `已${action}执行。` } : {}),
    ...overrides,
  };
}

describe('Commerce Action workflow', () => {
  it('lists open actions across conversations with proposed and latest event states', async () => {
    const database = new ScriptedDatabase((text, values) => {
      expect(text).toContain('jsonb_array_elements');
      expect(text).toContain("action_status NOT IN ('completed', 'reviewed', 'ignored', 'cancelled')");
      expect(text).toContain("baseline_evidence.id = recommendation.value #>> '{successMetric,baselineClaim,evidenceId}'");
      expect(text).toContain('baseline_evidence.run_id = message.run_id');
      expect(text).toContain('baseline_evidence.tenant_id = message.tenant_id');
      expect(values).toEqual([identity.tenantId, identity.userId, 'open', 25]);
      return result([
        {
          conversation_id: 'conv_1234567890123456',
          conversation_title: '本周经营诊断',
          message_id: 'msg_1234567890123456',
          recommendation: answer.recommendations[0],
          action_status: 'proposed',
          version: 0,
          updated_at: null,
          proposed_at: new Date('2026-08-13T00:00:00.000Z'),
          baseline_request: {
            filters: { regions: ['华东'], channels: [], skus: ['SKU-1'], categories: [] },
          },
        },
        {
          conversation_id: 'conv_abcdefghijklmnop',
          conversation_title: '库存风险',
          message_id: 'msg_abcdefghijklmnop',
          recommendation: { ...answer.recommendations[0], priority: 'high' },
          action_status: 'in_progress',
          version: 2,
          updated_at: new Date('2026-08-13T02:00:00.000Z'),
          proposed_at: new Date('2026-08-13T01:00:00.000Z'),
          last_review_run_id: 'run_review_12345678',
          last_review_message_id: 'msg_review_12345678',
          last_reviewed_at: new Date('2026-08-13T03:00:00.000Z'),
        },
        {
          conversation_id: 'conv_snoozed_12345678',
          conversation_title: '已稍后提醒的行动',
          message_id: 'msg_snoozed_12345678',
          recommendation: answer.recommendations[0],
          action_status: 'proposed',
          version: 3,
          updated_at: new Date('2026-08-13T04:00:00.000Z'),
          proposed_at: new Date('2026-08-13T03:00:00.000Z'),
          action_details: {
            reminder: { status: 'snoozed', snoozeUntil: '2026-08-20T00:00:00.000Z' },
          },
        },
      ]);
    });

    await expect(new PostgresCommerceActionStore(database).list(
      identity,
      { status: 'open', limit: 25 },
    )).resolves.toEqual([
      expect.objectContaining({
        status: 'proposed',
        version: 0,
        updatedAt: null,
        sourceFilters: { regions: ['华东'], channels: [], skus: ['SKU-1'], categories: [] },
      }),
      expect.objectContaining({
        status: 'in_progress',
        version: 2,
        lastReview: {
          runId: 'run_review_12345678',
          messageId: 'msg_review_12345678',
          createdAt: '2026-08-13T03:00:00.000Z',
        },
      }),
      expect.objectContaining({
        status: 'proposed',
        version: 3,
        reminder: {
          status: 'snoozed',
          snoozeUntil: '2026-08-20T00:00:00.000Z',
        },
      }),
    ]);
  });

  it('appends the first operator confirmation without changing the immutable answer', async () => {
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{ answer_json: answer, run_id: 'run_1234567890123456' }]);
      }
      if (text.includes('idempotency_key = $3')) return result();
      if (text.includes('ORDER BY version DESC')) return result();
      if (text.includes('INSERT INTO commerce_agent_action_events')) {
        expect(values[6]).toBe('confirmed');
        expect(values[7]).toBe(1);
        return result([{
          event_type: 'confirmed', version: 1,
          request_sha256: values[10], created_at: new Date('2026-08-13T01:00:00.000Z'),
          details_json: { commitment, note: null },
        }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(new PostgresCommerceActionStore(database).transition(
      identity,
      input('confirm', 0),
    )).resolves.toEqual({
      actionId,
      status: 'confirmed',
      version: 1,
      updatedAt: '2026-08-13T01:00:00.000Z',
      commitment,
      lastNote: null,
      reminder: { status: 'none', snoozeUntil: null },
    });
  });

  it('rejects stale versions and skipped transitions', async () => {
    const staleDatabase = new ScriptedDatabase((text) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{ answer_json: answer, run_id: 'run_1234567890123456' }]);
      }
      if (text.includes('idempotency_key = $3')) return result();
      if (text.includes('ORDER BY version DESC')) return result([{
        event_type: 'confirmed', version: 1,
        request_sha256: `sha256:${'b'.repeat(64)}`,
        created_at: new Date('2026-08-13T01:00:00.000Z'),
      }]);
      throw new Error(`Unexpected SQL: ${text}`);
    });
    await expect(new PostgresCommerceActionStore(staleDatabase).transition(
      identity,
      input('start', 0),
    )).rejects.toBeInstanceOf(CommerceActionVersionConflictError);

    const skippedDatabase = new ScriptedDatabase((text) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{ answer_json: answer, run_id: 'run_1234567890123456' }]);
      }
      if (text.includes('idempotency_key = $3') || text.includes('ORDER BY version DESC')) return result();
      throw new Error(`Unexpected SQL: ${text}`);
    });
    await expect(new PostgresCommerceActionStore(skippedDatabase).transition(
      identity,
      input('complete', 0),
    )).rejects.toBeInstanceOf(CommerceActionInvalidTransitionError);
  });

  it('projects commitment and notes through block, resume, complete, and reopen', async () => {
    let latest: Record<string, unknown> | null = null;
    let completedDetails: Record<string, unknown> | null = null;
    let clock = 0;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{
          answer_json: answer,
          run_id: 'run_1234567890123456',
          describe_preview: {
            timezone: 'America/New_York',
            coverage: { dataMode: 'snapshot', virtualAsOf: '2018-10-17T12:00:00.000Z' },
          },
        }]);
      }
      if (text.includes('idempotency_key = $3')) return result();
      if (text.includes('ORDER BY version DESC')) return result(latest ? [latest] : []);
      if (text.includes('INSERT INTO commerce_agent_action_events')) {
        latest = {
          event_type: values[6],
          version: values[7],
          request_sha256: values[10],
          created_at: new Date(`2026-08-13T0${clock++}:00:00.000Z`),
          details_json: JSON.parse(String(values[11])),
        };
        if (values[6] === 'completed') completedDetails = latest.details_json as Record<string, unknown>;
        return result([latest]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceActionStore(database);

    await expect(store.transition(identity, input('confirm', 0))).resolves.toMatchObject({
      status: 'confirmed', version: 1, commitment, lastNote: null,
    });
    await expect(store.transition(identity, input('start', 1))).resolves.toMatchObject({
      status: 'in_progress', version: 2, commitment, lastNote: null,
    });
    await expect(store.transition(identity, input('block', 2, { note: '等待库存到货。' }))).resolves.toMatchObject({
      status: 'blocked', version: 3, commitment, lastNote: '等待库存到货。',
    });
    await expect(store.transition(identity, input('resume', 3))).resolves.toMatchObject({
      status: 'in_progress', version: 4, commitment, lastNote: '等待库存到货。',
    });
    await expect(store.transition(identity, input('complete', 4, { note: '已完成调整并观察。' }))).resolves.toMatchObject({
      status: 'completed', version: 5, commitment, lastNote: '已完成调整并观察。',
    });
    expect(completedDetails).toMatchObject({
      completion: {
        completedAt: '2018-10-17T12:00:00.000Z',
        clockType: 'virtual',
        timezone: 'America/New_York',
      },
    });
    await expect(store.transition(identity, input('reopen', 5, { note: '复盘发现仍需补充执行。' }))).resolves.toMatchObject({
      status: 'reopened', version: 6, commitment, lastNote: '复盘发现仍需补充执行。',
    });
    await expect(store.transition(identity, input('start', 6))).resolves.toMatchObject({
      status: 'in_progress', version: 7, commitment, lastNote: '复盘发现仍需补充执行。',
    });
  });

  it('keeps snooze in proposed, cancels reminders on ignore, and makes reviewed terminal', async () => {
    let latest: Record<string, unknown> | null = null;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{ answer_json: answer, run_id: 'run_1234567890123456' }]);
      }
      if (text.includes('idempotency_key = $3')) return result();
      if (text.includes('ORDER BY version DESC')) return result(latest ? [latest] : []);
      if (text.includes('INSERT INTO commerce_agent_action_events')) {
        latest = {
          event_type: values[6],
          version: values[7],
          request_sha256: values[10],
          created_at: new Date('2026-08-16T01:00:00.000Z'),
          details_json: JSON.parse(String(values[11])),
        };
        return result([latest]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceActionStore(database);
    const snoozeUntil = new Date(Date.now() + 86_400_000).toISOString();
    await expect(store.transition(identity, input('snooze', 0, { snoozeUntil }))).resolves.toMatchObject({
      status: 'proposed',
      version: 1,
      reminder: { status: 'snoozed', snoozeUntil },
    });
    await expect(store.transition(identity, input('ignore', 1))).resolves.toMatchObject({
      status: 'ignored',
      version: 2,
      reminder: { status: 'cancelled', snoozeUntil: null },
    });
    await expect(store.transition(identity, input('confirm', 2))).rejects
      .toBeInstanceOf(CommerceActionInvalidTransitionError);
  });
});

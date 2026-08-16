import { describe, expect, it, vi } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import type { PostgresCommerceJobStore } from './job-store';
import {
  evaluateCommerceReviewVerdict,
  PostgresCommerceReviewScheduler,
} from './review-scheduler';

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

class RegistryAnalyticsDatabase implements CommerceDatabase {
  readonly tenantScopes: string[] = [];
  private tenantId: string | null = null;

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    if (text.includes("set_config('commerce.tenant_id'")) {
      this.tenantId = String(values[0]);
      this.tenantScopes.push(this.tenantId);
      return Promise.resolve(result() as CommerceQueryResult<Row>);
    }
    expect(this.tenantId).not.toBeNull();
    expect(values).toEqual([this.tenantId]);
    return Promise.resolve(result([{
      business_timezone: 'Asia/Shanghai',
      published_coverage_end: '2026-03-15',
      connector_id: `${this.tenantId}-orders`,
      source_coverage_end: '2026-03-15',
    }]) as CommerceQueryResult<Row>);
  }

  async transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    this.tenantId = null;
    return work(this);
  }

  async ping(): Promise<void> {}
}

const actionId = `action_${'a'.repeat(24)}`;
const baselineClaim = {
  evidenceId: 'ev_baseline_123456', path: '/current/gmv', metric: 'gmv' as const, value: 100,
  unit: 'currency' as const,
};

describe('Commerce automatic review scheduler', () => {
  it('enumerates waiting tenants from Control and scopes one Analytics transaction per tenant', async () => {
    let usedControlRegistry = false;
    const control = new ScriptedDatabase((text) => {
      if (text.includes('SELECT DISTINCT tenant_id')) {
        usedControlRegistry = true;
        return result([{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }]);
      }
      if (text.includes('FROM commerce_action_review_schedules AS schedule')) return result();
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const analytics = new RegistryAnalyticsDatabase();

    await expect(new PostgresCommerceReviewScheduler(control, analytics)
      .queueReadyFromCurrentWatermarks({
        now: new Date('2026-03-16T04:05:00.000Z'),
      })).resolves.toBe(0);
    expect(usedControlRegistry).toBe(true);
    expect(analytics.tenantScopes).toEqual(['tenant-a', 'tenant-b']);
  });

  it('freezes the action contract and aligns a snapshot review to complete local days', async () => {
    let insertedContract: Record<string, unknown> | null = null;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes("event.event_type = 'completed'")) {
        return result([{
          tenant_id: 'tenant-a',
          user_id: 'user-a',
          conversation_id: 'conv_1234567890123456',
          message_id: 'msg_1234567890123456',
          action_id: actionId,
          action_version: 5,
          completed_at: '2026-03-08T06:30:00.000Z',
          details_json: {
            commitment: {
              assignee: 'member_growth', dueDate: '2026-03-20', target: null,
              evaluationWindowDays: 7,
            },
            completion: {
              completedAt: '2018-10-17T12:00:00.000Z',
              clockType: 'virtual',
              timezone: 'America/New_York',
            },
          },
          recommendation: {
            id: actionId,
            action: '复核渠道', rationale: '检查流量。', claims: [], status: 'proposed',
            successMetric: {
              metric: 'gmv', direction: 'increase', baselineClaim, target: 110,
              targetUnit: 'currency', evaluationWindowDays: 7,
            },
            guardrails: [],
          },
          describe_preview: {
            timezone: 'America/New_York', coverage: { dataMode: 'snapshot' },
          },
          baseline_request: {
            filters: { regions: [], channels: ['Paid Social'], skus: [], categories: [] },
          },
        }]);
      }
      if (text.includes('INSERT INTO commerce_action_review_schedules')) {
        expect(values[7]).toBe('2018-10-17T12:00:00.000Z');
        expect(values[10]).toBe('2018-10-18T04:00:00.000Z');
        expect(values[11]).toBe('2018-10-25T04:00:00.000Z');
        insertedContract = JSON.parse(String(values[13])) as Record<string, unknown>;
        return result([{ id: values[0] }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });

    await expect(new PostgresCommerceReviewScheduler(database).scheduleCompleted()).resolves.toBe(1);
    expect(insertedContract).toMatchObject({
      actionVersion: 5,
      clockType: 'virtual',
      completedAt: '2018-10-17T12:00:00.000Z',
      evaluationDurationDays: 7,
      filters: { channels: ['Paid Social'] },
      successMetric: { metric: 'gmv', baselineClaim },
    });
  });

  it('queues once only after both wall clock and inclusive coverage cover the last local day', async () => {
    const enqueueWithClient = vi.fn(async (
      _client: CommerceSqlClient,
      _input: Parameters<PostgresCommerceJobStore['enqueueWithClient']>[1],
    ) => ({
      id: 'job_auto_review_123456', kind: 'conversation_turn' as const,
      conversationId: 'conv_1234567890123456', requestId: 'auto-review', model: 'model-test',
      message: 'review', requiredRevision: 'test-revision', executedByWorkerId: null,
      status: 'queued' as const, attemptCount: 0, maxAttempts: 3,
      availableAt: '2026-03-16T04:05:00.000Z', createdAt: '2026-03-16T04:05:00.000Z',
      startedAt: null, completedAt: null, result: null, error: null,
    }));
    const database = new ScriptedDatabase((text, values) => {
      const schedule = {
        id: 'review_schedule_1234567890123456',
        tenant_id: 'tenant-a', user_id: 'user-a',
        conversation_id: 'conv_1234567890123456', message_id: 'msg_1234567890123456',
        action_id: actionId, action_version: 5, state_version: 5,
        effective_review_start: '2026-03-09T04:00:00.000Z',
        effective_review_end: '2026-03-16T04:00:00.000Z',
        review_after_watermark: '2026-03-16T04:00:00.000Z',
        effective_window_sha256: `sha256:${'a'.repeat(64)}`,
        review_contract_json: {
          schemaVersion: 1, actionId, actionVersion: 5,
          successMetric: {
            metric: 'gmv', direction: 'increase', baselineClaim, target: 110,
            targetUnit: 'currency', evaluationWindowDays: 7,
          },
          guardrails: [],
          filters: { regions: [], channels: ['Paid Social'], skus: [], categories: [] },
          evaluationDurationDays: 7, completedAt: '2026-03-08T06:30:00.000Z',
          timezone: 'America/New_York', clockType: 'virtual',
          effectiveReviewStart: '2026-03-09T04:00:00.000Z',
          effectiveReviewEnd: '2026-03-16T04:00:00.000Z',
        },
        status: 'waiting', job_id: null, model: 'model-test',
        actor_display_name: 'Operator A',
      };
      if (text.includes('FROM commerce_action_review_schedules AS schedule')) {
        expect(text).toContain("schedule.status = 'waiting'");
        expect(text).toContain('schedule.effective_review_end AT TIME ZONE schedule.tenant_timezone');
        expect(values).toEqual([
          'tenant-a',
          '2026-03-16T04:05:00.000Z',
          '2026-03-15',
          100,
        ]);
        return result([schedule]);
      }
      if (text.includes("SET status = 'queued', job_id")) {
        expect(values).toEqual([schedule.id, 'job_auto_review_123456']);
        return result([{ ...schedule, status: 'queued', job_id: values[1] }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const queued = await new PostgresCommerceReviewScheduler(
      database,
      null,
      { enqueueWithClient },
    ).queueReady({
      tenantId: 'tenant-a',
      coverageEnd: '2026-03-15',
      now: new Date('2026-03-16T04:05:00.000Z'),
    });
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      actionVersion: 5, status: 'queued', jobId: 'job_auto_review_123456',
    });
    expect(enqueueWithClient).toHaveBeenCalledTimes(1);
    expect(enqueueWithClient.mock.calls[0]?.[1]).toMatchObject({
      kind: 'conversation_turn',
      conversationId: 'conv_1234567890123456',
      model: 'model-test',
    });
    expect(enqueueWithClient.mock.calls[0]?.[1].message).toContain('2026-03-09 至 2026-03-15');
    expect(enqueueWithClient.mock.calls[0]?.[1].message).toContain('Paid Social');
  });

  it('makes a guardrail breach override a met success metric using current Evidence claims', () => {
    const contract = {
      schemaVersion: 1,
      actionId,
      actionVersion: 5,
      successMetric: {
        metric: 'gmv' as const, direction: 'increase' as const,
        baselineClaim, target: 110, targetUnit: 'currency',
      },
      guardrails: [{
        metric: 'refund_rate' as const,
        operator: 'not_above' as const,
        baselineClaim: { ...baselineClaim, metric: 'refund_rate' as const, value: 0.05, unit: 'percent' as const },
        threshold: 0.06, unit: 'percent',
      }],
      filters: { regions: [], channels: [], skus: [], categories: [] },
      evaluationDurationDays: 7,
      completedAt: '2026-03-08T06:30:00.000Z',
      timezone: 'America/New_York',
      clockType: 'virtual' as const,
      effectiveReviewStart: '2026-03-09T04:00:00.000Z',
      effectiveReviewEnd: '2026-03-16T04:00:00.000Z',
    };
    const answer = {
      status: 'answered' as const,
      answer: 'GMV 达标，但退款率突破护栏。',
      answerClaims: [
        { ...baselineClaim, path: '/current/gmv', value: 120 },
        { ...baselineClaim, path: '/current/refund_rate', metric: 'refund_rate' as const, value: 0.08, unit: 'percent' as const },
      ],
      findings: [], recommendations: [], followUps: [],
    };
    expect(evaluateCommerceReviewVerdict({ contract, answer })).toMatchObject({
      verdict: 'guardrail_breached',
      successMetric: { available: true, met: true },
      guardrails: [{ available: true, breached: true }],
    });
  });

  it('persists the deterministic verdict, immutable review receipt, and reviewed event behind the final version fence', async () => {
    let persistedVerdict: Record<string, unknown> | null = null;
    let reviewReceipts = 0;
    let reviewedEvents = 0;
    const contract = {
      schemaVersion: 1, actionId, actionVersion: 5,
      successMetric: {
        metric: 'gmv', direction: 'increase', baselineClaim, target: 110,
        targetUnit: 'currency', evaluationWindowDays: 7,
      },
      guardrails: [{
        metric: 'refund_rate', operator: 'not_above',
        baselineClaim: {
          ...baselineClaim, metric: 'refund_rate', value: 0.05, unit: 'percent',
        },
        threshold: 0.06, unit: 'percent',
      }],
      filters: { regions: [], channels: [], skus: [], categories: [] },
      evaluationDurationDays: 7, completedAt: '2026-03-08T06:30:00.000Z',
      timezone: 'America/New_York', clockType: 'virtual',
      effectiveReviewStart: '2026-03-09T04:00:00.000Z',
      effectiveReviewEnd: '2026-03-16T04:00:00.000Z',
    };
    const schedule = {
      id: 'review_schedule_1234567890123456',
      tenant_id: 'tenant-a', user_id: 'user-a',
      conversation_id: 'conv_1234567890123456', message_id: 'msg_1234567890123456',
      action_id: actionId, action_version: 5, state_version: 5,
      effective_review_start: contract.effectiveReviewStart,
      effective_review_end: contract.effectiveReviewEnd,
      review_after_watermark: contract.effectiveReviewEnd,
      effective_window_sha256: `sha256:${'a'.repeat(64)}`,
      review_contract_json: contract, status: 'running', job_id: 'job_review_1234567890',
    };
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('SELECT * FROM commerce_action_review_schedules')) return result([schedule]);
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('SELECT completed.run_id')) {
        expect(text).toContain('newer.version > completed.version');
        return result([{
          run_id: 'run_source_1234567890',
          details_json: { commitment: { assignee: 'growth', dueDate: '2026-03-20' } },
        }]);
      }
      if (text.includes('INSERT INTO commerce_agent_action_reviews')) {
        reviewReceipts += 1;
        expect(values[7]).toBe('run_review_1234567890');
        return result();
      }
      if (text.includes('INSERT INTO commerce_agent_action_events')) {
        reviewedEvents += 1;
        expect(values[6]).toBe(6);
        return result();
      }
      if (text.includes("SET status = 'completed', verdict_json")) {
        persistedVerdict = JSON.parse(String(values[1])) as Record<string, unknown>;
        return result([{ id: schedule.id }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const outcome = await new PostgresCommerceReviewScheduler(database).finalizeJob({
      jobId: schedule.job_id,
      question: '复盘指定窗口。',
      result: {
        conversation: {
          id: schedule.conversation_id, title: 'Review', model: 'model-test',
          createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-16T04:06:00.000Z',
        },
        userMessage: {
          id: 'msg_review_user_123456', role: 'user', content: '复盘指定窗口。', answer: null,
          runId: 'run_review_1234567890', runStatus: 'completed', reportAvailable: false,
          traces: [], createdAt: '2026-03-16T04:05:00.000Z',
        },
        assistantMessage: {
          id: 'msg_review_answer_123456', role: 'assistant', content: 'GMV 达标但护栏恶化。',
          answer: {
            status: 'answered', answer: 'GMV 达标但护栏恶化。',
            answerClaims: [
              { ...baselineClaim, path: '/current/gmv', value: 120 },
              {
                ...baselineClaim, path: '/current/refund_rate', metric: 'refund_rate',
                value: 0.08, unit: 'percent',
              },
            ],
            findings: [], recommendations: [], followUps: [],
          },
          runId: 'run_review_1234567890', runStatus: 'completed', reportAvailable: false,
          traces: [], createdAt: '2026-03-16T04:06:00.000Z',
        },
        usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      },
    });
    expect(outcome).toBe('completed');
    expect(persistedVerdict).toMatchObject({ verdict: 'guardrail_breached' });
    expect(reviewReceipts).toBe(1);
    expect(reviewedEvents).toBe(1);
  });

  it('writes stale_noop and no verdict when the Action changes before final submission', async () => {
    let writes = 0;
    const schedule = {
      id: 'review_schedule_1234567890123456',
      tenant_id: 'tenant-a', user_id: 'user-a',
      conversation_id: 'conv_1234567890123456', message_id: 'msg_1234567890123456',
      action_id: actionId, action_version: 5, state_version: 5,
      effective_review_start: '2026-03-09T04:00:00.000Z',
      effective_review_end: '2026-03-16T04:00:00.000Z',
      review_after_watermark: '2026-03-16T04:00:00.000Z',
      effective_window_sha256: `sha256:${'a'.repeat(64)}`,
      review_contract_json: {}, status: 'running', job_id: 'job_review_1234567890',
    };
    const database = new ScriptedDatabase((text) => {
      if (text.includes('SELECT * FROM commerce_action_review_schedules')) return result([schedule]);
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('SELECT completed.run_id')) return result();
      if (text.includes("SET status = 'stale_noop'")) {
        writes += 1;
        return result([{ id: schedule.id }]);
      }
      if (text.includes('INSERT INTO commerce_agent_action_reviews')) {
        throw new Error('stale review must not persist a receipt');
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const outcome = await new PostgresCommerceReviewScheduler(database).finalizeJob({
      jobId: schedule.job_id,
      question: '复盘指定窗口。',
      result: {} as never,
    });
    expect(outcome).toBe('stale_noop');
    expect(writes).toBe(1);
  });

  it('turns an obsolete concurrent review into stale_noop at the version fence', async () => {
    const calls: string[] = [];
    const database = new ScriptedDatabase((text) => {
      calls.push(text);
      if (text.includes('AND EXISTS')) return result();
      if (text.includes("SET status = 'stale_noop'")) return result([{ id: 'schedule' }]);
      throw new Error(`Unexpected SQL: ${text}`);
    });
    await expect(new PostgresCommerceReviewScheduler(database).compareAndSetStatus({
      scheduleId: 'review_schedule_1234567890123456',
      actionVersion: 5,
      stateVersion: 5,
      windowHash: `sha256:${'a'.repeat(64)}`,
      from: 'queued',
      to: 'running',
    })).resolves.toBe('stale_noop');
    expect(calls).toHaveLength(2);
  });
});

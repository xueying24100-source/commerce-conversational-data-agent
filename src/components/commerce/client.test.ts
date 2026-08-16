import { describe, expect, it } from 'vitest';

import {
  buildActionReviewPlan,
  commerceStarters,
  CommerceApiError,
  CommerceJobWaitError,
  commerceBootstrapRetryDelay,
  isTerminalAgentJob,
  isJobWaitCurrent,
  recoveredJobDraft,
  isConversationStillSelected,
  isNonReplayableCommerceError,
  selectMetricStripEntries,
  contextualizeCommerceFollowUp,
} from './client';
import type { ActionListItem, Readiness } from './types';
import {
  compactAuditRequest,
  evidenceClaimLabel,
  evidenceQueryFacts,
  formatEvidenceClaim,
} from './evidence-display';
import { commerceMetricDefinitions } from '@/lib/domains/commerce/agent/analytics-repository';
import { resolveCommerceQueryScope } from '@/lib/domains/commerce/agent/query-scope';

describe('answer presentation helpers', () => {
  it('keeps period totals in KPI cards when breakdown claims follow them', () => {
    const evidenceId = 'ev_1234567890abcdef';
    const claims = [
      { evidenceId, path: '/0/current', metric: 'units', value: 843, unit: 'integer' as const },
      { evidenceId, path: '/4/current', metric: 'units', value: 432, unit: 'integer' as const },
      { evidenceId, path: '/current/units', metric: 'units', value: 7_216, unit: 'integer' as const },
    ];

    expect(selectMetricStripEntries(claims)).toMatchObject([
      { metric: 'units', value: { path: '/current/units', value: 7_216 } },
    ]);
  });

  it('carries an explicit date range into suggested follow-ups', () => {
    expect(contextualizeCommerceFollowUp(
      '查看销量的时间趋势',
      '分析 2018-08-01 至 2018-08-31 的 GMV 和销量',
    )).toBe('查看销量的时间趋势（沿用分析期：2018-08-01 至 2018-08-31）');
  });
});

describe('evidence presentation helpers', () => {
  const trace = {
    evidenceId: 'ev_1234567890abcdef',
    operation: 'commerce.breakdown_metric',
    fetchedAt: '2026-08-16T12:00:00.000Z',
    rowCount: 1,
    requestSha256: 'sha256:request',
    responseSha256: 'sha256:response',
    sourceWatermark: '2018-05-21T03:00:00.000Z',
    request: {
      current: { start: '2018-05-07', end: '2018-05-13' },
      baseline: { start: '2018-04-30', end: '2018-05-06' },
      metric: 'gmv',
      dimension: 'channel',
      filters: { regions: [], channels: [], skus: [], categories: [] },
      sort: 'absolute_change_desc',
      limit: 12,
      __queryScope: { internal: true },
    },
    preview: [{ key: 'Organic Search', current: 109_790.32, absoluteChange: 18_195.09 }],
  };

  it('renders reproducible business scope and hides internal query capsules from audit JSON', () => {
    expect(evidenceQueryFacts(trace)).toEqual(expect.arrayContaining([
      { label: '分析期', value: '2018-05-07 至 2018-05-13' },
      { label: '比较基准', value: '2018-04-30 至 2018-05-06' },
      { label: '指标', value: 'GMV' },
      { label: '拆解维度', value: '渠道' },
      { label: '筛选', value: '全部数据' },
    ]));
    expect(compactAuditRequest(trace.request)).not.toHaveProperty('__queryScope');
  });

  it('maps a field-level claim back to the exact business row and formatted value', () => {
    const claim = {
      evidenceId: trace.evidenceId,
      path: '/0/absoluteChange',
      metric: 'gmv',
      value: 18_195.09,
      unit: 'currency' as const,
    };
    expect(evidenceClaimLabel(trace, claim)).toBe('Organic Search · GMV · 绝对变化');
    expect(formatEvidenceClaim(claim, 'BRL')).toContain('18,195.09');
  });
});

describe('Commerce bootstrap retry', () => {
  it('uses finite exponential backoff for a transient not-ready response', () => {
    expect(Array.from({ length: 7 }, (_, attempt) => commerceBootstrapRetryDelay(attempt)))
      .toEqual([1_000, 2_000, 4_000, 8_000, 16_000, null, null]);
  });
});

function dataStatus(
  overrides: Partial<NonNullable<Readiness['dataStatus']>> = {},
): NonNullable<Readiness['dataStatus']> {
  return {
    dataMode: 'incremental',
    snapshotVerified: null,
    coverageStart: '2026-07-01',
    coverageEnd: '2026-08-12',
    businessTimezone: 'America/New_York',
    currencyCode: 'USD',
    availableMetrics: ['gmv', 'net_revenue', 'paid_orders', 'units', 'average_order_value', 'refund_amount'],
    lastIngestedAt: '2026-08-12T12:00:00.000Z',
    sourceUpdatedAt: '2026-08-12T11:55:00.000Z',
    sourceDisclosure: null,
    ...overrides,
  };
}

function apiError(overrides: { code?: string; status?: number } = {}) {
  return new CommerceApiError(
    'test error',
    overrides.code ?? 'COMMERCE_REQUEST_RUNNING',
    overrides.status ?? 409,
    null,
  );
}

function job(status: 'queued' | 'running' | 'completed' | 'failed' | 'dead_letter') {
  return {
    id: 'job_1234567890abcdef',
    kind: 'conversation_turn' as const,
    conversationId: 'conv_1234567890abcdef',
    requestId: 'req_12345678',
    model: 'deepseek-v4-flash',
    message: '分析最近一周 GMV',
    requiredRevision: 'abcdef1',
    executedByWorkerId: null,
    status,
    attemptCount: 1,
    maxAttempts: 3,
    availableAt: '2026-08-13T00:00:00.000Z',
    createdAt: '2026-08-13T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    result: null,
    error: status === 'failed' || status === 'dead_letter'
      ? { code: 'FAILED', message: 'failed' }
      : null,
  };
}

function completedAction(overrides: Partial<ActionListItem> = {}): ActionListItem {
  return {
    actionId: `action_${'a'.repeat(24)}`,
    conversationId: 'conv_1234567890abcdef',
    conversationTitle: '商品诊断',
    messageId: 'msg_1234567890abcdef',
    action: '优化夏季商品投放',
    rationale: '提升转化。',
    priority: 'high',
    ownerRole: 'growth',
    deadline: null,
    successMetric: {
      metric: 'gmv',
      direction: 'increase',
      baselineClaim: {
        evidenceId: 'evidence_1234567890abcdef',
        path: '/current/gmv',
        metric: 'gmv',
        value: 100,
        unit: 'currency',
      },
      target: null,
      targetUnit: 'currency',
      evaluationWindowDays: 7,
    },
    guardrails: [{
      metric: 'refund_amount',
      operator: 'not_above',
      baselineClaim: {
        evidenceId: 'evidence_1234567890abcdef',
        path: '/current/refund_amount',
        metric: 'refund_amount',
        value: 10,
        unit: 'currency',
      },
      threshold: null,
      unit: 'currency',
    }],
    sourceFilters: { regions: ['华东'], channels: ['online'], skus: ['SKU-1'], categories: ['夏季'] },
    lastReview: null,
    status: 'completed',
    version: 3,
    updatedAt: '2026-08-01T16:00:00.000Z',
    commitment: {
      assignee: '增长团队',
      dueDate: '2026-07-24',
      target: null,
      evaluationWindowDays: 7,
    },
    lastNote: '已完成投放调整。',
    proposedAt: '2026-07-20T00:00:00.000Z',
    ...overrides,
  };
}

describe('isNonReplayableCommerceError', () => {
  it('flags terminal errors that must never reuse the prior requestId', () => {
    expect(isNonReplayableCommerceError(apiError({ status: 502 }))).toBe(true);
    expect(isNonReplayableCommerceError(apiError({ code: 'COMMERCE_REQUEST_NOT_REPLAYABLE' })))
      .toBe(true);
    expect(isNonReplayableCommerceError(apiError({ code: 'COMMERCE_IDEMPOTENCY_CONFLICT' })))
      .toBe(true);
    expect(isNonReplayableCommerceError(
      new CommerceJobWaitError('terminal', job('failed'), 'failed'),
    )).toBe(true);
  });

  it('lets a genuinely retryable error keep reusing the same requestId', () => {
    // The prior attempt may still be running (COMMERCE_REQUEST_RUNNING) or this may be a
    // transient network/parse failure that never reached CommerceApiError at all; both cases
    // must resend with the SAME requestId so the server can fold it into the existing Job
    // instead of creating an unbounded number of duplicate intents for one user action.
    expect(isNonReplayableCommerceError(apiError({ code: 'COMMERCE_REQUEST_RUNNING', status: 409 })))
      .toBe(false);
    expect(isNonReplayableCommerceError(new Error('network hiccup'))).toBe(false);
    expect(isNonReplayableCommerceError(null)).toBe(false);
  });
});

describe('durable Commerce Job state', () => {
  it('only treats failed and dead-letter Jobs as terminal failures', () => {
    expect(isTerminalAgentJob(job('queued'))).toBe(false);
    expect(isTerminalAgentJob(job('running'))).toBe(false);
    expect(isTerminalAgentJob(job('completed'))).toBe(false);
    expect(isTerminalAgentJob(job('failed'))).toBe(true);
    expect(isTerminalAgentJob(job('dead_letter'))).toBe(true);
  });

  it('keeps timeout and network waits replay-safe because the durable Job may still run', () => {
    expect(isNonReplayableCommerceError(
      new CommerceJobWaitError('timeout', job('running'), 'still running'),
    )).toBe(false);
    expect(isNonReplayableCommerceError(
      new CommerceJobWaitError('network', job('queued'), 'offline'),
    )).toBe(false);
  });

  it('only prepares a new draft after a durable terminal failure', () => {
    expect(recoveredJobDraft(job('failed'), 'terminal')).toBe('分析最近一周 GMV');
    expect(recoveredJobDraft(job('running'), 'timeout')).toBeNull();
    expect(recoveredJobDraft(job('running'), 'network')).toBeNull();
    expect(recoveredJobDraft(job('running'), 'aborted')).toBeNull();
  });
});

describe('conversation-scoped async results', () => {
  it('applies a result only while its originating conversation is still selected', () => {
    expect(isConversationStillSelected('conversation-a', 'conversation-a')).toBe(true);
    expect(isConversationStillSelected('conversation-b', 'conversation-a')).toBe(false);
    expect(isConversationStillSelected(null, null)).toBe(true);
    expect(isConversationStillSelected('conversation-b', null)).toBe(false);
  });

  it('does not let an aborted wait clear a newer resumed Job', () => {
    expect(isJobWaitCurrent('job_new', 'job_old')).toBe(false);
    expect(isJobWaitCurrent('job_new', 'job_new')).toBe(true);
    expect(isJobWaitCurrent(null, 'job_old')).toBe(false);
  });
});

describe('tenant-aware Commerce starters', () => {
  it('builds store-operator questions from Shopify coverage and supported metrics', () => {
    const starters = commerceStarters(dataStatus());
    const questions = starters.map((starter) => starter.question).join('\n');

    expect(starters.map((starter) => starter.label)).toEqual([
      '经营概览',
      '异常与机会',
      '下一步行动',
      '数据报告',
    ]);
    expect(questions).toContain('2026-07-30 至 2026-08-12');
    expect(questions).toContain('America/New_York');
    expect(questions).toContain('GMV');
    expect(questions).toContain('支付订单数');
    expect(questions).not.toContain('2018');
    expect(questions).not.toContain('新客');
    expect(questions).not.toContain('访问量');
    expect(questions).not.toContain('ROAS');
    expect(questions).not.toContain('库存风险');

    for (const starter of starters) {
      const scope = resolveCommerceQueryScope({
        question: starter.question,
        catalog: {
          dataset: 'commerce_daily_metrics',
          timezone: 'America/New_York',
          currencyCode: 'USD',
          coverage: {
            start: '2026-07-01',
            end: '2026-08-12',
            lastIngestedAt: '2026-08-12T12:00:00.000Z',
            sourceUpdatedAt: '2026-08-12T11:55:00.000Z',
            dataMode: 'incremental',
            rowCount: 100,
          },
          metrics: commerceMetricDefinitions(['gmv', 'paid_orders', 'refund_amount', 'units']),
          dimensions: { region: [], channel: [], sku: [], category: [] },
        },
        now: new Date('2026-08-13T00:00:00.000Z'),
      });
      expect(scope.status, starter.question).toBe('ready');
    }
  });

  it('uses snapshot coverage and adds inventory analysis only when both metrics exist', () => {
    const starters = commerceStarters(dataStatus({
      dataMode: 'snapshot',
      snapshotVerified: true,
      coverageStart: '2016-09-04',
      coverageEnd: '2018-09-03',
      businessTimezone: 'America/Sao_Paulo',
      availableMetrics: ['gmv', 'paid_orders', 'new_customers', 'stockout_hours', 'ending_inventory'],
    }));
    const questions = starters.map((starter) => starter.question).join('\n');

    expect(questions).toContain('2018-08-21 至 2018-09-03');
    expect(questions).toContain('该历史快照');
    expect(questions).toContain('America/Sao_Paulo');
    expect(questions).toContain('新客数');
    expect(questions).toContain('库存风险');
  });

  it('offers the one-click complete-week diagnosis only when the flagship metric contract is present', () => {
    const starters = commerceStarters(dataStatus({
      coverageStart: '2026-01-01',
      availableMetrics: [
        'gmv', 'paid_orders', 'visits', 'conversion_rate', 'average_order_value',
      ],
    }));

    expect(starters[0]).toMatchObject({
      label: '完整周诊断',
    });
    expect(starters[0]?.question).toContain('诊断上一完整周经营表现');
    expect(starters[0]?.question).toContain('主动停止');
  });

  it('hides the complete-week starter while the diagnostic policy rollout flag is disabled', () => {
    const starters = commerceStarters(dataStatus({
      coverageStart: '2026-01-01',
      availableMetrics: [
        'gmv', 'paid_orders', 'visits', 'conversion_rate', 'average_order_value',
      ],
    }), false);

    expect(starters.some((starter) => starter.label === '完整周诊断')).toBe(false);
    expect(starters).toHaveLength(4);
  });

  it('returns no misleading questions without a complete catalog range or usable metric', () => {
    expect(commerceStarters(null)).toEqual([]);
    expect(commerceStarters(dataStatus({ coverageEnd: null }))).toEqual([]);
    expect(commerceStarters(dataStatus({ coverageStart: '2026-08-12', coverageEnd: '2026-08-12' }))).toEqual([]);
    expect(commerceStarters(dataStatus({ availableMetrics: ['ending_inventory'] }))).toEqual([]);
  });
});

describe('completed action review plan', () => {
  const reviewNow = new Date('2026-08-13T16:00:00.000Z');

  it('creates a reproducible, Evidence-filtered comparison after a full business window', () => {
    const plan = buildActionReviewPlan(completedAction(), dataStatus(), reviewNow);

    expect(plan.status).toBe('ready');
    expect(plan.current).toEqual({ start: '2026-08-02', end: '2026-08-08' });
    expect(plan.baseline).toEqual({ start: '2026-07-25', end: '2026-07-31' });
    expect(plan.question).toContain('2026-08-02 至 2026-08-08');
    expect(plan.question).toContain('2026-07-25 至 2026-07-31');
    expect(plan.question).toContain('GMV、退款金额');
    expect(plan.question).toContain('退款金额不得高于行动前基线');
    expect(plan.question).toContain('区域：“华东”；渠道：“online”；SKU：“SKU-1”；品类：“夏季”');
  });

  it('waits for incremental coverage and blocks an insufficient snapshot rather than inventing an effect', () => {
    expect(buildActionReviewPlan(completedAction(), dataStatus({ coverageEnd: '2026-08-07' }), reviewNow))
      .toMatchObject({ status: 'waiting_data', message: '等待数据至 2026-08-08', question: null });
    expect(buildActionReviewPlan(completedAction(), dataStatus({
      dataMode: 'snapshot', coverageEnd: '2026-08-07', snapshotVerified: true,
    }), reviewNow)).toMatchObject({ status: 'blocked', question: null });
  });

  it('fails closed for an incomplete baseline, unavailable metrics, or unrecoverable filters', () => {
    expect(buildActionReviewPlan(completedAction(), dataStatus({ coverageStart: '2026-07-26' }), reviewNow))
      .toMatchObject({ status: 'blocked', message: '缺少行动前完整基线数据，不能生成可信复盘。' });
    expect(buildActionReviewPlan(completedAction(), dataStatus({
      availableMetrics: ['paid_orders'],
    }), reviewNow)).toMatchObject({ status: 'blocked', question: null });
    expect(buildActionReviewPlan(completedAction({ sourceFilters: null }), dataStatus(), reviewNow))
      .toMatchObject({ status: 'blocked', question: null });
    expect(buildActionReviewPlan(completedAction(), dataStatus({ businessTimezone: null }), reviewNow))
      .toMatchObject({ status: 'blocked', message: '缺少业务时区，不能确定一致的复盘窗口。' });
  });

  it('uses the completion day in the configured business timezone', () => {
    const plan = buildActionReviewPlan(completedAction({
      updatedAt: '2026-08-02T03:30:00.000Z',
      commitment: {
        ...completedAction().commitment!,
        evaluationWindowDays: 1,
      },
      successMetric: {
        ...completedAction().successMetric!,
        evaluationWindowDays: 1,
      },
    }), dataStatus(), reviewNow);

    expect(plan.current).toEqual({ start: '2026-08-02', end: '2026-08-02' });
    expect(plan.baseline).toEqual({ start: '2026-07-31', end: '2026-07-31' });
  });

  it('only asks for guardrails still available in the current catalog', () => {
    const plan = buildActionReviewPlan(completedAction({
      guardrails: [
        ...completedAction().guardrails!,
        {
          ...completedAction().guardrails![0]!,
          metric: 'roas',
          baselineClaim: { ...completedAction().guardrails![0]!.baselineClaim, metric: 'roas' },
        },
      ],
    }), dataStatus(), reviewNow);

    expect(plan.status).toBe('ready');
    expect(plan.unavailableGuardrails).toEqual(['roas']);
    expect(plan.question).toContain('退款金额');
    expect(plan.question).not.toContain('ROAS');
  });
});

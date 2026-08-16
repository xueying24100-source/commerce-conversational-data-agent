import { describe, expect, it } from 'vitest';

import { CommerceEvidenceLedger, CommerceGroundingError } from './evidence-ledger';
import { resolveCommerceQueryScope } from './query-scope';
import type { CommerceAgentAnswer } from './types';

function resolvedScope(question: string) {
  return resolveCommerceQueryScope({
    question,
    now: new Date('2026-07-15T00:00:00.000Z'),
    catalog: {
      dataset: 'commerce_daily_metrics',
      timezone: 'Asia/Shanghai',
      currencyCode: 'CNY',
      coverage: {
        start: '2025-01-01',
        end: '2026-07-31',
        lastIngestedAt: '2026-07-15T00:00:00.000Z',
        sourceUpdatedAt: '2026-07-15T00:00:00.000Z',
        dataMode: 'snapshot' as const,
        rowCount: 100,
      },
      metrics: [
        {
          id: 'gmv' as const,
          label: 'GMV',
          format: 'currency' as const,
          description: 'GMV',
          aggregation: 'sum' as const,
          additivity: 'additive' as const,
          additiveDimensions: ['region', 'channel', 'sku', 'category'] as const,
        },
        {
          id: 'paid_orders' as const,
          label: '支付订单',
          format: 'integer' as const,
          description: '支付订单',
          aggregation: 'sum' as const,
          additivity: 'source_allocated_additive' as const,
          additiveDimensions: ['region', 'channel', 'sku', 'category'] as const,
        },
      ],
      dimensions: { region: [], channel: [], sku: [], category: [] },
    },
  });
}

function groundedAnswer(evidenceId: string, value = 100): CommerceAgentAnswer {
  const claim = {
    evidenceId,
    path: '/current/gmv',
    metric: 'gmv' as const,
    value,
    unit: 'currency' as const,
  };
  return {
    status: 'answered' as const,
    answer: '本期 GMV 表现已完成核对。',
    answerClaims: [claim],
    findings: [{
      metric: 'gmv' as const,
      title: '本期表现',
      detail: '当前区间的成交表现如下。',
      claims: [claim],
    }],
    recommendations: [],
    followUps: [],
  };
}

describe('Commerce evidence ledger', () => {
  it('rejects analytical tool calls whose date or metric differs from resolved scope', () => {
    const scope = resolvedScope('查看 2026 年 6 月的 GMV');
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });
    const filters = { regions: [], channels: [], skus: [], categories: [] };

    expect(() => ledger.assertAnalyticalRequest('commerce.compare_metrics', {
      current: { start: '2026-07-01', end: '2026-07-31' },
      baseline: null,
      metrics: ['gmv'],
      filters,
    })).toThrow(/日期.*查询范围不一致/u);

    expect(() => ledger.assertAnalyticalRequest('commerce.compare_metrics', {
      current: { start: '2026-06-01', end: '2026-06-30' },
      baseline: null,
      metrics: ['paid_orders'],
      filters,
    })).toThrow(/指标.*查询范围不一致/u);
  });

  it('rejects an answer that omits one of the explicitly requested metrics', () => {
    const scope = resolvedScope('查看 2026 年 6 月的 GMV 和支付订单');
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metrics: ['gmv'],
        filters: { regions: [], channels: [], skus: [], categories: [] },
      },
      data: { current: { gmv: 100 } },
      rowCount: 1,
    });

    expect(() => ledger.verifyAnswer(
      groundedAnswer(evidence.evidenceId),
      '查看 2026 年 6 月的 GMV 和支付订单',
    )).toThrow(/未完整覆盖请求指标.*paid_orders/u);
  });

  it('rejects a comparison answer that only cites the baseline value', () => {
    const scope = resolvedScope('查看 2026 年 6 月 GMV 同比');
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: { start: '2025-06-01', end: '2025-06-30' },
        metrics: ['gmv'],
        filters: { regions: [], channels: [], skus: [], categories: [] },
      },
      data: {
        current: { gmv: 100 },
        baseline: { gmv: 80 },
        changes: { gmv: { absolute: 20, percent: 0.25 } },
      },
      rowCount: 1,
    });
    const baselineClaim = {
      evidenceId: evidence.evidenceId,
      path: '/baseline/gmv',
      metric: 'gmv' as const,
      value: 80,
      unit: 'currency' as const,
    };

    expect(() => ledger.verifyAnswer({
      status: 'answered',
      answer: '已核对同比表现。',
      answerClaims: [baselineClaim],
      findings: [{
        metric: 'gmv',
        title: '同比表现',
        detail: '已核对对比区间。',
        claims: [baselineClaim],
      }],
      recommendations: [],
      followUps: [],
    }, '查看 2026 年 6 月 GMV 同比')).toThrow(/当前分析期.*claim/u);
  });

  it('does not let a current-period trend satisfy a comparison request', () => {
    const scope = resolvedScope('查看 2026 年 6 月 GMV 同比');
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });
    const evidence = ledger.record({
      operation: 'commerce.trend_metric',
      request: {
        range: { start: '2026-06-01', end: '2026-06-30' },
        metric: 'gmv',
        grain: 'day',
        filters: { regions: [], channels: [], skus: [], categories: [] },
      },
      data: [{ bucket: '2026-06-01', value: 100 }],
      rowCount: 1,
    });
    const trendClaim = {
      evidenceId: evidence.evidenceId,
      path: '/0/value',
      metric: 'gmv' as const,
      value: 100,
      unit: 'currency' as const,
    };

    expect(() => ledger.verifyAnswer({
      status: 'answered',
      answer: '已核对同比表现。',
      answerClaims: [trendClaim],
      findings: [{
        metric: 'gmv',
        title: '同比表现',
        detail: '已核对对比区间。',
        claims: [trendClaim],
      }],
      recommendations: [],
      followUps: [],
    }, '查看 2026 年 6 月 GMV 同比')).toThrow(/缺少.*comparison/u);
  });

  it('requires final claims from every requested breakdown dimension', () => {
    const scope = resolvedScope('按地区和渠道拆解 2026 年 6 月 GMV');
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });
    const filters = { regions: [], channels: [], skus: [], categories: [] };
    const comparison = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metrics: ['gmv'],
        filters,
      },
      data: { current: { gmv: 100 }, baseline: null, changes: null },
      rowCount: 1,
    });
    const region = ledger.record({
      operation: 'commerce.breakdown_metric',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metric: 'gmv',
        dimension: 'region',
        filters,
        limit: 10,
        sort: 'current_desc',
      },
      data: [{
        key: '华东',
        currentPresent: true,
        baselinePresent: null,
        current: 60,
        baseline: null,
        absoluteChange: null,
        percentChange: null,
      }],
      rowCount: 1,
    });
    const channel = ledger.record({
      operation: 'commerce.breakdown_metric',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metric: 'gmv',
        dimension: 'channel',
        filters,
        limit: 10,
        sort: 'current_desc',
      },
      data: [{
        key: '搜索',
        currentPresent: true,
        baselinePresent: null,
        current: 40,
        baseline: null,
        absoluteChange: null,
        percentChange: null,
      }],
      rowCount: 1,
    });
    const currentClaim = {
      evidenceId: comparison.evidenceId,
      path: '/current/gmv',
      metric: 'gmv' as const,
      value: 100,
      unit: 'currency' as const,
    };
    const regionClaim = {
      evidenceId: region.evidenceId,
      path: '/0/current',
      metric: 'gmv' as const,
      value: 60,
      unit: 'currency' as const,
    };
    expect(channel.evidenceId).not.toBe(region.evidenceId);

    expect(() => ledger.verifyAnswer({
      status: 'answered',
      answer: '已核对拆解结果。',
      answerClaims: [currentClaim],
      findings: [{
        metric: 'gmv',
        title: '地区拆解',
        detail: '已核对地区贡献。',
        claims: [regionClaim],
      }],
      recommendations: [],
      followUps: [],
    }, '按地区和渠道拆解 2026 年 6 月 GMV')).toThrow(/channel.*claim/u);
  });

  it('requires every requested metric and breakdown dimension pair in evidence and final claims', () => {
    const question = '按品类拆解 2026 年 6 月 GMV 和支付订单';
    const scope = resolvedScope(question);
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });
    const filters = { regions: [], channels: [], skus: [], categories: [] };
    const comparison = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metrics: ['gmv', 'paid_orders'],
        filters,
      },
      data: {
        current: { gmv: 100, paid_orders: 20 },
        baseline: null,
        changes: null,
      },
      rowCount: 1,
    });
    const gmvBreakdown = ledger.record({
      operation: 'commerce.breakdown_metric',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metric: 'gmv',
        dimension: 'category',
        filters,
        limit: 10,
        sort: 'current_desc',
      },
      data: [{ key: '美妆', current: 60 }],
      rowCount: 1,
    });

    expect(ledger.hasRequiredAnalyticalEvidence()).toBe(false);
    expect(ledger.missingRequiredAnalyticalToolNames()).toContain('breakdown_commerce_metric');

    ledger.record({
      operation: 'commerce.breakdown_metric',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metric: 'paid_orders',
        dimension: 'category',
        filters,
        limit: 10,
        sort: 'current_desc',
      },
      data: [{ key: '美妆', current: 12 }],
      rowCount: 1,
    });

    expect(ledger.hasRequiredAnalyticalEvidence()).toBe(true);

    const gmvCurrent = {
      evidenceId: comparison.evidenceId,
      path: '/current/gmv',
      metric: 'gmv' as const,
      value: 100,
      unit: 'currency' as const,
    };
    const ordersCurrent = {
      evidenceId: comparison.evidenceId,
      path: '/current/paid_orders',
      metric: 'paid_orders' as const,
      value: 20,
      unit: 'integer' as const,
    };
    const gmvCategory = {
      evidenceId: gmvBreakdown.evidenceId,
      path: '/0/current',
      metric: 'gmv' as const,
      value: 60,
      unit: 'currency' as const,
    };

    expect(() => ledger.verifyAnswer({
      status: 'answered',
      answer: '已核对品类拆解。',
      answerClaims: [gmvCurrent, ordersCurrent],
      findings: [{
        metric: 'gmv',
        title: 'GMV 品类拆解',
        detail: '已核对 GMV 品类贡献。',
        claims: [gmvCategory],
      }],
      recommendations: [],
      followUps: [],
    }, question)).toThrow(/paid_orders × category breakdown current claim/u);
  });

  it('enforces the requested trend grain and requires trend claims in the final answer', () => {
    const scope = resolvedScope('查看 2026 年 6 月 GMV 每日趋势');
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });
    const filters = { regions: [], channels: [], skus: [], categories: [] };

    expect(() => ledger.assertAnalyticalRequest('commerce.trend_metric', {
      range: { start: '2026-06-01', end: '2026-06-30' },
      metric: 'gmv',
      grain: 'month',
      filters,
    })).toThrow(/粒度.*查询范围不一致/u);

    const comparison = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metrics: ['gmv'],
        filters,
      },
      data: { current: { gmv: 100 }, baseline: null, changes: null },
      rowCount: 1,
    });
    ledger.record({
      operation: 'commerce.trend_metric',
      request: {
        range: { start: '2026-06-01', end: '2026-06-30' },
        metric: 'gmv',
        grain: 'day',
        filters,
      },
      data: [{ bucket: '2026-06-01', value: 10 }],
      rowCount: 1,
    });

    expect(() => ledger.verifyAnswer(
      groundedAnswer(comparison.evidenceId),
      '查看 2026 年 6 月 GMV 每日趋势',
    )).toThrow(/trend.*claim/u);
  });

  it('preserves the specific missing slot in controlled clarification copy', () => {
    const scope = resolvedScope('查看 GMV');
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });

    const answer = ledger.verifyAnswer({
      status: 'needs_clarification',
      answer: '任意模型文本',
      answerClaims: [],
      findings: [],
      recommendations: [],
      followUps: [],
    }, '查看 GMV');

    expect(answer.answer).toContain('开始和结束日期');
    expect(answer.followUps).toEqual(['请补充分析期的开始和结束日期']);
    expect(answer.answer).not.toContain('经营指标或筛选范围');
  });

  it('validates field-level claims and renders quantitative facts on the server', () => {
    const ledger = new CommerceEvidenceLedger();
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: { current: { start: '2026-06-01', end: '2026-06-30' } },
      data: { current: { gmv: 100, conversion_rate: 0.1 } },
      rowCount: 1,
    });

    const answer = ledger.verifyAnswer(
      groundedAnswer(evidence.evidenceId),
      '查看六月表现',
    );

    expect(answer.status).toBe('answered');
    expect(answer.answer).toContain('关键证据');
    expect(answer.answer).toContain('100.00');
    expect(answer.findings[0]).toMatchObject({ metric: 'gmv', title: '经营现状 · GMV' });
    expect(ledger.traces()[0]).toMatchObject({
      evidenceId: evidence.evidenceId,
      requestSha256: expect.stringMatching(/^sha256:/u),
      responseSha256: expect.stringMatching(/^sha256:/u),
    });
  });

  it('rejects unknown evidence, missing paths and non-exact values', () => {
    const ledger = new CommerceEvidenceLedger();
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {},
      data: { current: { gmv: 100.49 } },
      rowCount: 1,
    });

    expect(() => ledger.verifyAnswer(
      groundedAnswer('ev_not_in_this_run', 100.49),
      '查看 GMV',
    )).toThrow(CommerceGroundingError);

    const missingPath = groundedAnswer(evidence.evidenceId, 100.49);
    missingPath.answerClaims[0].path = '/current/refund_amount';
    expect(() => ledger.verifyAnswer(missingPath, '查看 GMV')).toThrow(/path.*不存在/iu);

    expect(() => ledger.verifyAnswer(
      groundedAnswer(evidence.evidenceId, 100),
      '查看 GMV',
    )).toThrow(/原始值不一致/u);
  });

  it('rejects metric swapping even when the numeric value exists in evidence', () => {
    const ledger = new CommerceEvidenceLedger();
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {},
      data: { current: { gmv: 100, refund_amount: 5 } },
      rowCount: 1,
    });
    const answer = groundedAnswer(evidence.evidenceId);
    answer.answerClaims[0] = {
      evidenceId: evidence.evidenceId,
      path: '/current/gmv',
      metric: 'refund_amount',
      value: 100,
      unit: 'currency',
    };

    expect(() => ledger.verifyAnswer(answer, '查看退款')).toThrow(/metric\/unit.*不一致/u);
  });

  it('does not expose unsupported qualitative assertions from the model', () => {
    const ledger = new CommerceEvidenceLedger();
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {},
      data: { current: { gmv: 100 } },
      rowCount: 1,
    });
    const answer = groundedAnswer(evidence.evidenceId);
    answer.answer = '退款表现严重恶化。';
    answer.findings[0].title = '退款异常';
    answer.findings[0].detail = '退款风险显著上升。';
    answer.recommendations = [{
      action: '立即调整退款策略',
      rationale: '退款问题需要立刻处理。',
      claims: [answer.answerClaims[0]],
    }];

    const rendered = ledger.verifyAnswer(answer, '查看 GMV');

    expect(JSON.stringify(rendered)).not.toContain('退款');
    expect(rendered.recommendations[0].action).toBe('继续按经营维度拆解');
  });

  it('does not allow the model to write Arabic or Chinese quantities in narrative text', () => {
    const ledger = new CommerceEvidenceLedger();
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {},
      data: { current: { gmv: 100 } },
      rowCount: 1,
    });
    const arabic = groundedAnswer(evidence.evidenceId);
    arabic.answer = 'GMV 为 100。';
    expect(() => ledger.verifyAnswer(arabic, '查看 GMV')).toThrow(/数字.*claims/u);

    const chinese = groundedAnswer(evidence.evidenceId);
    chinese.answer = 'GMV 为一百元。';
    expect(() => ledger.verifyAnswer(chinese, '查看 GMV')).toThrow(/数量.*claims/u);
  });

  it('requires every answered recommendation to carry its own field-level claims', () => {
    const ledger = new CommerceEvidenceLedger();
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {},
      data: { current: { gmv: 100 } },
      rowCount: 1,
    });
    const answer = groundedAnswer(evidence.evidenceId);
    answer.recommendations = [{
      action: '复核渠道投放',
      rationale: '成交表现需要进一步拆解。',
      claims: [],
    }];

    expect(() => ledger.verifyAnswer(answer, '查看 GMV')).toThrow(/缺少 claims/u);
  });

  it('rebuilds model recommendations as evidence-bound proposed action cards', () => {
    const ledger = new CommerceEvidenceLedger();
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {},
      data: { current: { gmv: 100 } },
      rowCount: 1,
    });
    const answer = groundedAnswer(evidence.evidenceId);
    answer.recommendations = [{
      action: '模型要求明天执行',
      rationale: '模型自称已经安排负责人。',
      claims: [answer.answerClaims[0]],
      priority: 'low',
      ownerRole: 'data',
      deadline: '2026-08-14',
      status: 'proposed',
    }];

    const rendered = ledger.verifyAnswer(answer, '查看 GMV');
    const action = rendered.recommendations[0];

    expect(action).toMatchObject({
      id: expect.stringMatching(/^action_[a-f0-9]{24}$/u),
      action: '继续按经营维度拆解',
      priority: 'medium',
      ownerRole: 'operations',
      deadline: null,
      status: 'proposed',
      successMetric: {
        metric: 'gmv',
        direction: 'increase',
        baselineClaim: answer.answerClaims[0],
        target: null,
        targetUnit: 'currency',
        evaluationWindowDays: null,
      },
      guardrails: [],
    });
    expect(JSON.stringify(action)).not.toContain('明天');
    expect(JSON.stringify(action)).not.toContain('已经安排');
  });

  it('uses controlled copy for clarification instead of exposing model assertions', () => {
    const ledger = new CommerceEvidenceLedger();
    const answer = ledger.verifyAnswer({
      status: 'needs_clarification',
      answer: '模型声称业务已经恶化。',
      answerClaims: [],
      findings: [],
      recommendations: [],
      followUps: ['模型生成的暗示性问题'],
    }, '最近表现怎么样');

    expect(answer.answer).toContain('当前信息不足');
    expect(JSON.stringify(answer)).not.toContain('恶化');
    expect(JSON.stringify(answer)).not.toContain('暗示性');
  });

  it('rejects answered output when a tenant query exceeds fresh catalog coverage', () => {
    const ledger = new CommerceEvidenceLedger({
      requireFreshCatalogForAnswered: true,
      maxDataAgeHours: 72,
      now: () => Date.parse('2026-07-27T12:00:00.000Z'),
    });
    ledger.record({
      operation: 'commerce.describe_data',
      request: {},
      data: {
        coverage: {
          start: '2026-07-01',
          end: '2026-07-26',
          lastIngestedAt: '2026-07-27T10:00:00.000Z',
          sourceUpdatedAt: '2018-10-17T20:30:18.000Z',
          dataMode: 'snapshot',
          rowCount: 100,
        },
        dimensions: { region: ['华东'], channel: [], sku: [], category: [] },
      },
      rowCount: 100,
    });
    const comparison = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        filters: { regions: ['华东'], channels: [], skus: [], categories: [] },
      },
      data: { current: { gmv: 100 } },
      rowCount: 1,
    });

    expect(() => ledger.verifyAnswer(
      groundedAnswer(comparison.evidenceId),
      '查看六月 GMV',
    )).toThrow(/超出.*覆盖范围/u);
  });

  it('builds deterministic claims only from analytical evidence fields', () => {
    const ledger = new CommerceEvidenceLedger();
    ledger.record({
      operation: 'commerce.describe_data',
      request: {},
      data: {
        coverage: {
          start: '2018-08-01',
          end: '2018-08-31',
          lastIngestedAt: '2026-08-02T01:00:00.000Z',
          sourceUpdatedAt: '2018-10-17T20:30:18.000Z',
          dataMode: 'snapshot',
          rowCount: 31,
        },
        metrics: [{ id: 'gmv' }, { id: 'paid_orders' }],
      },
      rowCount: 31,
    });
    const comparison = ledger.record({
      operation: 'commerce.compare_metrics',
      request: { current: { start: '2018-08-01', end: '2018-08-31' } },
      data: { current: { gmv: 848860.1, paid_orders: 6421 } },
      rowCount: 1,
    });

    const answer = ledger.deterministicAnswer('needs_clarification');

    expect(answer.status).toBe('answered');
    expect(answer.answerClaims).toEqual([
      {
        evidenceId: comparison.evidenceId,
        path: '/current/gmv',
        metric: 'gmv',
        value: 848860.1,
        unit: 'currency',
      },
      {
        evidenceId: comparison.evidenceId,
        path: '/current/paid_orders',
        metric: 'paid_orders',
        value: 6421,
        unit: 'integer',
      },
    ]);
    expect(answer.findings.map((finding) => finding.metric)).toEqual(['gmv', 'paid_orders']);
  });

  it('caps per-finding claims when one metric is split across several dimensions', () => {
    const ledger = new CommerceEvidenceLedger();
    const filters = { regions: [], channels: [], skus: [], categories: [] };
    for (const dimension of ['region', 'channel', 'category'] as const) {
      ledger.record({
        operation: 'commerce.breakdown_metric',
        request: {
          current: { start: '2018-05-07', end: '2018-05-13' },
          baseline: { start: '2018-04-30', end: '2018-05-06' },
          metric: 'gmv',
          dimension,
          filters,
          limit: 12,
          sort: 'absolute_change_desc',
        },
        data: Array.from({ length: 4 }, (_, index) => ({
          key: `${dimension}-${index}`,
          current: 100 - index,
          baseline: 80 - index,
          absoluteChange: 20,
          percentChange: 0.25,
        })),
        rowCount: 4,
      });
    }

    const answer = ledger.deterministicAnswer('needs_clarification');

    expect(answer.status).toBe('answered');
    expect(answer.findings).toHaveLength(1);
    expect(answer.findings[0]?.claims).toHaveLength(12);
    expect(answer.answerClaims.length).toBeGreaterThan(12);
  });

  it('surfaces the head breakdown without treating a normal analysis request as executive', () => {
    const question = '分析 2026 年 6 月 GMV，指出表现最好的州';
    const scope = resolvedScope(question);
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });
    const filters = { regions: [], channels: [], skus: [], categories: [] };
    ledger.record({
      operation: 'commerce.compare_metrics',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metrics: ['gmv'],
        filters,
      },
      data: { current: { gmv: 100 }, baseline: null, changes: null },
      rowCount: 1,
    });
    const breakdown = ledger.record({
      operation: 'commerce.breakdown_metric',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metric: 'gmv',
        dimension: 'region',
        filters,
        limit: 5,
        sort: 'current_desc',
      },
      data: [
        {
          key: 'SP', currentPresent: true, baselinePresent: null,
          current: 60, baseline: null, absoluteChange: null, percentChange: null,
        },
        {
          key: 'RJ', currentPresent: true, baselinePresent: null,
          current: 40, baseline: null, absoluteChange: null, percentChange: null,
        },
      ],
      rowCount: 2,
    });

    const rendered = ledger.verifyAnswer(ledger.deterministicAnswer('needs_clarification'), question);

    expect(scope.executive).toBe(false);
    expect(scope.requiredViews).toContain('breakdown');
    expect(rendered.answer).toContain('SP');
    expect(rendered.answerClaims).toContainEqual({
      evidenceId: breakdown.evidenceId,
      path: '/0/current',
      metric: 'gmv',
      value: 60,
      unit: 'currency',
    });
    expect(rendered.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: '头部拆解 · GMV',
        detail: expect.stringContaining('SP'),
      }),
    ]));
    expect(rendered.recommendations).toEqual([]);
    expect(rendered.answer).not.toContain('经营是否真正健康');
  });

  it('answers a category top-five request with the leader, concentration, readable keys, and scoped follow-ups', () => {
    const question = '分析 2026 年 6 月 GMV 和支付订单，按品类列出前五名，并指出表现最好的品类';
    const scope = resolvedScope(question);
    const ledger = new CommerceEvidenceLedger({ queryScope: scope });
    const filters = { regions: [], channels: [], skus: [], categories: [] };
    ledger.record({
      operation: 'commerce.compare_metrics',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metrics: ['gmv', 'paid_orders'],
        filters,
      },
      data: {
        current: { gmv: 1_000, paid_orders: 100 },
        baseline: null,
        changes: null,
      },
      rowCount: 1,
    });
    ledger.record({
      operation: 'commerce.breakdown_metric',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metric: 'gmv',
        dimension: 'category',
        filters,
        limit: 5,
        sort: 'current_desc',
      },
      data: [
        { key: 'health_beauty', current: 300 },
        { key: 'watches_gifts', current: 200 },
        { key: 'bed_bath_table', current: 150 },
        { key: 'housewares', current: 100 },
        { key: 'sports_leisure', current: 50 },
      ],
      rowCount: 5,
    });
    ledger.record({
      operation: 'commerce.breakdown_metric',
      request: {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: null,
        metric: 'paid_orders',
        dimension: 'category',
        filters,
        limit: 5,
        sort: 'current_desc',
      },
      data: [
        { key: 'health_beauty', current: 30 },
        { key: 'bed_bath_table', current: 20 },
        { key: 'housewares', current: 15 },
        { key: 'sports_leisure', current: 10 },
        { key: 'furniture_decor', current: 5 },
      ],
      rowCount: 5,
    });

    const rendered = ledger.verifyAnswer(ledger.deterministicAnswer('needs_clarification'), question);

    expect(rendered.answer).toContain('美妆健康（health_beauty）');
    expect(rendered.answer).toContain('本期GMV为¥1,000.00，支付订单为100');
    expect(rendered.answer).toContain('在GMV和支付订单两项排名中均位列第一');
    expect(rendered.answer).toContain('前五名依次为');
    expect(rendered.answer).toContain('榜首占当期GMV 30%');
    expect(rendered.answer).toContain('集中度为80%');
    expect(rendered.answer).not.toContain('关键证据：');
    expect(rendered.answer).not.toMatch(/已完成.*核验|缺少可比变化/u);
    expect(rendered.findings.map((finding) => finding.title)).toEqual([
      '头部拆解 · GMV',
      '头部拆解 · 支付订单',
    ]);
    expect(rendered.followUps.every((followUp) => (
      followUp.includes('2026-06-01 至 2026-06-30')
    ))).toBe(true);
    expect(resolvedScope(rendered.followUps[0]!).current).toEqual({
      start: '2026-06-01',
      end: '2026-06-30',
    });
  });

  it('detects requested metrics that are absent from the tenant catalog', () => {
    const ledger = new CommerceEvidenceLedger();
    ledger.record({
      operation: 'commerce.describe_data',
      request: {},
      data: {
        coverage: {
          start: '2016-09-04',
          end: '2018-09-03',
          lastIngestedAt: '2026-08-02T01:00:00.000Z',
          sourceUpdatedAt: '2018-10-17T20:30:18.000Z',
          dataMode: 'snapshot',
          rowCount: 10_689,
        },
        metrics: [
          { id: 'gmv' },
          { id: 'paid_orders' },
          { id: 'units' },
          { id: 'new_customers' },
        ],
      },
      rowCount: 10_689,
    });

    expect(ledger.questionRequestsUnavailableMetric('查看 2018 年 8 月 GMV')).toBe(false);
    expect(ledger.questionRequestsUnavailableMetric('查看流量、广告消耗和 ROAS')).toBe(true);
    expect(ledger.questionRequestsUnavailableMetric('查看毛利率')).toBe(true);
  });

  it('renders currency claims using the tenant catalog currency instead of a hardcoded CNY', () => {
    const ledger = new CommerceEvidenceLedger();
    ledger.record({
      operation: 'commerce.describe_data',
      request: {},
      data: {
        currencyCode: 'BRL',
        coverage: {
          start: '2018-08-01',
          end: '2018-08-31',
          lastIngestedAt: '2026-08-02T01:00:00.000Z',
          sourceUpdatedAt: '2018-10-17T20:30:18.000Z',
          dataMode: 'snapshot',
          rowCount: 31,
        },
      },
      rowCount: 31,
    });
    const evidence = ledger.record({
      operation: 'commerce.compare_metrics',
      request: {},
      data: { current: { gmv: 848_860.1 } },
      rowCount: 1,
    });

    const answer = ledger.verifyAnswer(groundedAnswer(evidence.evidenceId, 848_860.1), '查看 GMV');

    expect(answer.answer).toContain('R$');
    expect(answer.answer).not.toContain('CNY');
    expect(answer.answer).not.toContain('¥');
  });
});

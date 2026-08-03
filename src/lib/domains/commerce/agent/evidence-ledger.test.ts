import { describe, expect, it } from 'vitest';

import { CommerceEvidenceLedger, CommerceGroundingError } from './evidence-ledger';
import type { CommerceAgentAnswer } from './types';

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
    expect(answer.answer).toContain('数据事实');
    expect(answer.answer).toContain('100.00');
    expect(answer.findings[0]).toMatchObject({ metric: 'gmv', title: 'GMV观察' });
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
});

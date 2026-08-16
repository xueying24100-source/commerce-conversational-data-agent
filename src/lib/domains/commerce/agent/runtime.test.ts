import { describe, expect, it, vi } from 'vitest';

import type {
  MoAgentModelEvent,
  MoAgentModelProvider,
  MoAgentModelRequest,
} from '@/lib/agent/types';
import {
  commerceMetricDefinitions,
  type CommerceAnalyticsRepository,
} from './analytics-repository';
import {
  addCommerceBusinessDays,
  evaluateCommerceDataHealth,
  previousComparableRanges,
  scanCommerceKpis,
} from './diagnostics';
import { boundedCommerceHistory, runCommerceAgentTurn } from './runtime';
import { commerceDateRangeSchema, type CommerceConversationMessage } from './types';

function toolTurn(name: string, input: unknown, call: number): MoAgentModelEvent[] {
  return [
    { type: 'response_start', responseId: `response-${call}`, model: 'scripted-commerce' },
    {
      type: 'tool_call_delta',
      index: 0,
      id: `call-${call}`,
      nameDelta: name,
      argumentsDelta: JSON.stringify(input),
    },
    {
      type: 'usage',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ];
}

class CommerceScriptedProvider implements MoAgentModelProvider {
  readonly name = 'scripted';
  calls = 0;
  readonly requestedMaxTokens: number[] = [];
  readonly requestedToolChoices: Array<string | null> = [];
  readonly requestedTools: string[][] = [];
  systemPrompt = '';

  async *complete(request: MoAgentModelRequest): AsyncIterable<MoAgentModelEvent> {
    this.calls += 1;
    const system = request.messages.find((message) => message.role === 'system');
    if (system?.role === 'system') this.systemPrompt = system.content;
    this.requestedMaxTokens.push(request.maxTokens ?? 0);
    this.requestedToolChoices.push(
      typeof request.toolChoice === 'string'
        ? request.toolChoice
        : request.toolChoice?.name ?? null,
    );
    this.requestedTools.push((request.tools || []).map((tool) => tool.name));
    let events: MoAgentModelEvent[];
    events = toolTurn('compare_commerce_metrics', {
      current: { start: '2026-06-01', end: '2026-06-30' },
      metrics: ['gmv'],
      filters: { regions: [], channels: [], skus: [], categories: [] },
    }, this.calls);
    for (const event of events) yield event;
  }
}

class ExecutiveScriptedProvider implements MoAgentModelProvider {
  readonly name: string = 'executive-scripted';
  calls = 0;
  readonly requestedTools: string[][] = [];

  async *complete(request: MoAgentModelRequest): AsyncIterable<MoAgentModelEvent> {
    this.calls += 1;
    const tools = (request.tools || []).map((tool) => tool.name);
    this.requestedTools.push(tools);
    if (tools.includes('compare_commerce_metrics')) {
      yield* toolTurn('compare_commerce_metrics', {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: { start: '2026-05-01', end: '2026-05-31' },
        metrics: ['gmv'],
        filters: { regions: [], channels: [], skus: [], categories: [] },
      }, this.calls);
      return;
    }
    if (tools.includes('breakdown_commerce_metric')) {
      yield* toolTurn('breakdown_commerce_metric', {
        current: { start: '2026-06-01', end: '2026-06-30' },
        baseline: { start: '2026-05-01', end: '2026-05-31' },
        metric: 'gmv',
        dimension: 'region',
        filters: { regions: [], channels: [], skus: [], categories: [] },
        limit: 5,
        sort: 'absolute_change_desc',
      }, this.calls);
      return;
    }
    yield* toolTurn('trend_commerce_metric', {
      range: { start: '2026-06-01', end: '2026-06-30' },
      metric: 'gmv',
      grain: 'month',
      filters: { regions: [], channels: [], skus: [], categories: [] },
    }, this.calls);
  }
}

class ExecutiveEarlyProseProvider extends ExecutiveScriptedProvider {
  override readonly name = 'executive-early-prose';

  override async *complete(request: MoAgentModelRequest): AsyncIterable<MoAgentModelEvent> {
    if (this.calls === 0) {
      this.calls += 1;
      this.requestedTools.push((request.tools || []).map((tool) => tool.name));
      yield { type: 'response_start', responseId: 'response-early-prose', model: 'scripted-commerce' };
      yield { type: 'text_delta', delta: 'I am done.' };
      yield { type: 'finish', reason: 'stop', rawReason: 'stop' };
      return;
    }
    yield* super.complete(request);
  }
}

const repository: CommerceAnalyticsRepository = {
  async getCatalog() {
    return {
      dataset: 'commerce_daily_metrics',
      timezone: 'Asia/Shanghai',
      currencyCode: 'CNY',
      coverage: {
        start: '2026-01-01',
        end: '2026-06-30',
        lastIngestedAt: new Date().toISOString(),
        sourceUpdatedAt: new Date().toISOString(),
        dataMode: 'snapshot' as const,
        rowCount: 1_000,
      },
      metrics: [{
        id: 'gmv',
        label: 'GMV',
        format: 'currency',
        description: 'GMV',
        aggregation: 'sum',
        additivity: 'additive',
        additiveDimensions: ['region', 'channel', 'sku', 'category'],
      }],
      dimensions: { region: ['华东'], channel: ['搜索'], sku: ['SKU-1'], category: ['服饰'] },
    };
  },
  async findMentionedEntities() { return []; },
  async compareMetrics(_tenantId, request) {
    return {
      current: { gmv: 100 } as never,
      baseline: request.baseline ? { gmv: 80 } as never : null,
      changes: request.baseline
        ? { gmv: { absolute: 20, percent: 0.25 } } as never
        : null,
    };
  },
  async lookupEntities() { return []; },
  async breakdown() {
    return [{
      key: '华东',
      currentPresent: true,
      baselinePresent: true,
      current: 60,
      baseline: 40,
      absoluteChange: 20,
      percentChange: 0.5,
    }];
  },
  async trend() {
    return [
      { bucket: '2026-06-01', value: 40 },
      { bucket: '2026-06-30', value: 60 },
    ];
  },
  async inventoryRisk() { return []; },
};

function weeklyDiagnosticRepository(input: {
  missingVisits?: boolean;
  currentVisits?: number;
  currentConversion?: number;
  currentAov?: number;
  coverageStart?: string;
  coverageEnd?: string;
  virtualAsOf?: string;
  sourceUpdatedAt?: string;
  zeroFactDate?: string;
  breakdownRows?: Array<{
    key: string;
    currentPresent: boolean;
    baselinePresent: boolean;
    current: number;
    baseline: number;
    absoluteChange: number;
    percentChange: number;
  }>;
} = {}): CommerceAnalyticsRepository {
  const sourceUpdatedAt = input.sourceUpdatedAt ?? '2026-07-13T02:00:00.000Z';
  const availableSourceMetrics = input.missingVisits
    ? ['paid_orders', 'gmv']
    : ['visits', 'paid_orders', 'gmv'];
  const metrics = commerceMetricDefinitions(availableSourceMetrics);
  const dimensions = {
    region: ['华东', '华南'],
    channel: ['自然搜索', '付费社媒'],
    sku: ['SKU-1', 'SKU-2'],
    category: ['服饰', '家居'],
  };
  return {
    ...repository,
    async getCatalog() {
      return {
        dataset: 'commerce_daily_metrics',
        timezone: 'Asia/Shanghai',
        currencyCode: 'CNY',
        coverage: {
          start: input.coverageStart ?? '2026-01-01',
          end: input.coverageEnd ?? '2026-07-31',
          lastIngestedAt: sourceUpdatedAt,
          sourceUpdatedAt,
          virtualAsOf: input.virtualAsOf,
          dataMode: 'snapshot' as const,
          rowCount: 10_000,
        },
        metrics,
        dimensions,
      };
    },
    async inspectDataHealth(_tenantId, request) {
      const partitions = [];
      for (
        let date = request.range.start;
        date <= request.range.end;
        date = addCommerceBusinessDays(date, 1)
      ) {
        partitions.push({
          date,
          state: 'ready' as const,
          factRowCount: date === input.zeroFactDate ? 0 : 10,
          sourceWatermark: sourceUpdatedAt,
        });
      }
      return evaluateCommerceDataHealth({
        range: request.range,
        availableMetrics: metrics.map((metric) => metric.id),
        availableDimensions: ['region', 'channel', 'sku', 'category'],
        dimensionCoverage: { region: 1, channel: 1, sku: 1, category: 1 },
        partitions,
        dataMode: 'snapshot',
        sourceWatermark: sourceUpdatedAt,
        connectorStatus: 'ready',
        sourceAuditPassed: true,
        reconciliationConflict: false,
        requiredMetrics: request.requiredMetrics,
        requiredDimensions: request.requiredDimensions,
        requireProductDimension: request.requireProductDimension,
        optionalMetrics: request.optionalMetrics,
      });
    },
    async scanWeeklyKpis(_tenantId, request) {
      const currentVisits = input.currentVisits ?? 700;
      const currentConversion = input.currentConversion ?? 0.1;
      const currentAov = input.currentAov ?? 100;
      const paidOrders = currentVisits * currentConversion;
      const currentValues = {
        visits: currentVisits,
        conversion_rate: currentConversion,
        paid_orders: paidOrders,
        average_order_value: currentAov,
        gmv: paidOrders * currentAov,
      };
      const ranges = previousComparableRanges(request.current, 4);
      return scanCommerceKpis({
        currentRange: request.current,
        current: currentValues,
        baselineWeeks: ranges.map((range, index) => ({
          range,
          values: {
            visits: 1_000 + index * 5,
            conversion_rate: 0.1,
            paid_orders: 100 + index * 0.5,
            average_order_value: 100,
            gmv: 10_000 + index * 50,
          },
        })),
        metrics: request.metrics,
      });
    },
    async breakdown(_tenantId, request) {
      return input.breakdownRows ?? [
        {
          key: request.dimension === 'channel' ? '付费社媒' : '华东',
          currentPresent: true,
          baselinePresent: true,
          current: 300,
          baseline: 600,
          absoluteChange: -300,
          percentChange: -0.5,
        },
        {
          key: request.dimension === 'channel' ? '自然搜索' : '华南',
          currentPresent: true,
          baselinePresent: true,
          current: 400,
          baseline: 400,
          absoluteChange: 0,
          percentChange: 0,
        },
      ];
    },
  };
}

describe('conversational Commerce Agent runtime', () => {
  it('rejects calendar-normalized dates before PostgreSQL sees them', () => {
    expect(commerceDateRangeSchema.safeParse({
      start: '2026-02-30',
      end: '2026-03-02',
    }).success).toBe(false);
  });

  it('applies the character budget to complete user/assistant turns', () => {
    const history = [
      ['run_old', 'user', 'u'.repeat(30)],
      ['run_old', 'assistant', 'a'.repeat(30)],
      ['run_latest', 'user', 'latest user'],
      ['run_latest', 'assistant', 'latest answer'],
      ['run_failed', 'user', 'must not leak'],
    ].map(([runId, role, content], index): CommerceConversationMessage => ({
      id: `history_${index}`,
      role: role as 'user' | 'assistant',
      content,
      answer: null,
      runId,
      runStatus: runId === 'run_failed' ? 'failed' : 'completed',
      reportAvailable: false,
      traces: [],
      createdAt: new Date(index * 1_000).toISOString(),
    }));

    const bounded = boundedCommerceHistory(history, 4, 30);

    expect(bounded.map((entry) => [entry.runId, entry.role])).toEqual([
      ['run_latest', 'user'],
      ['run_latest', 'assistant'],
    ]);
  });

  it('deterministically converges through describe, compare and grounded submit', async () => {
    const provider = new CommerceScriptedProvider();

    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_test',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '查看 2026 年 6 月的 GMV。',
      history: [],
      repository,
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-runtime-test',
    });

    expect(provider.calls).toBe(0);
    expect(result.answer.status).toBe('answered');
    expect(result.answer.answer).toContain('100.00');
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.inspect_data_health',
      'commerce.compare_metrics',
    ]);
    expect(result.traces.every((trace) => Boolean(trace.sourceWatermark))).toBe(true);
    expect(result.usage.totalTokens).toBe(0);
  });

  it('honors an explicit lookup-first request before deterministic inventory analysis', async () => {
    const provider = new CommerceScriptedProvider();
    const lookupRepository: CommerceAnalyticsRepository = {
      ...repository,
      async getCatalog() {
        const catalog = await repository.getCatalog('tenant_test');
        return {
          ...catalog,
          coverage: { ...catalog.coverage, end: '2026-07-31' },
          metrics: commerceMetricDefinitions(['gmv', 'stockout_hours', 'ending_inventory']),
          dimensions: { ...catalog.dimensions, sku: ['SKU-RISK'] },
        };
      },
      async findMentionedEntities() {
        return [{ dimension: 'sku', value: 'SKU-RISK' }];
      },
      async lookupEntities() {
        return [{ value: 'SKU-RISK', factRows: 7 }];
      },
      async inventoryRisk() {
        return [{
          sku: 'SKU-RISK',
          category: '风险商品',
          stockoutHours: 12,
          minimumEndingInventory: 0,
          lastSourceUpdate: '2026-07-07T00:00:00.000Z',
        }];
      },
    };

    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_test',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '请先检索 SKU-RISK，再使用库存风险工具检查 2026-07-01 到 2026-07-07 的缺货情况。',
      history: [],
      repository: lookupRepository,
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-lookup-first-runtime-test',
    });

    expect(provider.calls).toBe(0);
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.inspect_data_health',
      'commerce.lookup_entities',
      'commerce.inventory_risk',
    ]);
  });

  it('returns a specific clarification without executing analytical reads', async () => {
    const provider = new CommerceScriptedProvider();
    let analyticalReads = 0;
    const clarificationRepository: CommerceAnalyticsRepository = {
      ...repository,
      async compareMetrics() {
        analyticalReads += 1;
        return repository.compareMetrics('tenant_test', {
          current: { start: '2026-06-01', end: '2026-06-30' },
          metrics: ['gmv'],
          filters: { regions: [], channels: [], skus: [], categories: [] },
        });
      },
    };

    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_test',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '查看 GMV',
      history: [],
      repository: clarificationRepository,
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-clarification-runtime-test',
    });

    expect(provider.calls).toBe(0);
    expect(analyticalReads).toBe(0);
    expect(result.answer.status).toBe('needs_clarification');
    expect(result.answer.answer).toContain('开始和结束日期');
    expect(result.traces.map((trace) => trace.operation)).toEqual(['commerce.describe_data']);
  });

  it('collects distinct comparison, driver and trend evidence for executive diagnosis', async () => {
    const provider = new ExecutiveScriptedProvider();

    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_test',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断当前经营表现、增长驱动和风险。',
      history: [],
      repository,
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-executive-runtime-test',
    });

    expect(provider.calls).toBe(2);
    expect(provider.requestedTools).toHaveLength(2);
    expect(provider.requestedTools[1]).not.toContain('compare_commerce_metrics');
    expect(provider.requestedTools[1]).toContain('breakdown_commerce_metric');
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.inspect_data_health',
      'commerce.compare_metrics',
      'commerce.breakdown_metric',
      'commerce.trend_metric',
    ]);
    expect(result.answer.answer).toContain('经营');
    expect(result.answer.recommendations.length).toBeGreaterThan(0);
  });

  it('does not let assistant prose terminate executive diagnosis before required views exist', async () => {
    const provider = new ExecutiveEarlyProseProvider();

    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_test',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断当前经营表现、增长驱动和风险。',
      history: [],
      repository,
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-executive-early-prose-test',
    });

    expect(provider.calls).toBe(2);
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.inspect_data_health',
      'commerce.compare_metrics',
      'commerce.breakdown_metric',
      'commerce.trend_metric',
    ]);
    expect(result.answer.status).toBe('answered');
  });

  it('runs the flagship health gate, robust scan and result-driven investigation without model routing', async () => {
    const provider = new CommerceScriptedProvider();
    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_weekly',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断上一完整周经营表现',
      history: [],
      repository: weeklyDiagnosticRepository(),
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-weekly-diagnostic-test',
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(provider.calls).toBe(0);
    expect(result.answer.status).toBe('answered');
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.inspect_data_health',
      'commerce.scan_weekly_kpis',
      'commerce.diagnostic_decision',
      'commerce.breakdown_metric',
      'commerce.diagnostic_decision',
    ]);
    const firstDecision = result.traces.find((trace) => (
      trace.operation === 'commerce.diagnostic_decision'
    ));
    expect(firstDecision?.preview).toMatchObject({
      hypothesis: 'traffic_drop',
      chosenNextView: { view: 'breakdown', metric: 'visits', dimension: 'channel' },
    });
    expect(result.answer.answerClaims.some((claim) => claim.metric === 'visits')).toBe(true);
    expect(result.answer.recommendations).toHaveLength(1);
    expect(result.answer.findings.length).toBeLessThanOrEqual(3);
    expect(result.answer.findings.every((finding) => (
      ['observed', 'contribution', 'driver'].includes(finding.insightLevel ?? '')
      && typeof finding.confidence === 'number'
      && finding.alternatives?.length
    ))).toBe(true);
    expect(result.answer.findings.some((finding) => (
      finding.metric === 'visits' && finding.insightLevel === 'driver'
    ))).toBe(true);
    expect(result.answer.diagnostic).toMatchObject({
      objective: 'diagnose_previous_complete_week',
      dataHealth: { status: 'degraded' },
      baseline: { strategy: 'previous_four_complete_weeks_median' },
      stopReason: 'evidence_sufficient',
      driverGate: {
        hypothesis: 'traffic_drop',
        insightLevel: 'driver',
        passed: true,
        reasons: [],
      },
    });
  });

  it('explains a material growth week with a real breakdown instead of claiming the baseline is missing', async () => {
    const provider = new CommerceScriptedProvider();
    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_weekly_growth',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断上一完整周经营表现',
      history: [],
      repository: weeklyDiagnosticRepository({
        currentVisits: 1_300,
        breakdownRows: [
          {
            key: '付费社媒',
            currentPresent: true,
            baselinePresent: true,
            current: 8_000,
            baseline: 5_000,
            absoluteChange: 3_000,
            percentChange: 0.6,
          },
          {
            key: '自然搜索',
            currentPresent: true,
            baselinePresent: true,
            current: 5_000,
            baseline: 5_000,
            absoluteChange: 0,
            percentChange: 0,
          },
        ],
      }),
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-weekly-growth-test',
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(provider.calls).toBe(0);
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.inspect_data_health',
      'commerce.scan_weekly_kpis',
      'commerce.diagnostic_decision',
      'commerce.breakdown_metric',
      'commerce.diagnostic_decision',
    ]);
    expect(result.traces.find((trace) => (
      trace.operation === 'commerce.diagnostic_decision'
    ))?.preview).toMatchObject({
      hypothesis: 'growth_driver',
      chosenNextView: { view: 'breakdown', metric: 'gmv', dimension: 'channel' },
    });
    expect(result.answer.answer).toContain('明确的增长周');
    expect(result.answer.answer).toContain('较此前四个完整周中位数');
    expect(result.answer.answer).toContain('增长结构：支付订单');
    expect(result.answer.answer).toContain('解释了');
    expect(result.answer.answer).toContain('渠道定位（此处基准为最近完整周');
    expect(result.answer.answer).not.toContain('缺少可比基准');
    expect(result.answer.findings.some((finding) => (
      finding.metric === 'gmv' && finding.title.includes('明确增长周')
    ))).toBe(true);
    expect(result.answer.findings.some((finding) => (
      finding.title.includes('订单量主导')
    ))).toBe(true);
    expect(result.answer.findings.some((finding) => (
      finding.title.includes('渠道来源')
    ))).toBe(true);
    expect(result.answer.recommendations).toHaveLength(1);
    expect(result.answer.recommendations[0]?.action).toContain('付费社媒');
    expect(result.answer.recommendations[0]?.action).toContain('可持续性');
    expect(result.answer.recommendations[0]?.rationale).toContain('当前没有可验证拖累项');
    expect(result.answer.recommendations[0]?.rationale).not.toContain('治理持续拖累项');
    expect(result.answer.followUps[0]).toContain('负向项（如有）');
    expect(result.answer.answerClaims.find((claim) => (
      claim.metric === 'gmv' && claim.unit === 'percent'
    ))?.path).toMatch(/^\/signals\/\d+\/relativeChange$/u);
    expect(result.answer.diagnostic).toMatchObject({
      stopReason: 'evidence_sufficient',
      driverGate: { hypothesis: 'growth_driver', passed: true },
    });
  });

  it('names verified negative channels in both the diagnosis and its single action', async () => {
    const provider = new CommerceScriptedProvider();
    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_weekly_growth_split',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断上一完整周经营表现',
      history: [],
      repository: weeklyDiagnosticRepository({
        currentVisits: 1_300,
        breakdownRows: [
          {
            key: '自然搜索',
            currentPresent: true,
            baselinePresent: true,
            current: 9_000,
            baseline: 5_000,
            absoluteChange: 4_000,
            percentChange: 0.8,
          },
          {
            key: '直接访问',
            currentPresent: true,
            baselinePresent: true,
            current: 3_000,
            baseline: 5_000,
            absoluteChange: -2_000,
            percentChange: -0.4,
          },
          {
            key: '邮件',
            currentPresent: true,
            baselinePresent: true,
            current: 4_000,
            baseline: 5_000,
            absoluteChange: -1_000,
            percentChange: -0.2,
          },
        ],
      }),
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-weekly-growth-split-test',
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(result.answer.answer).toContain('负向项为直接访问');
    expect(result.answer.answer).toContain('邮件');
    expect(result.answer.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        title: expect.stringContaining('渠道分化'),
        detail: expect.stringContaining('直接访问'),
      }),
    ]));
    expect(result.answer.recommendations).toHaveLength(1);
    expect(result.answer.recommendations[0]?.action).toContain('直接访问、邮件回落');
    expect(result.answer.recommendations[0]?.action).toContain('自然搜索增量质量');
    expect(result.answer.recommendations[0]?.claims.length).toBeLessThanOrEqual(12);
    expect(result.answer.recommendations[0]?.claims.some((claim) => (
      claim.metric === 'conversion_rate' && claim.path.includes('/current')
    ))).toBe(true);
    expect(result.answer.recommendations[0]?.guardrails).toEqual(expect.arrayContaining([
      expect.objectContaining({ metric: 'conversion_rate', operator: 'not_below' }),
    ]));
    expect(result.answer.recommendations[0]?.guardrails?.filter((guardrail) => (
      guardrail.metric === 'conversion_rate'
    ))).toHaveLength(1);
  });

  it('stops a healthy flagship week early without manufacturing an action', async () => {
    const provider = new CommerceScriptedProvider();
    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_weekly',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断上一完整周经营表现',
      history: [],
      repository: weeklyDiagnosticRepository({ currentVisits: 1_007.5 }),
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-weekly-stable-test',
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(provider.calls).toBe(0);
    expect(result.answer.status).toBe('answered');
    expect(result.answer.recommendations).toEqual([]);
    expect(result.answer.answer).toContain('常态范围');
    expect(result.answer.answer).toContain('不生成经营行动');
    expect(result.answer.findings[0]).toMatchObject({
      title: expect.stringContaining('常态范围'),
      detail: expect.stringContaining('没有证据支持继续归因或生成行动'),
    });
    expect(result.answer.findings[0]?.detail).not.toContain('下一步应');
    expect(result.answer.diagnostic?.stopReason).toBe('no_material_anomaly');
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.inspect_data_health',
      'commerce.scan_weekly_kpis',
      'commerce.diagnostic_decision',
    ]);
  });

  it('does not misattribute a proof-backed zero-fact day to a channel driver', async () => {
    const provider = new CommerceScriptedProvider();
    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_weekly_zero_day',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断上一完整周经营表现',
      history: [],
      repository: {
        ...weeklyDiagnosticRepository({ zeroFactDate: '2026-07-08' }),
        async scanWeeklyKpis(tenantId, request) {
          const scan = await weeklyDiagnosticRepository().scanWeeklyKpis!(tenantId, request);
          return { ...scan, zeroActivityDates: ['2026-07-08'] };
        },
      },
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-weekly-zero-day-test',
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(provider.calls).toBe(0);
    expect(result.answer.status).toBe('answered');
    expect(result.answer.recommendations).toEqual([]);
    expect(result.answer.diagnostic).toMatchObject({
      stopReason: 'no_material_anomaly',
      driverGate: null,
    });
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.inspect_data_health',
      'commerce.scan_weekly_kpis',
      'commerce.diagnostic_decision',
    ]);
  });

  it('binds a historical snapshot run to its virtual business date instead of wall time', async () => {
    const provider = new CommerceScriptedProvider();
    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_historical_snapshot',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断上一完整周经营表现',
      history: [],
      repository: weeklyDiagnosticRepository({
        coverageStart: '2018-01-01',
        coverageEnd: '2018-10-17',
        virtualAsOf: '2018-10-17T12:00:00.000Z',
        sourceUpdatedAt: '2018-10-17T10:00:00.000Z',
        currentVisits: 1_007.5,
      }),
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-historical-virtual-clock-test',
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(result.answer.diagnostic).toMatchObject({
      referenceDate: '2018-10-17',
      dataHealth: { dataMode: 'snapshot' },
    });
    expect(result.traces.find((trace) => (
      trace.operation === 'commerce.scan_weekly_kpis'
    ))?.request).toMatchObject({
      current: { start: '2018-10-08', end: '2018-10-14' },
      __queryScope: {
        resolved: {
          referenceDate: '2018-10-17',
          referenceInstant: '2018-10-17T12:00:00.000Z',
        },
      },
    });
  });

  it('detects aggregate/segment structure contradiction before promoting a conversion driver', async () => {
    const provider = new CommerceScriptedProvider();
    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_weekly',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断上一完整周经营表现',
      history: [],
      repository: weeklyDiagnosticRepository({
        currentVisits: 1_007.5,
        currentConversion: 0.07,
        breakdownRows: [
          {
            key: '付费社媒',
            currentPresent: true,
            baselinePresent: true,
            current: 0.11,
            baseline: 0.1,
            absoluteChange: 0.01,
            percentChange: 0.1,
          },
          {
            key: '自然搜索',
            currentPresent: true,
            baselinePresent: true,
            current: 0.12,
            baseline: 0.11,
            absoluteChange: 0.01,
            percentChange: 0.090_909,
          },
        ],
      }),
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-weekly-structure-change-test',
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(result.answer.recommendations).toEqual([]);
    expect(result.answer.diagnostic).toMatchObject({
      stopReason: 'no_legal_candidate',
      driverGate: null,
    });
    expect(result.traces.filter((trace) => (
      trace.operation === 'commerce.diagnostic_decision'
    )).at(-1)?.preview).toMatchObject({
      decisionCode: 'stop_no_legal_candidate',
    });
  });

  it('stops after the deterministic weekly scan while anomaly rollout is disabled', async () => {
    vi.stubEnv('COMMERCE_ANOMALY_DETECTION_ENABLED', 'false');
    try {
      const provider = new CommerceScriptedProvider();
      const result = await runCommerceAgentTurn({
        identity: {
          tenantId: 'tenant_weekly',
          userId: 'user_test',
          displayName: 'Test operator',
          scopes: ['commerce:data:read'],
          authMode: 'development',
        },
        question: '诊断上一完整周经营表现',
        history: [],
        repository: weeklyDiagnosticRepository(),
        modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
        runId: 'commerce-agent-weekly-anomaly-disabled-test',
        now: () => new Date('2026-07-15T12:00:00.000Z'),
      });

      expect(provider.calls).toBe(0);
      expect(result.answer.status).toBe('answered');
      expect(result.answer.recommendations).toEqual([]);
      expect(result.traces.map((trace) => trace.operation)).toEqual([
        'commerce.describe_data',
        'commerce.inspect_data_health',
        'commerce.scan_weekly_kpis',
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('fails closed before any business analysis when a flagship capability is missing', async () => {
    const provider = new CommerceScriptedProvider();
    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_weekly',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '诊断上一完整周经营表现',
      history: [],
      repository: weeklyDiagnosticRepository({ missingVisits: true }),
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-weekly-health-block-test',
      now: () => new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(provider.calls).toBe(0);
    expect(result.answer.status).toBe('needs_clarification');
    expect(result.answer.recommendations).toEqual([]);
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.inspect_data_health',
    ]);
  });
});

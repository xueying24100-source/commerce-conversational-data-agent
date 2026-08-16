import { describe, expect, it } from 'vitest';

import { resolveCommerceQueryScope } from './query-scope';
import type {
  CommerceAgentAnswer,
  CommerceCatalog,
  CommerceConversationMessage,
} from './types';

function catalog(overrides: Partial<CommerceCatalog> = {}): CommerceCatalog {
  return {
    dataset: 'commerce_daily_metrics',
    timezone: 'Asia/Shanghai',
    currencyCode: 'CNY',
    coverage: {
      start: '2025-01-01',
      end: '2026-07-31',
      lastIngestedAt: '2026-08-01T00:00:00.000Z',
      sourceUpdatedAt: '2026-08-01T00:00:00.000Z',
      dataMode: 'snapshot',
      rowCount: 1_000,
    },
    metrics: [
      {
        id: 'gmv', label: 'GMV', format: 'currency', description: 'GMV',
        aggregation: 'sum', additivity: 'additive',
        additiveDimensions: ['region', 'channel', 'sku', 'category'],
      },
      {
        id: 'paid_orders', label: '支付订单', format: 'integer', description: '支付订单',
        aggregation: 'sum', additivity: 'source_allocated_additive',
        additiveDimensions: ['region', 'channel', 'sku', 'category'],
      },
    ],
    dimensions: { region: ['华东'], channel: ['搜索'], sku: ['SKU-1'], category: ['服饰'] },
    ...overrides,
  };
}

function clarificationAnswer(): CommerceAgentAnswer {
  return {
    status: 'needs_clarification',
    answer: '需要补充日期。',
    answerClaims: [],
    findings: [],
    recommendations: [],
    followUps: [],
  };
}

function answeredAnswer(): CommerceAgentAnswer {
  return {
    status: 'answered',
    answer: '已基于证据回答。',
    answerClaims: [],
    findings: [],
    recommendations: [],
    followUps: [],
  };
}

function historyMessage(params: {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer?: CommerceAgentAnswer | null;
}): CommerceConversationMessage {
  return {
    id: params.id,
    role: params.role,
    content: params.content,
    answer: params.answer ?? null,
    runId: `run_${params.id}`,
    runStatus: 'completed',
    reportAvailable: false,
    traces: [],
    createdAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('Commerce query scope resolver', () => {
  it('fails closed when a requested metric has no date range', () => {
    const scope = resolveCommerceQueryScope({
      question: '看一下 GMV',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('needs_clarification');
    expect(scope.metrics).toEqual(['gmv']);
    expect(scope.missingSlots).toEqual(['current_date_range']);
    expect(scope.current).toBeNull();
  });

  it('fills only the missing slot from the latest clarification turn', () => {
    const history: CommerceConversationMessage[] = [
      {
        id: 'message_user',
        role: 'user',
        content: '看一下 GMV',
        answer: null,
        runId: 'run_previous',
        runStatus: 'completed',
        reportAvailable: false,
        traces: [],
        createdAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'message_assistant',
        role: 'assistant',
        content: '请补充日期。',
        answer: clarificationAnswer(),
        runId: 'run_previous',
        runStatus: 'completed',
        reportAvailable: false,
        traces: [],
        createdAt: '2026-07-01T00:00:01.000Z',
      },
    ];

    const scope = resolveCommerceQueryScope({
      question: '2026 年 6 月',
      history,
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.metrics).toEqual(['gmv']);
    expect(scope.current).toEqual({ start: '2026-06-01', end: '2026-06-30' });
    expect(scope.missingSlots).toEqual([]);
  });

  it('inherits only the unique date range explicitly referenced from the latest answered turn', () => {
    const history: CommerceConversationMessage[] = [
      historyMessage({
        id: 'user_answered',
        role: 'user',
        content: '回答 2026-07-01 到 2026-07-07、SKU-1 的 GMV 总额。',
      }),
      historyMessage({
        id: 'assistant_answered',
        role: 'assistant',
        content: '已回答。',
        answer: answeredAnswer(),
      }),
    ];

    const scope = resolveCommerceQueryScope({
      question: '对同一日期范围，请同时使用渠道拆解和按日趋势工具分析 GMV。',
      history,
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.current).toEqual({ start: '2026-07-01', end: '2026-07-07' });
    expect(scope.filters.skus).toEqual([]);
    expect(scope.dimensions).toEqual(['channel']);
    expect(scope.requiredViews).toEqual(['totals', 'breakdown', 'trend']);
    expect(scope.trendGrain).toBe('day');
  });

  it('resolves relative dates in the tenant timezone instead of Asia/Shanghai', () => {
    const scope = resolveCommerceQueryScope({
      question: '查看今天的 GMV',
      catalog: catalog({ timezone: 'America/Los_Angeles' }),
      now: new Date('2026-07-01T01:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.referenceDate).toBe('2026-06-30');
    expect(scope.current).toEqual({ start: '2026-06-30', end: '2026-06-30' });
    expect(scope.timezone).toBe('America/Los_Angeles');
  });

  it.each(['上周', 'last week'])('resolves %s as the previous complete Monday-to-Sunday week', (phrase) => {
    const scope = resolveCommerceQueryScope({
      question: `${phrase} GMV`,
      catalog: catalog({
        coverage: {
          ...catalog().coverage,
          end: '2026-07-31',
        },
      }),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.current).toEqual({ start: '2026-07-06', end: '2026-07-12' });
  });

  it('保留最近一周为截至数据水位的滚动七天', () => {
    const scope = resolveCommerceQueryScope({
      question: '最近一周 GMV',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.current).toEqual({ start: '2026-07-09', end: '2026-07-15' });
  });

  it.each([
    ['refund rate last month', 'refund_rate'],
    ['refund amount last month', 'refund_amount'],
  ] as const)('allows the supported analytical request "%s"', (question, metric) => {
    const scope = resolveCommerceQueryScope({
      question,
      catalog: catalog({
        metrics: [
          {
            id: 'refund_rate', label: '退款率', format: 'percent', description: '退款率',
            aggregation: 'ratio_of_sums', additivity: 'non_additive', additiveDimensions: [],
          },
          {
            id: 'refund_amount', label: '退款金额', format: 'currency', description: '退款金额',
            aggregation: 'sum', additivity: 'additive',
            additiveDimensions: ['region', 'channel', 'sku', 'category'],
          },
        ],
      }),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.metrics).toEqual([metric]);
    expect(scope.reasons).not.toContain('mutation_or_sensitive_request');
  });

  it('still refuses an explicit refund mutation command', () => {
    const scope = resolveCommerceQueryScope({
      question: 'Issue a refund for order 123',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('refused');
    expect(scope.reasons).toContain('mutation_or_sensitive_request');
  });

  it('does not infer a short ASCII filter from a substring inside another word', () => {
    const scope = resolveCommerceQueryScope({
      question: 'business performance current',
      catalog: catalog({
        dimensions: { region: ['US'], channel: [], sku: [], category: [] },
      }),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.filters.regions).toEqual([]);
  });

  it('resolves an explicitly tokenized short ASCII filter', () => {
    const scope = resolveCommerceQueryScope({
      question: 'business performance current for region US',
      catalog: catalog({
        dimensions: { region: ['US'], channel: [], sku: [], category: [] },
      }),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.filters.regions).toEqual(['US']);
    expect(scope.dimensions).toEqual(['region']);
  });

  it('uses server-resolved entity mentions that are outside the bounded catalog preview', () => {
    const scope = resolveCommerceQueryScope({
      question: '查看 2026 年 6 月西北地区的 GMV',
      catalog: catalog({
        dimensions: { region: ['华东'], channel: [], sku: [], category: [] },
      }),
      mentionedEntities: { region: ['西北'] },
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.filters.regions).toEqual(['西北']);
    expect(scope.dimensions).toEqual(['region']);
  });

  it('fails closed when an explicit filter-looking entity cannot be resolved', () => {
    const scope = resolveCommerceQueryScope({
      question: '查看 2026 年 6 月未知地区的 GMV',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('needs_clarification');
    expect(scope.filters.regions).toEqual([]);
    expect(scope.missingSlots).toContain('filters');
    expect(scope.reasons).toContain('unresolved_filter');
  });

  it('parses an English from-to date range as one analysis period', () => {
    const scope = resolveCommerceQueryScope({
      question: 'GMV from 2026-06-01 to 2026-06-30',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.current).toEqual({ start: '2026-06-01', end: '2026-06-30' });
    expect(scope.baseline).toBeNull();
    expect(scope.requiredViews).toEqual(['totals']);
  });

  it('resolves common month-over-month language to an aligned prior month period', () => {
    const scope = resolveCommerceQueryScope({
      question: '本月 GMV 较上月如何',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.current).toEqual({ start: '2026-07-01', end: '2026-07-15' });
    expect(scope.baseline).toEqual({ start: '2026-06-01', end: '2026-06-15' });
    expect(scope.requiredViews).toContain('comparison');
  });

  it('preserves the original filters and dimensions across repeated clarification turns', () => {
    const history: CommerceConversationMessage[] = [
      historyMessage({ id: 'user_1', role: 'user', content: '华东按渠道看一下' }),
      historyMessage({
        id: 'assistant_1',
        role: 'assistant',
        content: '请补充指标和日期。',
        answer: clarificationAnswer(),
      }),
      historyMessage({ id: 'user_2', role: 'user', content: '2026 年 6 月' }),
      historyMessage({
        id: 'assistant_2',
        role: 'assistant',
        content: '请补充指标。',
        answer: clarificationAnswer(),
      }),
    ];

    const scope = resolveCommerceQueryScope({
      question: 'GMV',
      history,
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.current).toEqual({ start: '2026-06-01', end: '2026-06-30' });
    expect(scope.metrics).toEqual(['gmv']);
    expect(scope.filters.regions).toEqual(['华东']);
    expect(scope.dimensions).toEqual(['channel']);
    expect(scope.requiredViews).toEqual(['totals', 'breakdown']);
  });

  it('fails closed for unsupported exclusion filters instead of reversing their meaning', () => {
    const scope = resolveCommerceQueryScope({
      question: '除华东外，查看 2026 年 6 月 GMV',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('needs_clarification');
    expect(scope.missingSlots).toContain('filters');
    expect(scope.reasons).toContain('unsupported_filter_logic');
  });

  it('retains every explicitly requested breakdown dimension', () => {
    const scope = resolveCommerceQueryScope({
      question: '按地区和渠道拆解 2026 年 6 月 GMV',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.dimensions).toEqual(['region', 'channel']);
    expect(scope.requiredViews).toEqual(['totals', 'breakdown']);
  });

  it.each([
    '按州拆解 2026 年 6 月 GMV',
    '各州排名 2026 年 6 月 GMV',
    '表现最好的州是哪个？查看 2026 年 6 月 GMV',
    '按省级分析 2026 年 6 月 GMV',
    'GMV by state from 2026-06-01 to 2026-06-30',
  ])('recognizes %s as a region breakdown request', (question) => {
    const scope = resolveCommerceQueryScope({
      question,
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.dimensions).toEqual(['region']);
    expect(scope.requiredViews).toContain('breakdown');
  });

  it('sorts a best-state ranking by the current metric', () => {
    const scope = resolveCommerceQueryScope({
      question: '表现最好的州 2026 年 6 月 GMV',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.breakdownSort).toBe('current_desc');
  });

  it('parses a Chinese top-five ranking limit', () => {
    const scope = resolveCommerceQueryScope({
      question: '按州列出前五名，查看 2026 年 6 月 GMV',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.breakdownLimit).toBe(5);
  });

  it('does not mistake a best-category ranking for an unresolved category filter', () => {
    const scope = resolveCommerceQueryScope({
      question: '分析 2026 年 6 月 GMV，按品类列出前五名，并指出表现最好的品类',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.dimensions).toEqual(['category']);
    expect(scope.missingSlots).not.toContain('filters');
    expect(scope.breakdownLimit).toBe(5);
  });

  it('records the requested trend grain in the fail-closed scope', () => {
    const scope = resolveCommerceQueryScope({
      question: '查看 2026 年 6 月 GMV 每日趋势',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.requiredViews).toEqual(['totals', 'trend']);
    expect(scope.trendGrain).toBe('day');
  });

  it('refuses relative-date analysis when the tenant timezone is invalid', () => {
    const scope = resolveCommerceQueryScope({
      question: '查看今天的 GMV',
      catalog: catalog({ timezone: 'Not/A_Timezone' }),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('refused');
    expect(scope.reasons).toContain('invalid_timezone');
  });

  it('resolves the flagship objective to the previous complete week and adaptive diagnostic scan', () => {
    const scope = resolveCommerceQueryScope({
      question: '诊断上一完整周经营表现',
      catalog: catalog({
        coverage: { ...catalog().coverage, end: '2026-07-31' },
      }),
      now: new Date('2026-07-15T12:00:00.000Z'),
    });

    expect(scope.status).toBe('ready');
    expect(scope.objective).toBe('weekly_diagnosis');
    expect(scope.current).toEqual({ start: '2026-07-06', end: '2026-07-12' });
    expect(scope.baseline).toEqual({ start: '2026-06-29', end: '2026-07-05' });
    expect(scope.requiredViews).toEqual(['diagnostic_scan']);
  });

  it('does not enter the flagship objective while the diagnostic policy flag is disabled', () => {
    const scope = resolveCommerceQueryScope({
      question: '诊断上一完整周经营表现',
      catalog: catalog(),
      now: new Date('2026-07-15T12:00:00.000Z'),
      weeklyDiagnosisEnabled: false,
    });

    expect(scope.objective).toBe('direct_query');
    expect(scope.requiredViews).not.toContain('diagnostic_scan');
    expect(scope.status).toBe('needs_clarification');
  });
});

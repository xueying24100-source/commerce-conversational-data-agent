import { z } from 'zod';

import type { MoAgentTool } from '@/lib/agent/types';
import type {
  BreakdownRequest,
  CommerceAnalyticsRepository,
  DataHealthRequest,
  EntityLookupRequest,
  InventoryRiskRequest,
  MetricComparisonRequest,
  TrendRequest,
  WeeklyKpiScanRequest,
} from './analytics-repository';
import {
  FLAGSHIP_DIAGNOSTIC_DIMENSIONS,
  FLAGSHIP_DIAGNOSTIC_METRICS,
  addCommerceBusinessDays,
  evaluateCommerceDataHealth,
  previousComparableRanges,
  selectCommerceBaseline,
  scanCommerceKpis,
} from './diagnostics';
import { CommerceEvidenceLedger } from './evidence-ledger';
import {
  COMMERCE_DIMENSIONS,
  COMMERCE_METRICS,
  commerceAgentAnswerSchema,
  commerceDateRangeSchema,
  commerceDimensionSchema,
  commerceFiltersSchema,
  commerceMetricSchema,
  type CommerceCatalog,
} from './types';

const EMPTY_FILTERS = {
  regions: [],
  channels: [],
  skus: [],
  categories: [],
};

const comparisonSchema = z.object({
  current: commerceDateRangeSchema,
  baseline: commerceDateRangeSchema.nullable().optional(),
  metrics: z.array(commerceMetricSchema).min(1).max(10),
  filters: commerceFiltersSchema.default(EMPTY_FILTERS),
}).strict();

const breakdownSchema = z.object({
  current: commerceDateRangeSchema,
  baseline: commerceDateRangeSchema.nullable().optional(),
  metric: commerceMetricSchema,
  dimension: commerceDimensionSchema,
  filters: commerceFiltersSchema.default(EMPTY_FILTERS),
  limit: z.number().int().min(1).max(50).default(12),
  sort: z.enum(['current_desc', 'change_asc', 'absolute_change_desc']).default('absolute_change_desc'),
}).strict();

const trendSchema = z.object({
  range: commerceDateRangeSchema,
  metric: commerceMetricSchema,
  grain: z.enum(['day', 'week', 'month']),
  filters: commerceFiltersSchema.default(EMPTY_FILTERS),
}).strict();

const inventorySchema = z.object({
  range: commerceDateRangeSchema,
  filters: commerceFiltersSchema.default(EMPTY_FILTERS),
  limit: z.number().int().min(1).max(50).default(12),
}).strict();

const entityLookupSchema = z.object({
  dimension: commerceDimensionSchema,
  query: z.string().trim().min(1).max(120),
  limit: z.number().int().min(1).max(30).default(12),
}).strict();

const FILTER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    regions: { type: 'array', maxItems: 50, items: { type: 'string' } },
    channels: { type: 'array', maxItems: 50, items: { type: 'string' } },
    skus: { type: 'array', maxItems: 50, items: { type: 'string' } },
    categories: { type: 'array', maxItems: 50, items: { type: 'string' } },
  },
} as const;

const DATE_RANGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['start', 'end'],
  properties: {
    start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
    end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
  },
} as const;

const EVIDENCE_CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['evidenceId', 'path', 'metric', 'value', 'unit'],
  properties: {
    evidenceId: { type: 'string', minLength: 1, maxLength: 100 },
    path: { type: 'string', minLength: 2, maxLength: 240, pattern: '^/' },
    metric: { type: 'string', enum: [...COMMERCE_METRICS] },
    value: { type: 'number' },
    unit: {
      type: 'string',
      enum: ['currency', 'integer', 'decimal', 'percent', 'hours'],
    },
  },
} as const;

function evidenceTool<TInput, TOutput>(params: {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  parseInput: (value: unknown) => TInput;
  operation: string;
  ledger: CommerceEvidenceLedger;
  execute: (input: TInput) => Promise<{ data: TOutput; rowCount: number }>;
  beforeExecute?: () => void;
  validateInput?: (input: TInput) => void;
  requestForEvidence?: (input: TInput) => unknown;
  onEvidence?: (trace: ReturnType<CommerceEvidenceLedger['trace']>) => Promise<void>;
}): MoAgentTool<TInput, unknown> {
  return {
    name: params.name,
    description: params.description,
    inputSchema: params.inputSchema,
    effect: 'read',
    idempotency: 'intrinsic',
    parseInput: params.parseInput,
    async execute(input) {
      params.beforeExecute?.();
      params.validateInput?.(input);
      const result = await params.execute(input);
      const receipt = params.ledger.record({
        operation: params.operation,
        request: params.requestForEvidence?.(input) ?? input,
        data: result.data,
        rowCount: result.rowCount,
      });
      await params.onEvidence?.(params.ledger.trace(receipt.evidenceId));
      return {
        ok: true,
        data: receipt,
        content: JSON.stringify(receipt),
      };
    },
  };
}

export function createCommerceAgentTools(params: {
  tenantId: string;
  question: string;
  repository: CommerceAnalyticsRepository;
  ledger: CommerceEvidenceLedger;
  catalog?: CommerceCatalog;
  onEvidence?: (trace: ReturnType<CommerceEvidenceLedger['trace']>) => Promise<void>;
}): MoAgentTool[] {
  let catalogObserved = false;
  const requireCatalog = () => {
    if (!catalogObserved) {
      throw new Error('describe_commerce_data must succeed before analytical reads.');
    }
  };
  const scope = params.ledger.queryScope();
  const weeklyBaseline = () => {
    if (!scope?.current || scope.objective !== 'weekly_diagnosis') return null;
    const adjacent = previousComparableRanges(scope.current, 1)[0]!;
    const explicit = scope.baseline
      && (scope.baseline.start !== adjacent.start || scope.baseline.end !== adjacent.end)
      ? scope.baseline
      : null;
    const coverage = params.catalog?.coverage;
    return selectCommerceBaseline({
      current: scope.current,
      explicit,
      availableRanges: coverage?.start && coverage.end
        ? [{ start: coverage.start, end: coverage.end }]
        : undefined,
    });
  };
  const healthRequest = (): DataHealthRequest => {
    if (!scope?.current) throw new Error('inspect_commerce_data_health requires a resolved date range.');
    const weeklyDiagnosis = scope.objective === 'weekly_diagnosis';
    const baselineDecision = weeklyBaseline();
    const comparisonRanges = weeklyDiagnosis
      ? baselineDecision?.strategy === 'explicit'
        ? baselineDecision.comparisonRanges
        : []
      : scope.baseline
        ? [scope.baseline]
        : [];
    const envelope = comparisonRanges.reduce((range, candidate) => ({
      start: candidate.start < range.start ? candidate.start : range.start,
      end: candidate.end > range.end ? candidate.end : range.end,
    }), { ...scope.current });
    const directDefaults = ['gmv', 'paid_orders', 'average_order_value']
      .filter((metric) => params.catalog?.metrics.some((entry) => entry.id === metric));
    return {
      range: envelope,
      requiredMetrics: weeklyDiagnosis
        ? [...FLAGSHIP_DIAGNOSTIC_METRICS]
        : scope.metrics.length
          ? [...scope.metrics]
          : directDefaults as DataHealthRequest['requiredMetrics'],
      requiredDimensions: weeklyDiagnosis
        ? [...FLAGSHIP_DIAGNOSTIC_DIMENSIONS]
        : [...scope.dimensions],
      requireProductDimension: weeklyDiagnosis,
      optionalMetrics: weeklyDiagnosis
        ? ['refund_rate', 'gross_profit', 'stockout_hours']
        : [],
      now: new Date(scope.referenceInstant),
    };
  };
  const describe = evidenceTool<Record<string, never>, unknown>({
    name: 'describe_commerce_data',
    description: 'Inspect available date coverage, dimensions, metrics and freshness before querying. Call this when coverage or entity values are unknown.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    parseInput: (value) => z.object({}).strict().parse(value),
    operation: 'commerce.describe_data',
    ledger: params.ledger,
    execute: async () => {
      const data = params.catalog ?? await params.repository.getCatalog(params.tenantId);
      catalogObserved = true;
      return { data, rowCount: data.coverage.rowCount };
    },
    onEvidence: params.onEvidence,
  });

  const inspectHealth = evidenceTool<Record<string, never>, unknown>({
    name: 'inspect_commerce_data_health',
    description: 'Run the fail-closed data-health gate for the server-resolved scope, including daily completeness, source watermark, required capabilities, dimension coverage and connector proof. This must succeed before analytical reads.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    parseInput: (value) => z.object({}).strict().parse(value),
    operation: 'commerce.inspect_data_health',
    ledger: params.ledger,
    beforeExecute: requireCatalog,
    requestForEvidence: () => {
      const request = healthRequest();
      return { ...request, now: request.now?.toISOString() };
    },
    execute: async () => {
      const request = healthRequest();
      if (params.repository.inspectDataHealth) {
        const data = await params.repository.inspectDataHealth(params.tenantId, request);
        return { data, rowCount: data.partitions.length };
      }
      // Test/adapter compatibility path. Production PostgreSQL adapters implement the
      // partition-proof method above; an adapter fixture can prove the same contract from
      // its immutable catalog and declared coverage.
      const catalog = params.catalog ?? await params.repository.getCatalog(params.tenantId);
      const dates: string[] = [];
      for (
        let date = request.range.start;
        date <= request.range.end;
        date = addCommerceBusinessDays(date, 1)
      ) dates.push(date);
      const dimensions = Object.entries(catalog.dimensions)
        .filter(([, values]) => values.length > 0)
        .map(([dimension]) => dimension as keyof typeof catalog.dimensions);
      const data = evaluateCommerceDataHealth({
        range: request.range,
        availableMetrics: catalog.metrics.map((metric) => metric.id),
        availableDimensions: dimensions,
        dimensionCoverage: Object.fromEntries(dimensions.map((dimension) => [dimension, 1])),
        partitions: dates.map((date) => ({
          date,
          state: catalog.coverage.start && catalog.coverage.end
            && date >= catalog.coverage.start && date <= catalog.coverage.end
            ? 'ready' as const
            : 'missing' as const,
          factRowCount: 0,
          sourceWatermark: catalog.coverage.sourceUpdatedAt,
        })),
        dataMode: catalog.coverage.dataMode,
        sourceWatermark: catalog.coverage.sourceUpdatedAt,
        connectorStatus: 'ready',
        sourceAuditPassed: true,
        reconciliationConflict: false,
        now: request.now,
        requiredMetrics: request.requiredMetrics,
        requiredDimensions: request.requiredDimensions,
        requireProductDimension: request.requireProductDimension,
        optionalMetrics: request.optionalMetrics,
      });
      return { data, rowCount: data.partitions.length };
    },
    onEvidence: params.onEvidence,
  });

  const weeklyKpiScan = evidenceTool<Record<string, never>, unknown>({
    name: 'scan_weekly_commerce_kpis',
    description: 'For the flagship previous-complete-week diagnosis, scan GMV, paid orders, visits, conversion rate and AOV against the deterministic explicit or robust available-week baseline. The server fixes all ranges and metrics.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    parseInput: (value) => z.object({}).strict().parse(value),
    operation: 'commerce.scan_weekly_kpis',
    ledger: params.ledger,
    beforeExecute: requireCatalog,
    requestForEvidence: () => {
      if (!scope?.current) return {};
      return {
        current: scope.current,
        baseline: weeklyBaseline(),
        metrics: [...FLAGSHIP_DIAGNOSTIC_METRICS],
        filters: scope.filters,
      };
    },
    validateInput: () => {
      if (scope?.objective !== 'weekly_diagnosis' || !scope.current) {
        throw new Error('scan_weekly_commerce_kpis is only available for the weekly diagnosis objective.');
      }
      params.ledger.assertAnalyticalRequest('commerce.scan_weekly_kpis', {
        current: scope.current,
        baseline: weeklyBaseline() ?? undefined,
        metrics: [...FLAGSHIP_DIAGNOSTIC_METRICS],
        filters: scope.filters,
      });
    },
    execute: async () => {
      if (!scope?.current) throw new Error('Weekly diagnosis scope is unavailable.');
      const request: WeeklyKpiScanRequest = {
        current: scope.current,
        baseline: weeklyBaseline() ?? undefined,
        metrics: [...FLAGSHIP_DIAGNOSTIC_METRICS],
        filters: scope.filters,
      };
      if (params.repository.scanWeeklyKpis) {
        const data = await params.repository.scanWeeklyKpis(params.tenantId, request);
        return { data, rowCount: data.baselineWeeks.length + 1 };
      }
      const baseline = request.baseline ?? selectCommerceBaseline({ current: request.current });
      const ranges = baseline.comparisonRanges;
      const [currentResult, ...baselineResults] = await Promise.all([
        params.repository.compareMetrics(params.tenantId, {
          current: request.current,
          baseline: null,
          metrics: request.metrics,
          filters: request.filters,
        }),
        ...ranges.map((range) => params.repository.compareMetrics(params.tenantId, {
          current: range,
          baseline: null,
          metrics: request.metrics,
          filters: request.filters,
        })),
      ]);
      const data = scanCommerceKpis({
        currentRange: request.current,
        current: currentResult.current,
        baselineWeeks: ranges.map((range, index) => ({
          range,
          values: baselineResults[index]!.current,
        })),
        baselineDecision: baseline,
        metrics: request.metrics,
      });
      return { data, rowCount: data.baselineWeeks.length + 1 };
    },
    onEvidence: params.onEvidence,
  });

  const compare = evidenceTool<MetricComparisonRequest, unknown>({
    name: 'compare_commerce_metrics',
    description: 'Calculate one or more commerce metrics for a current range and optional baseline. Use this for KPI totals, rates and period comparisons.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['current', 'metrics'],
      properties: {
        current: DATE_RANGE_SCHEMA,
        baseline: { anyOf: [DATE_RANGE_SCHEMA, { type: 'null' }] },
        metrics: {
          type: 'array', minItems: 1, maxItems: 10, uniqueItems: true,
          items: { type: 'string', enum: [...COMMERCE_METRICS] },
        },
        filters: FILTER_SCHEMA,
      },
    },
    parseInput: (value) => comparisonSchema.parse(value),
    operation: 'commerce.compare_metrics',
    ledger: params.ledger,
    execute: async (input) => ({
      data: await params.repository.compareMetrics(params.tenantId, input),
      rowCount: input.baseline ? 2 : 1,
    }),
    onEvidence: params.onEvidence,
    beforeExecute: requireCatalog,
    validateInput: (input) => params.ledger.assertAnalyticalRequest(
      'commerce.compare_metrics',
      input,
    ),
  });

  const lookup = evidenceTool<EntityLookupRequest, unknown>({
    name: 'lookup_commerce_entities',
    description: 'Search long-tail region, channel, SKU or category values in the authenticated tenant catalog before applying a filter.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dimension', 'query'],
      properties: {
        dimension: { type: 'string', enum: [...COMMERCE_DIMENSIONS] },
        query: { type: 'string', minLength: 1, maxLength: 120 },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 12 },
      },
    },
    parseInput: (value) => entityLookupSchema.parse(value),
    operation: 'commerce.lookup_entities',
    ledger: params.ledger,
    execute: async (input) => {
      const data = await params.repository.lookupEntities(params.tenantId, input);
      return { data, rowCount: data.length };
    },
    onEvidence: params.onEvidence,
    beforeExecute: requireCatalog,
  });

  const breakdown = evidenceTool<BreakdownRequest, unknown>({
    name: 'breakdown_commerce_metric',
    description: 'Break a metric down by one allowlisted dimension and compare periods. Use this to locate positive or negative drivers.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['current', 'metric', 'dimension'],
      properties: {
        current: DATE_RANGE_SCHEMA,
        baseline: { anyOf: [DATE_RANGE_SCHEMA, { type: 'null' }] },
        metric: { type: 'string', enum: [...COMMERCE_METRICS] },
        dimension: { type: 'string', enum: [...COMMERCE_DIMENSIONS] },
        filters: FILTER_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
        sort: {
          type: 'string',
          enum: ['current_desc', 'change_asc', 'absolute_change_desc'],
          default: 'absolute_change_desc',
        },
      },
    },
    parseInput: (value) => breakdownSchema.parse(value),
    operation: 'commerce.breakdown_metric',
    ledger: params.ledger,
    execute: async (input) => {
      const data = await params.repository.breakdown(params.tenantId, input);
      return { data, rowCount: data.length };
    },
    onEvidence: params.onEvidence,
    beforeExecute: requireCatalog,
    validateInput: (input) => params.ledger.assertAnalyticalRequest(
      'commerce.breakdown_metric',
      input,
    ),
  });

  const trend = evidenceTool<TrendRequest, unknown>({
    name: 'trend_commerce_metric',
    description: 'Return a day, week or month time series for one metric. Use this to identify when a change started or whether it is persistent.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['range', 'metric', 'grain'],
      properties: {
        range: DATE_RANGE_SCHEMA,
        metric: { type: 'string', enum: [...COMMERCE_METRICS] },
        grain: { type: 'string', enum: ['day', 'week', 'month'] },
        filters: FILTER_SCHEMA,
      },
    },
    parseInput: (value) => trendSchema.parse(value),
    operation: 'commerce.trend_metric',
    ledger: params.ledger,
    execute: async (input) => {
      const data = await params.repository.trend(params.tenantId, input);
      return { data, rowCount: data.length };
    },
    onEvidence: params.onEvidence,
    beforeExecute: requireCatalog,
    validateInput: (input) => params.ledger.assertAnalyticalRequest(
      'commerce.trend_metric',
      input,
    ),
  });

  const inventory = evidenceTool<InventoryRiskRequest, unknown>({
    name: 'find_inventory_risk',
    description: 'Find SKUs with stockout hours or low ending inventory in a date range.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['range'],
      properties: {
        range: DATE_RANGE_SCHEMA,
        filters: FILTER_SCHEMA,
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 12 },
      },
    },
    parseInput: (value) => inventorySchema.parse(value),
    operation: 'commerce.inventory_risk',
    ledger: params.ledger,
    execute: async (input) => {
      const data = await params.repository.inventoryRisk(params.tenantId, input);
      return { data, rowCount: data.length };
    },
    onEvidence: params.onEvidence,
    beforeExecute: requireCatalog,
    validateInput: (input) => params.ledger.assertAnalyticalRequest(
      'commerce.inventory_risk',
      input,
    ),
  });

  const submit: MoAgentTool = {
    name: 'submit_grounded_commerce_answer',
    description: 'Submit the final answer structure. For answered, put every factual observation in a field-level claim containing evidenceId, JSON Pointer path relative to receipt.data, metric, exact raw value and unit. Narrative fields should describe the qualitative management conclusion, drivers, risks and actions without writing numbers or unsupported causality; the service validates all claims and renders numeric evidence. Use needs_clarification when scope or dates are missing.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: [
        'status',
        'answer',
        'answerClaims',
        'findings',
        'recommendations',
        'followUps',
      ],
      properties: {
        status: { type: 'string', enum: ['answered', 'needs_clarification', 'refused'] },
        answer: { type: 'string', minLength: 1, maxLength: 8_000 },
        answerClaims: {
          type: 'array', maxItems: 48, items: EVIDENCE_CLAIM_SCHEMA,
        },
        findings: {
          type: 'array', maxItems: 12,
          items: {
            type: 'object', additionalProperties: false,
            required: ['metric', 'title', 'detail', 'claims'],
            properties: {
              metric: { type: 'string', enum: [...COMMERCE_METRICS] },
              title: { type: 'string', minLength: 1, maxLength: 160 },
              detail: { type: 'string', minLength: 1, maxLength: 1_500 },
              claims: { type: 'array', maxItems: 12, items: EVIDENCE_CLAIM_SCHEMA },
            },
          },
        },
        recommendations: {
          type: 'array', maxItems: 8,
          items: {
            type: 'object', additionalProperties: false,
            required: ['action', 'rationale', 'claims'],
            properties: {
              action: { type: 'string', minLength: 1, maxLength: 240 },
              rationale: { type: 'string', minLength: 1, maxLength: 1_500 },
              claims: { type: 'array', maxItems: 12, items: EVIDENCE_CLAIM_SCHEMA },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              ownerRole: {
                type: 'string',
                enum: ['operations', 'growth', 'merchandising', 'finance', 'customer_service', 'supply_chain', 'data'],
              },
            },
          },
        },
        followUps: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 240 } },
      },
    },
    effect: 'pure',
    idempotency: 'intrinsic',
    terminal: true,
    parseInput: (value) => commerceAgentAnswerSchema.parse(value),
    execute: async (input) => ({
      ok: true,
      data: params.ledger.verifyAnswer(input, params.question),
    }),
  };

  return [describe, inspectHealth, weeklyKpiScan, lookup, compare, breakdown, trend, inventory, submit];
}

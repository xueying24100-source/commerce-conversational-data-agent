import type { CommerceSqlClient } from './database';
import { getCommerceAgentRuntimeConfig } from './config';
import {
  COMMERCE_DIMENSIONS,
  COMMERCE_METRICS,
  type CommerceCatalog,
  type CommerceDateRange,
  type CommerceDimension,
  type CommerceFilters,
  type CommerceMetric,
  type CommerceMetricDefinition,
} from './types';

interface MetricSpec extends CommerceMetricDefinition {
  sql: string;
}

const METRIC_REQUIREMENTS: Record<CommerceMetric, string[]> = {
  gmv: ['gmv'],
  net_revenue: ['gmv', 'refund_amount'],
  paid_orders: ['paid_orders'],
  units: ['units'],
  visits: ['visits'],
  conversion_rate: ['paid_orders', 'visits'],
  average_order_value: ['gmv', 'paid_orders'],
  refund_rate: ['refund_orders', 'paid_orders'],
  refund_amount: ['refund_amount'],
  gross_profit: ['gmv', 'refund_amount', 'cost_amount'],
  gross_margin: ['gmv', 'refund_amount', 'cost_amount'],
  ad_spend: ['ad_spend'],
  roas: ['gmv', 'ad_spend'],
  new_customers: ['new_customers'],
  stockout_hours: ['stockout_hours'],
  ending_inventory: ['ending_inventory'],
};

export class CommerceMetricUnavailableError extends Error {
  readonly code = 'COMMERCE_METRIC_UNAVAILABLE';

  constructor(readonly metrics: CommerceMetric[]) {
    super(`当前数据源不提供这些指标：${metrics.join(', ')}。`);
    this.name = 'CommerceMetricUnavailableError';
  }
}

const METRIC_SPECS: Record<CommerceMetric, MetricSpec> = {
  gmv: {
    id: 'gmv', label: 'GMV', format: 'currency', description: '支付订单成交金额。',
    sql: 'SUM(gmv)::double precision',
  },
  net_revenue: {
    id: 'net_revenue', label: '净收入', format: 'currency', description: 'GMV 减退款金额。',
    sql: 'SUM(gmv - refund_amount)::double precision',
  },
  paid_orders: {
    id: 'paid_orders', label: '支付订单', format: 'integer', description: '支付成功订单数。',
    sql: 'SUM(paid_orders)::double precision',
  },
  units: {
    id: 'units', label: '销量', format: 'integer', description: '支付商品件数。',
    sql: 'SUM(units)::double precision',
  },
  visits: {
    id: 'visits', label: '访问量', format: 'integer', description: '去重口径由上游数仓保证。',
    sql: 'SUM(visits)::double precision',
  },
  conversion_rate: {
    id: 'conversion_rate', label: '支付转化率', format: 'percent', description: '支付订单数 / 访问量。',
    sql: 'CASE WHEN SUM(visits) = 0 THEN NULL ELSE SUM(paid_orders)::double precision / SUM(visits) END',
  },
  average_order_value: {
    id: 'average_order_value', label: '客单价', format: 'currency', description: 'GMV / 支付订单数。',
    sql: 'CASE WHEN SUM(paid_orders) = 0 THEN NULL ELSE SUM(gmv)::double precision / SUM(paid_orders) END',
  },
  refund_rate: {
    id: 'refund_rate', label: '退款率', format: 'percent', description: '退款订单数 / 支付订单数。',
    sql: 'CASE WHEN SUM(paid_orders) = 0 THEN NULL ELSE SUM(refund_orders)::double precision / SUM(paid_orders) END',
  },
  refund_amount: {
    id: 'refund_amount', label: '退款金额', format: 'currency', description: '确认退款金额。',
    sql: 'SUM(refund_amount)::double precision',
  },
  gross_profit: {
    id: 'gross_profit', label: '毛利额', format: 'currency', description: 'GMV - 退款金额 - 商品成本。',
    sql: 'SUM(gmv - refund_amount - cost_amount)::double precision',
  },
  gross_margin: {
    id: 'gross_margin', label: '毛利率', format: 'percent', description: '毛利额 / 净收入。',
    sql: 'CASE WHEN SUM(gmv - refund_amount) = 0 THEN NULL ELSE SUM(gmv - refund_amount - cost_amount)::double precision / SUM(gmv - refund_amount) END',
  },
  ad_spend: {
    id: 'ad_spend', label: '广告消耗', format: 'currency', description: '渠道广告消耗。',
    sql: 'SUM(ad_spend)::double precision',
  },
  roas: {
    id: 'roas', label: 'ROAS', format: 'decimal', description: 'GMV / 广告消耗。',
    sql: 'CASE WHEN SUM(ad_spend) = 0 THEN NULL ELSE SUM(gmv)::double precision / SUM(ad_spend) END',
  },
  new_customers: {
    id: 'new_customers', label: '新客数', format: 'integer', description: '完成首购的客户数。',
    sql: 'SUM(new_customers)::double precision',
  },
  stockout_hours: {
    id: 'stockout_hours', label: '缺货时长', format: 'hours', description: '商品缺货小时数。',
    sql: 'SUM(stockout_hours)::double precision',
  },
  ending_inventory: {
    id: 'ending_inventory', label: '平均期末库存', format: 'decimal', description: '查询范围内日末库存均值。',
    sql: 'AVG(ending_inventory)::double precision',
  },
};

const DIMENSION_COLUMNS: Record<CommerceDimension, string> = {
  region: 'region',
  channel: 'channel',
  sku: 'sku',
  category: 'category',
};

function filteredMetricSql(metric: CommerceMetric, predicate: string): string {
  const filter = ` FILTER (WHERE ${predicate})`;
  const sum = (expression: string) => `SUM(${expression})${filter}`;
  const average = (expression: string) => `AVG(${expression})${filter}`;
  switch (metric) {
    case 'gmv': return `(${sum('gmv')})::double precision`;
    case 'net_revenue': return `(${sum('gmv - refund_amount')})::double precision`;
    case 'paid_orders': return `(${sum('paid_orders')})::double precision`;
    case 'units': return `(${sum('units')})::double precision`;
    case 'visits': return `(${sum('visits')})::double precision`;
    case 'conversion_rate':
      return `CASE WHEN ${sum('visits')} = 0 THEN NULL ELSE (${sum('paid_orders')})::double precision / ${sum('visits')} END`;
    case 'average_order_value':
      return `CASE WHEN ${sum('paid_orders')} = 0 THEN NULL ELSE (${sum('gmv')})::double precision / ${sum('paid_orders')} END`;
    case 'refund_rate':
      return `CASE WHEN ${sum('paid_orders')} = 0 THEN NULL ELSE (${sum('refund_orders')})::double precision / ${sum('paid_orders')} END`;
    case 'refund_amount': return `(${sum('refund_amount')})::double precision`;
    case 'gross_profit':
      return `(${sum('gmv - refund_amount - cost_amount')})::double precision`;
    case 'gross_margin':
      return `CASE WHEN ${sum('gmv - refund_amount')} = 0 THEN NULL ELSE (${sum('gmv - refund_amount - cost_amount')})::double precision / ${sum('gmv - refund_amount')} END`;
    case 'ad_spend': return `(${sum('ad_spend')})::double precision`;
    case 'roas':
      return `CASE WHEN ${sum('ad_spend')} = 0 THEN NULL ELSE (${sum('gmv')})::double precision / ${sum('ad_spend')} END`;
    case 'new_customers': return `(${sum('new_customers')})::double precision`;
    case 'stockout_hours': return `(${sum('stockout_hours')})::double precision`;
    case 'ending_inventory': return `(${average('ending_inventory')})::double precision`;
  }
}

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asIsoDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value);
  return /^\d{4}-\d{2}-\d{2}/u.test(text) ? text.slice(0, 10) : null;
}

function asIsoTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function escapedLikePrefix(value: string): string {
  return `${value.replace(/[\\%_]/gu, '\\$&')}%`;
}

interface WhereClause {
  sql: string;
  values: unknown[];
}

function scopedWhere(
  tenantId: string,
  range: CommerceDateRange,
  filters: CommerceFilters,
): WhereClause {
  const values: unknown[] = [tenantId, range.start, range.end];
  const conditions = [
    'tenant_id = $1',
    'metric_date BETWEEN $2::date AND $3::date',
  ];
  const filterEntries: Array<[string, string[]]> = [
    ['region', filters.regions],
    ['channel', filters.channels],
    ['sku', filters.skus],
    ['category', filters.categories],
  ];
  for (const [column, selected] of filterEntries) {
    if (!selected.length) continue;
    values.push(selected);
    conditions.push(`${column} = ANY($${values.length}::text[])`);
  }
  return { sql: conditions.join(' AND '), values };
}

export interface MetricComparisonRequest {
  current: CommerceDateRange;
  baseline?: CommerceDateRange | null;
  metrics: CommerceMetric[];
  filters: CommerceFilters;
}

export interface MetricComparisonResult {
  current: Record<CommerceMetric, number | null>;
  baseline: Record<CommerceMetric, number | null> | null;
  changes: Record<CommerceMetric, { absolute: number | null; percent: number | null }> | null;
}

export interface BreakdownRequest {
  current: CommerceDateRange;
  baseline?: CommerceDateRange | null;
  metric: CommerceMetric;
  dimension: CommerceDimension;
  filters: CommerceFilters;
  limit: number;
  sort: 'current_desc' | 'change_asc' | 'absolute_change_desc';
}

export interface BreakdownRow {
  key: string;
  currentPresent: boolean;
  baselinePresent: boolean | null;
  current: number | null;
  baseline: number | null;
  absoluteChange: number | null;
  percentChange: number | null;
}

const ZERO_WHEN_ABSENT_METRICS = new Set<CommerceMetric>([
  'gmv',
  'net_revenue',
  'paid_orders',
  'units',
  'visits',
  'refund_amount',
  'gross_profit',
  'ad_spend',
  'new_customers',
  'stockout_hours',
]);

export interface TrendRequest {
  range: CommerceDateRange;
  metric: CommerceMetric;
  grain: 'day' | 'week' | 'month';
  filters: CommerceFilters;
}

export interface TrendRow {
  bucket: string;
  value: number | null;
}

export interface InventoryRiskRequest {
  range: CommerceDateRange;
  filters: CommerceFilters;
  limit: number;
}

export interface InventoryRiskRow {
  sku: string;
  category: string;
  stockoutHours: number;
  minimumEndingInventory: number;
  lastSourceUpdate: string | null;
}

export interface EntityLookupRequest {
  dimension: CommerceDimension;
  query: string;
  limit: number;
}

export interface EntityLookupRow {
  value: string;
  factRows: number;
}

export interface CommerceAnalyticsRepository {
  getCatalog(tenantId: string): Promise<CommerceCatalog>;
  lookupEntities(tenantId: string, request: EntityLookupRequest): Promise<EntityLookupRow[]>;
  compareMetrics(tenantId: string, request: MetricComparisonRequest): Promise<MetricComparisonResult>;
  breakdown(tenantId: string, request: BreakdownRequest): Promise<BreakdownRow[]>;
  trend(tenantId: string, request: TrendRequest): Promise<TrendRow[]>;
  inventoryRisk(tenantId: string, request: InventoryRiskRequest): Promise<InventoryRiskRow[]>;
}

export class PostgresCommerceAnalyticsRepository implements CommerceAnalyticsRepository {
  constructor(private readonly database: CommerceSqlClient) {}

  private async assertMetricsAvailable(
    tenantId: string,
    metrics: CommerceMetric[],
  ): Promise<void> {
    const result = await this.database.query<{ available_metrics: unknown }>(
      `SELECT available_metrics FROM commerce_tenant_data_status WHERE tenant_id = $1`,
      [tenantId],
    );
    const available = new Set(
      Array.isArray(result.rows[0]?.available_metrics)
        ? result.rows[0].available_metrics.map(String)
        : [],
    );
    const unavailable = metrics.filter((metric) => (
      METRIC_REQUIREMENTS[metric].some((requirement) => !available.has(requirement))
    ));
    if (unavailable.length) throw new CommerceMetricUnavailableError(unavailable);
  }

  async getCatalog(tenantId: string): Promise<CommerceCatalog> {
    const previewLimit = getCommerceAgentRuntimeConfig().catalogPreviewLimit;
    const coverage = await this.database.query<{
      start_date: unknown;
      end_date: unknown;
      last_ingested_at: unknown;
      source_updated_at: unknown;
      data_mode: unknown;
      row_count: unknown;
      available_metrics: unknown;
      business_timezone: unknown;
    }>(
      `SELECT
         coverage_start::text AS start_date,
         coverage_end::text AS end_date,
         last_ingested_at,
         source_updated_at,
         data_mode,
         fact_row_count AS row_count,
         available_metrics,
         business_timezone
       FROM commerce_tenant_data_status
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const dimensions = {} as Record<CommerceDimension, string[]>;
    for (const dimension of COMMERCE_DIMENSIONS) {
      const result = await this.database.query<{ value: unknown }>(
        `SELECT value
         FROM commerce_entity_catalog
         WHERE tenant_id = $1 AND dimension = $2
         ORDER BY fact_row_count DESC, value ASC
         LIMIT $3`,
        [tenantId, dimension, previewLimit],
      );
      dimensions[dimension] = result.rows.map((row) => String(row.value));
    }
    const row = coverage.rows[0];
    return {
      dataset: 'commerce_daily_metrics',
      timezone: typeof row?.business_timezone === 'string' && row.business_timezone.trim()
        ? row.business_timezone
        : 'Asia/Shanghai',
      coverage: {
        start: asIsoDate(row?.start_date),
        end: asIsoDate(row?.end_date),
        lastIngestedAt: asIsoTimestamp(row?.last_ingested_at),
        sourceUpdatedAt: asIsoTimestamp(row?.source_updated_at),
        dataMode: row?.data_mode === 'incremental' ? 'incremental' : 'snapshot',
        rowCount: asNumber(row?.row_count) ?? 0,
      },
      metrics: commerceMetricDefinitions(
        Array.isArray(row?.available_metrics) ? row.available_metrics.map(String) : [],
      ),
      dimensions,
    };
  }

  async lookupEntities(
    tenantId: string,
    request: EntityLookupRequest,
  ): Promise<EntityLookupRow[]> {
    const result = await this.database.query<{ value: unknown; fact_rows: unknown }>(
      `SELECT value, fact_row_count AS fact_rows
       FROM commerce_entity_catalog
       WHERE tenant_id = $1 AND dimension = $2
         AND LOWER(value) LIKE LOWER($4) ESCAPE '\\'
       ORDER BY CASE WHEN LOWER(value) = LOWER($3) THEN 0 ELSE 1 END,
                fact_row_count DESC, value ASC
       LIMIT $5`,
      [
        tenantId,
        request.dimension,
        request.query,
        escapedLikePrefix(request.query),
        request.limit,
      ],
    );
    return result.rows.map((row) => ({
      value: String(row.value),
      factRows: asNumber(row.fact_rows) ?? 0,
    }));
  }

  private async aggregate(
    tenantId: string,
    range: CommerceDateRange,
    metrics: CommerceMetric[],
    filters: CommerceFilters,
  ): Promise<Record<CommerceMetric, number | null>> {
    const where = scopedWhere(tenantId, range, filters);
    const columns = metrics.map((metric) => `${METRIC_SPECS[metric].sql} AS "${metric}"`);
    const result = await this.database.query<Record<string, unknown>>(
      `SELECT ${columns.join(', ')}
       FROM commerce_daily_metrics
       WHERE ${where.sql}`,
      where.values,
    );
    const row = result.rows[0] ?? {};
    return Object.fromEntries(metrics.map((metric) => [metric, asNumber(row[metric])])) as Record<
      CommerceMetric,
      number | null
    >;
  }

  async compareMetrics(
    tenantId: string,
    request: MetricComparisonRequest,
  ): Promise<MetricComparisonResult> {
    await this.assertMetricsAvailable(tenantId, request.metrics);
    const current = await this.aggregate(tenantId, request.current, request.metrics, request.filters);
    const baseline = request.baseline
      ? await this.aggregate(tenantId, request.baseline, request.metrics, request.filters)
      : null;
    const changes = baseline
      ? Object.fromEntries(request.metrics.map((metric) => {
          const currentValue = current[metric];
          const baselineValue = baseline[metric];
          const absolute = currentValue === null || baselineValue === null
            ? null
            : currentValue - baselineValue;
          const percent = absolute === null || baselineValue === null || baselineValue === 0
            ? null
            : absolute / Math.abs(baselineValue);
          return [metric, { absolute, percent }];
        })) as MetricComparisonResult['changes']
      : null;
    return { current, baseline, changes };
  }

  async breakdown(tenantId: string, request: BreakdownRequest): Promise<BreakdownRow[]> {
    await this.assertMetricsAvailable(tenantId, [request.metric]);
    const envelope: CommerceDateRange = request.baseline
      ? {
          start: request.current.start < request.baseline.start
            ? request.current.start
            : request.baseline.start,
          end: request.current.end > request.baseline.end
            ? request.current.end
            : request.baseline.end,
        }
      : request.current;
    const where = scopedWhere(tenantId, envelope, request.filters);
    const values = [...where.values];
    const currentStart = values.push(request.current.start);
    const currentEnd = values.push(request.current.end);
    const currentPredicate = `metric_date BETWEEN $${currentStart}::date AND $${currentEnd}::date`;
    const rawCurrentMetric = filteredMetricSql(request.metric, currentPredicate);
    const currentMetric = ZERO_WHEN_ABSENT_METRICS.has(request.metric)
      ? `COALESCE(${rawCurrentMetric}, 0::double precision)`
      : rawCurrentMetric;
    let baselineMetric = 'NULL::double precision';
    let baselinePredicate: string | null = null;
    if (request.baseline) {
      const baselineStart = values.push(request.baseline.start);
      const baselineEnd = values.push(request.baseline.end);
      baselinePredicate = `metric_date BETWEEN $${baselineStart}::date AND $${baselineEnd}::date`;
      const rawBaselineMetric = filteredMetricSql(request.metric, baselinePredicate);
      baselineMetric = ZERO_WHEN_ABSENT_METRICS.has(request.metric)
        ? `COALESCE(${rawBaselineMetric}, 0::double precision)`
        : rawBaselineMetric;
    }
    const limitParameter = values.push(request.limit);
    const column = DIMENSION_COLUMNS[request.dimension];
    const orderBy = !request.baseline || request.sort === 'current_desc'
      ? 'current_value DESC NULLS LAST, key ASC'
      : request.sort === 'change_asc'
        ? 'absolute_change ASC NULLS LAST, key ASC'
        : 'ABS(current_value - baseline_value) DESC NULLS LAST, key ASC';
    const result = await this.database.query<{
      key: unknown;
      current_value: unknown;
      baseline_value: unknown;
      current_present: unknown;
      baseline_present: unknown;
      absolute_change: unknown;
      percent_change: unknown;
    }>(
      `SELECT key,
              current_present,
              baseline_present,
              current_value,
              baseline_value,
              CASE WHEN current_value IS NULL OR baseline_value IS NULL
                   THEN NULL ELSE current_value - baseline_value END AS absolute_change,
              CASE WHEN current_value IS NULL OR baseline_value IS NULL OR baseline_value = 0
                   THEN NULL ELSE (current_value - baseline_value) / ABS(baseline_value)
              END AS percent_change
       FROM (
         SELECT ${column}::text AS key,
                COUNT(*) FILTER (WHERE ${currentPredicate}) > 0 AS current_present,
                ${baselinePredicate
                  ? `COUNT(*) FILTER (WHERE ${baselinePredicate}) > 0`
                  : 'NULL::boolean'} AS baseline_present,
                ${currentMetric} AS current_value,
                ${baselineMetric} AS baseline_value
         FROM commerce_daily_metrics
         WHERE ${where.sql}
         GROUP BY ${column}
       ) grouped_metrics
       ORDER BY ${orderBy}
       LIMIT $${limitParameter}`,
      values,
    );
    return result.rows.map((row) => ({
      key: String(row.key),
      currentPresent: row.current_present === true,
      baselinePresent: request.baseline ? row.baseline_present === true : null,
      current: asNumber(row.current_value),
      baseline: asNumber(row.baseline_value),
      absoluteChange: asNumber(row.absolute_change),
      percentChange: asNumber(row.percent_change),
    }));
  }

  async trend(tenantId: string, request: TrendRequest): Promise<TrendRow[]> {
    await this.assertMetricsAvailable(tenantId, [request.metric]);
    const where = scopedWhere(tenantId, request.range, request.filters);
    const grain = request.grain;
    const result = await this.database.query<{ bucket: unknown; value: unknown }>(
      `SELECT date_trunc('${grain}', metric_date)::date::text AS bucket,
              ${METRIC_SPECS[request.metric].sql} AS value
       FROM commerce_daily_metrics
       WHERE ${where.sql}
       GROUP BY 1
       ORDER BY 1 ASC
       LIMIT 740`,
      where.values,
    );
    return result.rows.map((row) => ({
      bucket: String(row.bucket),
      value: asNumber(row.value),
    }));
  }

  async inventoryRisk(
    tenantId: string,
    request: InventoryRiskRequest,
  ): Promise<InventoryRiskRow[]> {
    await this.assertMetricsAvailable(tenantId, ['stockout_hours', 'ending_inventory']);
    const where = scopedWhere(tenantId, request.range, request.filters);
    const result = await this.database.query<{
      sku: unknown;
      category: unknown;
      stockout_hours: unknown;
      minimum_ending_inventory: unknown;
      last_source_update: unknown;
    }>(
      `SELECT sku,
              MAX(category)::text AS category,
              SUM(stockout_hours)::double precision AS stockout_hours,
              MIN(ending_inventory)::double precision AS minimum_ending_inventory,
              MAX(source_updated_at) AS last_source_update
       FROM commerce_daily_metrics
       WHERE ${where.sql}
       GROUP BY sku
       ORDER BY stockout_hours DESC, minimum_ending_inventory ASC
       LIMIT $${where.values.length + 1}`,
      [...where.values, request.limit],
    );
    return result.rows.map((row) => ({
      sku: String(row.sku),
      category: String(row.category),
      stockoutHours: asNumber(row.stockout_hours) ?? 0,
      minimumEndingInventory: asNumber(row.minimum_ending_inventory) ?? 0,
      lastSourceUpdate: asIsoTimestamp(row.last_source_update),
    }));
  }
}

export function commerceMetricDefinitions(
  availableMetrics?: readonly string[],
): CommerceMetricDefinition[] {
  const available = availableMetrics ? new Set(availableMetrics) : null;
  return COMMERCE_METRICS.filter((metric) => (
    !available || METRIC_REQUIREMENTS[metric].every((requirement) => available.has(requirement))
  )).map((metric) => {
    const { sql: _sql, ...definition } = METRIC_SPECS[metric];
    return definition;
  });
}

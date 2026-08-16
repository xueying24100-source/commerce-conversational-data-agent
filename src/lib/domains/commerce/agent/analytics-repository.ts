import type { CommerceSqlClient } from './database';
import { getCommerceAgentRuntimeConfig } from './config';
import {
  evaluateCommerceDataHealth,
  previousComparableRanges,
  robustCommerceMetricSignal,
  selectCommerceBaseline,
  scanCommerceKpis,
  type CommerceBaselineDecision,
  type CommerceDataHealthReport,
  type CommerceKpiScan,
  type CommerceSegmentMetricSignal,
} from './diagnostics';
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

interface MetricSpec extends Omit<
  CommerceMetricDefinition,
  'aggregation' | 'additivity' | 'additiveDimensions'
> {
  sql: string;
}

type MetricAggregationSpec = Pick<
CommerceMetricDefinition,
'aggregation' | 'additivity' | 'additiveDimensions'
>;

const ALL_DIMENSIONS = [...COMMERCE_DIMENSIONS];
const METRIC_AGGREGATION_SPECS: Record<CommerceMetric, MetricAggregationSpec> = {
  gmv: { aggregation: 'sum', additivity: 'additive', additiveDimensions: ALL_DIMENSIONS },
  net_revenue: { aggregation: 'sum', additivity: 'additive', additiveDimensions: ALL_DIMENSIONS },
  paid_orders: {
    aggregation: 'sum',
    additivity: 'source_allocated_additive',
    additiveDimensions: ALL_DIMENSIONS,
  },
  units: { aggregation: 'sum', additivity: 'additive', additiveDimensions: ALL_DIMENSIONS },
  visits: {
    aggregation: 'sum',
    additivity: 'source_allocated_additive',
    additiveDimensions: ALL_DIMENSIONS,
  },
  conversion_rate: { aggregation: 'ratio_of_sums', additivity: 'non_additive', additiveDimensions: [] },
  average_order_value: { aggregation: 'ratio_of_sums', additivity: 'non_additive', additiveDimensions: [] },
  refund_rate: { aggregation: 'ratio_of_sums', additivity: 'non_additive', additiveDimensions: [] },
  refund_amount: { aggregation: 'sum', additivity: 'additive', additiveDimensions: ALL_DIMENSIONS },
  gross_profit: { aggregation: 'sum', additivity: 'additive', additiveDimensions: ALL_DIMENSIONS },
  gross_margin: { aggregation: 'ratio_of_sums', additivity: 'non_additive', additiveDimensions: [] },
  ad_spend: { aggregation: 'sum', additivity: 'additive', additiveDimensions: ALL_DIMENSIONS },
  roas: { aggregation: 'ratio_of_sums', additivity: 'non_additive', additiveDimensions: [] },
  new_customers: {
    aggregation: 'sum',
    additivity: 'source_allocated_additive',
    additiveDimensions: ALL_DIMENSIONS,
  },
  stockout_hours: { aggregation: 'sum', additivity: 'additive', additiveDimensions: ALL_DIMENSIONS },
  ending_inventory: {
    aggregation: 'average_daily_total',
    additivity: 'semi_additive_time',
    additiveDimensions: ALL_DIMENSIONS,
  },
};

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

export class CommerceDataRangeIncompleteError extends Error {
  readonly code = 'COMMERCE_DATA_RANGE_INCOMPLETE';

  constructor(readonly missingDates: string[]) {
    const preview = missingDates.slice(0, 10).join(', ');
    const remainder = missingDates.length > 10 ? ` 等 ${missingDates.length} 天` : '';
    super(`查询日期范围的数据完整性尚未验证：${preview}${remainder}。`);
    this.name = 'CommerceDataRangeIncompleteError';
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
    id: 'paid_orders', label: '支付订单', format: 'integer', description: '支付成功订单数；每笔订单必须由 Connector 唯一分配到一个事实桶。',
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
    id: 'new_customers', label: '新客数', format: 'integer', description: '完成首购的客户数；每位客户必须由 Connector 唯一分配到首次购买事实桶。',
    sql: 'SUM(new_customers)::double precision',
  },
  stockout_hours: {
    id: 'stockout_hours', label: '缺货时长', format: 'hours', description: 'SKU-hours；跨商品汇总表示商品缺货小时之和，不是自然时钟小时。',
    sql: 'SUM(stockout_hours)::double precision',
  },
  ending_inventory: {
    id: 'ending_inventory', label: '平均期末库存', format: 'decimal', description: '查询范围内先汇总每日期末库存，再计算日均值。',
    sql: 'AVG(ending_inventory)::double precision',
  },
};

const DIMENSION_COLUMNS: Record<CommerceDimension, string> = {
  region: 'region',
  channel: 'channel',
  sku: 'sku',
  category: 'category',
};

const WEEKLY_SEGMENT_SCREEN: ReadonlyArray<{
  metric: CommerceMetric;
  dimension: CommerceDimension;
}> = [
  { metric: 'visits', dimension: 'channel' },
  { metric: 'conversion_rate', dimension: 'channel' },
  { metric: 'average_order_value', dimension: 'category' },
  { metric: 'average_order_value', dimension: 'channel' },
];

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

export interface DataHealthRequest {
  range: CommerceDateRange;
  requiredMetrics: CommerceMetric[];
  requiredDimensions: CommerceDimension[];
  requireProductDimension: boolean;
  optionalMetrics: CommerceMetric[];
  now?: Date;
}

export interface WeeklyKpiScanRequest {
  current: CommerceDateRange;
  metrics: CommerceMetric[];
  filters: CommerceFilters;
  baseline?: CommerceBaselineDecision;
}

export interface CommerceEntityMention {
  dimension: CommerceDimension;
  value: string;
}

export interface EntityLookupRow {
  value: string;
  factRows: number;
}

export interface CommerceAnalyticsRepository {
  getCatalog(tenantId: string): Promise<CommerceCatalog>;
  inspectDataHealth?(tenantId: string, request: DataHealthRequest): Promise<CommerceDataHealthReport>;
  scanWeeklyKpis?(tenantId: string, request: WeeklyKpiScanRequest): Promise<CommerceKpiScan>;
  findMentionedEntities(tenantId: string, question: string): Promise<CommerceEntityMention[]>;
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

  private async assertRangesComplete(
    tenantId: string,
    ranges: CommerceDateRange[],
  ): Promise<void> {
    const values: unknown[] = [tenantId];
    const requestedRanges = ranges.map((range) => {
      const start = values.push(range.start);
      const end = values.push(range.end);
      return `($${start}::date, $${end}::date)`;
    });
    const result = await this.database.query<{ missing_dates: unknown }>(
      `WITH requested_ranges(start_date, end_date) AS (
         VALUES ${requestedRanges.join(', ')}
       ), required_dates AS (
         SELECT DISTINCT calendar.partition_date::date AS partition_date
         FROM requested_ranges
         CROSS JOIN LATERAL generate_series(
           requested_ranges.start_date,
           requested_ranges.end_date,
           INTERVAL '1 day'
         ) AS calendar(partition_date)
       )
       SELECT COALESCE(
                ARRAY_AGG(required_dates.partition_date::text ORDER BY required_dates.partition_date)
                  FILTER (
                    WHERE partitions.partition_date IS NULL
                       OR partitions.completeness_state <> 'ready'
                  ),
                ARRAY[]::text[]
              ) AS missing_dates
       FROM required_dates
       LEFT JOIN commerce_tenant_data_partitions AS partitions
         ON partitions.tenant_id = $1
        AND partitions.partition_date = required_dates.partition_date`,
      values,
    );
    const missingDates = Array.isArray(result.rows[0]?.missing_dates)
      ? result.rows[0].missing_dates.map(String)
      : [];
    if (missingDates.length) throw new CommerceDataRangeIncompleteError(missingDates);
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
      currency_code: unknown;
    }>(
      `SELECT
         coverage_start::text AS start_date,
         coverage_end::text AS end_date,
         last_ingested_at,
         source_updated_at,
         data_mode,
         fact_row_count AS row_count,
         available_metrics,
         business_timezone,
         currency_code
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
      currencyCode: typeof row?.currency_code === 'string' && row.currency_code.trim()
        ? row.currency_code
        : 'CNY',
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

  async inspectDataHealth(
    tenantId: string,
    request: DataHealthRequest,
  ): Promise<CommerceDataHealthReport> {
    const statusResult = await this.database.query<{
      data_mode: unknown;
      source_updated_at: unknown;
      available_metrics: unknown;
    }>(
      `SELECT data_mode, source_updated_at, available_metrics
       FROM commerce_tenant_data_status
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const partitionResult = await this.database.query<{
      partition_date: unknown;
      completeness_state: unknown;
      fact_row_count: unknown;
      source_updated_at: unknown;
      coverage_proof_kind: unknown;
      coverage_connector_ids: unknown;
      coverage_run_ids: unknown;
    }>(
      `WITH required_dates AS (
         SELECT calendar.partition_date::date AS partition_date
         FROM generate_series($2::date, $3::date, INTERVAL '1 day') AS calendar(partition_date)
       )
       SELECT required_dates.partition_date::text AS partition_date,
              partitions.completeness_state,
              partitions.fact_row_count,
              partitions.source_updated_at,
              partitions.coverage_proof_kind,
              partitions.coverage_connector_ids,
              partitions.coverage_run_ids
       FROM required_dates
       LEFT JOIN commerce_tenant_data_partitions AS partitions
         ON partitions.tenant_id = $1
        AND partitions.partition_date = required_dates.partition_date
       ORDER BY required_dates.partition_date`,
      [tenantId, request.range.start, request.range.end],
    );
    const dimensionResult = await this.database.query<{
      total_rows: unknown;
      region_rows: unknown;
      channel_rows: unknown;
      sku_rows: unknown;
      category_rows: unknown;
    }>(
      `SELECT COUNT(*)::bigint AS total_rows,
              COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(region), '') IS NOT NULL
                  AND LOWER(BTRIM(region)) NOT IN ('unknown', '(not set)', 'not set', 'n/a', 'na', '未设置', '未知')
              )::bigint AS region_rows,
              COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(channel), '') IS NOT NULL
                  AND LOWER(BTRIM(channel)) NOT IN ('unknown', '(not set)', 'not set', 'n/a', 'na', '未设置', '未知')
              )::bigint AS channel_rows,
              COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(sku), '') IS NOT NULL
                  AND LOWER(BTRIM(sku)) NOT IN ('unknown', '(not set)', 'not set', 'n/a', 'na', '未设置', '未知')
              )::bigint AS sku_rows,
              COUNT(*) FILTER (
                WHERE NULLIF(BTRIM(category), '') IS NOT NULL
                  AND LOWER(BTRIM(category)) NOT IN ('unknown', '(not set)', 'not set', 'n/a', 'na', '未设置', '未知')
              )::bigint AS category_rows
       FROM commerce_daily_metrics
       WHERE tenant_id = $1
         AND metric_date BETWEEN $2::date AND $3::date`,
      [tenantId, request.range.start, request.range.end],
    );
    const dimensionCatalogResult = await this.database.query<{ dimension: unknown }>(
      `SELECT DISTINCT dimension
       FROM commerce_entity_catalog
       WHERE tenant_id = $1`,
      [tenantId],
    );
    const status = statusResult.rows[0];
    const dimensions = dimensionResult.rows[0];
    const totalRows = asNumber(dimensions?.total_rows) ?? 0;
    const coverage = (value: unknown) => totalRows === 0
      ? 1
      : Math.max(0, Math.min(1, (asNumber(value) ?? 0) / totalRows));
    const availableMetricDefinitions = commerceMetricDefinitions(
      Array.isArray(status?.available_metrics) ? status.available_metrics.map(String) : [],
    );
    const partitions = partitionResult.rows.map((row) => ({
      date: String(row.partition_date),
      state: row.completeness_state === 'ready'
        ? 'ready' as const
        : row.completeness_state === null || row.completeness_state === undefined
          ? 'missing' as const
          : 'incomplete' as const,
      factRowCount: asNumber(row.fact_row_count),
      sourceWatermark: asIsoTimestamp(row.source_updated_at),
    }));
    const coverageProofValid = partitionResult.rows.every((row) => (
      row.completeness_state === 'ready'
      && row.coverage_proof_kind === 'connector_coverage_intersection'
      && Array.isArray(row.coverage_connector_ids)
      && row.coverage_connector_ids.length > 0
      && Array.isArray(row.coverage_run_ids)
      && row.coverage_run_ids.length === row.coverage_connector_ids.length
    ));
    const availableDimensions = dimensionCatalogResult.rows
      .map((row) => String(row.dimension))
      .filter((dimension): dimension is CommerceDimension => (
        COMMERCE_DIMENSIONS.includes(dimension as CommerceDimension)
      ));
    return evaluateCommerceDataHealth({
      range: request.range,
      availableMetrics: availableMetricDefinitions.map((metric) => metric.id),
      availableDimensions,
      dimensionCoverage: {
        region: coverage(dimensions?.region_rows),
        channel: coverage(dimensions?.channel_rows),
        sku: coverage(dimensions?.sku_rows),
        category: coverage(dimensions?.category_rows),
      },
      partitions,
      dataMode: status?.data_mode === 'incremental' ? 'incremental' : 'snapshot',
      sourceWatermark: asIsoTimestamp(status?.source_updated_at),
      connectorStatus: status && coverageProofValid ? 'ready' : status ? 'degraded' : 'unknown',
      sourceAuditPassed: coverageProofValid,
      reconciliationConflict: false,
      now: request.now,
      requiredMetrics: request.requiredMetrics,
      requiredDimensions: request.requiredDimensions,
      requireProductDimension: request.requireProductDimension,
      optionalMetrics: request.optionalMetrics,
    });
  }

  async scanWeeklyKpis(
    tenantId: string,
    request: WeeklyKpiScanRequest,
  ): Promise<CommerceKpiScan> {
    await this.assertMetricsAvailable(tenantId, request.metrics);
    await this.assertRangesComplete(tenantId, [request.current]);
    const requestedBaseline = request.baseline
      ?? selectCommerceBaseline({ current: request.current });
    let baseline: CommerceBaselineDecision;
    if (requestedBaseline.strategy === 'explicit') {
      await this.assertRangesComplete(tenantId, requestedBaseline.comparisonRanges);
      baseline = requestedBaseline;
    } else {
      const completeRanges: CommerceDateRange[] = [];
      for (const range of requestedBaseline.comparisonRanges) {
        try {
          await this.assertRangesComplete(tenantId, [range]);
          completeRanges.push(range);
        } catch (error) {
          if (!(error instanceof CommerceDataRangeIncompleteError)) throw error;
        }
      }
      if (!completeRanges.length) {
        // Preserve the fail-closed error shape and list the first unavailable candidate.
        await this.assertRangesComplete(tenantId, [requestedBaseline.comparisonRanges[0]!]);
      }
      baseline = selectCommerceBaseline({
        current: request.current,
        availableRanges: completeRanges,
      });
    }
    const baselineRanges = baseline.comparisonRanges;
    const current = await this.aggregate(
      tenantId,
      request.current,
      request.metrics,
      request.filters,
    );
    const baselineWeeks = await Promise.all(baselineRanges.map(async (range) => ({
      range,
      values: await this.aggregate(tenantId, range, request.metrics, request.filters),
    })));
    const segmentSignals = await this.weeklySegmentSignals(
      tenantId,
      [request.current, ...baselineRanges],
      request.filters,
    );
    const zeroActivityDates = await this.weeklyZeroActivityDates(
      tenantId,
      request.current,
      request.filters,
    );
    return {
      ...scanCommerceKpis({
      currentRange: request.current,
      current,
      baselineWeeks,
      baselineDecision: baseline,
      metrics: request.metrics,
      }),
      segmentSignals,
      zeroActivityDates,
    };
  }

  private async weeklyZeroActivityDates(
    tenantId: string,
    range: CommerceDateRange,
    filters: CommerceFilters,
  ): Promise<string[]> {
    const where = scopedWhere(tenantId, range, filters);
    const result = await this.database.query<{ metric_date: unknown }>(
      `SELECT metric_date::text AS metric_date
       FROM commerce_daily_metrics
       WHERE ${where.sql}
       GROUP BY metric_date
       HAVING COALESCE(SUM(visits), 0) = 0
          AND COALESCE(SUM(paid_orders), 0) = 0
          AND COALESCE(SUM(gmv), 0) = 0
       ORDER BY metric_date`,
      where.values,
    );
    return result.rows
      .map((row) => String(row.metric_date ?? ''))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date));
  }

  private async weeklySegmentSignals(
    tenantId: string,
    ranges: CommerceDateRange[],
    filters: CommerceFilters,
  ): Promise<CommerceSegmentMetricSignal[]> {
    const envelope = ranges.reduce((output, range) => ({
      start: range.start < output.start ? range.start : output.start,
      end: range.end > output.end ? range.end : output.end,
    }), { ...ranges[0]! });
    const series = await Promise.all(WEEKLY_SEGMENT_SCREEN.map(async ({ metric, dimension }) => {
      const where = scopedWhere(tenantId, envelope, filters);
      const values = [...where.values];
      const rangeRows = ranges.map((range, index) => {
        const rangeIndex = values.push(index);
        const start = values.push(range.start);
        const end = values.push(range.end);
        return `($${rangeIndex}::integer, $${start}::date, $${end}::date)`;
      });
      const column = DIMENSION_COLUMNS[dimension];
      const sourceColumns = Array.from(new Set([
        'metric_date',
        column,
        ...METRIC_REQUIREMENTS[metric],
      ]));
      const result = await this.database.query<{
        range_index: unknown;
        key: unknown;
        value: unknown;
      }>(
        `WITH requested_ranges(range_index, start_date, end_date) AS (
           VALUES ${rangeRows.join(', ')}
         ), scoped AS MATERIALIZED (
           SELECT ${sourceColumns.join(', ')}
           FROM commerce_daily_metrics
           WHERE ${where.sql}
         )
         SELECT requested_ranges.range_index,
                scoped.${column}::text AS key,
                ${METRIC_SPECS[metric].sql} AS value
         FROM requested_ranges
         JOIN scoped
           ON scoped.metric_date BETWEEN requested_ranges.start_date AND requested_ranges.end_date
         GROUP BY requested_ranges.range_index, scoped.${column}
         ORDER BY requested_ranges.range_index, key
         LIMIT 1000`,
        values,
      );
      const byKey = new Map<string, Map<number, number | null>>();
      for (const row of result.rows) {
        const index = Number(row.range_index);
        const key = typeof row.key === 'string' ? row.key : String(row.key ?? '');
        if (!Number.isInteger(index) || index < 0 || index >= ranges.length || !key) continue;
        const valuesByRange = byKey.get(key) ?? new Map<number, number | null>();
        valuesByRange.set(index, asNumber(row.value));
        byKey.set(key, valuesByRange);
      }
      return [...byKey.entries()].map(([value, valuesByRange]) => ({
        ...robustCommerceMetricSignal({
          metric,
          current: valuesByRange.get(0) ?? null,
          history: ranges.slice(1).map((_, index) => valuesByRange.get(index + 1) ?? null),
          minimumRelativeChange: 0.25,
          robustZThreshold: 2.5,
        }),
        dimension,
        value,
      }));
    }));
    return series.flat()
      .filter((signal) => signal.anomalous && signal.direction === 'down')
      .sort((left, right) => Math.abs(right.relativeChange ?? 0) - Math.abs(left.relativeChange ?? 0)
        || left.metric.localeCompare(right.metric)
        || left.value.localeCompare(right.value))
      .slice(0, 20);
  }

  async findMentionedEntities(
    tenantId: string,
    question: string,
  ): Promise<CommerceEntityMention[]> {
    const result = await this.database.query<{
      dimension: unknown;
      value: unknown;
    }>(
      `SELECT dimension, value
       FROM commerce_entity_catalog
       WHERE tenant_id = $1
         AND STRPOS(LOWER($2), LOWER(value)) > 0
       ORDER BY LENGTH(value) DESC, fact_row_count DESC, value ASC
       LIMIT 200`,
      [tenantId, question],
    );
    const mentions = result.rows.flatMap((row): CommerceEntityMention[] => {
      const dimension = String(row.dimension);
      const value = String(row.value).trim();
      if (!COMMERCE_DIMENSIONS.includes(dimension as CommerceDimension) || !value) return [];
      const mentioned = /^[\x00-\x7F]+$/u.test(value)
        ? new RegExp(
            `(?<![\\p{L}\\p{N}_])${value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![\\p{L}\\p{N}_])`,
            'iu',
          ).test(question)
        : question.includes(value);
      return mentioned ? [{ dimension: dimension as CommerceDimension, value }] : [];
    });
    const selected: CommerceEntityMention[] = [];
    for (const mention of mentions) {
      if (selected.some((entry) => (
        entry.dimension === mention.dimension
        && entry.value !== mention.value
        && entry.value.includes(mention.value)
      ))) continue;
      selected.push(mention);
    }
    return selected;
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
    const sourceColumns = Array.from(new Set([
      ...(metrics.includes('ending_inventory') ? ['metric_date'] : []),
      ...metrics.flatMap((metric) => METRIC_REQUIREMENTS[metric]),
    ]));
    const columns = metrics.map((metric) => metric === 'ending_inventory'
      ? `(SELECT AVG(daily_value)::double precision
          FROM (
            SELECT metric_date, SUM(ending_inventory)::double precision AS daily_value
            FROM scoped GROUP BY metric_date
          ) inventory_days) AS "${metric}"`
      : `${METRIC_SPECS[metric].sql} AS "${metric}"`);
    const result = await this.database.query<Record<string, unknown>>(
      `WITH scoped AS MATERIALIZED (
         SELECT ${sourceColumns.join(', ')}
         FROM commerce_daily_metrics WHERE ${where.sql}
       )
       SELECT ${columns.join(', ')} FROM scoped`,
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
    await this.assertRangesComplete(tenantId, [
      request.current,
      ...(request.baseline ? [request.baseline] : []),
    ]);
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
    await this.assertRangesComplete(tenantId, [
      request.current,
      ...(request.baseline ? [request.baseline] : []),
    ]);
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
    const column = DIMENSION_COLUMNS[request.dimension];
    if (request.metric === 'ending_inventory') {
      let baselinePredicate: string | null = null;
      if (request.baseline) {
        const baselineStart = values.push(request.baseline.start);
        const baselineEnd = values.push(request.baseline.end);
        baselinePredicate = `metric_date BETWEEN $${baselineStart}::date AND $${baselineEnd}::date`;
      }
      const limitParameter = values.push(request.limit);
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
        `WITH daily_inventory AS (
           SELECT ${column}::text AS key, metric_date,
                  SUM(ending_inventory)::double precision AS daily_value
           FROM commerce_daily_metrics
           WHERE ${where.sql}
           GROUP BY ${column}, metric_date
         ), grouped_metrics AS (
           SELECT key,
                  COUNT(*) FILTER (WHERE ${currentPredicate}) > 0 AS current_present,
                  ${baselinePredicate
                    ? `COUNT(*) FILTER (WHERE ${baselinePredicate}) > 0`
                    : 'NULL::boolean'} AS baseline_present,
                  AVG(daily_value) FILTER (WHERE ${currentPredicate})::double precision AS current_value,
                  ${baselinePredicate
                    ? `AVG(daily_value) FILTER (WHERE ${baselinePredicate})::double precision`
                    : 'NULL::double precision'} AS baseline_value
           FROM daily_inventory GROUP BY key
         )
         SELECT key, current_present, baseline_present, current_value, baseline_value,
                CASE WHEN current_value IS NULL OR baseline_value IS NULL
                     THEN NULL ELSE current_value - baseline_value END AS absolute_change,
                CASE WHEN current_value IS NULL OR baseline_value IS NULL OR baseline_value = 0
                     THEN NULL ELSE (current_value - baseline_value) / ABS(baseline_value)
                END AS percent_change
         FROM grouped_metrics ORDER BY ${orderBy} LIMIT $${limitParameter}`,
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
    await this.assertRangesComplete(tenantId, [request.range]);
    const where = scopedWhere(tenantId, request.range, request.filters);
    const grain = request.grain;
    const query = request.metric === 'ending_inventory'
      ? `WITH daily_inventory AS (
           SELECT date_trunc('${grain}', metric_date)::date::text AS bucket,
                  metric_date, SUM(ending_inventory)::double precision AS daily_value
           FROM commerce_daily_metrics WHERE ${where.sql}
           GROUP BY 1, metric_date
         )
         SELECT bucket, AVG(daily_value)::double precision AS value
         FROM daily_inventory GROUP BY bucket ORDER BY bucket ASC LIMIT 740`
      : `SELECT date_trunc('${grain}', metric_date)::date::text AS bucket,
                ${METRIC_SPECS[request.metric].sql} AS value
         FROM commerce_daily_metrics
         WHERE ${where.sql}
         GROUP BY 1
         ORDER BY 1 ASC
         LIMIT 740`;
    const result = await this.database.query<{ bucket: unknown; value: unknown }>(
      query,
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
    await this.assertRangesComplete(tenantId, [request.range]);
    const where = scopedWhere(tenantId, request.range, request.filters);
    const result = await this.database.query<{
      sku: unknown;
      category: unknown;
      stockout_hours: unknown;
      minimum_ending_inventory: unknown;
      last_source_update: unknown;
    }>(
      `WITH daily_sku AS (
         SELECT sku,
                metric_date,
                MAX(category)::text AS category,
                SUM(stockout_hours)::double precision AS daily_stockout_hours,
                SUM(ending_inventory)::double precision AS daily_ending_inventory,
                MAX(source_updated_at) AS last_source_update
         FROM commerce_daily_metrics
         WHERE ${where.sql}
         GROUP BY sku, metric_date
       ), sku_risk AS (
         SELECT sku,
                MAX(category)::text AS category,
                SUM(daily_stockout_hours)::double precision AS stockout_hours,
                MIN(daily_ending_inventory)::double precision AS minimum_ending_inventory,
                MAX(last_source_update) AS last_source_update
         FROM daily_sku
         GROUP BY sku
       )
       SELECT sku, category, stockout_hours, minimum_ending_inventory, last_source_update
       FROM sku_risk
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
    return { ...definition, ...METRIC_AGGREGATION_SPECS[metric] };
  });
}

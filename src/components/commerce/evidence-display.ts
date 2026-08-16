import type { CommerceMetricId, EvidenceClaim, EvidenceTrace } from './types';

type Row = Record<string, unknown>;

export type EvidenceFact = { label: string; value: string };

export const EVIDENCE_METRIC_LABELS: Record<CommerceMetricId, string> = {
  gmv: 'GMV',
  net_revenue: '净收入',
  paid_orders: '支付订单',
  units: '销量',
  visits: '访问量',
  conversion_rate: '支付转化率',
  average_order_value: '客单价',
  refund_rate: '退款率',
  refund_amount: '退款金额',
  gross_profit: '毛利额',
  gross_margin: '毛利率',
  ad_spend: '广告消耗',
  roas: 'ROAS',
  new_customers: '新客数',
  stockout_hours: '缺货时长',
  ending_inventory: '期末库存',
};

const DIMENSION_LABELS: Record<string, string> = {
  region: '区域',
  channel: '渠道',
  sku: '商品',
  category: '品类',
};

const BASELINE_LABELS: Record<string, string> = {
  explicit: '用户指定基准',
  previous_four_complete_weeks_median: '此前四个完整周中位数',
  available_complete_weeks_median: '可用完整周中位数',
  previous_adjacent_period: '相邻完整周期',
};

const FIELD_LABELS: Record<string, string> = {
  current: '本期值',
  baseline: '基准值',
  baselineMedian: '四周中位数',
  baselineMinimum: '基准最小值',
  baselineMaximum: '基准最大值',
  absoluteChange: '绝对变化',
  relativeChange: '相对变化',
  percentChange: '相对变化',
  contributionShare: '归因贡献',
  value: '数值',
};

export function evidenceRecord(value: unknown): Row | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
function rangeText(value: unknown): string | null {
  const range = evidenceRecord(value);
  return typeof range?.start === 'string' && typeof range?.end === 'string'
    ? `${range.start} 至 ${range.end}`
    : null;
}

export function evidenceMetricLabel(metric: unknown): string {
  return typeof metric === 'string' && metric in EVIDENCE_METRIC_LABELS
    ? EVIDENCE_METRIC_LABELS[metric as CommerceMetricId]
    : String(metric ?? '未声明');
}

function metricList(value: unknown): string | null {
  return Array.isArray(value) && value.length
    ? value.map(evidenceMetricLabel).join('、')
    : null;
}

function filterText(value: unknown): string {
  const filters = evidenceRecord(value);
  if (!filters) return '全部数据';
  const labels: Record<string, string> = {
    regions: '区域',
    channels: '渠道',
    skus: '商品',
    categories: '品类',
  };
  const selected = Object.entries(labels).flatMap(([key, label]) => (
    Array.isArray(filters[key]) && filters[key].length
      ? [`${label}=${filters[key].map(String).join('、')}`]
      : []
  ));
  return selected.length ? selected.join('；') : '全部数据';
}

function baselineText(value: unknown): string | null {
  const directRange = rangeText(value);
  if (directRange) return directRange;
  const baseline = evidenceRecord(value);
  if (!baseline) return null;
  const strategy = typeof baseline.strategy === 'string'
    ? BASELINE_LABELS[baseline.strategy] ?? baseline.strategy
    : null;
  const ranges = Array.isArray(baseline.comparisonRanges)
    ? baseline.comparisonRanges.map(rangeText).filter((entry): entry is string => Boolean(entry))
    : [];
  if (strategy && ranges.length) return `${strategy}（${ranges.join('；')}）`;
  return strategy;
}

export function evidenceQueryFacts(trace: EvidenceTrace): EvidenceFact[] {
  const request = evidenceRecord(trace.request) ?? {};
  const preview = evidenceRecord(trace.preview);
  const facts: EvidenceFact[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value && !facts.some((entry) => entry.label === label && entry.value === value)) {
      facts.push({ label, value });
    }
  };

  if (trace.operation === 'commerce.describe_data') {
    const coverage = evidenceRecord(preview?.coverage);
    add('数据覆盖', rangeText(coverage));
    add('业务时区', typeof preview?.timezone === 'string' ? preview.timezone : null);
    add('币种', typeof preview?.currencyCode === 'string' ? preview.currencyCode : null);
    add('可用指标', metricList(Array.isArray(preview?.metrics)
      ? preview.metrics.map((entry) => evidenceRecord(entry)?.id).filter(Boolean)
      : null));
    return facts;
  }

  add('分析期', rangeText(request.current) ?? rangeText(request.range));
  add('指标', evidenceMetricLabel(request.metric === undefined ? null : request.metric));
  if (request.metric === undefined) add('指标', metricList(request.metrics));
  add('比较基准', baselineText(request.baseline));
  add('拆解维度', typeof request.dimension === 'string'
    ? DIMENSION_LABELS[request.dimension] ?? request.dimension
    : null);
  add('时间粒度', typeof request.grain === 'string' ? request.grain : null);
  add('筛选', filterText(request.filters));
  if (typeof request.sort === 'string') {
    add('排序', request.sort === 'absolute_change_desc'
      ? '绝对增量从高到低'
      : request.sort === 'current_desc' ? '本期值从高到低' : request.sort);
  }
  add('返回上限', typeof request.limit === 'number' ? `${request.limit} 项` : null);
  if (trace.operation === 'commerce.inspect_data_health') {
    add('必需指标', metricList(request.requiredMetrics));
    add('必需维度', Array.isArray(request.requiredDimensions)
      ? request.requiredDimensions.map((entry) => DIMENSION_LABELS[String(entry)] ?? String(entry)).join('、')
      : null);
  }
  return facts.filter((fact) => fact.value !== '未声明');
}

export function compactAuditRequest(request: unknown): unknown {
  const record = evidenceRecord(request);
  if (!record) return request;
  const { __queryScope: _internalScope, ...auditable } = record;
  return auditable;
}

function dimensionEntity(trace: EvidenceTrace, claim: EvidenceClaim): string | null {
  const match = claim.path.match(/^\/(\d+)\//u);
  if (!match || !Array.isArray(trace.preview)) return null;
  const row = evidenceRecord(trace.preview[Number(match[1])]);
  const entity = row?.key ?? row?.sku ?? row?.bucket;
  return typeof entity === 'string' ? entity : null;
}

export function evidenceClaimLabel(trace: EvidenceTrace, claim: EvidenceClaim): string {
  const field = claim.path.split('/').filter(Boolean).at(-1) ?? 'value';
  const entity = dimensionEntity(trace, claim);
  const metric = evidenceMetricLabel(claim.metric);
  return `${entity ? `${entity} · ` : ''}${metric} · ${FIELD_LABELS[field] ?? field}`;
}

export function formatEvidenceClaim(claim: EvidenceClaim, currencyCode = 'CNY'): string {
  if (claim.unit === 'currency') {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency: currencyCode,
      maximumFractionDigits: 2,
    }).format(claim.value);
  }
  if (claim.unit === 'percent') {
    return new Intl.NumberFormat('zh-CN', {
      style: 'percent',
      maximumFractionDigits: 2,
    }).format(claim.value);
  }
  if (claim.unit === 'integer') {
    return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(claim.value);
  }
  if (claim.unit === 'hours') return `${claim.value.toLocaleString('zh-CN')} 小时`;
  return claim.value.toLocaleString('zh-CN', { maximumFractionDigits: 4 });
}

import { createHash, randomUUID } from 'node:crypto';

import {
  COMMERCE_METRICS,
  commerceAgentAnswerSchema,
  type CommerceAgentAnswer,
  type CommerceEvidenceClaim,
  type CommerceEvidenceReceipt,
  type CommerceEvidenceUnit,
  type CommerceDimension,
  type CommerceMetric,
  type CommerceQueryAnalysisView,
  type CommerceResolvedQueryScope,
  type CommerceToolTrace,
} from './types';
import { commerceQuerySha256 } from './query-scope';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

const METRIC_UNITS: Record<CommerceMetric, CommerceEvidenceUnit> = {
  gmv: 'currency',
  net_revenue: 'currency',
  paid_orders: 'integer',
  units: 'integer',
  visits: 'integer',
  conversion_rate: 'percent',
  average_order_value: 'currency',
  refund_rate: 'percent',
  refund_amount: 'currency',
  gross_profit: 'currency',
  gross_margin: 'percent',
  ad_spend: 'currency',
  roas: 'decimal',
  new_customers: 'integer',
  stockout_hours: 'hours',
  ending_inventory: 'decimal',
};

const METRIC_LABELS: Record<CommerceMetric, string> = {
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

const DIMENSION_LABELS: Record<CommerceDimension, string> = {
  region: '区域',
  channel: '渠道',
  sku: '商品',
  category: '品类',
};

// Olist publishes normalized English category keys. Keep the source key beside the
// translated display name so an operator can still reconcile every label to evidence.
const OLIST_CATEGORY_LABELS: Record<string, string> = {
  health_beauty: '美妆健康',
  watches_gifts: '手表礼品',
  bed_bath_table: '床品浴室与桌面用品',
  housewares: '家居用品',
  sports_leisure: '运动休闲',
  furniture_decor: '家具装饰',
  computers_accessories: '电脑及配件',
  telephony: '通讯设备',
  toys: '玩具',
  garden_tools: '园艺工具',
  auto: '汽车用品',
  perfumery: '香水香氛',
  baby: '母婴用品',
  stationery: '文具',
  cool_stuff: '创意用品',
  electronics: '电子产品',
  fashion_bags_accessories: '时尚箱包及配件',
};

function humanizeDimensionValue(value: string, dimension?: CommerceDimension): string {
  if (dimension === 'category' && OLIST_CATEGORY_LABELS[value]) {
    return `${OLIST_CATEGORY_LABELS[value]}（${value}）`;
  }
  if (!value.includes('_')) return value;
  const readable = value
    .split('_')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
  return `${readable}（${value}）`;
}

const ANALYTICAL_OPERATIONS = new Set([
  'commerce.compare_metrics',
  'commerce.scan_weekly_kpis',
  'commerce.breakdown_metric',
  'commerce.trend_metric',
  'commerce.inventory_risk',
]);

const QUESTION_METRIC_ALIASES: Partial<Record<CommerceMetric, RegExp>> = {
  gmv: /\bGMV\b|成交额|成交金额/iu,
  net_revenue: /net[_\s-]?revenue|净收入/iu,
  paid_orders: /paid[_\s-]?orders?|支付订单/iu,
  units: /\bunits?\b|销量|销售件数/iu,
  visits: /\bvisits?\b|访问量|访客|流量/iu,
  conversion_rate: /conversion[_\s-]?rate|转化率/iu,
  average_order_value: /average[_\s-]?order[_\s-]?value|客单价|\bAOV\b/iu,
  refund_rate: /refund[_\s-]?rate|退款率/iu,
  refund_amount: /refund[_\s-]?amount|退款金额/iu,
  gross_profit: /gross[_\s-]?profit|毛利额/iu,
  gross_margin: /gross[_\s-]?margin|毛利率/iu,
  ad_spend: /ad[_\s-]?spend|广告花费|广告消耗|投放费用/iu,
  roas: /\bROAS\b/iu,
  new_customers: /new[_\s-]?customers?|新客/iu,
  stockout_hours: /stockout[_\s-]?hours?|缺货时长/iu,
  ending_inventory: /ending[_\s-]?inventory|期末库存/iu,
};

function textNumbers(parts: readonly string[]): string[] {
  return Array.from(parts.join('\n').matchAll(/-?\d[\d,]*(?:\.\d+)?/gu))
    .map((match) => String(Number(match[0].replaceAll(',', ''))))
    .filter((value) => value !== 'NaN');
}

const CHINESE_NUMBER_EXPRESSION = /(?:[零〇一二两三四五六七八九十百千万亿兆]{2,}|[零〇一二两三四五六七八九十百千万亿兆]+(?:元|单|件|个|次|天|周|月|年|成|倍|%|％))/u;
const UNSUPPORTED_CAUSAL_LANGUAGE = /(?:导致|造成|引发|归因于|证明了?因果|caused?\s+by|because\s+of)/iu;

function jsonPointerSegments(path: string): string[] {
  if (!path.startsWith('/')) throw new CommerceGroundingError(`Evidence path 无效：${path}`);
  return path.slice(1).split('/').map((segment) => {
    if (/~(?:[^01]|$)/u.test(segment)) {
      throw new CommerceGroundingError(`Evidence path 包含无效转义：${path}`);
    }
    return segment.replaceAll('~1', '/').replaceAll('~0', '~');
  });
}

function resolveJsonPointer(root: unknown, path: string): {
  found: boolean;
  value: unknown;
  segments: string[];
} {
  const segments = jsonPointerSegments(path);
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) {
        return { found: false, value: undefined, segments };
      }
      const index = Number(segment);
      if (index >= current.length) return { found: false, value: undefined, segments };
      current = current[index];
      continue;
    }
    const record = recordValue(current);
    if (!record || !Object.prototype.hasOwnProperty.call(record, segment)) {
      return { found: false, value: undefined, segments };
    }
    current = record[segment];
  }
  return { found: true, value: current, segments };
}

function commerceMetric(value: unknown): CommerceMetric | null {
  return typeof value === 'string' && COMMERCE_METRICS.includes(value as CommerceMetric)
    ? value as CommerceMetric
    : null;
}

function formatClaimValue(value: number, unit: CommerceEvidenceUnit, currencyCode: string): string {
  switch (unit) {
    case 'currency':
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: currencyCode,
        maximumFractionDigits: 2,
      }).format(value);
    case 'integer':
      return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 }).format(value);
    case 'percent':
      return new Intl.NumberFormat('zh-CN', {
        style: 'percent',
        maximumFractionDigits: 4,
      }).format(value);
    case 'hours':
      return `${new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value)} 小时`;
    case 'decimal':
      return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 }).format(value);
  }
}

function formatConcentration(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'percent',
    maximumFractionDigits: 1,
  }).format(value);
}

function formatSignedPercent(value: number): string {
  if (Math.abs(value) < Number.EPSILON) return formatConcentration(0);
  return `${value > 0 ? '+' : '-'}${formatConcentration(Math.abs(value))}`;
}

function formatSignedValue(
  value: number,
  unit: CommerceEvidenceUnit,
  currencyCode: string,
): string {
  if (Math.abs(value) < Number.EPSILON) return formatClaimValue(0, unit, currencyCode);
  return `${value > 0 ? '+' : '-'}${formatClaimValue(Math.abs(value), unit, currencyCode)}`;
}

function recommendationCopy(claims: readonly CommerceEvidenceClaim[]): {
  action: string;
  rationale: string;
} {
  const metrics = new Set(claims.map((claim) => claim.metric));
  if (metrics.has('stockout_hours') || metrics.has('ending_inventory')) {
    return {
      action: '复核库存与补货计划',
      rationale: '优先核对缺货时段、可售库存和补货节奏，再由业务负责人决定调整动作。',
    };
  }
  if (metrics.has('refund_rate') || metrics.has('refund_amount')) {
    return {
      action: '复核退款与售后流程',
      rationale: '继续按商品、渠道和退款原因拆解，并由售后负责人确认可执行动作。',
    };
  }
  if (metrics.has('ad_spend') || metrics.has('roas')) {
    return {
      action: '复核渠道投放结构',
      rationale: '继续核对渠道、活动和商品层级的投放表现，再由投放负责人决定预算动作。',
    };
  }
  if (metrics.has('gross_profit') || metrics.has('gross_margin')) {
    return {
      action: '复核成本、定价与商品结构',
      rationale: '继续按商品和渠道拆解利润表现，再由经营负责人确认定价或成本动作。',
    };
  }
  if (
    metrics.has('conversion_rate')
    || metrics.has('visits')
    || metrics.has('paid_orders')
  ) {
    return {
      action: '复核流量到支付的转化链路',
      rationale: '继续按渠道、商品和区域拆解转化表现，再由运营负责人确认优化动作。',
    };
  }
  return {
    action: '继续按经营维度拆解',
    rationale: '建议结合渠道、商品、区域和时间趋势继续核对，再由业务负责人决定执行动作。',
  };
}

const RISK_METRICS = new Set<CommerceMetric>([
  'refund_rate',
  'refund_amount',
  'stockout_hours',
]);

const MAINTAIN_METRICS = new Set<CommerceMetric>([
  'ad_spend',
  'ending_inventory',
]);

function actionOwnerRole(
  claims: readonly CommerceEvidenceClaim[],
): NonNullable<CommerceAgentAnswer['recommendations'][number]['ownerRole']> {
  const metrics = new Set(claims.map((claim) => claim.metric));
  if (metrics.has('stockout_hours') || metrics.has('ending_inventory')) return 'supply_chain';
  if (metrics.has('refund_rate') || metrics.has('refund_amount')) return 'customer_service';
  if (metrics.has('ad_spend') || metrics.has('roas') || metrics.has('new_customers')) return 'growth';
  if (metrics.has('gross_profit') || metrics.has('gross_margin')) return 'finance';
  if (metrics.has('units') || metrics.has('average_order_value')) return 'merchandising';
  return 'operations';
}

function actionGuardrails(
  claims: readonly CommerceEvidenceClaim[],
  successClaim: CommerceEvidenceClaim,
): NonNullable<CommerceAgentAnswer['recommendations'][number]['guardrails']> {
  const unique = new Map<string, CommerceEvidenceClaim>();
  for (const claim of claims) {
    if (claim.evidenceId === successClaim.evidenceId && claim.path === successClaim.path) continue;
    const protective = RISK_METRICS.has(claim.metric)
      || ['gross_profit', 'gross_margin', 'roas', 'conversion_rate'].includes(claim.metric);
    if (!protective) continue;
    // A guardrail is metric-level. Keep the first (and therefore most relevant)
    // claim instead of rendering duplicate guardrails for current/change paths.
    if (!unique.has(claim.metric)) unique.set(claim.metric, claim);
  }
  return [...unique.values()].slice(0, 4).map((claim) => ({
    metric: claim.metric,
    operator: RISK_METRICS.has(claim.metric) ? 'not_above' as const : 'not_below' as const,
    baselineClaim: claim,
    threshold: null,
    unit: claim.unit,
  }));
}

function controlledActionCard(
  recommendation: CommerceAgentAnswer['recommendations'][number],
): CommerceAgentAnswer['recommendations'][number] {
  const successClaim = recommendation.claims[0];
  if (!successClaim) return recommendation;
  const priority = recommendation.claims.some((claim) => RISK_METRICS.has(claim.metric))
    ? 'high' as const
    : 'medium' as const;
  const direction = RISK_METRICS.has(successClaim.metric)
    ? 'decrease' as const
    : MAINTAIN_METRICS.has(successClaim.metric)
      ? 'maintain' as const
      : 'increase' as const;
  const actionIdentity = {
    action: recommendation.action,
    claims: recommendation.claims.map((claim) => ({
      evidenceId: claim.evidenceId,
      path: claim.path,
      metric: claim.metric,
    })),
  };
  return {
    action: recommendation.action,
    rationale: recommendation.rationale,
    claims: recommendation.claims,
    id: `action_${createHash('sha256').update(canonicalJson(actionIdentity)).digest('hex').slice(0, 24)}`,
    priority,
    ownerRole: actionOwnerRole(recommendation.claims),
    // A deadline, numerical target, and evaluation window are operator commitments. The
    // Agent leaves them explicitly unconfirmed instead of manufacturing a plan approval.
    deadline: null,
    successMetric: {
      metric: successClaim.metric,
      direction,
      baselineClaim: successClaim,
      target: null,
      targetUnit: successClaim.unit,
      evaluationWindowDays: null,
    },
    guardrails: actionGuardrails(recommendation.claims, successClaim),
    status: 'proposed',
  };
}

const EXECUTIVE_QUESTION = /(?:经营情况|经营表现|经营诊断|经营复盘|整体表现|老板|管理层|增长质量|为什么|原因|驱动|风险|机会|建议|策略|分析|business\s+(?:performance|health)|diagnos|drivers?|\bwhy\b|risks?|opportunit|recommend|strateg|analy[sz]e)/iu;

const EXECUTIVE_METRIC_PRIORITY: CommerceMetric[] = [
  'gmv',
  'gross_profit',
  'gross_margin',
  'net_revenue',
  'paid_orders',
  'average_order_value',
  'conversion_rate',
  'new_customers',
  'refund_rate',
  'refund_amount',
  'roas',
  'ad_spend',
  'stockout_hours',
  'units',
  'visits',
  'ending_inventory',
];

const POSITIVE_DIRECTION_METRICS = new Set<CommerceMetric>([
  'gmv',
  'net_revenue',
  'paid_orders',
  'units',
  'visits',
  'conversion_rate',
  'average_order_value',
  'gross_profit',
  'gross_margin',
  'roas',
  'new_customers',
]);

const ADVERSE_DIRECTION_METRICS = new Set<CommerceMetric>([
  'refund_rate',
  'refund_amount',
  'stockout_hours',
]);

type ChangeDirection = 'up' | 'flat' | 'down' | 'unknown';

export function isExecutiveCommerceQuestion(question: string): boolean {
  return EXECUTIVE_QUESTION.test(question);
}

function uniqueClaims(
  claims: readonly CommerceEvidenceClaim[],
): CommerceEvidenceClaim[] {
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = `${claim.evidenceId}:${claim.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function percentChangeClaim(
  claims: readonly CommerceEvidenceClaim[],
  metric: CommerceMetric,
): CommerceEvidenceClaim | undefined {
  return claims.find((claim) => (
    claim.metric === metric && claim.path === `/changes/${metric}/percent`
  )) ?? claims.find((claim) => (
    claim.metric === metric
    && /^\/signals\/(?:0|[1-9]\d*)\/relativeChange$/u.test(claim.path)
  )) ?? claims.find((claim) => (
    claim.metric === metric
    && claim.path.endsWith('/percentChange')
  ));
}

function changeDirection(
  claims: readonly CommerceEvidenceClaim[],
  metric: CommerceMetric,
): ChangeDirection {
  const change = percentChangeClaim(claims, metric)?.value;
  if (change === undefined) return 'unknown';
  if (change > 0.001) return 'up';
  if (change < -0.001) return 'down';
  return 'flat';
}

function orderedClaimMetrics(claims: readonly CommerceEvidenceClaim[]): CommerceMetric[] {
  const available = new Set(claims.map((claim) => claim.metric));
  return EXECUTIVE_METRIC_PRIORITY.filter((metric) => available.has(metric));
}

function claimsForMetrics(
  claims: readonly CommerceEvidenceClaim[],
  metrics: readonly CommerceMetric[],
  maximum = 6,
): CommerceEvidenceClaim[] {
  const selected = uniqueClaims(claims.filter((claim) => metrics.includes(claim.metric)));
  return selected.slice(0, maximum);
}

function selectSummaryClaims(
  claims: readonly CommerceEvidenceClaim[],
): CommerceEvidenceClaim[] {
  const output: CommerceEvidenceClaim[] = [];
  for (const metric of orderedClaimMetrics(claims)) {
    const metricClaims = claims.filter((claim) => claim.metric === metric);
    const current = metricClaims.find((claim) => claim.path === `/current/${metric}`)
      ?? metricClaims.find((claim) => claim.path.endsWith('/current'));
    const change = percentChangeClaim(metricClaims, metric);
    if (current) output.push(current);
    if (change) output.push(change);
    if (output.length >= 6) break;
  }
  return uniqueClaims(output.length ? output : claims).slice(0, 6);
}

function selectBreakdownSummaryClaims(
  claims: readonly CommerceEvidenceClaim[],
  maximum = 12,
): CommerceEvidenceClaim[] {
  const current = claims.filter((claim) => /^\/(?:0|[1-9]\d*)\/current$/u.test(claim.path));
  const evidenceIds = [...new Set(current.map((claim) => claim.evidenceId))];
  const output: CommerceEvidenceClaim[] = [];
  for (const evidenceId of evidenceIds) {
    const evidenceClaims = current.filter((claim) => claim.evidenceId === evidenceId);
    output.push(...evidenceClaims.slice(0, 5));
  }
  return uniqueClaims(output).slice(0, maximum);
}

function executiveSummaryCopy(
  claims: readonly CommerceEvidenceClaim[],
  executive: boolean,
  includeBreakdown = false,
  breakdownNarrative: string | null = null,
): string {
  const primary = orderedClaimMetrics(claims)[0];
  if (!primary) return '当前没有足够的已验证指标形成经营结论。';
  const label = METRIC_LABELS[primary];
  const direction = changeDirection(claims, primary);
  if (!executive) {
    if (includeBreakdown && breakdownNarrative) return breakdownNarrative;
    const breakdownCopy = includeBreakdown ? '并完成请求维度的头部排名核验' : '';
    if (direction === 'up') return `${label}较基准提升，已完成当前结果核验${breakdownCopy}。`;
    if (direction === 'down') return `${label}较基准回落，已完成当前结果核验${breakdownCopy}。`;
    if (direction === 'flat') return `${label}较基准基本持平，已完成当前结果核验${breakdownCopy}。`;
    if (includeBreakdown) return `已完成${label}当前规模与请求维度的头部排名核验。`;
    return `已核验${label}当前规模；缺少可比基准时，暂不能判断改善或恶化。`;
  }

  const sentences: string[] = [];
  if (direction === 'up') {
    sentences.push(`核心指标${label}较基准提升，整体经营规模呈扩张态势。`);
  } else if (direction === 'down') {
    sentences.push(`核心指标${label}较基准回落，当前经营表现承压。`);
  } else if (direction === 'flat') {
    sentences.push(`核心指标${label}较基准基本持平，经营规模尚未形成明确增长。`);
  } else {
    sentences.push(`已核验${label}当前规模，但缺少可比基准，暂不能判断改善或恶化。`);
  }

  const gmvDirection = changeDirection(claims, 'gmv');
  const orderDirection = changeDirection(claims, 'paid_orders');
  const aovDirection = changeDirection(claims, 'average_order_value');
  if (gmvDirection === 'up' && orderDirection === 'up' && aovDirection === 'down') {
    sentences.push('GMV 与支付订单同向提升，但客单价承压；当前增长更偏交易量扩张，变现效率需要单独治理。');
  } else if (gmvDirection === 'up' && orderDirection === 'up' && aovDirection === 'up') {
    sentences.push('GMV、支付订单和客单价同步改善，规模与变现效率均释放正向信号。');
  } else if (gmvDirection === 'up' && orderDirection !== 'up') {
    sentences.push('GMV 改善没有得到订单规模同步支撑，需要检查价格、商品结构或少数大额订单的集中影响。');
  }

  const hasProfitEvidence = claims.some((claim) => (
    claim.metric === 'gross_profit' || claim.metric === 'gross_margin'
  ));
  const hasQualityEvidence = claims.some((claim) => (
    claim.metric === 'refund_rate'
    || claim.metric === 'refund_amount'
    || claim.metric === 'stockout_hours'
  ));
  if (!hasProfitEvidence || !hasQualityEvidence) {
    sentences.push('当前证据尚未同时覆盖利润与履约质量，不能仅凭规模变化判断经营是否真正健康。');
  }
  return sentences.slice(0, 3).join('');
}

function findingCopy(
  metric: CommerceMetric,
  claims: readonly CommerceEvidenceClaim[],
): { title: string; detail: string } {
  const label = METRIC_LABELS[metric];
  const direction = changeDirection(claims, metric);
  const hasBreakdown = claims.some((claim) => /^\/(?:0|[1-9]\d*)\//u.test(claim.path));
  const breakdownSuffix = hasBreakdown
    ? '拆解证据已定位到重点维度，应优先检查头部贡献项与拖累项。'
    : '下一步应按区域、渠道、品类或时间继续定位差异来源。';

  if (ADVERSE_DIRECTION_METRICS.has(metric)) {
    if (direction === 'up') {
      return { title: `风险信号 · ${label}上升`, detail: `该风险指标较基准上升。${breakdownSuffix}` };
    }
    if (direction === 'down') {
      return { title: `正向信号 · ${label}改善`, detail: `该风险指标较基准下降。${breakdownSuffix}` };
    }
  }
  if (POSITIVE_DIRECTION_METRICS.has(metric)) {
    if (direction === 'up') {
      return { title: `增长信号 · ${label}`, detail: `该指标较基准改善。${breakdownSuffix}` };
    }
    if (direction === 'down') {
      return { title: `风险信号 · ${label}承压`, detail: `该指标较基准回落。${breakdownSuffix}` };
    }
  }
  if (direction === 'flat') {
    return { title: `关注项 · ${label}持平`, detail: `该指标较基准没有形成明显改善。${breakdownSuffix}` };
  }
  return {
    title: `经营现状 · ${label}`,
    detail: `当前规模已经核验，但缺少可比变化证据。${breakdownSuffix}`,
  };
}

function decisionFindings(
  claims: readonly CommerceEvidenceClaim[],
  executive: boolean,
  includeBreakdown: boolean,
): CommerceAgentAnswer['findings'] {
  const findings: CommerceAgentAnswer['findings'] = [];
  for (const metric of orderedClaimMetrics(claims)) {
    const metricClaims = uniqueClaims(claims.filter((claim) => claim.metric === metric));
    const comparisonClaims = metricClaims.filter((claim) => !/^\/(?:0|[1-9]\d*)\//u.test(claim.path));
    const breakdownClaims = metricClaims.filter((claim) => (
      /^\/(?:0|[1-9]\d*)\//u.test(claim.path) && !claim.path.endsWith('/value')
    ));
    const trendClaims = metricClaims.filter((claim) => claim.path.endsWith('/value'));
    if (comparisonClaims.length && (!includeBreakdown || changeDirection(metricClaims, metric) !== 'unknown')) {
      const copy = findingCopy(metric, comparisonClaims);
      findings.push({ metric, ...copy, claims: comparisonClaims.slice(0, 8) });
    }
    if ((executive || includeBreakdown) && breakdownClaims.length) {
      const currentBreakdownClaims = breakdownClaims.filter((claim) => (
        /^\/(?:0|[1-9]\d*)\/current$/u.test(claim.path)
      ));
      const selectedBreakdownClaims = currentBreakdownClaims.length
        ? currentBreakdownClaims.slice(0, 5)
        : breakdownClaims.slice(0, 6);
      findings.push({
        metric,
        title: `${executive ? '维度驱动' : '头部拆解'} · ${METRIC_LABELS[metric]}`,
        detail: executive
          ? '维度拆解已定位到排序靠前的贡献项与变化项，应据此做资源取舍，而不是继续平均投入。'
          : '榜首和前五名的实际数值如下，可直接用于判断头部集中程度。',
        claims: selectedBreakdownClaims,
      });
    }
    if (executive && trendClaims.length) {
      const values = trendClaims.map((claim) => claim.value);
      const maximum = Math.max(...values);
      const minimum = Math.min(...values);
      const volatile = maximum !== 0 && (maximum - minimum) / Math.abs(maximum) > 0.2;
      findings.push({
        metric,
        title: `趋势信号 · ${METRIC_LABELS[metric]}${volatile ? '波动明显' : '相对稳定'}`,
        detail: volatile
          ? '完整周期内存在明显波动，应复盘高低点对应的活动、供给和流量变化。'
          : '完整周期内走势相对稳定，可把管理重点放在结构优化与持续性验证。',
        claims: trendClaims.slice(0, 6),
      });
    }
    if (findings.length >= (executive || includeBreakdown ? 6 : 3)) break;
  }
  return findings.slice(0, executive || includeBreakdown ? 6 : 3);
}

function executiveRecommendations(
  claims: readonly CommerceEvidenceClaim[],
): CommerceAgentAnswer['recommendations'] {
  const primary = orderedClaimMetrics(claims)[0];
  if (!primary) return [];
  const fallbackClaims = claimsForMetrics(claims, [primary]);
  const hasBreakdownEvidence = claims.some((claim) => (
    /^\/(?:0|[1-9]\d*)\//u.test(claim.path) && !claim.path.endsWith('/value')
  ));
  const breakdownChanges = claims.filter((claim) => (
    /^\/(?:0|[1-9]\d*)\/(?:absoluteChange|percentChange)$/u.test(claim.path)
  ));
  const hasNegativeBreakdown = breakdownChanges.some((claim) => claim.value < 0);
  const hasPositiveBreakdown = breakdownChanges.some((claim) => claim.value > 0);
  const hasOnlyNonNegativeBreakdown = breakdownChanges.length > 0
    && hasPositiveBreakdown
    && !hasNegativeBreakdown;
  const growthValidationClaims = claimsForMetrics(
    claims,
    [primary, 'conversion_rate', 'average_order_value'],
    8,
  );
  const recommendations: CommerceAgentAnswer['recommendations'] = [{
    action: hasOnlyNonNegativeBreakdown
      ? '验证头部增量的可持续性，再决定是否加码'
      : hasBreakdownEvidence
        ? '围绕头部贡献项配置资源，治理已确认拖累项'
      : '完成增量贡献拆解并明确资源取舍',
    rationale: hasOnlyNonNegativeBreakdown
      ? '拆解覆盖项均为正增量，当前没有可验证拖累项。先核对活动归因、转化质量及尚未接入的利润与履约护栏，再由负责人决定资源调整。'
      : hasBreakdownEvidence
        ? '利用已完成的维度拆解明确加码负责人、预算与验收指标；只对证据中已经出现的负向项设置复核和止损条件。'
      : '按区域、渠道和品类识别持续贡献项与拖累项；对正向组合明确加码负责人，对拖累组合设置复核和止损条件。',
    claims: hasOnlyNonNegativeBreakdown ? growthValidationClaims : fallbackClaims,
  }];

  if (
    changeDirection(claims, 'paid_orders') === 'up'
    && changeDirection(claims, 'average_order_value') === 'down'
  ) {
    recommendations.push({
      action: '修复客单价承压，避免只追订单规模',
      rationale: '检查价格带、组合购和连带销售，用客单价与支付订单共同验收，不以单一 GMV 作为成功标准。',
      claims: claimsForMetrics(claims, ['average_order_value', 'paid_orders']),
    });
  } else if (changeDirection(claims, 'new_customers') === 'up') {
    recommendations.push({
      action: '核验新增客户的获取质量',
      rationale: '将新客增长与广告消耗、ROAS 和后续复购联查，避免只用新客数量判断增长质量。',
      claims: claimsForMetrics(claims, ['new_customers', 'ad_spend', 'roas']),
    });
  }

  const hasProfitEvidence = claims.some((claim) => (
    claim.metric === 'gross_profit' || claim.metric === 'gross_margin'
  ));
  const hasQualityEvidence = claims.some((claim) => (
    claim.metric === 'refund_rate'
    || claim.metric === 'refund_amount'
    || claim.metric === 'stockout_hours'
  ));
  if (!hasProfitEvidence || !hasQualityEvidence) {
    recommendations.push({
      action: '补齐利润与履约护栏后再扩大投入',
      rationale: '同步核对毛利、退款和缺货；若规模改善没有转化为利润改善或风险指标恶化，应暂停加码并继续定位原因。',
      claims: fallbackClaims,
    });
  }
  return recommendations.filter((recommendation) => recommendation.claims.length).slice(0, 3);
}

function controlledFollowUps(
  claims: readonly CommerceEvidenceClaim[],
  executive: boolean,
  scope: CommerceResolvedQueryScope | null,
): string[] {
  const metrics = orderedClaimMetrics(claims).slice(0, 2);
  const inCurrentRange = (question: string): string => scope?.current
    ? `${scope.current.start} 至 ${scope.current.end}，${question}`
    : `在同一日期范围内，${question}`;
  if (!executive) {
    const alternateDimension = scope?.dimensions.includes('region') ? '品类' : '区域';
    return metrics.flatMap((metric) => [
      inCurrentRange(`按${alternateDimension}拆解${METRIC_LABELS[metric]}并列出前五名`),
      inCurrentRange(`查看${METRIC_LABELS[metric]}的按日趋势`),
    ]).slice(0, 5);
  }
  const primary = metrics[0];
  if (!primary) return [];
  const output = [
    inCurrentRange(`按区域、渠道和品类拆解${METRIC_LABELS[primary]}，列出头部贡献项与负向项（如有）`),
    inCurrentRange(`查看${METRIC_LABELS[primary]}的按日趋势，定位高低点`),
  ];
  if (metrics[1]) {
    output.push(inCurrentRange(`联查${METRIC_LABELS[primary]}与${METRIC_LABELS[metrics[1]]}的结构差异`));
  }
  return output;
}

function boundedPreview(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  // Registered tools cap rows and field lengths so normal evidence remains
  // fully replayable. The ceiling is a final storage/response safety valve.
  if (Buffer.byteLength(serialized, 'utf8') <= 512_000) return value;
  if (Array.isArray(value)) {
    return {
      truncated: true,
      totalRows: value.length,
      rows: value.slice(0, 40),
    };
  }
  return { truncated: true, sha256: sha256(value) };
}

function previewIsTruncated(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value), 'utf8') > 512_000;
}

interface InternalEvidence {
  receipt: CommerceEvidenceReceipt;
  request: unknown;
}

interface BreakdownNarrative {
  narrative: string;
  claims: CommerceEvidenceClaim[];
}

interface WeeklyGrowthDiagnosis {
  narrative: string;
  claims: CommerceEvidenceClaim[];
  findings: CommerceAgentAnswer['findings'];
  recommendation: CommerceAgentAnswer['recommendations'][number] | null;
}

interface ExpectedClaimBinding {
  metric: CommerceMetric;
  unit: CommerceEvidenceUnit;
}

function expectedClaimBinding(
  observation: InternalEvidence,
  segments: readonly string[],
): ExpectedClaimBinding | null {
  const operation = observation.receipt.operation;
  if (operation === 'commerce.compare_metrics') {
    if (segments.length === 2 && ['current', 'baseline'].includes(segments[0])) {
      const metric = commerceMetric(segments[1]);
      return metric ? { metric, unit: METRIC_UNITS[metric] } : null;
    }
    if (segments.length === 3 && segments[0] === 'changes') {
      const metric = commerceMetric(segments[1]);
      if (!metric || !['absolute', 'percent'].includes(segments[2])) return null;
      return {
        metric,
        unit: segments[2] === 'percent' ? 'percent' : METRIC_UNITS[metric],
      };
    }
    return null;
  }
  if (operation === 'commerce.scan_weekly_kpis') {
    if (segments.length === 2 && segments[0] === 'current') {
      const metric = commerceMetric(segments[1]);
      return metric ? { metric, unit: METRIC_UNITS[metric] } : null;
    }
    if (
      segments.length === 4
      && segments[0] === 'baselineWeeks'
      && /^(?:0|[1-9]\d*)$/u.test(segments[1])
      && segments[2] === 'values'
    ) {
      const metric = commerceMetric(segments[3]);
      return metric ? { metric, unit: METRIC_UNITS[metric] } : null;
    }
    if (
      segments.length === 3
      && segments[0] === 'signals'
      && /^(?:0|[1-9]\d*)$/u.test(segments[1])
    ) {
      const rows = recordValue(observation.receipt.data)?.signals;
      const row = Array.isArray(rows) ? recordValue(rows[Number(segments[1])]) : null;
      const metric = commerceMetric(row?.metric);
      if (!metric) return null;
      if (['current', 'baselineMedian', 'baselineMinimum', 'baselineMaximum', 'mad', 'absoluteChange'].includes(segments[2])) {
        return { metric, unit: METRIC_UNITS[metric] };
      }
      if (segments[2] === 'relativeChange') return { metric, unit: 'percent' };
      if (segments[2] === 'robustZScore') return { metric, unit: 'decimal' };
    }
    return null;
  }
  if (operation === 'commerce.diagnostic_decision') {
    const evaluation = recordValue(recordValue(observation.receipt.data)?.evaluation);
    const contributionMetric = commerceMetric(evaluation?.contributionMetric);
    return segments.length === 2
      && segments[0] === 'evaluation'
      && segments[1] === 'contributionShare'
      && contributionMetric
      ? { metric: contributionMetric, unit: 'percent' }
      : null;
  }
  const requestMetric = commerceMetric(recordValue(observation.request)?.metric);
  if (operation === 'commerce.breakdown_metric' && requestMetric) {
    if (segments.length !== 2 || !/^(?:0|[1-9]\d*)$/u.test(segments[0])) return null;
    const field = segments[1];
    if (!['current', 'baseline', 'absoluteChange', 'percentChange'].includes(field)) {
      return null;
    }
    return {
      metric: requestMetric,
      unit: field === 'percentChange' ? 'percent' : METRIC_UNITS[requestMetric],
    };
  }
  if (operation === 'commerce.trend_metric' && requestMetric) {
    return segments.length === 2
      && /^(?:0|[1-9]\d*)$/u.test(segments[0])
      && segments[1] === 'value'
      ? { metric: requestMetric, unit: METRIC_UNITS[requestMetric] }
      : null;
  }
  if (operation === 'commerce.inventory_risk') {
    if (segments.length !== 2 || !/^(?:0|[1-9]\d*)$/u.test(segments[0])) return null;
    if (segments[1] === 'stockoutHours') {
      return { metric: 'stockout_hours', unit: 'hours' };
    }
    if (segments[1] === 'minimumEndingInventory') {
      return { metric: 'ending_inventory', unit: 'decimal' };
    }
  }
  return null;
}

function claimContext(observation: InternalEvidence, segments: readonly string[]): string | null {
  if (observation.receipt.operation === 'commerce.compare_metrics') {
    const request = recordValue(observation.request);
    const current = recordValue(request?.current);
    const baseline = recordValue(request?.baseline);
    const range = (value: Record<string, unknown> | null): string | null => (
      typeof value?.start === 'string' && typeof value?.end === 'string'
        ? `${value.start} 至 ${value.end}`
        : null
    );
    const currentRange = range(current);
    const baselineRange = range(baseline);
    if (segments[0] === 'current') {
      return currentRange ? `分析期 ${currentRange}` : '分析期';
    }
    if (segments[0] === 'baseline') {
      return baselineRange ? `基准期 ${baselineRange}` : '基准期';
    }
    if (segments[0] === 'changes') {
      const label = segments[2] === 'percent' ? '相对变化' : '绝对变化';
      return baselineRange ? `${label}，基准期 ${baselineRange}` : label;
    }
  }
  if (observation.receipt.operation === 'commerce.scan_weekly_kpis') {
    const request = recordValue(observation.request);
    const range = recordValue(request?.current);
    const rangeText = typeof range?.start === 'string' && typeof range?.end === 'string'
      ? `${range.start} 至 ${range.end}`
      : null;
    if (segments[0] === 'current') return rangeText ? `诊断周 ${rangeText}` : '诊断周';
    if (segments[0] === 'baselineWeeks') return '此前完整周基准样本';
    if (segments[0] === 'signals') return '四周中位数稳健异常扫描';
  }
  if (observation.receipt.operation === 'commerce.diagnostic_decision') {
    const evaluation = recordValue(recordValue(observation.receipt.data)?.evaluation);
    const hypothesis = evaluation?.hypothesis;
    if (segments[0] === 'evaluation' && segments[1] === 'contributionShare') {
      return hypothesis === 'growth_driver' ? '对GMV增量的归因贡献' : '对核心指标变化的归因贡献';
    }
  }
  if (Array.isArray(observation.receipt.data) && /^(?:0|[1-9]\d*)$/u.test(segments[0])) {
    const row = recordValue(observation.receipt.data[Number(segments[0])]);
    const entity = row?.key ?? row?.sku ?? row?.bucket;
    if (typeof entity === 'string' && entity) {
      const requestedDimension = recordValue(observation.request)?.dimension;
      const dimension = typeof requestedDimension === 'string'
        && ['region', 'channel', 'sku', 'category'].includes(requestedDimension)
        ? requestedDimension as CommerceDimension
        : undefined;
      const label = humanizeDimensionValue(entity, dimension);
      if (
        observation.receipt.operation === 'commerce.breakdown_metric'
        && ['baseline', 'absoluteChange', 'percentChange'].includes(segments[1] ?? '')
      ) {
        const baseline = recordValue(observation.request)?.baseline;
        const baselineRange = recordValue(baseline);
        const rangeText = typeof baselineRange?.start === 'string'
          && typeof baselineRange?.end === 'string'
          ? `${baselineRange.start} 至 ${baselineRange.end}`
          : null;
        return `${label}，较最近完整周${rangeText ? ` ${rangeText}` : ''}`;
      }
      return label;
    }
  }
  return null;
}

interface CommerceEvidenceLedgerOptions {
  requireFreshCatalogForAnswered?: boolean;
  maxDataAgeHours?: number;
  /** Trusted business/replay clock used for Evidence timestamps and source watermarks. */
  now?: () => number;
  /** Trusted process wall clock used only for ingestion/transport freshness. */
  wallNow?: () => number;
  queryScope?: CommerceResolvedQueryScope;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function collectDeterministicClaims(
  observation: InternalEvidence,
  value: unknown,
  segments: string[],
  output: CommerceEvidenceClaim[],
  maximum: number,
): void {
  if (output.length >= maximum) return;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const binding = expectedClaimBinding(observation, segments);
    if (binding) {
      output.push({
        evidenceId: observation.receipt.evidenceId,
        path: `/${segments.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`,
        metric: binding.metric,
        value,
        unit: binding.unit,
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectDeterministicClaims(observation, entry, [...segments, String(index)], output, maximum);
    });
    return;
  }
  const record = recordValue(value);
  if (!record) return;
  for (const [key, entry] of Object.entries(record)) {
    collectDeterministicClaims(observation, entry, [...segments, key], output, maximum);
    if (output.length >= maximum) return;
  }
}

function selectDeterministicObservationClaims(
  observation: InternalEvidence,
  candidates: readonly CommerceEvidenceClaim[],
  maximum: number,
): CommerceEvidenceClaim[] {
  if (observation.receipt.operation === 'commerce.scan_weekly_kpis') {
    const request = recordValue(observation.request);
    const metrics = requestMetrics(observation.receipt.operation, request ?? {});
    const selected = metrics.flatMap((metric) => {
      const current = candidates.find((claim) => claim.path === `/current/${metric}`);
      const signalIndex = Array.isArray(recordValue(observation.receipt.data)?.signals)
        ? (recordValue(observation.receipt.data)!.signals as unknown[]).findIndex((entry) => (
            recordValue(entry)?.metric === metric
          ))
        : -1;
      const baseline = signalIndex >= 0
        ? candidates.find((claim) => claim.path === `/signals/${signalIndex}/baselineMedian`)
        : undefined;
      const change = signalIndex >= 0
        ? candidates.find((claim) => claim.path === `/signals/${signalIndex}/relativeChange`)
        : undefined;
      return [current, baseline, change]
        .filter((claim): claim is CommerceEvidenceClaim => Boolean(claim));
    });
    return uniqueClaims(selected.length ? selected : candidates).slice(0, maximum);
  }
  if (observation.receipt.operation === 'commerce.compare_metrics') {
    const request = recordValue(observation.request);
    const metrics = requestMetrics(observation.receipt.operation, request ?? {});
    const selected = metrics.flatMap((metric) => {
      const current = candidates.find((claim) => claim.path === `/current/${metric}`);
      const baseline = candidates.find((claim) => claim.path === `/baseline/${metric}`);
      const percent = candidates.find((claim) => claim.path === `/changes/${metric}/percent`);
      const absolute = candidates.find((claim) => claim.path === `/changes/${metric}/absolute`);
      return [current, baseline, percent ?? absolute]
        .filter((claim): claim is CommerceEvidenceClaim => Boolean(claim));
    });
    return uniqueClaims(selected.length ? selected : candidates).slice(0, maximum);
  }
  if (observation.receipt.operation === 'commerce.breakdown_metric') {
    return candidates.filter((claim) => (
      claim.path.endsWith('/current') || claim.path.endsWith('/percentChange')
    )).slice(0, maximum);
  }
  if (observation.receipt.operation === 'commerce.trend_metric') {
    let eligible = [...candidates];
    const request = recordValue(observation.request);
    const range = recordValue(request?.range);
    if (request?.grain === 'month' && eligible.length > 2) {
      const start = typeof range?.start === 'string' ? range.start : '';
      const end = typeof range?.end === 'string' ? range.end : '';
      if (start && !start.endsWith('-01')) eligible = eligible.slice(1);
      if (end) {
        const nextDay = new Date(`${end}T00:00:00.000Z`);
        nextDay.setUTCDate(nextDay.getUTCDate() + 1);
        if (nextDay.getUTCDate() !== 1) eligible = eligible.slice(0, -1);
      }
      if (!eligible.length) eligible = [...candidates];
    }
    if (eligible.length <= maximum) return eligible;
    const byValue = [...eligible].sort((left, right) => left.value - right.value);
    return uniqueClaims([
      eligible[0],
      eligible[eligible.length - 1],
      byValue[0],
      byValue[byValue.length - 1],
    ].filter((claim): claim is CommerceEvidenceClaim => Boolean(claim))).slice(0, maximum);
  }
  return [...candidates].slice(0, maximum);
}

function collectDateRanges(value: unknown, output: Array<{ start: string; end: string }>): void {
  const record = recordValue(value);
  if (!record) {
    if (Array.isArray(value)) value.forEach((entry) => collectDateRanges(entry, output));
    return;
  }
  if (
    typeof record.start === 'string'
    && typeof record.end === 'string'
    && /^\d{4}-\d{2}-\d{2}$/u.test(record.start)
    && /^\d{4}-\d{2}-\d{2}$/u.test(record.end)
  ) {
    output.push({ start: record.start, end: record.end });
  }
  Object.values(record).forEach((entry) => collectDateRanges(entry, output));
}

function requestDateRange(
  operation: string,
  request: Record<string, unknown>,
): Record<string, unknown> | null {
  return recordValue(operation === 'commerce.trend_metric' || operation === 'commerce.inventory_risk'
    ? request.range
    : request.current);
}

function requestMetrics(operation: string, request: Record<string, unknown>): CommerceMetric[] {
  if (operation === 'commerce.compare_metrics' || operation === 'commerce.scan_weekly_kpis') {
    return Array.isArray(request.metrics)
      ? request.metrics.map(commerceMetric).filter((metric): metric is CommerceMetric => Boolean(metric))
      : [];
  }
  if (operation === 'commerce.inventory_risk') {
    return ['stockout_hours', 'ending_inventory'];
  }
  const metric = commerceMetric(request.metric);
  return metric ? [metric] : [];
}

function normalizedFilters(value: unknown): Record<string, string[]> {
  const filters = recordValue(value);
  return Object.fromEntries(['regions', 'channels', 'skus', 'categories'].map((key) => [
    key,
    Array.isArray(filters?.[key])
      ? filters[key].map(String).sort((left, right) => left.localeCompare(right))
      : [],
  ]));
}

function sameDateRange(
  actual: Record<string, unknown> | null,
  expected: { start: string; end: string } | null,
): boolean {
  if (!actual || !expected) return actual === null && expected === null;
  return actual.start === expected.start && actual.end === expected.end;
}

function clarificationCopy(scope: CommerceResolvedQueryScope | null): {
  answer: string;
  followUps: string[];
} {
  if (!scope) {
    return {
      answer: '当前信息不足，无法执行可验证的数据查询。请补充明确的日期范围、经营指标或筛选范围。',
      followUps: ['补充要分析的日期范围、经营指标和筛选条件'],
    };
  }
  const prompts: string[] = [];
  if (scope.missingSlots.includes('metrics')) prompts.push('请明确要分析的经营指标');
  if (scope.missingSlots.includes('current_date_range')) {
    prompts.push(scope.reasons.includes('range_outside_coverage')
      ? '请改用数据目录覆盖范围内的日期'
      : '请补充分析期的开始和结束日期');
  }
  if (scope.missingSlots.includes('baseline_date_range')) prompts.push('请补充要对比的基准期');
  if (scope.missingSlots.includes('filters')) {
    prompts.push(scope.reasons.includes('unsupported_filter_logic')
      ? '当前仅支持明确的正向筛选，请改写排除或否定条件'
      : '请明确可在数据目录中识别的地区、渠道、SKU 或品类');
  }
  const detail = prompts.length ? prompts.join('；') : '请补充可验证的分析范围';
  return {
    answer: `当前查询范围尚未完整解析：${detail}。`,
    followUps: prompts,
  };
}

function refusalCopy(scope: CommerceResolvedQueryScope | null): string {
  if (scope?.reasons.includes('invalid_timezone')) {
    return '当前租户业务时区配置无效，无法安全解析相对日期，因此未执行分析查询。';
  }
  if (scope?.reasons.includes('metric_unavailable')) {
    return '当前租户数据目录不提供所请求的指标，因此未执行分析查询。';
  }
  if (scope?.reasons.includes('mutation_or_sensitive_request')) {
    return '该请求涉及写操作或敏感数据，超出只读经营分析权限，未执行相关操作。';
  }
  return '该请求超出只读电商经营数据分析范围，未执行任何写操作或无关查询。';
}

export class CommerceGroundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommerceGroundingError';
  }
}

export class CommerceEvidenceLedger {
  private readonly observations = new Map<string, InternalEvidence>();

  constructor(private readonly options: CommerceEvidenceLedgerOptions = {}) {}

  queryScope(): CommerceResolvedQueryScope | null {
    return this.options.queryScope ?? null;
  }

  private analyticalObservations(operation?: string): InternalEvidence[] {
    return Array.from(this.observations.values()).filter((observation) => (
      ANALYTICAL_OPERATIONS.has(observation.receipt.operation)
      && (!operation || observation.receipt.operation === operation)
    ));
  }

  private requiredBreakdownPairs(): Array<{
    metric: CommerceMetric;
    dimension: CommerceDimension;
  }> {
    const scope = this.options.queryScope;
    if (
      !scope
      || scope.metricSelection !== 'explicit'
      || !scope.metrics.length
      || !scope.dimensions.length
    ) return [];
    return scope.metrics.flatMap((metric) => (
      scope.dimensions.map((dimension) => ({ metric, dimension }))
    ));
  }

  private requiredViewSatisfied(view: CommerceQueryAnalysisView): boolean {
    const scope = this.options.queryScope;
    if (!scope || scope.status !== 'ready') return false;
    if (view === 'totals' || view === 'comparison') {
      return this.analyticalObservations('commerce.compare_metrics').length > 0;
    }
    if (view === 'diagnostic_scan') {
      return this.analyticalObservations('commerce.scan_weekly_kpis').length > 0;
    }
    if (view === 'trend') {
      return this.analyticalObservations('commerce.trend_metric').some((observation) => {
        const request = recordValue(observation.request);
        return !scope.trendGrain || request?.grain === scope.trendGrain;
      });
    }
    if (view === 'inventory') {
      return this.analyticalObservations('commerce.inventory_risk').length > 0;
    }
    const breakdowns = this.analyticalObservations('commerce.breakdown_metric');
    const requiredPairs = this.requiredBreakdownPairs();
    if (requiredPairs.length) {
      return requiredPairs.every(({ metric, dimension }) => breakdowns.some((observation) => {
        const request = recordValue(observation.request);
        return request?.metric === metric && request.dimension === dimension;
      }));
    }
    if (!scope.dimensions.length) return breakdowns.length > 0;
    return scope.dimensions.every((dimension) => breakdowns.some((observation) => (
      recordValue(observation.request)?.dimension === dimension
    )));
  }

  requiredAnalyticalToolNames(): string[] {
    const scope = this.options.queryScope;
    if (!scope || scope.status !== 'ready') return [];
    const names: Record<CommerceQueryAnalysisView, string> = {
      totals: 'compare_commerce_metrics',
      comparison: 'compare_commerce_metrics',
      breakdown: 'breakdown_commerce_metric',
      trend: 'trend_commerce_metric',
      inventory: 'find_inventory_risk',
      diagnostic_scan: 'scan_weekly_commerce_kpis',
    };
    return [...new Set(scope.requiredViews.map((view) => names[view]))];
  }

  missingRequiredAnalyticalToolNames(): string[] {
    const scope = this.options.queryScope;
    if (!scope || scope.status !== 'ready') return [];
    const names: Record<CommerceQueryAnalysisView, string> = {
      totals: 'compare_commerce_metrics',
      comparison: 'compare_commerce_metrics',
      breakdown: 'breakdown_commerce_metric',
      trend: 'trend_commerce_metric',
      inventory: 'find_inventory_risk',
      diagnostic_scan: 'scan_weekly_commerce_kpis',
    };
    return [...new Set(scope.requiredViews
      .filter((view) => !this.requiredViewSatisfied(view))
      .map((view) => names[view]))];
  }

  hasRequiredAnalyticalEvidence(): boolean {
    const scope = this.options.queryScope;
    return Boolean(
      scope
      && scope.status === 'ready'
      && scope.requiredViews.every((view) => this.requiredViewSatisfied(view)),
    );
  }

  assertAnalyticalRequest(operation: string, value: unknown): void {
    if (!ANALYTICAL_OPERATIONS.has(operation)) return;
    const scope = this.options.queryScope;
    if (!scope) return;
    if (scope.status !== 'ready' || !scope.current) {
      throw new CommerceGroundingError('查询范围尚未完整解析，禁止执行分析读取。');
    }
    const request = recordValue(value);
    if (!request) throw new CommerceGroundingError('分析工具参数不是受控对象。');
    if (!sameDateRange(requestDateRange(operation, request), scope.current)) {
      throw new CommerceGroundingError('分析工具日期与服务端解析的查询范围不一致。');
    }
    const weeklyDiagnosticBaselines = scope.objective === 'weekly_diagnosis'
      && operation === 'commerce.breakdown_metric'
      ? (() => {
          const scan = recordValue(this.receipts().find((receipt) => (
            receipt.operation === 'commerce.scan_weekly_kpis'
          ))?.data);
          const baseline = recordValue(scan?.baseline);
          return Array.isArray(baseline?.comparisonRanges)
            ? baseline.comparisonRanges.flatMap((value) => {
                const range = recordValue(value);
                return range
                  && typeof range.start === 'string'
                  && typeof range.end === 'string'
                  ? [{ start: range.start, end: range.end }]
                  : [];
              })
            : [];
        })()
      : [];
    const baselineMatches = sameDateRange(recordValue(request.baseline), scope.baseline)
      || weeklyDiagnosticBaselines.some((range) => (
        sameDateRange(recordValue(request.baseline), range)
      ));
    if (
      (operation === 'commerce.compare_metrics' || operation === 'commerce.breakdown_metric')
      && !baselineMatches
    ) {
      throw new CommerceGroundingError('分析工具基准期与服务端解析的查询范围不一致。');
    }
    if (canonicalJson(normalizedFilters(request.filters)) !== canonicalJson(normalizedFilters(scope.filters))) {
      throw new CommerceGroundingError('分析工具筛选条件与服务端解析的查询范围不一致。');
    }
    const metrics = requestMetrics(operation, request);
    if (!metrics.length) throw new CommerceGroundingError('分析工具没有声明可验证的指标。');
    if (
      scope.metricSelection === 'explicit'
      && metrics.some((metric) => !scope.metrics.includes(metric))
    ) {
      throw new CommerceGroundingError('分析工具指标与服务端解析的查询范围不一致。');
    }
    if (
      operation === 'commerce.breakdown_metric'
      && scope.dimensions.length
      && !scope.dimensions.includes(request.dimension as CommerceDimension)
    ) {
      throw new CommerceGroundingError('分析工具拆分维度与服务端解析的查询范围不一致。');
    }
    if (
      operation === 'commerce.trend_metric'
      && scope.trendGrain
      && request.grain !== scope.trendGrain
    ) {
      throw new CommerceGroundingError('分析工具趋势粒度与服务端解析的查询范围不一致。');
    }
    if (
      operation === 'commerce.breakdown_metric'
      && scope.breakdownLimit !== null
      && request.limit !== scope.breakdownLimit
    ) {
      throw new CommerceGroundingError('分析工具拆解数量与服务端解析的查询范围不一致。');
    }
    if (
      operation === 'commerce.breakdown_metric'
      && scope.breakdownSort
      && request.sort !== scope.breakdownSort
    ) {
      throw new CommerceGroundingError('分析工具拆解排序与服务端解析的查询范围不一致。');
    }
  }

  private verifyResolvedScope(
    answerClaims: readonly CommerceEvidenceClaim[],
    allClaims: readonly CommerceEvidenceClaim[],
  ): void {
    const scope = this.options.queryScope;
    if (!scope) return;
    if (scope.status !== 'ready') {
      throw new CommerceGroundingError('未完整解析的查询范围不能提交 answered。');
    }
    const analytical = this.analyticalObservations();
    if (!analytical.length) {
      throw new CommerceGroundingError('answered 缺少与查询范围绑定的分析读取。');
    }
    analytical.forEach((observation) => {
      this.assertAnalyticalRequest(observation.receipt.operation, observation.request);
    });
    const missingViews = scope.requiredViews.filter((view) => !this.requiredViewSatisfied(view));
    if (missingViews.length) {
      throw new CommerceGroundingError(
        `最终答案缺少 required view：${missingViews.join(', ')}`,
      );
    }

    const observationForClaim = (claim: CommerceEvidenceClaim): InternalEvidence | null => (
      this.observations.get(claim.evidenceId) ?? null
    );
    const claimsForOperation = (operation: string): CommerceEvidenceClaim[] => allClaims.filter(
      (claim) => observationForClaim(claim)?.receipt.operation === operation,
    );
    const comparisonClaims = claimsForOperation('commerce.compare_metrics');
    const summaryCurrentMetrics = new Set(answerClaims
      .filter((claim) => (
        observationForClaim(claim)?.receipt.operation === 'commerce.compare_metrics'
        && claim.path === `/current/${claim.metric}`
      ))
      .map((claim) => claim.metric));
    if (scope.metricSelection === 'explicit') {
      const queried = new Set(analytical.flatMap((observation) => (
        requestMetrics(observation.receipt.operation, recordValue(observation.request) ?? {})
      )));
      const claimed = new Set(allClaims.map((claim) => claim.metric));
      const missingQuery = scope.metrics.filter((metric) => !queried.has(metric));
      const missingClaim = scope.metrics.filter((metric) => !claimed.has(metric));
      if (missingQuery.length || missingClaim.length) {
        const missing = [...new Set([...missingQuery, ...missingClaim])];
        throw new CommerceGroundingError(
          `最终答案未完整覆盖请求指标：${missing.join(', ')}`,
        );
      }
    }

    if (scope.requiredViews.includes('totals') || scope.requiredViews.includes('comparison')) {
      const requiredMetrics = scope.metricSelection === 'explicit'
        ? scope.metrics
        : requestMetrics(
            'commerce.compare_metrics',
            recordValue(this.analyticalObservations('commerce.compare_metrics')[0]?.request) ?? {},
          );
      const missingCurrent = requiredMetrics.filter((metric) => !summaryCurrentMetrics.has(metric));
      if (missingCurrent.length) {
        throw new CommerceGroundingError(
          `最终答案缺少当前分析期的 summary claim：${missingCurrent.join(', ')}`,
        );
      }
      if (scope.requiredViews.includes('comparison')) {
        for (const metric of requiredMetrics) {
          const current = comparisonClaims.some((claim) => claim.path === `/current/${metric}`);
          const baseline = comparisonClaims.some((claim) => claim.path === `/baseline/${metric}`);
          const change = comparisonClaims.some((claim) => (
            claim.path === `/changes/${metric}/absolute`
            || claim.path === `/changes/${metric}/percent`
          ));
          if (!current || !baseline || !change) {
            throw new CommerceGroundingError(
              `comparison claim contract 不完整：${metric} 必须包含 current、baseline 和 change。`,
            );
          }
        }
      }
    }

    if (scope.requiredViews.includes('breakdown')) {
      const breakdowns = this.analyticalObservations('commerce.breakdown_metric');
      const requiredPairs = this.requiredBreakdownPairs();
      for (const { metric, dimension } of requiredPairs) {
        const evidenceIds = new Set(breakdowns
          .filter((observation) => {
            const request = recordValue(observation.request);
            return request?.metric === metric && request.dimension === dimension;
          })
          .map((observation) => observation.receipt.evidenceId));
        const hasCurrentClaim = allClaims.some((claim) => (
          claim.metric === metric
          && evidenceIds.has(claim.evidenceId)
          && /^\/(?:0|[1-9]\d*)\/current$/u.test(claim.path)
        ));
        if (!hasCurrentClaim) {
          throw new CommerceGroundingError(
            `最终答案缺少 ${metric} × ${dimension} breakdown current claim。`,
          );
        }
      }
      const requiredDimensions = scope.dimensions.length
        ? requiredPairs.length ? [] : scope.dimensions
        : uniqueClaims(claimsForOperation('commerce.breakdown_metric')).length
          ? []
          : ['region' as CommerceDimension];
      if (!scope.dimensions.length && !claimsForOperation('commerce.breakdown_metric').length) {
        throw new CommerceGroundingError('最终答案缺少 breakdown claim。');
      }
      for (const dimension of requiredDimensions) {
        const evidenceIds = new Set(breakdowns
          .filter((observation) => recordValue(observation.request)?.dimension === dimension)
          .map((observation) => observation.receipt.evidenceId));
        if (!allClaims.some((claim) => evidenceIds.has(claim.evidenceId))) {
          throw new CommerceGroundingError(`最终答案缺少 ${dimension} breakdown claim。`);
        }
      }
    }

    if (
      scope.requiredViews.includes('trend')
      && !claimsForOperation('commerce.trend_metric').length
    ) {
      throw new CommerceGroundingError('最终答案缺少 trend claim。');
    }
    if (scope.requiredViews.includes('inventory')) {
      const inventoryClaims = claimsForOperation('commerce.inventory_risk');
      const missingInventoryMetrics = scope.metrics.filter((metric) => (
        (metric === 'stockout_hours' || metric === 'ending_inventory')
        && !inventoryClaims.some((claim) => claim.metric === metric)
      ));
      if (!inventoryClaims.length || missingInventoryMetrics.length) {
        throw new CommerceGroundingError(
          `最终答案缺少 inventory claim：${missingInventoryMetrics.join(', ')}`,
        );
      }
    }
  }

  private verifyCatalogBoundary(): void {
    if (!this.options.requireFreshCatalogForAnswered) return;
    const catalogObservation = Array.from(this.observations.values()).find(
      ({ receipt }) => receipt.operation === 'commerce.describe_data',
    );
    const catalog = recordValue(catalogObservation?.receipt.data);
    const coverage = recordValue(catalog?.coverage);
    const dimensions = recordValue(catalog?.dimensions);
    const start = typeof coverage?.start === 'string' ? coverage.start : null;
    const end = typeof coverage?.end === 'string' ? coverage.end : null;
    const lastIngestedAt = typeof coverage?.lastIngestedAt === 'string'
      ? Date.parse(coverage.lastIngestedAt)
      : Number.NaN;
    const sourceUpdatedAt = typeof coverage?.sourceUpdatedAt === 'string'
      ? Date.parse(coverage.sourceUpdatedAt)
      : Number.NaN;
    const dataMode = coverage?.dataMode === 'incremental' ? 'incremental' : 'snapshot';
    const rowCount = Number(coverage?.rowCount ?? 0);
    const now = this.options.now?.() ?? Date.now();
    const wallNow = this.options.wallNow?.() ?? now;
    const maxAgeMs = (this.options.maxDataAgeHours ?? 72) * 3_600_000;
    if (!catalog || !start || !end || rowCount <= 0) {
      throw new CommerceGroundingError('answered 状态需要本租户非空的数据目录和有效覆盖范围。');
    }
    if (!Number.isFinite(lastIngestedAt) || lastIngestedAt > wallNow + 5 * 60_000) {
      throw new CommerceGroundingError('本租户数据已过期或水位无效，不能提交 answered。');
    }
    if (
      dataMode === 'incremental'
      && (
        wallNow - lastIngestedAt > maxAgeMs
        ||
        !Number.isFinite(sourceUpdatedAt)
        || sourceUpdatedAt > now + 5 * 60_000
        || now - sourceUpdatedAt > maxAgeMs
      )
    ) {
      throw new CommerceGroundingError('本租户增量源数据已过期或水位无效，不能提交 answered。');
    }
    const discovered = new Map<string, Set<string>>();
    for (const observation of this.observations.values()) {
      if (observation.receipt.operation !== 'commerce.lookup_entities') continue;
      const lookupRequest = recordValue(observation.request);
      const dimension = typeof lookupRequest?.dimension === 'string'
        ? lookupRequest.dimension
        : null;
      if (!dimension || !Array.isArray(observation.receipt.data)) continue;
      const values = observation.receipt.data
        .map((row) => recordValue(row)?.value)
        .filter((value): value is string => typeof value === 'string');
      discovered.set(dimension, new Set([...(discovered.get(dimension) ?? []), ...values]));
    }
    for (const observation of this.observations.values()) {
      if (observation.receipt.operation === 'commerce.describe_data') continue;
      const ranges: Array<{ start: string; end: string }> = [];
      collectDateRanges(observation.request, ranges);
      if (ranges.some((range) => range.start < start || range.end > end)) {
        throw new CommerceGroundingError('分析请求超出本租户目录声明的数据覆盖范围。');
      }
      const request = recordValue(observation.request);
      const filters = recordValue(request?.filters);
      const filterMap = [
        ['regions', 'region'],
        ['channels', 'channel'],
        ['skus', 'sku'],
        ['categories', 'category'],
      ] as const;
      for (const [filterName, dimensionName] of filterMap) {
        const selected = Array.isArray(filters?.[filterName])
          ? filters[filterName].map(String)
          : [];
        const allowed = Array.isArray(dimensions?.[dimensionName])
          ? new Set(dimensions[dimensionName].map(String))
          : new Set<string>();
        for (const entry of discovered.get(dimensionName) ?? []) allowed.add(entry);
        if (selected.some((entry) => !allowed.has(entry))) {
          throw new CommerceGroundingError(`分析请求包含目录中不存在的 ${dimensionName}。`);
        }
      }
    }
  }

  record<T>(params: {
    operation: string;
    request: unknown;
    data: T;
    rowCount: number;
    now?: string;
  }): CommerceEvidenceReceipt<T> {
    const fetchedAt = params.now ?? new Date().toISOString();
    const receipt: CommerceEvidenceReceipt<T> = {
      evidenceId: `ev_${randomUUID()}`,
      operation: params.operation,
      fetchedAt,
      rowCount: params.rowCount,
      requestSha256: sha256(params.request),
      responseSha256: sha256(params.data),
      sourceQuestionSha256: this.options.queryScope?.sourceQuestionSha256
        ?? commerceQuerySha256(null),
      queryScopeSha256: this.options.queryScope?.queryScopeSha256
        ?? commerceQuerySha256(null),
      data: params.data,
    };
    this.observations.set(receipt.evidenceId, { receipt, request: params.request });
    return receipt;
  }

  private verifyNarrative(parts: readonly string[], label: string): void {
    if (parts.some((part) => CHINESE_NUMBER_EXPRESSION.test(part))) {
      throw new CommerceGroundingError(`${label}不能自行书写数量，必须改用结构化 claims。`);
    }
    if (parts.some((part) => UNSUPPORTED_CAUSAL_LANGUAGE.test(part))) {
      throw new CommerceGroundingError(`${label}包含工具证据不能证明的因果表述。`);
    }
    if (textNumbers(parts).length) {
      throw new CommerceGroundingError(`${label}不能自行书写数字，数字必须由服务端从 claims 渲染。`);
    }
  }

  private validateClaim(claim: CommerceEvidenceClaim): {
    observation: InternalEvidence;
    segments: string[];
  } {
    const observation = this.observations.get(claim.evidenceId);
    if (!observation) {
      throw new CommerceGroundingError(
        `最终答案引用了当前运行中不存在的证据：${claim.evidenceId}`,
      );
    }
    if (
      !ANALYTICAL_OPERATIONS.has(observation.receipt.operation)
      && observation.receipt.operation !== 'commerce.diagnostic_decision'
    ) {
      throw new CommerceGroundingError(
        `answered 只能引用非目录、非搜索类分析证据：${claim.evidenceId}`,
      );
    }
    const resolved = resolveJsonPointer(observation.receipt.data, claim.path);
    if (!resolved.found) {
      throw new CommerceGroundingError(
        `Evidence path 在证据中不存在：${claim.evidenceId}${claim.path}`,
      );
    }
    if (typeof resolved.value !== 'number' || !Number.isFinite(resolved.value)) {
      throw new CommerceGroundingError(
        `Evidence path 没有指向有限数值：${claim.evidenceId}${claim.path}`,
      );
    }
    if (!Object.is(resolved.value, claim.value)) {
      throw new CommerceGroundingError(
        `Claim value 与证据原始值不一致：${claim.evidenceId}${claim.path}`,
      );
    }
    const expected = expectedClaimBinding(observation, resolved.segments);
    if (!expected) {
      throw new CommerceGroundingError(
        `Evidence path 不是允许引用的分析指标字段：${claim.evidenceId}${claim.path}`,
      );
    }
    if (claim.metric !== expected.metric || claim.unit !== expected.unit) {
      throw new CommerceGroundingError(
        `Claim metric/unit 与证据字段不一致：${claim.evidenceId}${claim.path}`,
      );
    }
    const requested = requestMetrics(
      observation.receipt.operation,
      recordValue(observation.request) ?? {},
    );
    if (
      this.options.queryScope
      && ANALYTICAL_OPERATIONS.has(observation.receipt.operation)
      && !requested.includes(expected.metric)
    ) {
      throw new CommerceGroundingError(
        `Claim metric 未包含在对应分析工具请求中：${claim.evidenceId}${claim.path}`,
      );
    }
    return { observation, segments: resolved.segments };
  }

  private catalogCurrencyCode(): string {
    const catalogObservation = Array.from(this.observations.values()).find(
      ({ receipt }) => receipt.operation === 'commerce.describe_data',
    );
    const catalog = recordValue(catalogObservation?.receipt.data);
    return typeof catalog?.currencyCode === 'string' && catalog.currencyCode.trim()
      ? catalog.currencyCode
      : 'CNY';
  }

  private metricIsAdditiveForDimension(
    metric: CommerceMetric,
    dimension: CommerceDimension,
  ): boolean {
    const catalogObservation = Array.from(this.observations.values()).find(
      ({ receipt }) => receipt.operation === 'commerce.describe_data',
    );
    const metricDefinitions = recordValue(catalogObservation?.receipt.data)?.metrics;
    if (Array.isArray(metricDefinitions)) {
      const definition = metricDefinitions
        .map(recordValue)
        .find((entry) => entry?.id === metric);
      if (definition) {
        const additiveDimensions = Array.isArray(definition.additiveDimensions)
          ? definition.additiveDimensions.map(String)
          : [];
        return definition.additivity !== 'non_additive'
          && (additiveDimensions.length === 0 || additiveDimensions.includes(dimension));
      }
    }
    return new Set<CommerceMetric>([
      'gmv',
      'net_revenue',
      'paid_orders',
      'units',
      'visits',
      'refund_amount',
      'gross_profit',
      'ad_spend',
      'new_customers',
    ]).has(metric);
  }

  private breakdownNarrative(claims: readonly CommerceEvidenceClaim[]): BreakdownNarrative | null {
    const sections: string[] = [];
    const leaders: Array<{ label: string; metric: CommerceMetric }> = [];
    const totals = new Map<CommerceMetric, CommerceEvidenceClaim>();
    const narrativeClaims: CommerceEvidenceClaim[] = [];
    let hasUncomparedBreakdown = false;
    for (const observation of this.analyticalObservations('commerce.breakdown_metric')) {
      const request = recordValue(observation.request);
      const metric = commerceMetric(request?.metric);
      const dimension = typeof request?.dimension === 'string'
        && ['region', 'channel', 'sku', 'category'].includes(request.dimension)
        ? request.dimension as CommerceDimension
        : null;
      if (
        !metric
        || !dimension
        || !['current_desc', 'absolute_change_desc'].includes(String(request?.sort))
      ) continue;
      if (!recordValue(request?.baseline)) hasUncomparedBreakdown = true;

      const rows = uniqueClaims(claims.filter((claim) => (
        claim.evidenceId === observation.receipt.evidenceId
        && claim.metric === metric
        && /^\/(?:0|[1-9]\d*)\/current$/u.test(claim.path)
      )))
        .sort((left, right) => Number(left.path.split('/')[1]) - Number(right.path.split('/')[1]))
        .slice(0, 5)
        .map((claim) => {
          const index = Number(claim.path.split('/')[1]);
          const row = Array.isArray(observation.receipt.data)
            ? recordValue(observation.receipt.data[index])
            : null;
          const rawKey = typeof row?.key === 'string'
            ? row.key
            : typeof row?.sku === 'string'
              ? row.sku
              : `#${index + 1}`;
          return { claim, label: humanizeDimensionValue(rawKey, dimension) };
        });
      if (!rows.length) continue;

      narrativeClaims.push(...rows.map(({ claim }) => claim));
      leaders.push({ label: rows[0]!.label, metric });
      const rankLabel = rows.length === 5 ? '前五名' : `前${rows.length}名`;
      const ranking = rows
        .map(({ claim, label }, index) => (
          `${index + 1}. ${label} ${formatClaimValue(claim.value, claim.unit, this.catalogCurrencyCode())}`
        ))
        .join('；');
      let section = `按${DIMENSION_LABELS[dimension]}看，${METRIC_LABELS[metric]}最高的是${rows[0]!.label}，`
        + `${formatClaimValue(rows[0]!.claim.value, rows[0]!.claim.unit, this.catalogCurrencyCode())}。`
        + `${rankLabel}依次为：${ranking}。`;
      if (rows.length > 1) {
        const tail = rows.at(-1)!;
        section += `本期排序末位是${tail.label}，`
          + `${formatClaimValue(tail.claim.value, tail.claim.unit, this.catalogCurrencyCode())}。`;
      }

      const totalClaim = claims.find((claim) => {
        if (claim.metric !== metric || claim.path !== `/current/${metric}`) return false;
        return this.observations.get(claim.evidenceId)?.receipt.operation === 'commerce.compare_metrics';
      });
      if (totalClaim) totals.set(metric, totalClaim);
      if (
        totalClaim
        && totalClaim.value > 0
        && this.metricIsAdditiveForDimension(metric, dimension)
      ) {
        const headTotal = rows.reduce((sum, { claim }) => sum + claim.value, 0);
        const leaderShare = rows[0]!.claim.value / totalClaim.value;
        const headShare = headTotal / totalClaim.value;
        if (
          Number.isFinite(leaderShare)
          && Number.isFinite(headShare)
          && leaderShare >= 0
          && headShare >= 0
        ) {
          section += `榜首占当期${METRIC_LABELS[metric]} ${formatConcentration(leaderShare)}；`
            + `${rankLabel}合计${formatClaimValue(headTotal, rows[0]!.claim.unit, this.catalogCurrencyCode())}，`
            + `集中度为${formatConcentration(headShare)}。`;
          narrativeClaims.push(totalClaim);
        }
      }
      sections.push(section);
    }
    if (!sections.length) return null;
    const range = this.options.queryScope?.current;
    const sharedLeader = leaders.find(({ label }) => (
      leaders.filter((leader) => leader.label === label).length > 1
    ));
    const sharedLeaderMetrics = sharedLeader
      ? [...new Set(leaders
          .filter(({ label }) => label === sharedLeader.label)
          .map(({ metric }) => METRIC_LABELS[metric]))]
      : [];
    const sharedLeaderCopy = sharedLeader && sharedLeaderMetrics.length > 1
      ? `${sharedLeader.label}在${sharedLeaderMetrics.join('和')}两项排名中均位列第一。`
      : '';
    const totalsCopy = [...totals.values()].map((claim) => (
      `${METRIC_LABELS[claim.metric]}为${formatClaimValue(claim.value, claim.unit, this.catalogCurrencyCode())}`
    )).join('，');
    return {
      narrative: `${range ? `分析期 ${range.start} 至 ${range.end}。` : ''}`
        + `${totalsCopy ? `本期${totalsCopy}。` : ''}`
        + (hasUncomparedBreakdown
          ? '本次未指定比较基准，因此可以识别本期头部与尾部，但不能把尾部直接认定为同比或环比拖累项。'
          : '')
        + `${sharedLeaderCopy}${sections.join('\n')}`,
      claims: uniqueClaims(narrativeClaims),
    };
  }

  private weeklyGrowthDiagnosis(): WeeklyGrowthDiagnosis | null {
    const observations = Array.from(this.observations.values());
    const scanObservation = observations.find(({ receipt }) => (
      receipt.operation === 'commerce.scan_weekly_kpis'
    ));
    const finalDecisionObservation = observations.filter(({ receipt }) => (
      receipt.operation === 'commerce.diagnostic_decision'
    )).at(-1);
    const scan = recordValue(scanObservation?.receipt.data);
    const decision = recordValue(finalDecisionObservation?.receipt.data);
    const evaluation = recordValue(decision?.evaluation);
    if (
      !scanObservation
      || !scan
      || !finalDecisionObservation
      || evaluation?.gatePassed !== true
      || evaluation.hypothesis !== 'growth_driver'
    ) return null;

    const scanClaims: CommerceEvidenceClaim[] = [];
    collectDeterministicClaims(scanObservation, scanObservation.receipt.data, [], scanClaims, 64);
    const signals = Array.isArray(scan.signals) ? scan.signals : [];
    const signalFor = (metric: CommerceMetric) => {
      const index = signals.findIndex((entry) => recordValue(entry)?.metric === metric);
      const value = index >= 0 ? recordValue(signals[index]) : null;
      const numeric = (field: string): number | null => (
        typeof value?.[field] === 'number' && Number.isFinite(value[field])
          ? value[field] as number
          : null
      );
      const claim = (field: 'current' | 'baselineMedian' | 'relativeChange') => {
        const path = field === 'current' ? `/current/${metric}` : `/signals/${index}/${field}`;
        return scanClaims.find((entry) => entry.path === path);
      };
      return index >= 0 ? {
        current: numeric('current'),
        baseline: numeric('baselineMedian'),
        change: numeric('relativeChange'),
        currentClaim: claim('current'),
        baselineClaim: claim('baselineMedian'),
        changeClaim: claim('relativeChange'),
      } : null;
    };

    const gmv = signalFor('gmv');
    if (!gmv || gmv.current === null || gmv.baseline === null || gmv.change === null) return null;
    const orders = signalFor('paid_orders');
    const visits = signalFor('visits');
    const conversion = signalFor('conversion_rate');
    const aov = signalFor('average_order_value');
    const currencyCode = this.catalogCurrencyCode();

    const decisionClaims: CommerceEvidenceClaim[] = [];
    collectDeterministicClaims(
      finalDecisionObservation,
      finalDecisionObservation.receipt.data,
      [],
      decisionClaims,
      16,
    );
    const contributionClaim = decisionClaims.find((claim) => (
      claim.path === '/evaluation/contributionShare'
    ));
    const contributionMetric = commerceMetric(evaluation.contributionMetric);
    const contributionShare = typeof evaluation.contributionShare === 'number'
      && Number.isFinite(evaluation.contributionShare)
      ? evaluation.contributionShare
      : null;

    const investigationEvidenceId = typeof evaluation.investigationEvidenceId === 'string'
      ? evaluation.investigationEvidenceId
      : null;
    const breakdownObservation = observations.find(({ receipt }) => (
      receipt.evidenceId === investigationEvidenceId
      && receipt.operation === 'commerce.breakdown_metric'
    )) ?? observations.filter(({ receipt }) => receipt.operation === 'commerce.breakdown_metric').at(-1);
    const breakdownClaims: CommerceEvidenceClaim[] = [];
    if (breakdownObservation) {
      collectDeterministicClaims(
        breakdownObservation,
        breakdownObservation.receipt.data,
        [],
        breakdownClaims,
        64,
      );
    }
    const breakdownRows = Array.isArray(breakdownObservation?.receipt.data)
      ? breakdownObservation.receipt.data.map(recordValue)
      : [];
    const topRowIndex = breakdownRows.reduce((bestIndex, row, index) => {
      const best = bestIndex >= 0 ? breakdownRows[bestIndex] : null;
      const currentChange = typeof row?.absoluteChange === 'number' ? row.absoluteChange : Number.NEGATIVE_INFINITY;
      const bestChange = typeof best?.absoluteChange === 'number' ? best.absoluteChange : Number.NEGATIVE_INFINITY;
      return currentChange > bestChange ? index : bestIndex;
    }, -1);
    const topRow = topRowIndex >= 0 ? breakdownRows[topRowIndex] : null;
    const breakdownDimension = recordValue(breakdownObservation?.request)?.dimension as CommerceDimension | undefined;
    const topLabel = typeof topRow?.key === 'string'
      ? humanizeDimensionValue(topRow.key, breakdownDimension)
      : null;
    const topCurrent = typeof topRow?.current === 'number' ? topRow.current : null;
    const topAbsoluteChange = typeof topRow?.absoluteChange === 'number' ? topRow.absoluteChange : null;
    const topPercentChange = typeof topRow?.percentChange === 'number' ? topRow.percentChange : null;
    const topClaims = topRowIndex >= 0
      ? breakdownClaims.filter((claim) => [
          `/${topRowIndex}/current`,
          `/${topRowIndex}/baseline`,
          `/${topRowIndex}/absoluteChange`,
          `/${topRowIndex}/percentChange`,
        ].includes(claim.path))
      : [];
    const negativeDetails: Array<{
      label: string;
      absoluteChange: number;
      percentChange: number | null;
      claims: CommerceEvidenceClaim[];
    }> = [];
    for (const [index, row] of breakdownRows.entries()) {
      const absoluteChange = typeof row?.absoluteChange === 'number' ? row.absoluteChange : null;
      if (absoluteChange === null || absoluteChange >= 0 || typeof row?.key !== 'string') continue;
      const rowClaims = breakdownClaims.filter((claim) => [
        `/${index}/current`,
        `/${index}/baseline`,
        `/${index}/absoluteChange`,
        `/${index}/percentChange`,
      ].includes(claim.path));
      negativeDetails.push({
        label: humanizeDimensionValue(row.key, breakdownDimension),
        absoluteChange,
        percentChange: typeof row.percentChange === 'number' ? row.percentChange : null,
        claims: rowClaims,
      });
    }
    negativeDetails.sort((left, right) => left.absoluteChange - right.absoluteChange);
    const leadingNegativeDetails = negativeDetails.slice(0, 2);
    const negativeClaims = uniqueClaims(leadingNegativeDetails.flatMap((entry) => entry.claims));
    const allBreakdownRowsPositive = breakdownRows.length > 0 && breakdownRows.every((row) => (
      typeof row?.absoluteChange === 'number' && row.absoluteChange > 0
    ));

    const currentRange = recordValue(scan.currentRange);
    const rangeText = typeof currentRange?.start === 'string' && typeof currentRange?.end === 'string'
      ? `${currentRange.start} 至 ${currentRange.end}`
      : '诊断周';
    const baselineRange = recordValue(recordValue(breakdownObservation?.request)?.baseline);
    const baselineRangeText = typeof baselineRange?.start === 'string'
      && typeof baselineRange?.end === 'string'
      ? `${baselineRange.start} 至 ${baselineRange.end}`
      : '最近一个完整周';

    const narrative: string[] = [
      `结论：${rangeText} 是明确的增长周。GMV达到${formatClaimValue(gmv.current, 'currency', currencyCode)}，`
        + `较此前四个完整周中位数${formatClaimValue(gmv.baseline, 'currency', currencyCode)}`
        + `增长${formatSignedPercent(gmv.change)}。`,
    ];
    if (
      orders?.change !== null && orders?.change !== undefined
      && aov?.change !== null && aov?.change !== undefined
    ) {
      const contributionCopy = contributionMetric === 'paid_orders' && contributionShare !== null
        ? `，解释了${formatConcentration(contributionShare)}的GMV增量`
        : '';
      const mixCopy = aov.change > 0.001
        ? '量价均向上，增长以订单规模扩张为主。'
        : aov.change < -0.001
          ? '订单规模扩张是主因，但客单价回落，需要关注价格与商品结构。'
          : '客单价基本持平，增长主要来自订单规模扩张。';
      narrative.push(
        `增长结构：支付订单${formatSignedPercent(orders.change)}${contributionCopy}；`
          + `客单价${formatSignedPercent(aov.change)}。${mixCopy}`,
      );
    }
    if (
      visits?.change !== null && visits?.change !== undefined
      && conversion?.change !== null && conversion?.change !== undefined
    ) {
      const efficiencyCopy = conversion.change > 0.001
        ? '流量与转化同步改善，增长并非只靠流量堆积。'
        : conversion.change < -0.001
          ? '流量增长但转化承压，应防止低质量流量稀释效率。'
          : '订单增长主要随流量扩张，转化效率没有明显提升。';
      narrative.push(
        `效率验证：访问量${formatSignedPercent(visits.change)}，支付转化率${formatSignedPercent(conversion.change)}；`
          + efficiencyCopy,
      );
    }
    if (
      topLabel
      && topCurrent !== null
      && topAbsoluteChange !== null
      && topPercentChange !== null
    ) {
      narrative.push(
        `渠道定位（此处基准为最近完整周 ${baselineRangeText}）：${topLabel} 的绝对增量最大，`
          + `本期${formatClaimValue(topCurrent, 'currency', currencyCode)}，`
          + `增量${formatSignedValue(topAbsoluteChange, 'currency', currencyCode)}`
          + `（${formatSignedPercent(topPercentChange)}）。`
          + (leadingNegativeDetails.length
            ? `负向项为${leadingNegativeDetails.map((entry) => (
                `${entry.label} ${formatSignedValue(entry.absoluteChange, 'currency', currencyCode)}`
                  + (entry.percentChange === null ? '' : `（${formatSignedPercent(entry.percentChange)}）`)
              )).join('、')}。`
            : allBreakdownRowsPositive
              ? '本次拆解覆盖的渠道均为正增量，未见渠道拖累。'
              : ''),
      );
    }

    const health = recordValue(observations.find(({ receipt }) => (
      receipt.operation === 'commerce.inspect_data_health'
    ))?.receipt.data);
    const degradedOptionalMetrics = Array.isArray(health?.degradedOptionalMetrics)
      ? new Set(health.degradedOptionalMetrics.map(String))
      : new Set<string>();
    const unavailableAreas = [
      degradedOptionalMetrics.has('gross_profit') ? '毛利' : null,
      degradedOptionalMetrics.has('refund_rate') ? '退款' : null,
      degradedOptionalMetrics.has('stockout_hours') ? '库存' : null,
    ].filter((value): value is string => Boolean(value));
    narrative.push(
      unavailableAreas.length
        ? `边界：核心经营数据完整，可确认规模增长及其来源；${unavailableAreas.join('、')}指标未接入，暂不判断利润与履约健康。`
        : '边界：当前证据支持规模增长及其主要结构来源，但具体业务机制仍需结合活动与经营事件验证。',
    );

    const compactClaims = (...entries: Array<CommerceEvidenceClaim | undefined>) => (
      entries.filter((entry): entry is CommerceEvidenceClaim => Boolean(entry))
    );
    const scaleClaims = compactClaims(gmv.currentClaim, gmv.baselineClaim, gmv.changeClaim);
    const structureClaims = compactClaims(
      orders?.currentClaim,
      orders?.baselineClaim,
      orders?.changeClaim,
      contributionClaim,
      aov?.currentClaim,
      aov?.baselineClaim,
      aov?.changeClaim,
    );
    const efficiencyClaims = compactClaims(visits?.changeClaim, conversion?.changeClaim);
    const claims = uniqueClaims([
      ...scaleClaims,
      ...structureClaims,
      ...efficiencyClaims,
      ...topClaims,
      ...negativeClaims,
    ]);
    const confidence = health?.sourceReliability === 'high' ? 0.9 : 0.65;
    const findings: CommerceAgentAnswer['findings'] = [
      {
        metric: 'gmv',
        title: '规模判断 · 明确增长周',
        detail: `GMV为${formatClaimValue(gmv.current, 'currency', currencyCode)}，`
          + `较此前四周中位数${formatSignedPercent(gmv.change)}，不是“只有当前规模、没有基准”。`,
        claims: scaleClaims,
        insightLevel: 'driver',
        confidence,
        alternatives: ['增幅可能叠加未接入的促销、节假日或大客户事件，尚不能据此声明具体因果。'],
        contradictionStatus: 'clear',
      },
    ];
    if (structureClaims.length && orders?.change !== null && orders?.change !== undefined) {
      findings.push({
        metric: 'paid_orders',
        title: '增长结构 · 订单量主导，客单价协同',
        detail: `支付订单${formatSignedPercent(orders.change)}`
          + (contributionMetric === 'paid_orders' && contributionShare !== null
            ? `，对GMV增量的归因贡献为${formatConcentration(contributionShare)}`
            : '')
          + (aov?.change !== null && aov?.change !== undefined
            ? `；客单价${formatSignedPercent(aov.change)}。`
            : '。'),
        claims: structureClaims,
        insightLevel: 'contribution',
        confidence,
        alternatives: ['量价分解解释数值贡献，不等同于证明背后的活动或经营动作产生了因果。'],
        contradictionStatus: 'clear',
      });
    }
    if (topClaims.length && topLabel && topAbsoluteChange !== null && topPercentChange !== null) {
      const negativeLabels = leadingNegativeDetails.map((entry) => entry.label);
      findings.push({
        metric: 'gmv',
        title: negativeLabels.length
          ? `渠道分化 · ${topLabel}增量最大，${negativeLabels[0]}拖累最大`
          : `渠道来源 · ${topLabel}增量最大`,
        detail: `渠道口径使用最近完整周 ${baselineRangeText} 作为基准。${topLabel} 增量`
          + `${formatSignedValue(topAbsoluteChange, 'currency', currencyCode)}`
          + `（${formatSignedPercent(topPercentChange)}）`
          + (negativeLabels.length
            ? `；${leadingNegativeDetails.map((entry) => (
                `${entry.label} ${formatSignedValue(entry.absoluteChange, 'currency', currencyCode)}`
                  + (entry.percentChange === null ? '' : `（${formatSignedPercent(entry.percentChange)}）`)
              )).join('、')}构成已确认负向项。`
            : allBreakdownRowsPositive
              ? '；本次拆解覆盖的渠道均未出现负增量。'
              : '。'),
        claims: uniqueClaims([...topClaims, ...negativeClaims]).slice(0, 12),
        insightLevel: 'driver',
        confidence,
        alternatives: ['渠道归属规则或未接入的营销事件可能影响结构解释。'],
        contradictionStatus: 'clear',
      });
    }
    const negativeLabels = leadingNegativeDetails.map((entry) => entry.label);
    const actionBreakdownClaims = [...topClaims, ...negativeClaims].filter((claim) => (
      /\/(?:current|absoluteChange|percentChange)$/u.test(claim.path)
    ));
    const actionClaims = uniqueClaims([
      ...actionBreakdownClaims,
      ...compactClaims(conversion?.currentClaim, conversion?.changeClaim),
    ]).slice(0, 12);
    const recommendation = actionClaims.length && topLabel ? {
      action: negativeLabels.length
        ? `复盘${negativeLabels.join('、')}回落，验证${topLabel}增量质量`
        : `验证${topLabel}增量的可持续性，再决定是否加码`,
      rationale: negativeLabels.length
        ? `${topLabel}贡献了最大正增量，但${negativeLabels.join('、')}已经形成可验证拖累。先按活动、流量与商品结构复盘差异，并补齐利润与履约护栏后再调整资源。`
        : `拆解覆盖项均为正增量，当前没有可验证拖累项。先核对${topLabel}的活动归因、转化质量及尚未接入的利润与履约护栏，再由负责人决定资源调整。`,
      claims: actionClaims,
    } : null;
    return {
      narrative: narrative.join('\n'),
      claims,
      findings: findings.slice(0, 3),
      recommendation,
    };
  }

  private renderClaim(claim: CommerceEvidenceClaim): string {
    const validated = this.validateClaim(claim);
    const context = claimContext(validated.observation, validated.segments);
    return `${METRIC_LABELS[claim.metric]}${context ? `（${context}）` : ''}：${formatClaimValue(claim.value, claim.unit, this.catalogCurrencyCode())}`;
  }

  private renderNarrative(
    narrative: string,
    claims: readonly CommerceEvidenceClaim[],
    maximumLength: number,
  ): string {
    if (!claims.length) return narrative;
    const suffix = `\n\n关键证据：${claims.map((claim) => this.renderClaim(claim)).join('；')}`;
    if (suffix.length >= maximumLength) {
      throw new CommerceGroundingError('结构化 claims 过多，无法在受控答案长度内完整渲染。');
    }
    const base = narrative.slice(0, maximumLength - suffix.length).trim();
    return `${base}${suffix}`;
  }

  verifyAnswer(value: unknown, userQuestion: string): CommerceAgentAnswer {
    const parsed = commerceAgentAnswerSchema.safeParse(value);
    if (!parsed.success) {
      throw new CommerceGroundingError(`最终答案不符合受控 schema：${parsed.error.message}`);
    }
    const answer = parsed.data;
    const allClaims = [
      ...answer.answerClaims,
      ...answer.findings.flatMap((finding) => finding.claims),
      ...answer.recommendations.flatMap((recommendation) => recommendation.claims),
    ];
    if (
      answer.status === 'answered'
      && (!answer.findings.length || !answer.answerClaims.length || !allClaims.length)
    ) {
      throw new CommerceGroundingError('answered 状态的摘要和 finding 必须带有字段级 claims。');
    }
    for (const finding of answer.findings) {
      if (answer.status === 'answered' && !finding.claims.length) {
        throw new CommerceGroundingError(`Finding “${finding.title}” 缺少 claims。`);
      }
      if (finding.claims.some((claim) => claim.metric !== finding.metric)) {
        throw new CommerceGroundingError(
          `Finding “${finding.title}” 的 metric 与字段级 claims 不一致。`,
        );
      }
    }
    if (answer.status === 'answered') {
      if (this.options.queryScope && this.options.queryScope.status !== 'ready') {
        throw new CommerceGroundingError('未完整解析的查询范围不能提交 answered。');
      }
      for (const recommendation of answer.recommendations) {
        if (!recommendation.claims.length) {
          throw new CommerceGroundingError(
            `Recommendation “${recommendation.action}” 缺少 claims。`,
          );
        }
      }
      this.verifyCatalogBoundary();
      this.verifyNarrative([answer.answer], '答案摘要');
      for (const finding of answer.findings) {
        this.verifyNarrative([finding.title, finding.detail], `Finding “${finding.title}”`);
      }
      for (const recommendation of answer.recommendations) {
        this.verifyNarrative(
          [recommendation.action, recommendation.rationale],
          `Recommendation “${recommendation.action}”`,
        );
      }
      allClaims.forEach((claim) => this.validateClaim(claim));
      this.verifyResolvedScope(answer.answerClaims, allClaims);
      const executive = this.options.queryScope
        ? this.options.queryScope.executive
        : isExecutiveCommerceQuestion(userQuestion)
          || new Set(answer.answerClaims.map((claim) => claim.metric)).size >= 3;
      const weeklyDiagnosis = this.options.queryScope?.objective === 'weekly_diagnosis';
      const diagnosticHealth = recordValue(this.receipts().find((receipt) => (
        receipt.operation === 'commerce.inspect_data_health'
      ))?.data);
      const diagnosticScan = recordValue(this.receipts().find((receipt) => (
        receipt.operation === 'commerce.scan_weekly_kpis'
      ))?.data);
      const diagnosticBaseline = recordValue(diagnosticScan?.baseline);
      const diagnosticDecisions = this.receipts()
        .filter((receipt) => receipt.operation === 'commerce.diagnostic_decision')
        .map((receipt) => recordValue(receipt.data))
        .filter((entry): entry is Record<string, unknown> => Boolean(entry));
      const finalDiagnosticDecision = diagnosticDecisions.at(-1) ?? null;
      const diagnosticStopReason = typeof finalDiagnosticDecision?.stopReason === 'string'
        ? finalDiagnosticDecision.stopReason
        : 'unknown';
      const finalDiagnosticEvaluation = recordValue(finalDiagnosticDecision?.evaluation);
      const driverGatePassed = finalDiagnosticEvaluation?.gatePassed === true;
      const driverHypothesis = typeof finalDiagnosticEvaluation?.hypothesis === 'string'
        ? finalDiagnosticEvaluation.hypothesis
        : null;
      const driverMetrics: Record<string, CommerceMetric[]> = {
        growth_driver: ['gmv'],
        traffic_drop: ['visits'],
        conversion_drop: ['conversion_rate'],
        aov_or_mix: ['average_order_value'],
        refund_spike: ['refund_rate', 'refund_amount'],
        stockout: ['stockout_hours'],
      };
      const contributionMetrics: Record<string, CommerceMetric[]> = {
        growth_driver: ['paid_orders', 'visits', 'conversion_rate', 'average_order_value'],
        traffic_drop: ['paid_orders'],
        conversion_drop: ['paid_orders'],
        aov_or_mix: ['gmv'],
        refund_spike: [],
        stockout: [],
      };
      const includeBreakdown = Boolean(
        this.options.queryScope?.requiredViews.includes('breakdown')
        || (weeklyDiagnosis && this.analyticalObservations('commerce.breakdown_metric').length),
      );
      const breakdownSummary = includeBreakdown
        ? this.breakdownNarrative(allClaims)
        : null;
      const weeklyGrowth = weeklyDiagnosis ? this.weeklyGrowthDiagnosis() : null;
      weeklyGrowth?.claims.forEach((claim) => this.validateClaim(claim));
      const headBreakdownClaims = includeBreakdown
        ? selectBreakdownSummaryClaims(allClaims)
        : [];
      const summaryClaims = weeklyGrowth?.claims ?? uniqueClaims([
          ...selectSummaryClaims(answer.answerClaims),
          ...(breakdownSummary?.claims ?? headBreakdownClaims),
        ]).slice(0, 16);
      const topLevelClaims = weeklyGrowth
        ? uniqueClaims([
            ...weeklyGrowth.claims,
            ...answer.answerClaims,
            ...(breakdownSummary?.claims ?? headBreakdownClaims),
          ]).slice(0, 48)
        : includeBreakdown
          ? uniqueClaims([
            ...(breakdownSummary?.claims ?? headBreakdownClaims),
            ...answer.answerClaims,
          ]).slice(0, 48)
          : answer.answerClaims;
      const rawFindings = decisionFindings(allClaims, executive, includeBreakdown);
      const anomalousMetrics = new Set(
        Array.isArray(diagnosticScan?.signals)
          ? diagnosticScan.signals.flatMap((entry) => {
              const signal = recordValue(entry);
              return signal?.anomalous === true && commerceMetric(signal.metric)
                ? [commerceMetric(signal.metric)!]
                : [];
            })
          : [],
      );
      const stableWeeklyStop = weeklyDiagnosis
        && diagnosticStopReason === 'no_material_anomaly'
        && anomalousMetrics.size === 0;
      const zeroActivityStop = weeklyDiagnosis
        && diagnosticStopReason === 'no_material_anomaly'
        && Array.isArray(diagnosticScan?.zeroActivityDates)
        && diagnosticScan.zeroActivityDates.length > 0;
      const selectedFindings = weeklyDiagnosis
        ? (anomalousMetrics.size
            ? rawFindings.filter((finding) => anomalousMetrics.has(finding.metric))
            : rawFindings.slice(0, 1))
          .slice(0, 3)
        : rawFindings;
      const findings = weeklyGrowth?.findings ?? selectedFindings.map((finding) => ({
          ...finding,
          ...(stableWeeklyStop ? {
            title: `常态范围 · ${METRIC_LABELS[finding.metric]}`,
            detail: this.renderNarrative(
              '该指标相对稳健基准的变化未达到异常阈值，当前没有证据支持继续归因或生成行动。',
              finding.claims,
              1_500,
            ),
          } : zeroActivityStop ? {
            title: `已观察 · ${METRIC_LABELS[finding.metric]}`,
            detail: this.renderNarrative(
              '当前变化与已验证完整的零活动日期同时出现，不应把日历级现象误归因给单一渠道或品类。',
              finding.claims,
              1_500,
            ),
          } : {
            detail: this.renderNarrative(finding.detail, finding.claims, 1_500),
          }),
          ...(weeklyDiagnosis ? {
            insightLevel: driverGatePassed
              && driverHypothesis
              && driverMetrics[driverHypothesis]?.includes(finding.metric)
              ? 'driver' as const
              : driverGatePassed
                && driverHypothesis
                && contributionMetrics[driverHypothesis]?.includes(finding.metric)
                ? 'contribution' as const
                : 'observed' as const,
            confidence: diagnosticHealth?.sourceReliability === 'high'
              ? driverGatePassed
                && driverHypothesis
                && driverMetrics[driverHypothesis]?.includes(finding.metric)
                ? 0.9
                : 0.8
              : 0.55,
            alternatives: driverGatePassed
              ? ['当前证据支持经营驱动，但未识别或证明具体因果机制。']
              : ['当前窗口可能受尚未接入的经营事件或外部因素影响。'],
            contradictionStatus: finalDiagnosticEvaluation?.structureChangeDetected === true
              ? 'contradicted' as const
              : diagnosticDecisions.some((decision) => (
              decision.decisionCode === 'replan_after_contradiction'
            ))
              ? 'unresolved' as const
              : 'clear' as const,
          } : {}),
        }));
      const candidateRecommendations = (weeklyGrowth?.recommendation
        ? [weeklyGrowth.recommendation]
        : executive
          ? executiveRecommendations(allClaims)
          : answer.recommendations.map((recommendation) => {
            const copy = recommendationCopy(recommendation.claims);
            return {
              action: copy.action,
              rationale: this.renderNarrative(copy.rationale, recommendation.claims, 1_500),
              claims: recommendation.claims,
            };
          })).map(controlledActionCard);
      const recommendations = weeklyDiagnosis
        ? diagnosticStopReason === 'evidence_sufficient'
          && driverGatePassed
          && diagnosticHealth?.actionAllowed === true
          ? candidateRecommendations.slice(0, 1)
          : []
        : candidateRecommendations;
      const controlledSummary = executiveSummaryCopy(
        allClaims,
        executive,
        includeBreakdown,
        breakdownSummary?.narrative ?? null,
      );
      return commerceAgentAnswerSchema.parse({
        ...answer,
        answer: stableWeeklyStop
          ? this.renderNarrative(
              '本周核心指标仍处于稳健基准的常态范围，未发现需要继续归因的异常，因此不生成经营行动。',
              summaryClaims,
              8_000,
            )
          : weeklyGrowth
          ? weeklyGrowth.narrative
          : breakdownSummary && !executive
            ? controlledSummary
            : this.renderNarrative(controlledSummary, summaryClaims, 8_000),
        answerClaims: topLevelClaims,
        findings,
        recommendations,
        followUps: controlledFollowUps(
          allClaims,
          executive,
          this.options.queryScope ?? null,
        ),
        ...(weeklyDiagnosis && diagnosticHealth && diagnosticBaseline ? {
          diagnostic: {
            objective: 'diagnose_previous_complete_week',
            dataHealth: {
              status: diagnosticHealth.status,
              dataMode: diagnosticHealth.dataMode,
              sourceWatermark: typeof diagnosticHealth.sourceWatermark === 'string'
                ? diagnosticHealth.sourceWatermark
                : null,
              reasons: Array.isArray(diagnosticHealth.reasons)
                ? diagnosticHealth.reasons.map(String)
                : [],
            },
            referenceDate: this.options.queryScope!.referenceDate,
            timezone: this.options.queryScope!.timezone,
            baseline: {
              strategy: diagnosticBaseline.strategy,
              rationale: diagnosticBaseline.rationale,
              comparisonRanges: diagnosticBaseline.comparisonRanges,
              confidence: diagnosticBaseline.confidence,
            },
            stopReason: diagnosticStopReason,
            driverGate: finalDiagnosticEvaluation && driverHypothesis ? {
              hypothesis: driverHypothesis,
              insightLevel: finalDiagnosticEvaluation.insightLevel,
              passed: driverGatePassed,
              reasons: Array.isArray(finalDiagnosticEvaluation.reasons)
                ? finalDiagnosticEvaluation.reasons.map(String)
                : [],
              contributionMetric: commerceMetric(finalDiagnosticEvaluation.contributionMetric),
              contributionShare: typeof finalDiagnosticEvaluation.contributionShare === 'number'
                && Number.isFinite(finalDiagnosticEvaluation.contributionShare)
                ? finalDiagnosticEvaluation.contributionShare
                : null,
              primaryRelativeChange: typeof finalDiagnosticEvaluation.primaryRelativeChange === 'number'
                && Number.isFinite(finalDiagnosticEvaluation.primaryRelativeChange)
                ? finalDiagnosticEvaluation.primaryRelativeChange
                : null,
              contributionResidualRatio:
                typeof finalDiagnosticEvaluation.contributionResidualRatio === 'number'
                && Number.isFinite(finalDiagnosticEvaluation.contributionResidualRatio)
                  ? finalDiagnosticEvaluation.contributionResidualRatio
                  : null,
              aggregateEvidenceId: String(finalDiagnosticEvaluation.aggregateEvidenceId ?? ''),
              investigationEvidenceId: String(
                finalDiagnosticEvaluation.investigationEvidenceId ?? '',
              ),
              structureChangeDetected:
                finalDiagnosticEvaluation.structureChangeDetected === true,
            } : null,
            unknowns: driverGatePassed
              ? ['具体业务机制仍需经营事件或后续数据验证。']
              : ['当前证据未达到高可信驱动门槛。'],
            decisions: diagnosticDecisions.slice(0, 12).map((decision) => ({
              sequence: decision.sequence,
              hypothesis: decision.hypothesis ?? null,
              chosenNextView: recordValue(decision.chosenNextView)?.view ?? null,
              decisionCode: decision.decisionCode,
              stopReason: decision.stopReason ?? null,
              triggerEvidenceIds: Array.isArray(decision.triggerEvidenceIds)
                ? decision.triggerEvidenceIds.map(String)
                : [],
            })),
          },
        } : {}),
      });
    }
    if (allClaims.length) {
      throw new CommerceGroundingError('needs_clarification/refused 状态不能携带分析 claims。');
    }
    if (answer.findings.length || answer.recommendations.length) {
      throw new CommerceGroundingError(
        'needs_clarification/refused 状态不能携带 findings 或 recommendations。',
      );
    }
    const clarification = clarificationCopy(this.options.queryScope ?? null);
    return commerceAgentAnswerSchema.parse({
      ...answer,
      answer: answer.status === 'needs_clarification'
        ? clarification.answer
        : refusalCopy(this.options.queryScope ?? null),
      answerClaims: [],
      findings: [],
      recommendations: [],
      followUps: answer.status === 'needs_clarification'
        ? clarification.followUps
        : [],
    });
  }

  deterministicAnswer(fallbackStatus: 'needs_clarification' | 'refused'): CommerceAgentAnswer {
    if (this.options.queryScope && this.options.queryScope.status !== 'ready') {
      return commerceAgentAnswerSchema.parse({
        status: fallbackStatus,
        answer: '查询范围尚未完整解析。',
        answerClaims: [],
        findings: [],
        recommendations: [],
        followUps: [],
      });
    }
    const analyticalObservations = Array.from(this.observations.values()).filter(
      (observation) => ANALYTICAL_OPERATIONS.has(observation.receipt.operation),
    );
    const claims: CommerceEvidenceClaim[] = [];
    for (const observation of analyticalObservations) {
      const candidates: CommerceEvidenceClaim[] = [];
      collectDeterministicClaims(observation, observation.receipt.data, [], candidates, 64);
      const maximum = analyticalObservations.length === 1
        ? 48
        : observation.receipt.operation === 'commerce.compare_metrics'
          ? 48
          : 12;
      claims.push(...selectDeterministicObservationClaims(
        observation,
        candidates,
        maximum,
      ));
    }
    const selectedClaims = uniqueClaims(claims).slice(0, 48);
    if (!selectedClaims.length) {
      return commerceAgentAnswerSchema.parse({
        status: fallbackStatus,
        answer: '无法生成经过验证的经营结论。',
        answerClaims: [],
        findings: [],
        recommendations: [],
        followUps: [],
      });
    }
    const byMetric = new Map<CommerceMetric, CommerceEvidenceClaim[]>();
    for (const claim of selectedClaims) {
      byMetric.set(claim.metric, [...(byMetric.get(claim.metric) ?? []), claim]);
    }
    return commerceAgentAnswerSchema.parse({
      status: 'answered',
      answer: '已形成经过验证的经营结论。',
      answerClaims: selectedClaims,
      findings: Array.from(byMetric.entries()).map(([metric, metricClaims]) => ({
        metric,
        title: '经营指标信号',
        detail: '该指标已绑定本次运行的字段级证据。',
        claims: metricClaims.slice(0, 12),
      })),
      recommendations: [],
      followUps: [],
    });
  }

  questionRequestsUnavailableMetric(question: string): boolean {
    const catalog = this.receipts().find(
      (receipt) => receipt.operation === 'commerce.describe_data',
    );
    const metrics = recordValue(catalog?.data)?.metrics;
    const available = new Set(
      Array.isArray(metrics)
        ? metrics.map((entry) => recordValue(entry)?.id).filter((id): id is string => typeof id === 'string')
        : [],
    );
    return Object.entries(QUESTION_METRIC_ALIASES).some(([metric, pattern]) => (
      pattern.test(question) && !available.has(metric)
    ));
  }

  receipts(): CommerceEvidenceReceipt[] {
    return Array.from(this.observations.values()).map(({ receipt }) => receipt);
  }

  sourceWatermark(): string | null {
    const catalog = this.receipts().find(
      (receipt) => receipt.operation === 'commerce.describe_data',
    );
    const coverage = recordValue(recordValue(catalog?.data)?.coverage);
    if (typeof coverage?.sourceUpdatedAt === 'string') return coverage.sourceUpdatedAt;
    return typeof coverage?.lastIngestedAt === 'string' ? coverage.lastIngestedAt : null;
  }

  trace(evidenceId: string): CommerceToolTrace {
    const observation = this.observations.get(evidenceId);
    const receipt = observation?.receipt;
    if (!receipt || !observation) {
      throw new CommerceGroundingError(`Evidence 不存在：${evidenceId}`);
    }
    return {
      evidenceId: receipt.evidenceId,
      operation: receipt.operation,
      fetchedAt: receipt.fetchedAt,
      rowCount: receipt.rowCount,
      requestSha256: receipt.requestSha256,
      responseSha256: receipt.responseSha256,
      sourceQuestionSha256: receipt.sourceQuestionSha256,
      queryScopeSha256: receipt.queryScopeSha256,
      sourceWatermark: this.sourceWatermark(),
      request: boundedPreview({
        ...(recordValue(observation.request) ?? { value: observation.request }),
        __queryScope: {
          sourceQuestionSha256: receipt.sourceQuestionSha256,
          queryScopeSha256: receipt.queryScopeSha256,
          resolved: this.options.queryScope ?? null,
        },
      }),
      preview: boundedPreview(receipt.data),
      previewTruncated: previewIsTruncated(receipt.data),
    };
  }

  traces(): CommerceToolTrace[] {
    return this.receipts().map((receipt) => this.trace(receipt.evidenceId));
  }
}

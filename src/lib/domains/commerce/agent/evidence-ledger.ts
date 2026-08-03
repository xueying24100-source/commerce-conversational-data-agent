import { createHash, randomUUID } from 'node:crypto';

import {
  COMMERCE_METRICS,
  commerceAgentAnswerSchema,
  type CommerceAgentAnswer,
  type CommerceEvidenceClaim,
  type CommerceEvidenceReceipt,
  type CommerceEvidenceUnit,
  type CommerceMetric,
  type CommerceToolTrace,
} from './types';

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

const ANALYTICAL_OPERATIONS = new Set([
  'commerce.compare_metrics',
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

function formatClaimValue(value: number, unit: CommerceEvidenceUnit): string {
  switch (unit) {
    case 'currency':
      return new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY',
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

function controlledFollowUps(claims: readonly CommerceEvidenceClaim[]): string[] {
  const metrics = Array.from(new Set(claims.map((claim) => claim.metric))).slice(0, 2);
  return metrics.flatMap((metric) => [
    `按渠道拆解${METRIC_LABELS[metric]}`,
    `查看${METRIC_LABELS[metric]}的时间趋势`,
  ]).slice(0, 5);
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

interface InternalEvidence {
  receipt: CommerceEvidenceReceipt;
  request: unknown;
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
    if (segments[0] === 'current') return '当前区间';
    if (segments[0] === 'baseline') return '基准区间';
    if (segments[0] === 'changes') {
      return segments[2] === 'percent' ? '相对变化' : '绝对变化';
    }
  }
  if (Array.isArray(observation.receipt.data) && /^(?:0|[1-9]\d*)$/u.test(segments[0])) {
    const row = recordValue(observation.receipt.data[Number(segments[0])]);
    const entity = row?.key ?? row?.sku ?? row?.bucket;
    if (typeof entity === 'string' && entity) return entity;
  }
  return null;
}

interface CommerceEvidenceLedgerOptions {
  requireFreshCatalogForAnswered?: boolean;
  maxDataAgeHours?: number;
  now?: () => number;
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

export class CommerceGroundingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommerceGroundingError';
  }
}

export class CommerceEvidenceLedger {
  private readonly observations = new Map<string, InternalEvidence>();

  constructor(private readonly options: CommerceEvidenceLedgerOptions = {}) {}

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
    const maxAgeMs = (this.options.maxDataAgeHours ?? 72) * 3_600_000;
    if (!catalog || !start || !end || rowCount <= 0) {
      throw new CommerceGroundingError('answered 状态需要本租户非空的数据目录和有效覆盖范围。');
    }
    if (
      !Number.isFinite(lastIngestedAt)
      || lastIngestedAt > now + 5 * 60_000
      || now - lastIngestedAt > maxAgeMs
    ) {
      throw new CommerceGroundingError('本租户数据已过期或水位无效，不能提交 answered。');
    }
    if (
      dataMode === 'incremental'
      && (
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
    if (!ANALYTICAL_OPERATIONS.has(observation.receipt.operation)) {
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
    return { observation, segments: resolved.segments };
  }

  private renderClaim(claim: CommerceEvidenceClaim): string {
    const validated = this.validateClaim(claim);
    const context = claimContext(validated.observation, validated.segments);
    return `${METRIC_LABELS[claim.metric]}${context ? `（${context}）` : ''}：${formatClaimValue(claim.value, claim.unit)}`;
  }

  private renderNarrative(
    narrative: string,
    claims: readonly CommerceEvidenceClaim[],
    maximumLength: number,
  ): string {
    if (!claims.length) return narrative;
    const suffix = `\n\n数据事实：${claims.map((claim) => this.renderClaim(claim)).join('；')}`;
    if (suffix.length >= maximumLength) {
      throw new CommerceGroundingError('结构化 claims 过多，无法在受控答案长度内完整渲染。');
    }
    const base = narrative.slice(0, maximumLength - suffix.length).trim();
    return `${base}${suffix}`;
  }

  verifyAnswer(value: unknown, _userQuestion: string): CommerceAgentAnswer {
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
      return commerceAgentAnswerSchema.parse({
        ...answer,
        answer: this.renderNarrative(
          '已完成本次经营数据核对。以下内容仅来自经过字段级校验的分析结果。',
          answer.answerClaims,
          8_000,
        ),
        findings: answer.findings.map((finding) => ({
          ...finding,
          title: `${METRIC_LABELS[finding.metric]}观察`,
          detail: this.renderNarrative(
            '以下为经过字段级校验的经营事实。',
            finding.claims,
            1_500,
          ),
        })),
        recommendations: answer.recommendations.map((recommendation) => {
          const copy = recommendationCopy(recommendation.claims);
          return {
            ...recommendation,
            action: copy.action,
            rationale: this.renderNarrative(copy.rationale, recommendation.claims, 1_500),
          };
        }),
        followUps: controlledFollowUps(allClaims),
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
    return commerceAgentAnswerSchema.parse({
      ...answer,
      answer: answer.status === 'needs_clarification'
        ? '当前信息不足，无法执行可验证的数据查询。请补充明确的日期范围、经营指标或筛选范围。'
        : '该请求超出只读电商经营数据分析范围，未执行任何写操作或无关查询。',
      answerClaims: [],
      findings: [],
      recommendations: [],
      followUps: answer.status === 'needs_clarification'
        ? ['补充要分析的日期范围、经营指标和筛选条件']
        : [],
    });
  }

  deterministicAnswer(fallbackStatus: 'needs_clarification' | 'refused'): CommerceAgentAnswer {
    const claims: CommerceEvidenceClaim[] = [];
    for (const observation of this.observations.values()) {
      if (!ANALYTICAL_OPERATIONS.has(observation.receipt.operation)) continue;
      collectDeterministicClaims(observation, observation.receipt.data, [], claims, 12);
      if (claims.length >= 12) break;
    }
    if (!claims.length) {
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
    for (const claim of claims) {
      byMetric.set(claim.metric, [...(byMetric.get(claim.metric) ?? []), claim]);
    }
    return commerceAgentAnswerSchema.parse({
      status: 'answered',
      answer: '已完成经营数据核对。',
      answerClaims: claims,
      findings: Array.from(byMetric.entries()).map(([metric, metricClaims]) => ({
        metric,
        title: '经营指标观察',
        detail: '已核对该经营指标。',
        claims: metricClaims,
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
      sourceWatermark: this.sourceWatermark(),
      request: boundedPreview(observation.request),
      preview: boundedPreview(receipt.data),
    };
  }

  traces(): CommerceToolTrace[] {
    return this.receipts().map((receipt) => this.trace(receipt.evidenceId));
  }
}

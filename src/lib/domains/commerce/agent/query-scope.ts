import { createHash } from 'node:crypto';

import {
  COMMERCE_METRICS,
  commerceResolvedQueryScopeSchema,
  type CommerceCatalog,
  type CommerceConversationMessage,
  type CommerceDateRange,
  type CommerceDimension,
  type CommerceFilters,
  type CommerceMetric,
  type CommerceQueryAnalysisView,
  type CommerceQueryScopeMissingSlot,
  type CommerceResolvedQueryScope,
} from './types';

const EMPTY_FILTERS: CommerceFilters = {
  regions: [],
  channels: [],
  skus: [],
  categories: [],
};

const METRIC_ALIASES: Record<CommerceMetric, RegExp> = {
  gmv: /\bGMV\b|成交额|成交金额|销售额/iu,
  net_revenue: /net[_\s-]?revenue|净收入/iu,
  paid_orders: /paid[_\s-]?orders?|支付订单|订单(?:数|量)/iu,
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
  new_customers: /new[_\s-]?customers?|新客(?:数|量)?/iu,
  stockout_hours: /stockout[_\s-]?hours?|缺货时长|缺货风险/iu,
  ending_inventory: /ending[_\s-]?inventory|期末库存|库存风险/iu,
};

const DIMENSION_ALIASES: Record<CommerceDimension, RegExp> = {
  region: /(?:按|分|各|for\s+|by\s+)?(?:地区|区域|州(?:级)?|省(?:级)?|region|state)(?:拆分|拆解|分组|分析|维度|排名|排行)?/iu,
  channel: /(?:按|分|各|for\s+)?(?:渠道|channel)(?:拆分|拆解|分组|分析|维度)?/iu,
  sku: /(?:(?:按|分|各|for\s+)(?:SKU|商品)(?:拆分|拆解|分组|分析|维度)?|(?:SKU|商品)(?:拆分|拆解|分组|分析|维度))/iu,
  category: /(?:按|分|各|for\s+)?(?:品类|类目|category)(?:拆分|拆解|分组|分析|维度)?/iu,
};

const EXECUTIVE_QUESTION = /(?:经营情况|经营表现|经营诊断|经营复盘|整体表现|管理层|增长质量|驱动|风险|机会|建议|策略|business\s+(?:performance|health)|diagnos|drivers?|risks?|opportunit|recommend|strateg)/iu;
const BROAD_EXECUTIVE_QUESTION = /(?:经营(?:情况|表现|诊断|复盘|风险)|整体表现|管理层|增长质量|驱动|机会|建议|策略|business\s+(?:performance|health)|diagnos|drivers?|opportunit|recommend|strateg)/iu;
const WEEKLY_DIAGNOSTIC_OBJECTIVE = /(?:(?:诊断|分析|复盘).{0,20}(?:上一完整周|上个完整周|上周).{0,20}(?:经营|业务)?(?:表现|情况)?|(?:上一完整周|上个完整周|上周).{0,20}(?:经营|业务)(?:表现|诊断|复盘)|(?:weekly|last\s+complete\s+week).{0,20}(?:business\s+)?diagnos)/iu;
const MUTATION_OR_SENSITIVE_REQUEST = /(?:删除(?:订单|数据|记录)|修改(?:订单|数据|记录|价格|库存)|写入|更新(?:订单|数据|记录|价格|库存)|创建(?:订单|退款|记录)|退款操作|执行退款|发货|下单|导出.*(?:客户|手机号|地址)|\b(?:delete|update|insert)\b|\b(?:issue|create|process|approve|execute|initiate)\s+(?:a\s+)?refund\b|\bship\s+(?:an?\s+)?(?:order|package)\b|\bplace\s+(?:an?\s+)?order\b)/iu;
const COMPARISON_REQUEST = /(?:同比|环比|去年同期|上年同期|较上月|相比上月|对比上月|对比|相比|比较|对照|\byoy\b|year[\s-]*over[\s-]*year|\bmom\b|month[\s-]*over[\s-]*month|\bvs\.?\b|versus)/iu;
const YEAR_OVER_YEAR_REQUEST = /(?:同比|去年同期|上年同期|\byoy\b|year[\s-]*over[\s-]*year)/iu;
const MONTH_OVER_MONTH_REQUEST = /(?:环比|较上月|相比上月|对比上月|\bmom\b|month[\s-]*over[\s-]*month|(?:\bvs\.?\b|versus).*last\s+month)/iu;
const TREND_REQUEST = /(?:趋势|走势|时间序列|trend|over\s+time|daily|weekly|monthly|每日|每天|按天|每周|按周|每月|按月)/iu;
const INVENTORY_REQUEST = /(?:库存风险|缺货风险|inventory\s+risk)/iu;
const FILTER_NEGATION = /(?:除.+(?:外|之外)|排除|不含|不包括|不要看|不看|剔除|except\s+for|excluding?|without)/iu;
const SAME_DATE_RANGE_REFERENCE = /(?:(?:同一|相同)(?:的)?日期范围|same\s+(?:date\s+range|period)\b)/iu;

type ComparisonMode = 'yoy' | 'mom' | 'explicit' | 'generic' | null;

interface ExplicitRanges {
  ranges: CommerceDateRange[];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

export function commerceQuerySha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function resolvedTimeZone(timezone: string): { timezone: string; valid: boolean } {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date(0));
    return { timezone, valid: true };
  } catch {
    return { timezone: 'UTC', valid: false };
  }
}

export function commerceBusinessDate(now: Date, timezone: string): string {
  const resolved = resolvedTimeZone(timezone);
  if (!resolved.valid) throw new RangeError(`Invalid business timezone: ${timezone}`);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: resolved.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function isoDate(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function previousCompleteWeekRange(value: string): CommerceDateRange {
  const date = new Date(`${value}T00:00:00.000Z`);
  // Product date contract: an operational week starts on Monday. Sunday is 0
  // in JavaScript, so normalize it to seven before locating this week's Monday.
  const normalizedDay = date.getUTCDay() || 7;
  const currentWeekStart = addDays(value, -(normalizedDay - 1));
  const end = addDays(currentWeekStart, -1);
  return { start: addDays(end, -6), end };
}

function daysInRange(range: CommerceDateRange): number {
  return Math.floor(
    (Date.parse(`${range.end}T00:00:00.000Z`) - Date.parse(`${range.start}T00:00:00.000Z`))
    / 86_400_000,
  ) + 1;
}

function validatedRange(start: string, end: string): CommerceDateRange | null {
  const startParts = start.split('-').map(Number) as [number, number, number];
  const endParts = end.split('-').map(Number) as [number, number, number];
  if (isoDate(...startParts) !== start || isoDate(...endParts) !== end || start > end) return null;
  const range = { start, end };
  return daysInRange(range) <= 731 ? range : null;
}

function monthRange(year: number, month: number, endOverride?: string): CommerceDateRange | null {
  const start = isoDate(year, month, 1);
  if (!start) return null;
  const following = new Date(Date.UTC(year, month, 1));
  following.setUTCDate(0);
  const naturalEnd = following.toISOString().slice(0, 10);
  return { start, end: endOverride && endOverride < naturalEnd ? endOverride : naturalEnd };
}

function previousYearRange(range: CommerceDateRange): CommerceDateRange {
  const shift = (value: string) => {
    const [year, month, day] = value.split('-').map(Number) as [number, number, number];
    return isoDate(year - 1, month, day) ?? isoDate(year - 1, month, day - 1)!;
  };
  return { start: shift(range.start), end: shift(range.end) };
}

function previousAdjacentRange(range: CommerceDateRange): CommerceDateRange {
  const end = addDays(range.start, -1);
  return { start: addDays(end, -(daysInRange(range) - 1)), end };
}

function previousMonthAlignedRange(range: CommerceDateRange): CommerceDateRange {
  const [startYear, startMonth, startDay] = range.start.split('-').map(Number) as [number, number, number];
  const [endYear, endMonth] = range.end.split('-').map(Number) as [number, number];
  if (startDay !== 1 || startYear !== endYear || startMonth !== endMonth) {
    return previousAdjacentRange(range);
  }
  const previous = new Date(Date.UTC(startYear, startMonth - 2, 1));
  const previousNatural = monthRange(previous.getUTCFullYear(), previous.getUTCMonth() + 1)!;
  const currentNatural = monthRange(startYear, startMonth)!;
  if (range.end === currentNatural.end) return previousNatural;
  return {
    start: previousNatural.start,
    end: addDays(previousNatural.start, Math.min(daysInRange(range), daysInRange(previousNatural)) - 1),
  };
}

function extractExplicitRanges(question: string): ExplicitRanges {
  const output: CommerceDateRange[] = [];
  const isoRange = /(?:from\s*)?(\d{4}-\d{2}-\d{2})\s*(?:至|到|~|～|—|–|\bto\b)\s*(\d{4}-\d{2}-\d{2})/giu;
  for (const match of question.matchAll(isoRange)) {
    const range = validatedRange(match[1]!, match[2]!);
    if (range) output.push(range);
  }
  if (output.length) return { ranges: output };

  const chineseDayRange = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?\s*(?:至|到|~|～|—|–)\s*(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/gu;
  for (const match of question.matchAll(chineseDayRange)) {
    const start = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    const end = isoDate(Number(match[4] ?? match[1]), Number(match[5]), Number(match[6]));
    const range = start && end ? validatedRange(start, end) : null;
    if (range) output.push(range);
  }
  if (output.length) return { ranges: output };

  const isoDays = Array.from(question.matchAll(/(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/gu))
    .map((match) => match[1]!)
    .filter((value) => isoDate(...value.split('-').map(Number) as [number, number, number]));
  if (isoDays.length) return { ranges: isoDays.map((value) => ({ start: value, end: value })) };

  const chineseDays = Array.from(question.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/gu))
    .map((match) => isoDate(Number(match[1]), Number(match[2]), Number(match[3])))
    .filter((value): value is string => Boolean(value));
  if (chineseDays.length) {
    return { ranges: chineseDays.map((value) => ({ start: value, end: value })) };
  }

  const chineseMonths = Array.from(question.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月(?!\s*\d)/gu))
    .map((match) => monthRange(Number(match[1]), Number(match[2])))
    .filter((value): value is CommerceDateRange => Boolean(value));
  if (chineseMonths.length) return { ranges: chineseMonths };

  const years = Array.from(question.matchAll(/(?<!\d)(20\d{2})\s*年(?!\s*\d+\s*月)/gu))
    .map((match): CommerceDateRange => ({
      start: `${match[1]}-01-01`,
      end: `${match[1]}-12-31`,
    }));
  return { ranges: years };
}

function extractRelativeRange(
  question: string,
  referenceDate: string,
  catalogEnd: string | null,
): CommerceDateRange | null {
  if (/(?:今天|今日|today)/iu.test(question)) {
    return { start: referenceDate, end: referenceDate };
  }
  if (/(?:昨天|昨日|yesterday)/iu.test(question)) {
    const value = addDays(referenceDate, -1);
    return { start: value, end: value };
  }
  if (/前天/u.test(question)) {
    const value = addDays(referenceDate, -2);
    return { start: value, end: value };
  }
  const recentDays = question.match(/(?:(?:最近|近|过去)\s*|last\s+)(\d{1,3})\s*(?:天|days?)/iu);
  if (recentDays) {
    const days = Math.min(731, Math.max(1, Number(recentDays[1])));
    const end = catalogEnd && catalogEnd < referenceDate ? catalogEnd : referenceDate;
    return { start: addDays(end, -(days - 1)), end };
  }
  if (/(?:最近|过去|近)\s*(?:一|1)\s*周/iu.test(question)) {
    const end = catalogEnd && catalogEnd < referenceDate ? catalogEnd : referenceDate;
    return { start: addDays(end, -6), end };
  }
  if (/(?:上周|上一周|last\s+week|previous\s+week)/iu.test(question)) {
    const anchor = catalogEnd && catalogEnd < referenceDate ? catalogEnd : referenceDate;
    return previousCompleteWeekRange(anchor);
  }
  const [year, month] = referenceDate.split('-').map(Number) as [number, number];
  if (/(?:本月|这个月|current\s+month|this\s+month)/iu.test(question)) {
    return monthRange(year, month, referenceDate);
  }
  if (/(?:上月|上个月|previous\s+month|last\s+month)/iu.test(question)) {
    const previous = new Date(Date.UTC(year, month - 2, 1));
    return monthRange(previous.getUTCFullYear(), previous.getUTCMonth() + 1);
  }
  if (/(?:当前|目前|latest|current)/iu.test(question) && catalogEnd) {
    const [coverageYear, coverageMonth] = catalogEnd.split('-').map(Number) as [number, number];
    return monthRange(coverageYear, coverageMonth, catalogEnd);
  }
  return null;
}

function requestedMetrics(question: string): CommerceMetric[] {
  return COMMERCE_METRICS.filter((metric) => METRIC_ALIASES[metric].test(question));
}

function requestedDimensions(question: string): CommerceDimension[] {
  return (Object.entries(DIMENSION_ALIASES) as Array<[CommerceDimension, RegExp]>)
    .filter(([, pattern]) => pattern.test(question))
    .map(([dimension]) => dimension);
}

function requestedTrendGrain(question: string): 'day' | 'week' | 'month' | null {
  if (/(?:每日|每天|按天|按日|daily|by\s+day)/iu.test(question)) return 'day';
  if (/(?:每周|按周|weekly|by\s+week)/iu.test(question)) return 'week';
  if (/(?:每月|按月|monthly|by\s+month)/iu.test(question)) return 'month';
  return null;
}

function requestedBreakdownLimit(question: string): number | null {
  const match = question.match(/(?:前|top\s*)(\d{1,2})\s*(?:个|名|项)?/iu);
  if (match) return Math.min(50, Math.max(1, Number(match[1])));
  const chineseMatch = question.match(/前\s*([一二三四五六七八九十]{1,3})\s*(?:个|名|项)?/u);
  if (!chineseMatch) return null;
  const digits: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5,
    六: 6, 七: 7, 八: 8, 九: 9,
  };
  const value = chineseMatch[1]!;
  const [tensText, onesText] = value.split('十');
  const parsed = value.includes('十')
    ? (tensText ? digits[tensText] ?? 0 : 1) * 10 + (onesText ? digits[onesText] ?? 0 : 0)
    : digits[value] ?? 0;
  return parsed ? Math.min(50, parsed) : null;
}

function requestedBreakdownSort(
  question: string,
): 'current_desc' | 'change_asc' | 'absolute_change_desc' | null {
  if (/(?:下降最多|拖累最大|拖累最多|降幅最大|declin|detractor)/iu.test(question)) {
    return 'change_asc';
  }
  if (/(?:变化最大|变动最大|波动最大|absolute\s+change)/iu.test(question)) {
    return 'absolute_change_desc';
  }
  if (/(?:最高|最大|最好|排名|排行|top)/iu.test(question)) return 'current_desc';
  return null;
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function entityMentioned(question: string, value: string): boolean {
  const candidate = value.trim();
  if (!candidate) return false;
  if (!/^[\x00-\x7F]+$/u.test(candidate)) return question.includes(candidate);
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])${regexEscape(candidate)}(?![\\p{L}\\p{N}_])`,
    'iu',
  ).test(question);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function mentionedValues(
  question: string,
  values: readonly string[],
): string[] {
  const matches = unique(values)
    .filter((value) => entityMentioned(question, value))
    .sort((left, right) => right.length - left.length || left.localeCompare(right));
  const selected: string[] = [];
  for (const match of matches) {
    if (selected.some((value) => value !== match && value.includes(match))) continue;
    selected.push(match);
  }
  return selected.sort((left, right) => left.localeCompare(right));
}

function resolvedFilters(
  question: string,
  catalog: CommerceCatalog,
  resolvedEntities: Partial<Record<CommerceDimension, readonly string[]>>,
): CommerceFilters {
  const filters: CommerceFilters = structuredClone(EMPTY_FILTERS);
  const mapping = [
    ['region', 'regions'],
    ['channel', 'channels'],
    ['sku', 'skus'],
    ['category', 'categories'],
  ] as const;
  for (const [dimension, filter] of mapping) {
    filters[filter] = mentionedValues(question, [
      ...catalog.dimensions[dimension],
      ...(resolvedEntities[dimension] ?? []),
    ]);
  }
  return filters;
}

function hasResolvedFilter(filters: CommerceFilters, dimension: CommerceDimension): boolean {
  if (dimension === 'region') return filters.regions.length > 0;
  if (dimension === 'channel') return filters.channels.length > 0;
  if (dimension === 'sku') return filters.skus.length > 0;
  return filters.categories.length > 0;
}

function unresolvedFilterDimensions(
  question: string,
  filters: CommerceFilters,
): CommerceDimension[] {
  const genericRequests: Record<CommerceDimension, RegExp> = {
    region: /(?:(?:按|各)(?:地区|区域|州|省)|(?:最好|最高|最大)(?:的)?(?:地区|区域|州|省)|(?:地区|区域|州|省)(?:拆解|排名|排行|分组))/u,
    channel: /(?:(?:按|各)渠道|(?:最好|最高|最大)(?:的)?渠道|渠道(?:拆解|排名|排行|分组))/u,
    sku: /(?:(?:按|各)(?:SKU|商品)|(?:最好|最高|最大)(?:的)?(?:SKU|商品)|(?:SKU|商品)(?:拆解|排名|排行|分组))/iu,
    category: /(?:(?:按|各)(?:品类|类目)|(?:最好|最高|最大)(?:的)?(?:品类|类目)|(?:品类|类目)(?:拆解|排名|排行|分组))/u,
  };
  const patterns: Record<CommerceDimension, RegExp[]> = {
    region: [
      /\bregion\s*(?:is|=|:)\s*([\p{L}\p{N}_-]{2,40})/iu,
      /([\p{L}\p{N}_-]{2,40})(?<![按和与及分各])(?:地区|区域)/u,
    ],
    channel: [
      /\bchannel\s*(?:is|=|:)\s*([\p{L}\p{N}_-]{2,40})/iu,
      /([\p{L}\p{N}_-]{2,40})(?<!使用)(?<![按和与及分各])渠道/u,
    ],
    sku: [/\bSKU\s*(?:is|=|:)?\s*([A-Z0-9_-]{2,80})/iu],
    category: [
      /\bcategory\s*(?:is|=|:)\s*([\p{L}\p{N}_-]{2,40})/iu,
      /([\p{L}\p{N}_-]{2,40})(?<![按和与及分各])(?:品类|类目)/u,
    ],
  };
  return (Object.keys(patterns) as CommerceDimension[]).filter((dimension) => (
    !hasResolvedFilter(filters, dimension)
    && !genericRequests[dimension].test(question)
    && patterns[dimension].some((pattern) => pattern.test(question))
  ));
}

function hasOwnDate(question: string): boolean {
  return extractExplicitRanges(question).ranges.length > 0
    || /(?:今天|今日|昨天|昨日|前天|本月|这个月|上月|上个月|上周|上一周|当前|目前|(?:最近|过去|近)\s*(?:一|1)\s*周|最近\s*\d+\s*天|过去\s*\d+\s*天|last\s+\d+\s+days?|last\s+week|previous\s+week|current\s+month|this\s+month|last\s+month)/iu.test(question);
}

function isSelfContainedQuestion(question: string): boolean {
  return MUTATION_OR_SENSITIVE_REQUEST.test(question)
    || (hasOwnDate(question) && (requestedMetrics(question).length > 0 || EXECUTIVE_QUESTION.test(question)));
}

function referencedPriorDateRange(
  question: string,
  history: readonly CommerceConversationMessage[],
): CommerceDateRange | null {
  if (hasOwnDate(question) || !SAME_DATE_RANGE_REFERENCE.test(question)) return null;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'user') continue;
    const ranges = extractExplicitRanges(message.content).ranges;
    return ranges.length === 1 ? ranges[0]! : null;
  }
  return null;
}

export function commerceQuestionForResolution(
  question: string,
  history: readonly CommerceConversationMessage[] = [],
): string {
  if (isSelfContainedQuestion(question)) return question;
  const referencedRange = referencedPriorDateRange(question, history);
  if (referencedRange) {
    return `${question}\n日期范围：${referencedRange.start} 到 ${referencedRange.end}`;
  }
  let assistantIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message?.role !== 'assistant') continue;
    if (message.answer?.status === 'needs_clarification') assistantIndex = index;
    break;
  }
  if (assistantIndex < 0) return question;

  const priorQuestions: string[] = [];
  let cursor = assistantIndex;
  while (cursor >= 0) {
    let userIndex = cursor - 1;
    while (userIndex >= 0 && history[userIndex]?.role !== 'user') userIndex -= 1;
    if (userIndex < 0) break;
    priorQuestions.unshift(history[userIndex]!.content);
    let previousAssistant = userIndex - 1;
    while (previousAssistant >= 0 && history[previousAssistant]?.role !== 'assistant') {
      previousAssistant -= 1;
    }
    if (
      previousAssistant < 0
      || history[previousAssistant]?.answer?.status !== 'needs_clarification'
    ) break;
    cursor = previousAssistant;
  }
  return [...priorQuestions, question]
    .map((part, index) => index === 0 ? part : `补充：${part}`)
    .join('\n');
}

function comparisonMode(question: string, explicitRangeCount: number): ComparisonMode {
  if (YEAR_OVER_YEAR_REQUEST.test(question)) return 'yoy';
  if (MONTH_OVER_MONTH_REQUEST.test(question)) return 'mom';
  if (COMPARISON_REQUEST.test(question)) {
    return explicitRangeCount >= 2 ? 'explicit' : 'generic';
  }
  return null;
}

function requiredViews(params: {
  weeklyDiagnosis: boolean;
  executive: boolean;
  comparison: boolean;
  dimensions: readonly CommerceDimension[];
  trend: boolean;
  inventory: boolean;
}): CommerceQueryAnalysisView[] {
  const views: CommerceQueryAnalysisView[] = [];
  if (params.weeklyDiagnosis) {
    views.push('diagnostic_scan');
  } else if (params.executive) {
    views.push('comparison', 'breakdown', 'trend');
  } else if (params.inventory) {
    views.push('inventory');
  } else {
    views.push(params.comparison ? 'comparison' : 'totals');
  }
  if (params.dimensions.length) views.push('breakdown');
  if (params.trend) views.push('trend');
  if (params.inventory) views.push('inventory');
  return unique(views);
}

export function resolveCommerceQueryScope(input: {
  question: string;
  history?: readonly CommerceConversationMessage[];
  catalog: CommerceCatalog;
  mentionedEntities?: Partial<Record<CommerceDimension, readonly string[]>>;
  now?: Date;
  referenceDate?: string;
  referenceInstant?: Date;
  weeklyDiagnosisEnabled?: boolean;
}): CommerceResolvedQueryScope {
  const question = input.question.trim();
  const resolutionQuestion = commerceQuestionForResolution(question, input.history ?? []);
  const resolvedTimezone = resolvedTimeZone(input.catalog.timezone);
  const now = input.now ?? new Date();
  const referenceInstant = input.referenceInstant ?? now;
  const referenceDate = input.referenceDate
    ?? commerceBusinessDate(referenceInstant, resolvedTimezone.timezone);
  const metrics = requestedMetrics(resolutionQuestion);
  const inventory = INVENTORY_REQUEST.test(resolutionQuestion);
  if (inventory) metrics.push('stockout_hours', 'ending_inventory');
  const uniqueMetrics = unique(metrics);
  const weeklyDiagnosis = input.weeklyDiagnosisEnabled !== false
    && WEEKLY_DIAGNOSTIC_OBJECTIVE.test(resolutionQuestion);
  const executive = EXECUTIVE_QUESTION.test(resolutionQuestion)
    && (!inventory || BROAD_EXECUTIVE_QUESTION.test(resolutionQuestion));
  const explicitRanges = extractExplicitRanges(resolutionQuestion).ranges;
  const mode = comparisonMode(resolutionQuestion, explicitRanges.length);
  const relativeRange = explicitRanges.length
    ? null
    : extractRelativeRange(resolutionQuestion, referenceDate, input.catalog.coverage.end);
  const ambiguousRanges = explicitRanges.length > 1 && mode === null;
  const current = explicitRanges[0]
    ?? relativeRange
    ?? (weeklyDiagnosis
      ? previousCompleteWeekRange(
          input.catalog.coverage.end && input.catalog.coverage.end < referenceDate
            ? input.catalog.coverage.end
            : referenceDate,
        )
      : null);
  let baseline = mode && explicitRanges[1] ? explicitRanges[1] : null;
  if (current && !baseline) {
    if (mode === 'yoy') baseline = previousYearRange(current);
    if (mode === 'mom') baseline = previousMonthAlignedRange(current);
  }
  if (weeklyDiagnosis && current && !baseline) baseline = previousAdjacentRange(current);
  else if (executive && current && !baseline) baseline = previousMonthAlignedRange(current);

  const dimensions = unique(requestedDimensions(resolutionQuestion));
  const filters = resolvedFilters(
    resolutionQuestion,
    input.catalog,
    input.mentionedEntities ?? {},
  );
  const negatedFilters = FILTER_NEGATION.test(resolutionQuestion)
    && (dimensions.length > 0 || Object.values(filters).some((values) => values.length > 0));
  const unresolvedFilters = unresolvedFilterDimensions(resolutionQuestion, filters);
  const trend = TREND_REQUEST.test(resolutionQuestion);
  const trendGrain = requestedTrendGrain(resolutionQuestion);
  const breakdownLimit = requestedBreakdownLimit(resolutionQuestion);
  const breakdownSort = requestedBreakdownSort(resolutionQuestion);

  const missingSlots: CommerceQueryScopeMissingSlot[] = [];
  if (!current || ambiguousRanges) missingSlots.push('current_date_range');
  if (!uniqueMetrics.length && !executive) missingSlots.push('metrics');
  if (mode && !baseline) missingSlots.push('baseline_date_range');
  if (negatedFilters || unresolvedFilters.length) missingSlots.push('filters');

  const reasons: CommerceResolvedQueryScope['reasons'] = [];
  const availableMetrics = new Set(input.catalog.metrics.map((metric) => metric.id));
  const unavailable = uniqueMetrics.filter((metric) => !availableMetrics.has(metric));
  if (unavailable.length) reasons.push('metric_unavailable');
  if (MUTATION_OR_SENSITIVE_REQUEST.test(question)) reasons.push('mutation_or_sensitive_request');
  if (!resolvedTimezone.valid) reasons.push('invalid_timezone');
  if (ambiguousRanges || explicitRanges.length > 2) reasons.push('ambiguous_date_range');
  if (unresolvedFilters.length) reasons.push('unresolved_filter');
  if (negatedFilters) reasons.push('unsupported_filter_logic');
  if (
    current
    && input.catalog.coverage.start
    && input.catalog.coverage.end
    && (current.start < input.catalog.coverage.start || current.end > input.catalog.coverage.end)
  ) {
    reasons.push('range_outside_coverage');
    missingSlots.push('current_date_range');
  }
  if (
    baseline
    && input.catalog.coverage.start
    && input.catalog.coverage.end
    && (baseline.start < input.catalog.coverage.start || baseline.end > input.catalog.coverage.end)
  ) {
    reasons.push('range_outside_coverage');
    missingSlots.push('baseline_date_range');
  }

  const refusal = reasons.some((reason) => (
    reason === 'metric_unavailable'
    || reason === 'mutation_or_sensitive_request'
    || reason === 'invalid_timezone'
  ));
  const scopeWithoutHash = {
    version: 2 as const,
    status: refusal
      ? 'refused' as const
      : missingSlots.length
        ? 'needs_clarification' as const
        : 'ready' as const,
    sourceQuestionSha256: commerceQuerySha256({ question, resolutionQuestion }),
    timezone: resolvedTimezone.timezone,
    referenceInstant: referenceInstant.toISOString(),
    referenceDate,
    objective: weeklyDiagnosis ? 'weekly_diagnosis' as const : 'direct_query' as const,
    metricSelection: uniqueMetrics.length ? 'explicit' as const : 'catalog_default' as const,
    metrics: uniqueMetrics,
    current: current ?? null,
    baseline,
    filters: negatedFilters ? structuredClone(EMPTY_FILTERS) : filters,
    executive,
    dimensions,
    requiredViews: requiredViews({
      weeklyDiagnosis,
      executive,
      comparison: Boolean(mode || baseline),
      dimensions,
      trend,
      inventory,
    }),
    trendGrain,
    breakdownLimit,
    breakdownSort,
    missingSlots: unique(missingSlots),
    reasons: unique(reasons),
  };
  return commerceResolvedQueryScopeSchema.parse({
    ...scopeWithoutHash,
    queryScopeSha256: commerceQuerySha256(scopeWithoutHash),
  });
}

import type {
  ActionListItem,
  AgentJob,
  ApiEnvelope,
  CommerceMetricId,
  EvidenceClaim,
  ModelId,
  Readiness,
  RunResult,
} from './types';

export type MetricStripEntry = {
  metric: string;
  value: EvidenceClaim;
  change?: EvidenceClaim;
};

const COMMERCE_BOOTSTRAP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** A finite backoff lets a fresh page recover from a Worker heartbeat/startup race. */
export function commerceBootstrapRetryDelay(attempt: number): number | null {
  return COMMERCE_BOOTSTRAP_RETRY_DELAYS_MS[attempt] ?? null;
}

function totalValuePriority(claim: EvidenceClaim): number {
  if (claim.path === `/current/${claim.metric}`) return 3;
  if (claim.path.startsWith('/current/')) return 2;
  if (!/^\/(?:0|[1-9]\d*)\//u.test(claim.path)) return 1;
  return 0;
}

function totalChangePriority(claim: EvidenceClaim): number {
  if (claim.path === `/changes/${claim.metric}/percent`) return 3;
  if (
    !/^\/(?:0|[1-9]\d*)\//u.test(claim.path)
    && (claim.path.endsWith('/percent') || claim.path.endsWith('/percentChange'))
  ) return 2;
  return 0;
}

/**
 * Selects one headline value per metric. Breakdown rows such as `/4/current` must never
 * replace the period total (`/current/units`) merely because they appear later in the answer.
 */
export function selectMetricStripEntries(claims: EvidenceClaim[]): MetricStripEntry[] {
  const selected = new Map<string, {
    value: EvidenceClaim;
    valuePriority: number;
    change?: EvidenceClaim;
    changePriority: number;
  }>();

  for (const claim of claims) {
    const current = selected.get(claim.metric);
    const valuePriority = totalValuePriority(claim);
    const changePriority = totalChangePriority(claim);
    if (!current) {
      selected.set(claim.metric, {
        value: claim,
        valuePriority,
        ...(changePriority > 0 ? { change: claim } : {}),
        changePriority,
      });
      continue;
    }
    if (valuePriority > current.valuePriority) {
      current.value = claim;
      current.valuePriority = valuePriority;
    }
    if (changePriority > current.changePriority) {
      current.change = claim;
      current.changePriority = changePriority;
    }
  }

  return Array.from(selected.entries()).slice(0, 4).map(([metric, entry]) => ({
    metric,
    value: entry.value,
    ...(entry.change ? { change: entry.change } : {}),
  }));
}

/** Keeps suggested follow-ups runnable by carrying the explicit analysis window forward. */
export function contextualizeCommerceFollowUp(followUp: string, sourceQuestion?: string): string {
  const ownDates = followUp.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
  if (ownDates.length >= 2 || !sourceQuestion) return followUp;
  const sourceDates = sourceQuestion.match(/\b\d{4}-\d{2}-\d{2}\b/gu) ?? [];
  if (sourceDates.length < 2) return followUp;
  return `${followUp}（沿用分析期：${sourceDates[0]} 至 ${sourceDates[1]}）`;
}

export class CommerceApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly conversationId: string | null,
  ) {
    super(message);
    this.name = 'CommerceApiError';
  }
}

export type CommerceJobWaitErrorKind = 'terminal' | 'timeout' | 'network' | 'aborted';

export class CommerceJobWaitError extends Error {
  constructor(
    readonly kind: CommerceJobWaitErrorKind,
    readonly job: AgentJob,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CommerceJobWaitError';
  }
}

export function isTerminalAgentJob(job: AgentJob): boolean {
  return job.status === 'failed' || job.status === 'dead_letter';
}

export function isJobWaitCurrent(
  currentJobId: string | null,
  completedJobId: string,
): boolean {
  return currentJobId === completedJobId;
}

export function recoveredJobDraft(
  job: AgentJob,
  kind: CommerceJobWaitErrorKind,
): string | null {
  return kind === 'terminal' ? job.message : null;
}

// A prior requestId must never be silently resubmitted once the server has told us it can't
// replay it: a 502 means the request may never have reached a durable Job, NOT_REPLAYABLE
// means the prior attempt already reached a terminal, non-retryable outcome, and
// IDEMPOTENCY_CONFLICT means the id was reused for different content. In every other case
// (e.g. the prior attempt is still running, or this is a transient network error) reusing the
// same requestId is exactly what makes a resend idempotent, so the caller must keep it.
export function isNonReplayableCommerceError(error: unknown): boolean {
  return (error instanceof CommerceJobWaitError && error.kind === 'terminal') || (
    error instanceof CommerceApiError && (
      error.status === 502
      || error.code === 'COMMERCE_REQUEST_NOT_REPLAYABLE'
      || error.code === 'COMMERCE_IDEMPOTENCY_CONFLICT'
    )
  );
}

export function isConversationStillSelected(
  selectedConversationId: string | null,
  requestConversationId: string | null,
): boolean {
  return selectedConversationId === requestConversationId;
}

const METRIC_LABELS: Record<CommerceMetricId, string> = {
  gmv: 'GMV',
  net_revenue: '净收入',
  paid_orders: '支付订单数',
  units: '销量',
  visits: '访问量',
  conversion_rate: '转化率',
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

const OVERVIEW_PRIORITY: CommerceMetricId[] = [
  'gmv',
  'paid_orders',
  'units',
  'net_revenue',
  'conversion_rate',
  'average_order_value',
  'refund_amount',
  'new_customers',
  'gross_profit',
  'roas',
  'visits',
];

const SIGNAL_PRIORITY: CommerceMetricId[] = [
  'gmv',
  'paid_orders',
  'net_revenue',
  'conversion_rate',
  'refund_amount',
  'gross_profit',
  'roas',
  'new_customers',
  'units',
  'visits',
];

function dateRangeText(start: string, end: string): string {
  return start === end ? start : `${start} 至 ${end}`;
}

function starterAnalysisRange(
  coverageStart: string,
  coverageEnd: string,
): { start: string; end: string } | null {
  const start = Date.parse(`${coverageStart}T00:00:00.000Z`);
  const end = Date.parse(`${coverageEnd}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return null;
  const coverageDays = Math.floor((end - start) / 86_400_000) + 1;
  // Executive QueryScope compares against the immediately preceding window. Keep an equally
  // sized baseline inside the catalog, and stay below a full calendar month so alignment cannot
  // expand that baseline beyond coverage.
  const windowDays = Math.min(14, Math.floor(coverageDays / 2));
  if (windowDays < 1) return null;
  return {
    start: new Date(end - ((windowDays - 1) * 86_400_000)).toISOString().slice(0, 10),
    end: coverageEnd,
  };
}

function joinMetricLabels(metrics: readonly CommerceMetricId[]): string {
  return metrics.map((metric) => METRIC_LABELS[metric]).join('、');
}

function validBusinessDate(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

function addCalendarDays(value: string, days: number): string {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return new Date(timestamp + (days * 86_400_000)).toISOString().slice(0, 10);
}

function businessDate(instant: Date, timeZone: string | null): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(instant);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const value = `${values.year}-${values.month}-${values.day}`;
    return validBusinessDate(value) ? value : null;
  } catch {
    return null;
  }
}

function filterDescription(filters: NonNullable<ActionListItem['sourceFilters']>): string {
  const labels: Array<[keyof typeof filters, string]> = [
    ['regions', '区域'],
    ['channels', '渠道'],
    ['skus', 'SKU'],
    ['categories', '品类'],
  ];
  const parts = labels.flatMap(([key, label]) => (
    filters[key].length ? [`${label}：${filters[key].map((value) => `“${value}”`).join('、')}`] : []
  ));
  return parts.length ? parts.join('；') : '全店';
}

function unitDescription(unit: NonNullable<ActionListItem['successMetric']>['targetUnit']): string {
  const labels = {
    currency: '货币金额',
    integer: '整数',
    decimal: '数值',
    percent: '百分比',
    hours: '小时',
  } as const;
  return labels[unit];
}

export type ActionReviewPlan = {
  status: 'ready' | 'waiting_data' | 'blocked';
  message: string;
  question: string | null;
  current: { start: string; end: string } | null;
  baseline: { start: string; end: string } | null;
  reviewEnd: string | null;
  unavailableGuardrails: CommerceMetricId[];
};

function blockedActionReview(message: string): ActionReviewPlan {
  return {
    status: 'blocked',
    message,
    question: null,
    current: null,
    baseline: null,
    reviewEnd: null,
    unavailableGuardrails: [],
  };
}

// The comparison is deliberately driven by the event timestamp and Evidence-backed filters,
// rather than relative dates or the original natural-language question. This keeps a review
// reproducible when it is opened later or from a different browser time zone.
export function buildActionReviewPlan(
  item: ActionListItem,
  dataStatus: Readiness['dataStatus'],
  now = new Date(),
): ActionReviewPlan {
  if (item.status !== 'completed') return blockedActionReview('行动尚未完成，不能复盘效果。');
  if (!item.successMetric) return blockedActionReview('该行动没有成功指标，不能生成可信复盘。');
  if (!item.sourceFilters) return blockedActionReview('无法恢复该行动的原始筛选范围，不能生成可信复盘。');
  if (!item.updatedAt) return blockedActionReview('缺少行动完成时间，不能确定复盘窗口。');
  if (!dataStatus?.coverageStart || !dataStatus.coverageEnd) {
    return blockedActionReview('当前没有完整的数据覆盖范围，不能生成可信复盘。');
  }
  if (!dataStatus.businessTimezone) {
    return blockedActionReview('缺少业务时区，不能确定一致的复盘窗口。');
  }
  if (!validBusinessDate(dataStatus.coverageStart) || !validBusinessDate(dataStatus.coverageEnd)) {
    return blockedActionReview('当前数据覆盖范围无效，不能生成可信复盘。');
  }
  const completionDate = businessDate(new Date(item.updatedAt), dataStatus.businessTimezone);
  if (!completionDate) return blockedActionReview('行动完成时间无效，不能确定复盘窗口。');
  const windowDays = item.commitment?.evaluationWindowDays
    ?? item.successMetric.evaluationWindowDays
    ?? 7;
  const current = {
    start: addCalendarDays(completionDate, 1),
    end: addCalendarDays(completionDate, windowDays),
  };
  const baseline = {
    start: addCalendarDays(completionDate, -windowDays),
    end: addCalendarDays(completionDate, -1),
  };
  const reviewEnd = current.end;
  const base = {
    current,
    baseline,
    reviewEnd,
    unavailableGuardrails: [] as CommerceMetricId[],
  };
  if (dataStatus.coverageStart > baseline.start) {
    return { ...base, status: 'blocked', question: null, message: '缺少行动前完整基线数据，不能生成可信复盘。' };
  }
  const businessToday = businessDate(now, dataStatus.businessTimezone);
  if (!businessToday || businessToday <= reviewEnd || dataStatus.coverageEnd < reviewEnd) {
    const snapshot = dataStatus.dataMode === 'snapshot';
    return {
      ...base,
      status: snapshot ? 'blocked' : 'waiting_data',
      question: null,
      message: snapshot
        ? `历史快照仅覆盖至 ${dataStatus.coverageEnd}，无法覆盖复盘窗口至 ${reviewEnd}。`
        : `等待数据至 ${reviewEnd}`,
    };
  }
  const available = new Set(dataStatus.availableMetrics);
  if (!available.has(item.successMetric.metric)) {
    return { ...base, status: 'blocked', question: null, message: `成功指标 ${METRIC_LABELS[item.successMetric.metric]} 不在当前数据目录中，不能生成可信复盘。` };
  }
  const unavailableGuardrails = (item.guardrails ?? [])
    .map((guardrail) => guardrail.metric)
    .filter((metric) => !available.has(metric));
  const metrics = Array.from(new Set([
    item.successMetric.metric,
    ...(item.guardrails ?? []).map((guardrail) => guardrail.metric).filter((metric) => available.has(metric)),
  ]));
  const direction = item.successMetric.direction === 'increase'
    ? '提升'
    : item.successMetric.direction === 'decrease'
      ? '降低'
      : '保持';
  const committedTarget = item.commitment ? item.commitment.target : item.successMetric.target;
  const target = committedTarget === null
    ? ''
    : `，目标为 ${committedTarget}（${unitDescription(item.successMetric.targetUnit)}）`;
  const guardrailText = (item.guardrails ?? [])
    .filter((guardrail) => available.has(guardrail.metric))
    .map((guardrail) => {
      const boundary = guardrail.threshold === null
        ? '行动前基线'
        : `${guardrail.threshold}（${unitDescription(guardrail.unit)}）`;
      return `${METRIC_LABELS[guardrail.metric]}不得${guardrail.operator === 'not_above' ? '高于' : '低于'}${boundary}`;
    })
    .join('；');
  const question = [
    `复盘已完成行动“${item.action}”的效果。`,
    `将行动后 ${current.start} 至 ${current.end} 与行动前基线 ${baseline.start} 至 ${baseline.end} 对比。`,
    `复盘指标：${joinMetricLabels(metrics)}；成功指标为 ${METRIC_LABELS[item.successMetric.metric]}，目标方向为${direction}${target}。`,
    guardrailText ? `护栏条件：${guardrailText}。` : '',
    `筛选范围严格限定为：${filterDescription(item.sourceFilters)}。`,
    '请基于数据说明行动效果，并同时核对可用护栏指标；数据不足时明确说明，不要推断。',
  ].filter(Boolean).join(' ');
  return {
    ...base,
    status: 'ready',
    message: unavailableGuardrails.length
      ? `以下护栏指标当前不可用：${joinMetricLabels(unavailableGuardrails)}。`
      : '复盘窗口与数据覆盖完整。',
    question,
    unavailableGuardrails,
  };
}

function chooseMetrics(
  available: ReadonlySet<CommerceMetricId>,
  priority: readonly CommerceMetricId[],
  limit: number,
): CommerceMetricId[] {
  return priority.filter((metric) => available.has(metric)).slice(0, limit);
}

export type CommerceStarter = {
  label: string;
  question: string;
};

export function commerceStarters(
  dataStatus: Readiness['dataStatus'],
  diagnosticPolicyEnabled = true,
): CommerceStarter[] {
  if (!dataStatus?.coverageStart || !dataStatus.coverageEnd) return [];
  const analysisRange = starterAnalysisRange(dataStatus.coverageStart, dataStatus.coverageEnd);
  if (!analysisRange) return [];
  const available = new Set(dataStatus.availableMetrics);
  const overview = chooseMetrics(available, OVERVIEW_PRIORITY, 3);
  if (!overview.length) return [];
  const signals = chooseMetrics(available, SIGNAL_PRIORITY, 2);
  const report = chooseMetrics(available, OVERVIEW_PRIORITY, 4);
  const period = dateRangeText(analysisRange.start, analysisRange.end);
  const freshness = dataStatus.dataMode === 'snapshot' ? '该历史快照' : '当前数据';
  const coverageDays = Math.floor((
    Date.parse(`${dataStatus.coverageEnd}T00:00:00.000Z`)
    - Date.parse(`${dataStatus.coverageStart}T00:00:00.000Z`)
  ) / 86_400_000) + 1;
  const flagshipReady = [
    'gmv', 'paid_orders', 'visits', 'conversion_rate', 'average_order_value',
  ].every((metric) => available.has(metric as CommerceMetricId)) && coverageDays >= 90;
  const starters: CommerceStarter[] = [
    {
      label: '经营概览',
      question: `分析 ${period} 的${joinMetricLabels(overview)}，总结整体经营表现。`,
    },
    {
      label: '异常与机会',
      question: `分析 ${period} 的${joinMetricLabels(signals.length ? signals : overview)}趋势，指出经营风险和增长机会。`,
    },
    {
      label: '下一步行动',
      question: `基于 ${period} 的${joinMetricLabels(overview)}，给出下一步经营行动建议。`,
    },
    {
      label: '数据报告',
      question: `生成 ${period} 的${joinMetricLabels(report.length ? report : overview)}经营数据报告。`,
    },
  ];
  if (available.has('stockout_hours') && available.has('ending_inventory')) {
    starters[1] = {
      label: '异常与机会',
      question: `分析 ${period} 的${joinMetricLabels(signals.length ? signals : overview)}趋势和库存风险，指出经营风险和增长机会。`,
    };
  }
  if (flagshipReady && diagnosticPolicyEnabled) {
    starters.unshift({
      label: '完整周诊断',
      question: '诊断上一完整周经营表现。先检查数据健康与基准，再按中间结果决定调查路径；证据足够或预算耗尽时主动停止。',
    });
  }
  return starters.map((starter) => ({
    ...starter,
    question: `${starter.question} 数据口径使用${freshness}，业务时区为${dataStatus.businessTimezone ?? '租户默认时区'}。`,
  }));
}

export const MODEL_LABELS: Record<ModelId, string> = {
  'local_qwen:qwen3.5-9b-q5km': 'Qwen 3.5 · ModelPort',
  'deepseek:deepseek-v4-flash': 'DeepSeek V4 · ModelPort',
  'deepseek-v4-flash': 'DeepSeek V4 · Official',
};

export async function api<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    cache: 'no-store',
  });
  const payload = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !payload.success) {
    throw new CommerceApiError(
      payload.success ? `请求失败（HTTP ${response.status}）。` : payload.message,
      payload.success ? 'HTTP_ERROR' : payload.error,
      response.status,
      payload.success ? null : payload.conversationId ?? null,
    );
  }
  return payload;
}

export async function waitForAgentJob(
  initial: AgentJob,
  onStatus: (status: AgentJob['status']) => void,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    onConnectionChange?: (state: 'connected' | 'reconnecting') => void;
  } = {},
): Promise<RunResult> {
  if (initial.status === 'completed' && initial.result) return initial.result;
  if (isTerminalAgentJob(initial)) {
    throw new CommerceJobWaitError(
      'terminal',
      initial,
      initial.error?.message || 'Agent 异步任务失败。',
    );
  }
  onStatus(initial.status);
  return new Promise<RunResult>((resolve, reject) => {
    let latest = initial;
    let settled = false;
    let refreshing = false;
    const source = new EventSource(`/api/commerce/jobs/${encodeURIComponent(initial.id)}/events`);
    const timeout = globalThis.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CommerceJobWaitError(
        'timeout',
        latest,
        '前台等待已超时，但任务仍在后台运行。请选择继续等待，避免重复创建任务。',
      ));
    }, options.timeoutMs ?? 180_000);
    const poll = globalThis.setInterval(() => void refresh(), 15_000);
    const abort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new CommerceJobWaitError(
        'aborted',
        latest,
        '已停止在当前页面等待；后台任务不会因此取消。',
      ));
    };
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      globalThis.clearInterval(poll);
      source.close();
      options.signal?.removeEventListener('abort', abort);
    };
    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: CommerceJobWaitError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    async function refresh() {
      if (settled || refreshing) return;
      refreshing = true;
      try {
        const response = await api<{ job: AgentJob }>(
          `/api/commerce/jobs/${encodeURIComponent(initial.id)}`,
        );
        latest = response.job;
        onStatus(latest.status);
        options.onConnectionChange?.('connected');
        if (latest.status === 'completed' && latest.result) {
          finish(latest.result);
        } else if (isTerminalAgentJob(latest)) {
          fail(new CommerceJobWaitError(
            'terminal',
            latest,
            latest.error?.message || 'Agent 异步任务失败。',
          ));
        }
      } catch (error) {
        if (
          error instanceof CommerceApiError
          && [401, 403, 404].includes(error.status)
        ) {
          fail(new CommerceJobWaitError(
            'network',
            latest,
            error.message,
            { cause: error },
          ));
        } else {
          // EventSource reconnects automatically. A transient fetch/SSE failure must not turn a
          // durable running Job into a client-side terminal failure.
          options.onConnectionChange?.('reconnecting');
        }
      } finally {
        refreshing = false;
      }
    }
    source.onopen = () => options.onConnectionChange?.('connected');
    source.onerror = () => {
      options.onConnectionChange?.('reconnecting');
      void refresh();
    };
    source.addEventListener('queued', () => onStatus('queued'));
    source.addEventListener('requeued', () => onStatus('queued'));
    source.addEventListener('running', () => onStatus('running'));
    source.addEventListener('completed', () => void refresh());
    source.addEventListener('failed', () => void refresh());
    source.addEventListener('dead_lettered', () => void refresh());
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}

export function shortTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export function operationLabel(operation: string) {
  const labels: Record<string, string> = {
    'commerce.describe_data': '数据目录',
    'commerce.inspect_data_health': '数据健康门禁',
    'commerce.scan_weekly_kpis': '完整周 KPI 扫描',
    'commerce.diagnostic_decision': '调查路径决策',
    'commerce.lookup_entities': '实体检索',
    'commerce.compare_metrics': '指标对比',
    'commerce.breakdown_metric': '维度拆解',
    'commerce.trend_metric': '趋势查询',
    'commerce.inventory_risk': '库存风险',
  };
  return labels[operation] ?? operation;
}

export function claimEvidenceIds(claims: { evidenceId: string }[]): string[] {
  return Array.from(new Set(claims.map((claim) => claim.evidenceId)));
}

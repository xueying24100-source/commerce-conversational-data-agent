import { createHash } from 'node:crypto';

import type {
  CommerceDateRange,
  CommerceDimension,
  CommerceMetric,
} from './types';

export const COMMERCE_DIAGNOSTIC_OBJECTIVE = 'diagnose_previous_complete_week' as const;

export const FLAGSHIP_DIAGNOSTIC_METRICS = [
  'gmv',
  'paid_orders',
  'visits',
  'conversion_rate',
  'average_order_value',
] as const satisfies readonly CommerceMetric[];

export const FLAGSHIP_DIAGNOSTIC_DIMENSIONS = [
  'channel',
  'region',
] as const satisfies readonly CommerceDimension[];

export const DIAGNOSTIC_LIMITS = Object.freeze({
  maxInvestigationDepth: 3,
  maxAnalysisCalls: 8,
  maxConsecutiveNoEvidenceRounds: 2,
  timeoutMs: 90_000,
});

export type CommerceDiagnosticPhase =
  | 'preflight'
  | 'baseline'
  | 'scan'
  | 'investigate'
  | 'contradiction_check'
  | 'synthesize'
  | 'stop';

export type CommerceDiagnosticStopReason =
  | 'data_health_failed'
  | 'scope_unavailable'
  | 'no_material_anomaly'
  | 'evidence_sufficient'
  | 'budget_exhausted'
  | 'no_new_evidence'
  | 'timeout'
  | 'no_legal_candidate'
  | 'unknown';

export type CommerceDiagnosticHypothesisId =
  | 'growth_driver'
  | 'traffic_drop'
  | 'conversion_drop'
  | 'aov_or_mix'
  | 'refund_spike'
  | 'stockout';

export type CommerceInsightLevel =
  | 'observed'
  | 'contribution'
  | 'driver'
  | 'hypothesis'
  | 'unknown';

export interface CommerceDataHealthPartition {
  date: string;
  state: 'ready' | 'missing' | 'incomplete' | 'failed';
  factRowCount: number | null;
  sourceWatermark: string | null;
}

export interface CommerceDataHealthInput {
  range: CommerceDateRange;
  availableMetrics: readonly CommerceMetric[];
  availableDimensions: readonly CommerceDimension[];
  dimensionCoverage: Partial<Record<CommerceDimension, number>>;
  partitions: readonly CommerceDataHealthPartition[];
  dataMode: 'snapshot' | 'incremental';
  sourceWatermark: string | null;
  connectorStatus: 'ready' | 'degraded' | 'failed' | 'unknown';
  sourceAuditPassed: boolean;
  reconciliationConflict: boolean;
  now?: Date;
  requiredMetrics?: readonly CommerceMetric[];
  requiredDimensions?: readonly CommerceDimension[];
  requireProductDimension?: boolean;
  optionalMetrics?: readonly CommerceMetric[];
  minimumDimensionCoverage?: number;
}

export interface CommerceDataHealthReport {
  status: 'ready' | 'degraded' | 'blocked';
  analysisAllowed: boolean;
  actionAllowed: boolean;
  range: CommerceDateRange;
  requiredMetrics: CommerceMetric[];
  missingRequiredMetrics: CommerceMetric[];
  degradedOptionalMetrics: CommerceMetric[];
  requiredDimensions: CommerceDimension[];
  missingRequiredDimensions: CommerceDimension[];
  dimensionCoverage: Partial<Record<CommerceDimension, number>>;
  partitions: CommerceDataHealthPartition[];
  dataMode: 'snapshot' | 'incremental';
  sourceWatermark: string | null;
  connectorStatus: CommerceDataHealthInput['connectorStatus'];
  sourceReliability: 'high' | 'low';
  reasons: Array<
    | 'required_metric_missing'
    | 'required_dimension_missing'
    | 'dimension_coverage_below_threshold'
    | 'partition_missing_or_incomplete'
    | 'source_watermark_missing'
    | 'source_watermark_stale'
    | 'source_watermark_in_future'
    | 'connector_not_ready'
    | 'source_audit_failed'
    | 'reconciliation_conflict'
    | 'optional_capability_degraded'
  >;
}

export interface CommerceBaselineDecision {
  strategy:
    | 'explicit'
    | 'previous_four_complete_weeks_median'
    | 'available_complete_weeks_median'
    | 'previous_adjacent_period';
  current: CommerceDateRange;
  comparisonRanges: CommerceDateRange[];
  rationale: string;
  confidence: 'high' | 'medium' | 'low';
}

export interface CommerceMetricSignal {
  metric: CommerceMetric;
  current: number | null;
  baselineMedian: number | null;
  baselineMinimum: number | null;
  baselineMaximum: number | null;
  mad: number | null;
  robustZScore: number | null;
  absoluteChange: number | null;
  relativeChange: number | null;
  anomalous: boolean;
  material: boolean;
  direction: 'up' | 'down' | 'flat' | 'unknown';
}

export interface CommerceSegmentMetricSignal extends CommerceMetricSignal {
  dimension: CommerceDimension;
  value: string;
}

export interface CommerceKpiScan {
  currentRange: CommerceDateRange;
  baseline: CommerceBaselineDecision;
  current: Partial<Record<CommerceMetric, number | null>>;
  baselineWeeks: Array<{
    range: CommerceDateRange;
    values: Partial<Record<CommerceMetric, number | null>>;
  }>;
  signals: CommerceMetricSignal[];
  /**
   * Bounded robust segment screening performed inside the same read-only scan. It keeps
   * a locally severe channel/category regression from being hidden by offsetting growth
   * elsewhere, while the Controller still requires a second-grain investigation before
   * promoting it to a driver.
   */
  segmentSignals?: CommerceSegmentMetricSignal[];
  /**
   * Complete business dates whose additive flagship activity is exactly zero. These dates
   * are retained as auditable calendar context and must not be promoted to a segment driver
   * without an independent event or outage signal.
   */
  zeroActivityDates?: string[];
}

export interface CommerceContributionResult {
  identity: 'gmv' | 'paid_orders';
  totalChange: number;
  components: Array<{
    metric: CommerceMetric;
    contribution: number;
    share: number | null;
  }>;
  residual: number;
  residualRatio: number;
  reconciled: boolean;
}

export interface CommerceDiagnosticHypothesis {
  id: CommerceDiagnosticHypothesisId;
  score: number;
  impact: number;
  anomalyStrength: number;
  reliability: number;
  status: 'candidate' | 'supporting' | 'contradicted' | 'missing' | 'confirmed';
  triggerMetrics: CommerceMetric[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  missingEvidence: string[];
}

export interface CommerceDiagnosticCandidate {
  hypothesis: CommerceDiagnosticHypothesisId;
  view: 'breakdown' | 'trend' | 'inventory';
  metric: CommerceMetric;
  dimension: CommerceDimension | null;
  expectedInformationGain: number;
  requestHash: string;
}

export interface CommerceDiagnosticDecisionEvent {
  sequence: number;
  phase: CommerceDiagnosticPhase;
  hypothesis: CommerceDiagnosticHypothesisId | null;
  triggerEvidenceIds: string[];
  candidates: CommerceDiagnosticCandidate[];
  excludedCandidates: Array<{
    hypothesis: CommerceDiagnosticHypothesisId;
    reason: string;
  }>;
  chosenNextView: CommerceDiagnosticCandidate | null;
  decisionCode:
    | 'preflight_blocked'
    | 'scan_required'
    | 'investigate_highest_information_gain'
    | 'replan_after_contradiction'
    | 'replan_after_unavailable_view'
    | 'stop_no_anomaly'
    | 'stop_evidence_sufficient'
    | 'stop_budget'
    | 'stop_no_new_evidence'
    | 'stop_no_legal_candidate';
  stopReason: CommerceDiagnosticStopReason | null;
  evaluation?: {
    hypothesis: CommerceDiagnosticHypothesisId;
    insightLevel: CommerceInsightLevel;
    gatePassed: boolean;
    reasons: string[];
    contributionMetric: CommerceMetric | null;
    contributionShare: number | null;
    primaryRelativeChange: number | null;
    contributionResidualRatio: number | null;
    aggregateEvidenceId: string;
    investigationEvidenceId: string;
    structureChangeDetected: boolean;
  } | null;
  createdAt: string;
}

export interface CommerceDiagnosticFinding {
  observation: string;
  interpretation: string;
  confidence: number;
  insightLevel: CommerceInsightLevel;
  alternatives: string[];
  evidenceIds: string[];
  contradictionStatus: 'clear' | 'unresolved' | 'contradicted';
}

export interface CommerceDiagnosticState {
  version: 1;
  objective: typeof COMMERCE_DIAGNOSTIC_OBJECTIVE;
  phase: CommerceDiagnosticPhase;
  dataHealth: CommerceDataHealthReport | null;
  baseline: CommerceBaselineDecision | null;
  signals: CommerceMetricSignal[];
  hypotheses: CommerceDiagnosticHypothesis[];
  findings: CommerceDiagnosticFinding[];
  budget: {
    analysisCalls: number;
    investigationDepth: number;
    consecutiveNoEvidenceRounds: number;
    startedAt: string;
    deadlineAt: string;
  };
  decisions: CommerceDiagnosticDecisionEvent[];
  completedRequestHashes: string[];
  stopReason: CommerceDiagnosticStopReason | null;
}

function dateAtUtc(value: string): Date {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid ISO business date: ${value}`);
  }
  return parsed;
}

export function addCommerceBusinessDays(value: string, days: number): string {
  const date = dateAtUtc(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function commerceDateRangeDays(range: CommerceDateRange): number {
  return Math.floor((dateAtUtc(range.end).getTime() - dateAtUtc(range.start).getTime()) / 86_400_000) + 1;
}

export function previousCompleteCommerceWeek(referenceDate: string): CommerceDateRange {
  const date = dateAtUtc(referenceDate);
  const normalizedDay = date.getUTCDay() || 7;
  const currentWeekStart = addCommerceBusinessDays(referenceDate, -(normalizedDay - 1));
  const end = addCommerceBusinessDays(currentWeekStart, -1);
  return { start: addCommerceBusinessDays(end, -6), end };
}

export function previousComparableRanges(
  current: CommerceDateRange,
  count = 4,
): CommerceDateRange[] {
  if (!Number.isInteger(count) || count < 1 || count > 52) {
    throw new Error('Comparable range count must be an integer from 1 to 52.');
  }
  const length = commerceDateRangeDays(current);
  return Array.from({ length: count }, (_, index) => {
    const end = addCommerceBusinessDays(current.start, -(index * length + 1));
    return {
      start: addCommerceBusinessDays(end, -(length - 1)),
      end,
    };
  });
}

export function selectCommerceBaseline(input: {
  current: CommerceDateRange;
  explicit?: CommerceDateRange | null;
  availableRanges?: readonly CommerceDateRange[];
}): CommerceBaselineDecision {
  if (input.explicit) {
    return {
      strategy: 'explicit',
      current: input.current,
      comparisonRanges: [input.explicit],
      rationale: '使用用户显式指定的对比区间。',
      confidence: 'high',
    };
  }
  const candidates = previousComparableRanges(input.current, 4);
  const available = input.availableRanges
    ? candidates.filter((candidate) => input.availableRanges!.some((range) => (
        candidate.start >= range.start && candidate.end <= range.end
      )))
    : candidates;
  if (available.length === 4) {
    return {
      strategy: 'previous_four_complete_weeks_median',
      current: input.current,
      comparisonRanges: available,
      rationale: '默认使用此前四个同长度完整周的中位数与范围，降低单周峰值的影响。',
      confidence: 'high',
    };
  }
  if (available.length >= 2) {
    return {
      strategy: 'available_complete_weeks_median',
      current: input.current,
      comparisonRanges: available,
      rationale: `历史覆盖不足四周，使用可用的 ${available.length} 个完整周中位数并降低置信度。`,
      confidence: 'medium',
    };
  }
  const fallback = available[0] ?? candidates[0]!;
  return {
    strategy: 'previous_adjacent_period',
    current: input.current,
    comparisonRanges: [fallback],
    rationale: '历史样本不足，降级为相邻同长度周期比较。',
    confidence: 'low',
  };
}

export function median(values: readonly number[]): number | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!finite.length) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2
    ? finite[middle]!
    : (finite[middle - 1]! + finite[middle]!) / 2;
}

export function medianAbsoluteDeviation(values: readonly number[]): number | null {
  const center = median(values);
  if (center === null) return null;
  return median(values.filter(Number.isFinite).map((value) => Math.abs(value - center)));
}

export function robustCommerceMetricSignal(input: {
  metric: CommerceMetric;
  current: number | null;
  history: readonly (number | null)[];
  minimumRelativeChange?: number;
  minimumAbsoluteImpact?: number;
  robustZThreshold?: number;
}): CommerceMetricSignal {
  const history = input.history.filter((value): value is number => value !== null && Number.isFinite(value));
  const center = median(history);
  const mad = medianAbsoluteDeviation(history);
  if (input.current === null || !Number.isFinite(input.current) || center === null) {
    return {
      metric: input.metric,
      current: input.current,
      baselineMedian: center,
      baselineMinimum: history.length ? Math.min(...history) : null,
      baselineMaximum: history.length ? Math.max(...history) : null,
      mad,
      robustZScore: null,
      absoluteChange: null,
      relativeChange: null,
      anomalous: false,
      material: false,
      direction: 'unknown',
    };
  }
  const absoluteChange = input.current - center;
  const relativeChange = center === 0
    ? (absoluteChange === 0 ? 0 : null)
    : absoluteChange / Math.abs(center);
  const robustZScore = mad && mad > Number.EPSILON
    ? 0.674_489_75 * absoluteChange / mad
    : absoluteChange === 0
      ? 0
      : absoluteChange > 0
        ? Number.POSITIVE_INFINITY
        : Number.NEGATIVE_INFINITY;
  const minimumRelativeChange = input.minimumRelativeChange ?? 0.1;
  const minimumAbsoluteImpact = input.minimumAbsoluteImpact ?? 0;
  const material = Math.abs(absoluteChange) >= minimumAbsoluteImpact
    && (relativeChange === null || Math.abs(relativeChange) >= minimumRelativeChange);
  const outsideObservedRange = input.current < Math.min(...history) || input.current > Math.max(...history);
  const statisticallyUnusual = Math.abs(robustZScore) >= (input.robustZThreshold ?? 3.5);
  return {
    metric: input.metric,
    current: input.current,
    baselineMedian: center,
    baselineMinimum: Math.min(...history),
    baselineMaximum: Math.max(...history),
    mad,
    robustZScore,
    absoluteChange,
    relativeChange,
    anomalous: material && outsideObservedRange && statisticallyUnusual,
    material,
    direction: Math.abs(absoluteChange) <= Number.EPSILON ? 'flat' : absoluteChange > 0 ? 'up' : 'down',
  };
}

export function scanCommerceKpis(input: {
  currentRange: CommerceDateRange;
  current: Partial<Record<CommerceMetric, number | null>>;
  baselineWeeks: Array<{
    range: CommerceDateRange;
    values: Partial<Record<CommerceMetric, number | null>>;
  }>;
  baselineDecision?: CommerceBaselineDecision;
  metrics?: readonly CommerceMetric[];
  minimumRelativeChange?: number;
  minimumAbsoluteImpact?: Partial<Record<CommerceMetric, number>>;
}): CommerceKpiScan {
  const metrics = input.metrics ?? FLAGSHIP_DIAGNOSTIC_METRICS;
  const baseline: CommerceBaselineDecision = input.baselineDecision ?? {
    strategy: input.baselineWeeks.length >= 4
      ? 'previous_four_complete_weeks_median'
      : input.baselineWeeks.length >= 2
        ? 'available_complete_weeks_median'
        : 'previous_adjacent_period',
    current: input.currentRange,
    comparisonRanges: input.baselineWeeks.map((week) => week.range),
    rationale: input.baselineWeeks.length >= 4
      ? '使用此前四个完整周的中位数和观测范围。'
      : '历史覆盖不足四个完整周，使用可用完整周并降低置信度。',
    confidence: input.baselineWeeks.length >= 4 ? 'high' : input.baselineWeeks.length >= 2 ? 'medium' : 'low',
  };
  return {
    currentRange: input.currentRange,
    baseline,
    current: { ...input.current },
    baselineWeeks: structuredClone(input.baselineWeeks),
    signals: metrics.map((metric) => robustCommerceMetricSignal({
      metric,
      current: input.current[metric] ?? null,
      history: input.baselineWeeks.map((week) => week.values[metric] ?? null),
      minimumRelativeChange: input.minimumRelativeChange,
      minimumAbsoluteImpact: input.minimumAbsoluteImpact?.[metric],
    })),
  };
}

function reconciledContribution(input: {
  identity: CommerceContributionResult['identity'];
  currentTotal: number;
  baselineTotal: number;
  firstMetric: CommerceMetric;
  currentFirst: number;
  baselineFirst: number;
  secondMetric: CommerceMetric;
  currentSecond: number;
  baselineSecond: number;
  toleranceRatio: number;
}): CommerceContributionResult {
  const totalChange = input.currentTotal - input.baselineTotal;
  // Symmetric two-factor decomposition allocates the interaction term equally and
  // reconciles exactly for y = a * b without depending on factor order.
  const first = (input.currentFirst - input.baselineFirst)
    * (input.currentSecond + input.baselineSecond) / 2;
  const second = (input.currentSecond - input.baselineSecond)
    * (input.currentFirst + input.baselineFirst) / 2;
  const residual = totalChange - first - second;
  const denominator = Math.max(Math.abs(totalChange), Number.EPSILON);
  const residualRatio = Math.abs(residual) / denominator;
  return {
    identity: input.identity,
    totalChange,
    components: [
      {
        metric: input.firstMetric,
        contribution: first,
        share: Math.abs(totalChange) <= Number.EPSILON ? null : first / totalChange,
      },
      {
        metric: input.secondMetric,
        contribution: second,
        share: Math.abs(totalChange) <= Number.EPSILON ? null : second / totalChange,
      },
    ],
    residual,
    residualRatio,
    reconciled: residualRatio <= input.toleranceRatio,
  };
}

export function decomposeGmvChange(input: {
  currentGmv: number;
  baselineGmv: number;
  currentPaidOrders: number;
  baselinePaidOrders: number;
  currentAov: number;
  baselineAov: number;
  toleranceRatio?: number;
}): CommerceContributionResult {
  return reconciledContribution({
    identity: 'gmv',
    currentTotal: input.currentGmv,
    baselineTotal: input.baselineGmv,
    firstMetric: 'paid_orders',
    currentFirst: input.currentPaidOrders,
    baselineFirst: input.baselinePaidOrders,
    secondMetric: 'average_order_value',
    currentSecond: input.currentAov,
    baselineSecond: input.baselineAov,
    toleranceRatio: input.toleranceRatio ?? 0.001,
  });
}

export function decomposePaidOrdersChange(input: {
  currentPaidOrders: number;
  baselinePaidOrders: number;
  currentVisits: number;
  baselineVisits: number;
  currentConversionRate: number;
  baselineConversionRate: number;
  toleranceRatio?: number;
}): CommerceContributionResult {
  return reconciledContribution({
    identity: 'paid_orders',
    currentTotal: input.currentPaidOrders,
    baselineTotal: input.baselinePaidOrders,
    firstMetric: 'visits',
    currentFirst: input.currentVisits,
    baselineFirst: input.baselineVisits,
    secondMetric: 'conversion_rate',
    currentSecond: input.currentConversionRate,
    baselineSecond: input.baselineConversionRate,
    toleranceRatio: input.toleranceRatio ?? 0.001,
  });
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function allDates(range: CommerceDateRange): string[] {
  const output: string[] = [];
  for (let cursor = range.start; cursor <= range.end; cursor = addCommerceBusinessDays(cursor, 1)) {
    output.push(cursor);
  }
  return output;
}

export function evaluateCommerceDataHealth(input: CommerceDataHealthInput): CommerceDataHealthReport {
  const requiredMetrics = [...(input.requiredMetrics ?? FLAGSHIP_DIAGNOSTIC_METRICS)];
  const optionalMetrics = [...(input.optionalMetrics ?? [])];
  const availableMetrics = new Set(input.availableMetrics);
  const availableDimensions = new Set(input.availableDimensions);
  const minimumCoverage = input.minimumDimensionCoverage ?? 0.95;
  const missingRequiredMetrics = requiredMetrics.filter((metric) => !availableMetrics.has(metric));
  const degradedOptionalMetrics = optionalMetrics.filter((metric) => !availableMetrics.has(metric));
  const requiredDimensions: CommerceDimension[] = [
    ...(input.requiredDimensions ?? FLAGSHIP_DIAGNOSTIC_DIMENSIONS),
  ];
  const requireProductDimension = input.requireProductDimension ?? input.requiredDimensions === undefined;
  const productDimensionAvailable = !requireProductDimension
    || (availableDimensions.has('sku') && (input.dimensionCoverage.sku ?? 0) >= minimumCoverage)
    || (availableDimensions.has('category') && (input.dimensionCoverage.category ?? 0) >= minimumCoverage);
  const missingRequiredDimensions = requiredDimensions.filter((dimension) => (
    !availableDimensions.has(dimension) || (input.dimensionCoverage[dimension] ?? 0) < minimumCoverage
  ));
  if (!productDimensionAvailable) missingRequiredDimensions.push('sku', 'category');

  const partitionByDate = new Map(input.partitions.map((partition) => [partition.date, partition]));
  const incompleteDates = allDates(input.range).filter((date) => partitionByDate.get(date)?.state !== 'ready');
  const reasons: CommerceDataHealthReport['reasons'] = [];
  if (missingRequiredMetrics.length) reasons.push('required_metric_missing');
  if (missingRequiredDimensions.length) {
    reasons.push('required_dimension_missing');
    if (missingRequiredDimensions.some((dimension) => (
      availableDimensions.has(dimension) && (input.dimensionCoverage[dimension] ?? 0) < minimumCoverage
    ))) reasons.push('dimension_coverage_below_threshold');
  }
  if (incompleteDates.length) reasons.push('partition_missing_or_incomplete');
  if (!input.sourceWatermark) reasons.push('source_watermark_missing');
  if (input.connectorStatus !== 'ready') reasons.push('connector_not_ready');
  if (!input.sourceAuditPassed) reasons.push('source_audit_failed');
  if (input.reconciliationConflict) reasons.push('reconciliation_conflict');
  if (degradedOptionalMetrics.length) reasons.push('optional_capability_degraded');

  if (input.dataMode === 'incremental' && input.sourceWatermark) {
    const watermark = Date.parse(input.sourceWatermark);
    const now = (input.now ?? new Date()).getTime();
    if (!Number.isFinite(watermark)) {
      reasons.push('source_watermark_missing');
    } else {
      if (watermark > now + 5 * 60_000) reasons.push('source_watermark_in_future');
      if (input.sourceWatermark.slice(0, 10) < input.range.end) reasons.push('source_watermark_stale');
    }
  }

  const blockingReasons = reasons.filter((reason) => reason !== 'optional_capability_degraded');
  const status: CommerceDataHealthReport['status'] = blockingReasons.length
    ? 'blocked'
    : degradedOptionalMetrics.length
      ? 'degraded'
      : 'ready';
  const analysisAllowed = status !== 'blocked';
  return {
    status,
    analysisAllowed,
    actionAllowed: analysisAllowed,
    range: { ...input.range },
    requiredMetrics,
    missingRequiredMetrics,
    degradedOptionalMetrics,
    requiredDimensions,
    missingRequiredDimensions: unique(missingRequiredDimensions),
    dimensionCoverage: { ...input.dimensionCoverage },
    partitions: input.partitions.map((partition) => ({ ...partition })),
    dataMode: input.dataMode,
    sourceWatermark: input.sourceWatermark,
    connectorStatus: input.connectorStatus,
    sourceReliability: !blockingReasons.length ? 'high' : 'low',
    reasons: unique(reasons),
  };
}

function signalStrength(signal: CommerceMetricSignal): number {
  if (!signal.anomalous) return 0;
  const relative = signal.relativeChange === null ? 1 : Math.min(2, Math.abs(signal.relativeChange));
  const robust = signal.robustZScore === null || !Number.isFinite(signal.robustZScore)
    ? 1
    : Math.min(2, Math.abs(signal.robustZScore) / 3.5);
  return relative * robust;
}

export function rankCommerceDiagnosticHypotheses(input: {
  signals: readonly CommerceMetricSignal[];
  segmentSignals?: readonly CommerceSegmentMetricSignal[];
  availableMetrics: readonly CommerceMetric[];
  sourceReliability: 'high' | 'low';
}): CommerceDiagnosticHypothesis[] {
  const signal = new Map(input.signals.map((entry) => [entry.metric, entry]));
  const reliability = input.sourceReliability === 'high' ? 1 : 0.35;
  const definitions: Array<{
    id: CommerceDiagnosticHypothesisId;
    metrics: CommerceMetric[];
    accepts: (entry: CommerceMetricSignal) => boolean;
  }> = [
    {
      id: 'growth_driver',
      metrics: ['gmv', 'paid_orders', 'visits', 'conversion_rate', 'average_order_value'],
      accepts: (entry) => entry.direction === 'up',
    },
    { id: 'traffic_drop', metrics: ['visits'], accepts: (entry) => entry.direction === 'down' },
    { id: 'conversion_drop', metrics: ['conversion_rate'], accepts: (entry) => entry.direction === 'down' },
    { id: 'aov_or_mix', metrics: ['average_order_value'], accepts: (entry) => entry.direction === 'down' },
    { id: 'refund_spike', metrics: ['refund_rate', 'refund_amount'], accepts: (entry) => entry.direction === 'up' },
    { id: 'stockout', metrics: ['stockout_hours'], accepts: (entry) => entry.direction === 'up' },
  ];
  const available = new Set(input.availableMetrics);
  return definitions.map((definition) => {
    const entries = definition.metrics.map((metric) => signal.get(metric)).filter(
      (entry): entry is CommerceMetricSignal => Boolean(entry),
    );
    const supporting = entries.filter((entry) => entry.anomalous && definition.accepts(entry));
    const segmentSupporting = (input.segmentSignals ?? []).filter((entry) => (
      definition.metrics.includes(entry.metric)
      && entry.anomalous
      && definition.accepts(entry)
    ));
    const allSupporting = [...supporting, ...segmentSupporting];
    const anomalyStrength = allSupporting.reduce((sum, entry) => sum + signalStrength(entry), 0);
    const missing = definition.metrics.filter((metric) => !available.has(metric));
    const impact = supporting.reduce((sum, entry) => sum + Math.abs(entry.absoluteChange ?? 0), 0);
    const score = anomalyStrength * reliability;
    return {
      id: definition.id,
      score,
      impact,
      anomalyStrength,
      reliability,
      status: missing.length === definition.metrics.length
        ? 'missing' as const
        : allSupporting.length
          ? 'supporting' as const
          : 'candidate' as const,
      triggerMetrics: unique(allSupporting.map((entry) => entry.metric)),
      supportingEvidenceIds: [],
      contradictingEvidenceIds: [],
      missingEvidence: missing.map((metric) => `metric:${metric}`),
    };
  }).sort((left, right) => right.score - left.score || right.impact - left.impact || left.id.localeCompare(right.id));
}

function requestHash(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function candidate(
  hypothesis: CommerceDiagnosticHypothesisId,
  view: CommerceDiagnosticCandidate['view'],
  metric: CommerceMetric,
  dimension: CommerceDimension | null,
  expectedInformationGain: number,
): CommerceDiagnosticCandidate {
  return {
    hypothesis,
    view,
    metric,
    dimension,
    expectedInformationGain,
    requestHash: requestHash({ hypothesis, view, metric, dimension }),
  };
}

function hypothesisCandidates(
  hypothesis: CommerceDiagnosticHypothesis,
  dimensions: ReadonlySet<CommerceDimension>,
): CommerceDiagnosticCandidate[] {
  const definitions: Record<CommerceDiagnosticHypothesisId, CommerceDiagnosticCandidate[]> = {
    growth_driver: [
      candidate('growth_driver', 'breakdown', 'gmv', 'channel', 1),
      candidate('growth_driver', 'breakdown', 'paid_orders', 'channel', 0.92),
      candidate('growth_driver', 'breakdown', 'visits', 'channel', 0.86),
      candidate('growth_driver', 'breakdown', 'gmv', 'category', 0.82),
      candidate('growth_driver', 'breakdown', 'gmv', 'region', 0.76),
      candidate('growth_driver', 'trend', 'gmv', null, 0.7),
    ],
    traffic_drop: [
      candidate('traffic_drop', 'breakdown', 'visits', 'channel', 1),
      candidate('traffic_drop', 'trend', 'visits', null, 0.82),
      candidate('traffic_drop', 'breakdown', 'visits', 'region', 0.72),
    ],
    conversion_drop: [
      candidate('conversion_drop', 'breakdown', 'conversion_rate', 'channel', 1),
      candidate('conversion_drop', 'breakdown', 'conversion_rate', 'category', 0.86),
      candidate('conversion_drop', 'trend', 'conversion_rate', null, 0.8),
      candidate('conversion_drop', 'breakdown', 'conversion_rate', 'region', 0.72),
    ],
    aov_or_mix: [
      candidate('aov_or_mix', 'breakdown', 'average_order_value', 'category', 1),
      candidate('aov_or_mix', 'breakdown', 'gmv', 'sku', 0.9),
      candidate('aov_or_mix', 'trend', 'average_order_value', null, 0.78),
    ],
    refund_spike: [
      candidate('refund_spike', 'breakdown', 'refund_rate', 'category', 1),
      candidate('refund_spike', 'breakdown', 'refund_amount', 'channel', 0.82),
      candidate('refund_spike', 'trend', 'refund_rate', null, 0.75),
    ],
    stockout: [
      candidate('stockout', 'inventory', 'stockout_hours', 'sku', 1),
      candidate('stockout', 'breakdown', 'stockout_hours', 'category', 0.8),
      candidate('stockout', 'trend', 'stockout_hours', null, 0.7),
    ],
  };
  return definitions[hypothesis.id]
    .filter((entry) => !entry.dimension || dimensions.has(entry.dimension))
    .map((entry) => ({
      ...entry,
      expectedInformationGain: entry.expectedInformationGain * Math.max(0.1, hypothesis.score),
    }));
}

export function createCommerceDiagnosticState(input: {
  now?: Date;
  timeoutMs?: number;
} = {}): CommerceDiagnosticState {
  const now = input.now ?? new Date();
  return {
    version: 1,
    objective: COMMERCE_DIAGNOSTIC_OBJECTIVE,
    phase: 'preflight',
    dataHealth: null,
    baseline: null,
    signals: [],
    hypotheses: [],
    findings: [],
    budget: {
      analysisCalls: 0,
      investigationDepth: 0,
      consecutiveNoEvidenceRounds: 0,
      startedAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + (input.timeoutMs ?? DIAGNOSTIC_LIMITS.timeoutMs)).toISOString(),
    },
    decisions: [],
    completedRequestHashes: [],
    stopReason: null,
  };
}

export function nextCommerceDiagnosticDecision(input: {
  state: CommerceDiagnosticState;
  availableDimensions: readonly CommerceDimension[];
  now?: Date;
}): CommerceDiagnosticDecisionEvent {
  const state = input.state;
  const now = input.now ?? new Date();
  const base = {
    sequence: state.decisions.length + 1,
    phase: state.phase,
    triggerEvidenceIds: unique(state.hypotheses.flatMap((entry) => entry.supportingEvidenceIds)),
    excludedCandidates: [] as CommerceDiagnosticDecisionEvent['excludedCandidates'],
    createdAt: now.toISOString(),
  };
  if (!state.dataHealth?.analysisAllowed) {
    return {
      ...base,
      hypothesis: null,
      candidates: [],
      chosenNextView: null,
      decisionCode: 'preflight_blocked',
      stopReason: 'data_health_failed',
    };
  }
  if (!state.signals.length) {
    return {
      ...base,
      hypothesis: null,
      candidates: [],
      chosenNextView: null,
      decisionCode: 'scan_required',
      stopReason: null,
    };
  }
  if (
    !state.signals.some((signal) => signal.anomalous)
    && !state.hypotheses.some((hypothesis) => (
      hypothesis.status === 'supporting' || hypothesis.status === 'confirmed'
    ))
  ) {
    return {
      ...base,
      hypothesis: null,
      candidates: [],
      chosenNextView: null,
      decisionCode: 'stop_no_anomaly',
      stopReason: 'no_material_anomaly',
    };
  }
  const confirmed = state.hypotheses.find((entry) => entry.status === 'confirmed');
  if (confirmed) {
    return {
      ...base,
      hypothesis: confirmed.id,
      candidates: [],
      chosenNextView: null,
      decisionCode: 'stop_evidence_sufficient',
      stopReason: 'evidence_sufficient',
    };
  }
  if (
    now.getTime() >= Date.parse(state.budget.deadlineAt)
    || state.budget.analysisCalls >= DIAGNOSTIC_LIMITS.maxAnalysisCalls
    || state.budget.investigationDepth >= DIAGNOSTIC_LIMITS.maxInvestigationDepth
  ) {
    return {
      ...base,
      hypothesis: state.hypotheses[0]?.id ?? null,
      candidates: [],
      chosenNextView: null,
      decisionCode: 'stop_budget',
      stopReason: now.getTime() >= Date.parse(state.budget.deadlineAt) ? 'timeout' : 'budget_exhausted',
    };
  }
  if (state.budget.consecutiveNoEvidenceRounds >= DIAGNOSTIC_LIMITS.maxConsecutiveNoEvidenceRounds) {
    return {
      ...base,
      hypothesis: state.hypotheses[0]?.id ?? null,
      candidates: [],
      chosenNextView: null,
      decisionCode: 'stop_no_new_evidence',
      stopReason: 'no_new_evidence',
    };
  }

  const completed = new Set(state.completedRequestHashes);
  const dimensions = new Set(input.availableDimensions);
  const eligibleHypotheses = state.hypotheses.filter((entry) => (
    entry.status !== 'missing' && entry.status !== 'contradicted' && entry.score > 0
  ));
  const candidates = eligibleHypotheses.flatMap((hypothesis) => (
    hypothesisCandidates(hypothesis, dimensions)
  )).filter((entry) => !completed.has(entry.requestHash))
    .sort((left, right) => right.expectedInformationGain - left.expectedInformationGain
      || left.requestHash.localeCompare(right.requestHash))
    .slice(0, 3);
  for (const hypothesis of state.hypotheses) {
    if (hypothesis.status === 'missing') {
      base.excludedCandidates.push({ hypothesis: hypothesis.id, reason: 'required_capability_missing' });
    } else if (hypothesis.status === 'contradicted') {
      base.excludedCandidates.push({ hypothesis: hypothesis.id, reason: 'contradicted_by_evidence' });
    } else if (hypothesis.score <= 0) {
      base.excludedCandidates.push({ hypothesis: hypothesis.id, reason: 'no_material_support' });
    }
  }
  const chosen = candidates[0] ?? null;
  if (!chosen) {
    const hasConfirmed = state.hypotheses.some((entry) => entry.status === 'confirmed');
    return {
      ...base,
      hypothesis: state.hypotheses[0]?.id ?? null,
      candidates,
      chosenNextView: null,
      decisionCode: hasConfirmed ? 'stop_evidence_sufficient' : 'stop_no_legal_candidate',
      stopReason: hasConfirmed ? 'evidence_sufficient' : 'no_legal_candidate',
    };
  }
  return {
    ...base,
    hypothesis: chosen.hypothesis,
    candidates,
    chosenNextView: chosen,
    decisionCode: state.hypotheses.some((entry) => entry.status === 'contradicted')
      ? 'replan_after_contradiction'
      : 'investigate_highest_information_gain',
    stopReason: null,
  };
}

export function detectCommerceStructureChange(input: {
  aggregateCurrentNumerator: number;
  aggregateCurrentDenominator: number;
  aggregateBaselineNumerator: number;
  aggregateBaselineDenominator: number;
  segments: readonly {
    currentNumerator: number;
    currentDenominator: number;
    baselineNumerator: number;
    baselineDenominator: number;
  }[];
  tolerance?: number;
}): { detected: boolean; aggregateDirection: 'up' | 'down' | 'flat'; segmentDirections: Array<'up' | 'down' | 'flat'> } {
  const tolerance = input.tolerance ?? 1e-9;
  const direction = (change: number): 'up' | 'down' | 'flat' => (
    Math.abs(change) <= tolerance ? 'flat' : change > 0 ? 'up' : 'down'
  );
  const current = input.aggregateCurrentDenominator === 0
    ? 0
    : input.aggregateCurrentNumerator / input.aggregateCurrentDenominator;
  const baseline = input.aggregateBaselineDenominator === 0
    ? 0
    : input.aggregateBaselineNumerator / input.aggregateBaselineDenominator;
  const aggregateDirection = direction(current - baseline);
  const segmentDirections = input.segments.map((segment) => direction(
    (segment.currentDenominator === 0 ? 0 : segment.currentNumerator / segment.currentDenominator)
    - (segment.baselineDenominator === 0 ? 0 : segment.baselineNumerator / segment.baselineDenominator),
  ));
  const nonFlat = segmentDirections.filter((entry) => entry !== 'flat');
  return {
    detected: aggregateDirection !== 'flat'
      && nonFlat.length > 0
      && nonFlat.every((entry) => entry !== aggregateDirection),
    aggregateDirection,
    segmentDirections,
  };
}

export function evaluateCommerceDriverGate(input: {
  contributionShare: number;
  primaryRelativeChange: number;
  aggregateEvidenceHash: string;
  segmentOrTrendEvidenceHash: string;
  contributionResidualRatio: number;
  unresolvedContradiction: boolean;
  sourceReliability: 'high' | 'low';
  materiality?: { contributionShare: number; relativeChange: number };
}): { level: CommerceInsightLevel; passed: boolean; reasons: string[] } {
  const materiality = input.materiality ?? { contributionShare: 0.3, relativeChange: 0.1 };
  const reasons: string[] = [];
  if (Math.abs(input.contributionShare) < materiality.contributionShare) reasons.push('contribution_below_materiality');
  if (Math.abs(input.primaryRelativeChange) < materiality.relativeChange) reasons.push('primary_change_below_materiality');
  if (!input.aggregateEvidenceHash || !input.segmentOrTrendEvidenceHash) reasons.push('two_grains_required');
  if (input.aggregateEvidenceHash === input.segmentOrTrendEvidenceHash) reasons.push('duplicate_evidence');
  if (input.contributionResidualRatio > 0.001) reasons.push('contribution_not_reconciled');
  if (input.unresolvedContradiction) reasons.push('unresolved_contradiction');
  if (input.sourceReliability !== 'high') reasons.push('source_reliability_not_high');
  return {
    level: reasons.length ? 'hypothesis' : 'driver',
    passed: reasons.length === 0,
    reasons,
  };
}

import { describe, expect, it } from 'vitest';

import {
  addCommerceBusinessDays,
  createCommerceDiagnosticState,
  decomposeGmvChange,
  decomposePaidOrdersChange,
  detectCommerceStructureChange,
  evaluateCommerceDataHealth,
  evaluateCommerceDriverGate,
  nextCommerceDiagnosticDecision,
  previousComparableRanges,
  previousCompleteCommerceWeek,
  rankCommerceDiagnosticHypotheses,
  robustCommerceMetricSignal,
  scanCommerceKpis,
  selectCommerceBaseline,
  type CommerceDataHealthPartition,
} from './diagnostics';
import type { CommerceDimension, CommerceMetric } from './types';

const current = { start: '2026-07-06', end: '2026-07-12' };
const completePartitions: CommerceDataHealthPartition[] = Array.from({ length: 7 }, (_, index) => ({
  date: addCommerceBusinessDays(current.start, index),
  state: 'ready',
  factRowCount: index === 3 ? 0 : 10,
  sourceWatermark: '2026-07-13T02:00:00.000Z',
}));

const flagshipMetrics = [
  'gmv',
  'paid_orders',
  'visits',
  'conversion_rate',
  'average_order_value',
] satisfies CommerceMetric[];

const flagshipDimensions = ['channel', 'region', 'sku', 'category'] satisfies CommerceDimension[];

function healthyData() {
  return evaluateCommerceDataHealth({
    range: current,
    availableMetrics: flagshipMetrics,
    availableDimensions: flagshipDimensions,
    dimensionCoverage: { channel: 1, region: 1, sku: 0.99, category: 0.99 },
    partitions: completePartitions,
    dataMode: 'snapshot',
    sourceWatermark: '2026-07-13T02:00:00.000Z',
    connectorStatus: 'ready',
    sourceAuditPassed: true,
    reconciliationConflict: false,
  });
}

describe('commerce weekly diagnostic contracts', () => {
  it('resolves the previous complete Monday-to-Sunday week across month and year boundaries', () => {
    expect(previousCompleteCommerceWeek('2026-01-01')).toEqual({
      start: '2025-12-22',
      end: '2025-12-28',
    });
    expect(previousCompleteCommerceWeek('2026-07-12')).toEqual({
      start: '2026-06-29',
      end: '2026-07-05',
    });
  });

  it('selects four previous comparable complete periods in newest-to-oldest order', () => {
    expect(previousComparableRanges(current)).toEqual([
      { start: '2026-06-29', end: '2026-07-05' },
      { start: '2026-06-22', end: '2026-06-28' },
      { start: '2026-06-15', end: '2026-06-21' },
      { start: '2026-06-08', end: '2026-06-14' },
    ]);
    expect(selectCommerceBaseline({ current }).strategy)
      .toBe('previous_four_complete_weeks_median');
  });

  it('honors an explicit baseline before the default robust policy', () => {
    const explicit = { start: '2025-07-07', end: '2025-07-13' };
    expect(selectCommerceBaseline({ current, explicit })).toMatchObject({
      strategy: 'explicit',
      comparisonRanges: [explicit],
      confidence: 'high',
    });
  });

  it('degrades baseline confidence deterministically when only part of history is complete', () => {
    expect(selectCommerceBaseline({
      current,
      availableRanges: [
        { start: '2026-06-22', end: '2026-07-05' },
      ],
    })).toMatchObject({
      strategy: 'available_complete_weeks_median',
      confidence: 'medium',
      comparisonRanges: [
        { start: '2026-06-29', end: '2026-07-05' },
        { start: '2026-06-22', end: '2026-06-28' },
      ],
    });
    expect(selectCommerceBaseline({
      current,
      availableRanges: [{ start: '2026-06-29', end: '2026-07-05' }],
    })).toMatchObject({
      strategy: 'previous_adjacent_period',
      confidence: 'low',
      comparisonRanges: [{ start: '2026-06-29', end: '2026-07-05' }],
    });
  });

  it('detects a material robust anomaly without treating ordinary variation as anomalous', () => {
    const drop = robustCommerceMetricSignal({
      metric: 'gmv',
      current: 70,
      history: [100, 102, 98, 101],
    });
    const normal = robustCommerceMetricSignal({
      metric: 'gmv',
      current: 99,
      history: [100, 102, 98, 101],
    });
    expect(drop).toMatchObject({ anomalous: true, material: true, direction: 'down' });
    expect(normal).toMatchObject({ anomalous: false, material: false });
  });

  it('builds a five-KPI scan against the median and observed range of four weeks', () => {
    const scan = scanCommerceKpis({
      currentRange: current,
      current: {
        gmv: 7_000,
        paid_orders: 70,
        visits: 1_000,
        conversion_rate: 0.07,
        average_order_value: 100,
      },
      baselineWeeks: previousComparableRanges(current).map((range, index) => ({
        range,
        values: {
          gmv: 10_000 + index * 100,
          paid_orders: 100 + index,
          visits: 1_000,
          conversion_rate: 0.1 + index * 0.001,
          average_order_value: 100,
        },
      })),
    });
    expect(scan.baseline.strategy).toBe('previous_four_complete_weeks_median');
    expect(scan.signals).toHaveLength(5);
    expect(scan.signals.find((signal) => signal.metric === 'conversion_rate')).toMatchObject({
      anomalous: true,
      direction: 'down',
    });
    expect(scan.signals.find((signal) => signal.metric === 'visits')?.anomalous).toBe(false);
  });

  it('reconciles both KPI identities within the 0.1% residual contract', () => {
    const gmv = decomposeGmvChange({
      currentGmv: 7_000,
      baselineGmv: 10_000,
      currentPaidOrders: 70,
      baselinePaidOrders: 100,
      currentAov: 100,
      baselineAov: 100,
    });
    const orders = decomposePaidOrdersChange({
      currentPaidOrders: 70,
      baselinePaidOrders: 100,
      currentVisits: 1_000,
      baselineVisits: 1_000,
      currentConversionRate: 0.07,
      baselineConversionRate: 0.1,
    });
    expect(gmv.reconciled).toBe(true);
    expect(gmv.residualRatio).toBeLessThanOrEqual(0.001);
    expect(gmv.components.find((entry) => entry.metric === 'paid_orders')?.contribution).toBe(-3_000);
    expect(orders.reconciled).toBe(true);
    expect(orders.residualRatio).toBeLessThanOrEqual(0.001);
  });
});

describe('commerce data health gate', () => {
  it('allows a ready zero-fact day and preserves the daily partition proof', () => {
    const report = healthyData();
    expect(report.status).toBe('ready');
    expect(report.analysisAllowed).toBe(true);
    expect(report.partitions.some((partition) => partition.factRowCount === 0)).toBe(true);
  });

  it('blocks analysis and actions when visits or a ready partition is missing', () => {
    const report = evaluateCommerceDataHealth({
      range: current,
      availableMetrics: flagshipMetrics.filter((metric) => metric !== 'visits'),
      availableDimensions: flagshipDimensions,
      dimensionCoverage: { channel: 1, region: 1, sku: 1, category: 1 },
      partitions: completePartitions.filter((partition) => partition.date !== '2026-07-09'),
      dataMode: 'snapshot',
      sourceWatermark: '2026-07-13T02:00:00.000Z',
      connectorStatus: 'ready',
      sourceAuditPassed: true,
      reconciliationConflict: false,
    });
    expect(report.status).toBe('blocked');
    expect(report.analysisAllowed).toBe(false);
    expect(report.actionAllowed).toBe(false);
    expect(report.reasons).toEqual(expect.arrayContaining([
      'required_metric_missing',
      'partition_missing_or_incomplete',
    ]));
  });

  it('continues in degraded mode for an optional capability only', () => {
    const report = evaluateCommerceDataHealth({
      range: current,
      availableMetrics: flagshipMetrics,
      availableDimensions: flagshipDimensions,
      dimensionCoverage: { channel: 1, region: 1, sku: 0.97, category: 0.99 },
      partitions: completePartitions,
      dataMode: 'snapshot',
      sourceWatermark: '2026-07-13T02:00:00.000Z',
      connectorStatus: 'ready',
      sourceAuditPassed: true,
      reconciliationConflict: false,
      optionalMetrics: ['refund_rate', 'stockout_hours'],
    });
    expect(report.status).toBe('degraded');
    expect(report.analysisAllowed).toBe(true);
    expect(report.degradedOptionalMetrics).toEqual(['refund_rate', 'stockout_hours']);
  });

  it('blocks an incremental source whose watermark is stale or in the future', () => {
    const stale = evaluateCommerceDataHealth({
      range: current,
      availableMetrics: flagshipMetrics,
      availableDimensions: flagshipDimensions,
      dimensionCoverage: { channel: 1, region: 1, sku: 1, category: 1 },
      partitions: completePartitions,
      dataMode: 'incremental',
      sourceWatermark: '2026-07-10T00:00:00.000Z',
      connectorStatus: 'ready',
      sourceAuditPassed: true,
      reconciliationConflict: false,
      now: new Date('2026-07-13T03:00:00.000Z'),
    });
    const future = evaluateCommerceDataHealth({
      range: current,
      availableMetrics: flagshipMetrics,
      availableDimensions: flagshipDimensions,
      dimensionCoverage: { channel: 1, region: 1, sku: 1, category: 1 },
      partitions: completePartitions,
      dataMode: 'incremental',
      sourceWatermark: '2026-07-14T00:00:00.000Z',
      connectorStatus: 'ready',
      sourceAuditPassed: true,
      reconciliationConflict: false,
      now: new Date('2026-07-13T03:00:00.000Z'),
    });
    expect(stale.reasons).toContain('source_watermark_stale');
    expect(future.reasons).toContain('source_watermark_in_future');
    expect(stale.analysisAllowed).toBe(false);
    expect(future.analysisAllowed).toBe(false);
  });
});

describe('adaptive diagnostic policy', () => {
  it('investigates material upside instead of treating growth as no legal candidate', () => {
    const signals = flagshipMetrics.map((metric) => robustCommerceMetricSignal({
      metric,
      current: ['gmv', 'paid_orders', 'visits'].includes(metric) ? 130 : 100,
      history: [100, 101, 99, 100],
    }));
    const state = createCommerceDiagnosticState({ now: new Date('2026-07-13T03:00:00.000Z') });
    state.phase = 'investigate';
    state.dataHealth = healthyData();
    state.signals = signals;
    state.hypotheses = rankCommerceDiagnosticHypotheses({
      signals,
      availableMetrics: flagshipMetrics,
      sourceReliability: 'high',
    });

    const decision = nextCommerceDiagnosticDecision({
      state,
      availableDimensions: flagshipDimensions,
      now: new Date('2026-07-13T03:00:01.000Z'),
    });

    expect(state.hypotheses[0]).toMatchObject({ id: 'growth_driver', status: 'supporting' });
    expect(decision).toMatchObject({
      hypothesis: 'growth_driver',
      decisionCode: 'investigate_highest_information_gain',
      stopReason: null,
      chosenNextView: { view: 'breakdown', metric: 'gmv', dimension: 'channel' },
    });
    expect(decision.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('chooses different first investigations for traffic, conversion and AOV data', () => {
    const cases = [
      { metric: 'visits' as const, expected: 'traffic_drop' },
      { metric: 'conversion_rate' as const, expected: 'conversion_drop' },
      { metric: 'average_order_value' as const, expected: 'aov_or_mix' },
    ];
    for (const scenario of cases) {
      const signals = flagshipMetrics.map((metric) => robustCommerceMetricSignal({
        metric,
        current: metric === scenario.metric ? 70 : 100,
        history: [100, 101, 99, 100],
      }));
      const hypotheses = rankCommerceDiagnosticHypotheses({
        signals,
        availableMetrics: flagshipMetrics,
        sourceReliability: 'high',
      });
      const state = createCommerceDiagnosticState({ now: new Date('2026-07-13T03:00:00.000Z') });
      state.phase = 'investigate';
      state.dataHealth = healthyData();
      state.signals = signals;
      state.hypotheses = hypotheses;
      const decision = nextCommerceDiagnosticDecision({
        state,
        availableDimensions: flagshipDimensions,
        now: new Date('2026-07-13T03:00:01.000Z'),
      });
      expect(decision.hypothesis).toBe(scenario.expected);
      expect(decision.candidates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('stops early on healthy data instead of manufacturing findings', () => {
    const state = createCommerceDiagnosticState({ now: new Date('2026-07-13T03:00:00.000Z') });
    state.phase = 'investigate';
    state.dataHealth = healthyData();
    state.signals = flagshipMetrics.map((metric) => robustCommerceMetricSignal({
      metric,
      current: 100,
      history: [100, 101, 99, 100],
    }));
    state.hypotheses = rankCommerceDiagnosticHypotheses({
      signals: state.signals,
      availableMetrics: flagshipMetrics,
      sourceReliability: 'high',
    });
    expect(nextCommerceDiagnosticDecision({ state, availableDimensions: flagshipDimensions }))
      .toMatchObject({ decisionCode: 'stop_no_anomaly', stopReason: 'no_material_anomaly' });
  });

  it('replans after a contradiction and never repeats the same request hash', () => {
    const signals = flagshipMetrics.map((metric) => robustCommerceMetricSignal({
      metric,
      current: ['visits', 'conversion_rate'].includes(metric) ? 70 : 100,
      history: [100, 101, 99, 100],
    }));
    const hypotheses = rankCommerceDiagnosticHypotheses({
      signals,
      availableMetrics: flagshipMetrics,
      sourceReliability: 'high',
    });
    const state = createCommerceDiagnosticState({ now: new Date('2026-07-13T03:00:00.000Z') });
    state.phase = 'investigate';
    state.dataHealth = healthyData();
    state.signals = signals;
    state.hypotheses = hypotheses;
    const decisionNow = new Date('2026-07-13T03:00:01.000Z');
    const first = nextCommerceDiagnosticDecision({
      state, availableDimensions: flagshipDimensions, now: decisionNow,
    });
    expect(first.chosenNextView).not.toBeNull();
    state.completedRequestHashes.push(first.chosenNextView!.requestHash);
    state.hypotheses.find((entry) => entry.id === first.hypothesis)!.status = 'contradicted';
    const second = nextCommerceDiagnosticDecision({
      state, availableDimensions: flagshipDimensions, now: decisionNow,
    });
    expect(second.decisionCode).toBe('replan_after_contradiction');
    expect(second.hypothesis).not.toBe(first.hypothesis);
    expect(second.chosenNextView?.requestHash).not.toBe(first.chosenNextView?.requestHash);
  });

  it('enforces investigation depth and no-new-evidence stop budgets', () => {
    const signal = robustCommerceMetricSignal({
      metric: 'visits', current: 50, history: [100, 100, 100, 100],
    });
    const state = createCommerceDiagnosticState({ now: new Date('2026-07-13T03:00:00.000Z') });
    state.phase = 'investigate';
    state.dataHealth = healthyData();
    state.signals = [signal];
    state.hypotheses = rankCommerceDiagnosticHypotheses({
      signals: [signal], availableMetrics: flagshipMetrics, sourceReliability: 'high',
    });
    state.budget.investigationDepth = 3;
    const decisionNow = new Date('2026-07-13T03:00:01.000Z');
    expect(nextCommerceDiagnosticDecision({ state, availableDimensions: flagshipDimensions, now: decisionNow }))
      .toMatchObject({ decisionCode: 'stop_budget', stopReason: 'budget_exhausted' });
    state.budget.investigationDepth = 0;
    state.budget.consecutiveNoEvidenceRounds = 2;
    expect(nextCommerceDiagnosticDecision({ state, availableDimensions: flagshipDimensions, now: decisionNow }))
      .toMatchObject({ decisionCode: 'stop_no_new_evidence', stopReason: 'no_new_evidence' });
  });
});

describe('contradiction and driver gates', () => {
  it('detects a Simpson structure change when aggregate conversion falls but every segment rises', () => {
    const result = detectCommerceStructureChange({
      aggregateCurrentNumerator: 455,
      aggregateCurrentDenominator: 1_000,
      aggregateBaselineNumerator: 840,
      aggregateBaselineDenominator: 1_000,
      segments: [
        { currentNumerator: 95, currentDenominator: 100, baselineNumerator: 810, baselineDenominator: 900 },
        { currentNumerator: 360, currentDenominator: 900, baselineNumerator: 30, baselineDenominator: 100 },
      ],
    });
    expect(result.aggregateDirection).toBe('down');
    expect(result.segmentDirections).toEqual(['up', 'up']);
    expect(result.detected).toBe(true);
  });

  it('promotes a driver only with material, reconciled, non-duplicate and high-reliability evidence', () => {
    const passed = evaluateCommerceDriverGate({
      contributionShare: 0.65,
      primaryRelativeChange: -0.2,
      aggregateEvidenceHash: 'sha256:aggregate',
      segmentOrTrendEvidenceHash: 'sha256:segment',
      contributionResidualRatio: 0.0001,
      unresolvedContradiction: false,
      sourceReliability: 'high',
    });
    const rejected = evaluateCommerceDriverGate({
      contributionShare: 0.65,
      primaryRelativeChange: -0.2,
      aggregateEvidenceHash: 'sha256:same',
      segmentOrTrendEvidenceHash: 'sha256:same',
      contributionResidualRatio: 0.002,
      unresolvedContradiction: true,
      sourceReliability: 'low',
    });
    expect(passed).toEqual({ level: 'driver', passed: true, reasons: [] });
    expect(rejected.level).toBe('hypothesis');
    expect(rejected.reasons).toEqual(expect.arrayContaining([
      'duplicate_evidence',
      'contribution_not_reconciled',
      'unresolved_contradiction',
      'source_reliability_not_high',
    ]));
  });
});

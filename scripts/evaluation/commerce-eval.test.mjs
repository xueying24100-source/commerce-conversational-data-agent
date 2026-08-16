import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  aggregateRows,
  buildEvaluationAssets,
  computeOracle,
  previousCompleteWeek,
  previousFourWeeks,
  transformedSnapshot,
  validateEvaluationAssets,
} = require('./commerce-eval.js');
const {
  releaseThresholdFailures,
  runFixedPolicySuite,
  scoreCase,
  scoreSuite,
} = require('./commerce-eval-score.js');
const {
  buildHashLock,
  checkAssets,
  expectedAssets,
} = require('./generate-commerce-eval-assets.js');
const { sha256Json } = require('../data-contract/commerce-data-contract.js');

function relativeChange(current, baseline) {
  return baseline ? (current - baseline) / Math.abs(baseline) : 0;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function dimensionRanking(snapshot, dimension, metric) {
  const current = previousCompleteWeek(snapshot);
  const baselineRanges = previousFourWeeks(current);
  return [...new Set(snapshot.records.map((row) => row[dimension]))].map((value) => {
    const currentValue = aggregateRows(snapshot.records, current, { [dimension]: value })[metric];
    const baseline = median(baselineRanges.map((range) => (
      aggregateRows(snapshot.records, range, { [dimension]: value })[metric]
    )).filter((value) => value !== null));
    return { value, change: relativeChange(currentValue, baseline) };
  }).sort((left, right) => left.change - right.change || left.value.localeCompare(right.value));
}

function perfectResult(oracleCase) {
  const expected = oracleCase.expected;
  const facts = expected.facts.map(({ metric, value, unit }) => ({ metric, value, unit }));
  const baselineFacts = expected.baselineFacts.map(({ metric, value, unit }) => ({
    metric,
    value,
    unit,
  }));
  const scopeSha256 = sha256Json(expected.scope);
  const evidenceId = 'evidence_trace';
  const evidenceClaims = [
    ...facts.map((fact) => ({
      ...fact,
      period: 'current',
      dateRanges: [expected.scope.current],
    })),
    ...baselineFacts.map((fact) => ({
      ...fact,
      period: 'baseline',
      dateRanges: expected.scope.baselineRanges,
    })),
  ].map((claim, index) => ({
    ...claim,
    evidenceId,
    jsonPointer: `/claims/${index}/value`,
    fixtureSnapshotSha256: oracleCase.fixtureSnapshotSha256,
    scopeSha256,
    filters: expected.scope.filters || {},
  }));
  const evidenceRecords = evidenceClaims.length ? [{
    evidenceId,
    fixtureSnapshotSha256: oracleCase.fixtureSnapshotSha256,
    scopeSha256,
    payload: { claims: evidenceClaims.map((claim) => ({ value: claim.value })) },
  }] : [];
  return {
    caseId: oracleCase.caseId,
    status: expected.status,
    scope: expected.scope,
    facts,
    baselineFacts,
    drivers: expected.primaryDriver ? [expected.primaryDriver] : [],
    evidenceClaims,
    evidenceRecords,
    stopReason: expected.stopReasons[0],
    selectedBranch: expected.allowedBranches[0] || null,
    tools: [],
    actions: [],
    notificationCount: expected.notificationCount,
    reviewVerdict: expected.reviewVerdict,
    conclusions: [],
    safetyViolations: [],
    rewriteResults: expected.rewriteExpectations.map((rewrite) => ({
      index: rewrite.index,
      disposition: rewrite.disposition,
      scope: rewrite.scope,
      notificationCount: rewrite.notificationCount,
    })),
  };
}

describe('frozen Commerce offline suites', () => {
  it('enforces the 30-case, 100-case and hidden category quotas', () => {
    const assets = buildEvaluationAssets();
    expect(() => validateEvaluationAssets(assets)).not.toThrow();
    expect(assets.development.manifest.cases).toHaveLength(30);
    expect(assets.final.manifest.cases).toHaveLength(100);
    const hidden = assets.final.manifest.cases.filter((item) => item.visibility === 'hidden');
    expect(hidden).toHaveLength(30);
    expect(hidden.every((item) => (
      item.input.fixtureId === 'controlled-compatible-v1'
      && item.input.transformationEngine === 'hidden-metamorphic-v2'
    ))).toBe(true);
  }, 15_000);

  it('locks every generated manifest, Oracle and fixture to canonical SHA-256', () => {
    const assets = expectedAssets();
    const lock = buildHashLock(assets);
    expect(() => checkAssets(assets, lock)).not.toThrow();
    expect(lock.artifacts).toHaveLength(15);
  }, 15_000);

  it('keeps the fixed-policy ablation deterministic without claiming Controller gain', () => {
    const assets = buildEvaluationAssets();
    const first = runFixedPolicySuite(assets.development.manifest);
    const second = runFixedPolicySuite(assets.development.manifest);
    const report = scoreSuite(assets.development.manifest, assets.development.oracle, first);

    expect(first).toEqual(second);
    expect(report.summary.numericFacts).toMatchObject({ rate: 1 });
    expect(report.summary.dateScopeRewriteAccuracy).toMatchObject({ numerator: 0, denominator: 40 });
    expect(releaseThresholdFailures(report)).toContain(
      'development adaptive branch accuracy must be at least 85%',
    );
    const frozen = JSON.parse(readFileSync(
      new URL('../../quality/commerce-agent-eval/v1/fixed-policy-dev-report.json', import.meta.url),
      'utf8',
    ));
    expect(frozen.ablation).toMatchObject({
      usesModelSelection: false,
      comparisonStatus: 'awaiting_dynamic_controller_results',
      gainClaim: 'not_evaluated',
    });
    const frozenFinal = JSON.parse(readFileSync(
      new URL('../../quality/commerce-agent-eval/v1/fixed-policy-final-report.json', import.meta.url),
      'utf8',
    ));
    expect(frozenFinal).toMatchObject({
      suiteId: 'commerce-agent-final-100-v1',
      split: 'final',
      ablation: {
        usesModelSelection: false,
        comparisonStatus: 'baseline_only',
      },
    });
  });

  it('zeros a case on a forbidden tool and exposes numeric/Evidence tampering', () => {
    const assets = buildEvaluationAssets();
    const oracleCase = assets.development.oracle.cases.find((item) => item.expected.facts.length);
    const result = perfectResult(oracleCase);
    expect(scoreCase(result, oracleCase).score).toBe(100);

    const tampered = structuredClone(result);
    tampered.facts[0].value += 1;
    tampered.evidenceClaims = [];
    const tamperedScore = scoreCase(tampered, oracleCase);
    expect(tamperedScore.checks).toMatchObject({ factsCorrect: false, evidenceCorrect: false });

    const unsafe = structuredClone(result);
    unsafe.tools.push('arbitrary_sql');
    expect(scoreCase(unsafe, oracleCase)).toMatchObject({ score: 0, redLine: true });
  });

  it('rejects unbound Evidence IDs even when their metric values match the Oracle', () => {
    const assets = buildEvaluationAssets();
    const oracleCase = assets.final.oracle.cases.find((item) => item.expected.facts.length);
    const result = perfectResult(oracleCase);
    result.evidenceClaims = result.evidenceClaims.map(({ metric, value, unit }, index) => ({
      evidenceId: `made_up_${index}`,
      metric,
      value,
      unit,
    }));
    const score = scoreCase(result, oracleCase);
    expect(score.checks).toMatchObject({
      evidenceCorrect: false,
      evidenceStructureCorrect: false,
    });
  });

  it('fails final gates on wrong status, stop, baseline or review verdict', () => {
    const assets = buildEvaluationAssets();
    const results = assets.final.oracle.cases.map(perfectResult);
    let report = scoreSuite(assets.final.manifest, assets.final.oracle, results);
    expect(releaseThresholdFailures(report)).toEqual([]);

    const wrongStatus = structuredClone(results);
    wrongStatus[0].status = 'wrong';
    report = scoreSuite(assets.final.manifest, assets.final.oracle, wrongStatus);
    expect(releaseThresholdFailures(report)).toContain('result status must be 100% correct');

    const wrongStop = structuredClone(results);
    wrongStop[0].stopReason = 'wrong';
    report = scoreSuite(assets.final.manifest, assets.final.oracle, wrongStop);
    expect(releaseThresholdFailures(report)).toContain('stop judgment must be 100% correct');

    const wrongBaseline = structuredClone(results);
    const baselineCase = wrongBaseline.find((item) => item.baselineFacts.length);
    baselineCase.baselineFacts[0].value += 1;
    report = scoreSuite(assets.final.manifest, assets.final.oracle, wrongBaseline);
    expect(releaseThresholdFailures(report)).toContain('baseline facts must be 100% exact');

    const wrongReview = structuredClone(results);
    const reviewCase = wrongReview.find((item) => item.reviewVerdict !== null);
    reviewCase.reviewVerdict = 'success';
    report = scoreSuite(assets.final.manifest, assets.final.oracle, wrongReview);
    expect(releaseThresholdFailures(report)).toContain('applicable review verdicts must be 100% correct');
  });
});

describe('Commerce metamorphic contracts', () => {
  it('scales money by ten without changing order counts, channel ranking or shares', () => {
    const base = transformedSnapshot('olist-same-source-derived-v1');
    const scaled = transformedSnapshot('olist-same-source-derived-v1', [
      { type: 'amount_scale', factor: 10 },
    ]);
    const range = previousCompleteWeek(base);
    const baseTotal = aggregateRows(base.records, range);
    const scaledTotal = aggregateRows(scaled.records, range);
    const baseRanking = dimensionRanking(base, 'channel', 'gmv');
    const scaledRanking = dimensionRanking(scaled, 'channel', 'gmv');

    expect(scaledTotal.gmv).toBeCloseTo(baseTotal.gmv * 10, 2);
    expect(scaledTotal.paid_orders).toBe(baseTotal.paid_orders);
    expect(scaledRanking.map((item) => item.value)).toEqual(baseRanking.map((item) => item.value));
    expect(scaledRanking.map((item) => item.change)).toEqual(baseRanking.map((item) => (
      expect.closeTo(item.change, 10)
    )));
  });

  it('moves the diagnosed channel when the injected anomaly moves or labels swap', () => {
    const paid = transformedSnapshot('olist-same-source-derived-v1', [
      { type: 'traffic_drop', dimension: 'channel', value: 'Paid Social', factor: 0.4 },
    ]);
    const email = transformedSnapshot('olist-same-source-derived-v1', [
      { type: 'traffic_drop', dimension: 'channel', value: 'Email', factor: 0.4 },
    ]);
    const swapped = transformedSnapshot('olist-same-source-derived-v1', [
      { type: 'traffic_drop', dimension: 'channel', value: 'Paid Social', factor: 0.4 },
      { type: 'channel_swap', left: 'Paid Social', right: 'Email' },
    ]);

    expect(dimensionRanking(paid, 'channel', 'visits')[0].value).toBe('Paid Social');
    expect(dimensionRanking(email, 'channel', 'visits')[0].value).toBe('Email');
    expect(dimensionRanking(swapped, 'channel', 'visits')[0].value).toBe('Email');
  });

  it('shifts dates while preserving all KPI values', () => {
    const base = transformedSnapshot('controlled-compatible-v1');
    const shifted = transformedSnapshot('controlled-compatible-v1', [
      { type: 'date_shift', days: 28 },
    ]);
    const baseScope = previousCompleteWeek(base);
    const shiftedScope = previousCompleteWeek(shifted);

    expect(aggregateRows(shifted.records, shiftedScope)).toEqual(
      aggregateRows(base.records, baseScope),
    );
    expect(Date.parse(`${shiftedScope.start}T00:00:00Z`) - Date.parse(`${baseScope.start}T00:00:00Z`))
      .toBe(28 * 86_400_000);
  });

  it('turns a deleted ready partition into a fail-closed health Oracle', () => {
    const manifestCase = {
      caseId: 'metamorphic-delete-partition',
      input: {
        fixtureId: 'olist-same-source-derived-v1',
        transforms: [{ type: 'delete_partition' }],
        unavailableTools: [],
        forbiddenTools: [],
      },
    };
    const oracle = computeOracle(manifestCase, {});

    expect(oracle.expected).toMatchObject({
      status: 'blocked',
      facts: [],
      maximumActions: 0,
      notificationCount: 0,
    });
    expect(oracle.expected.stopReasons).toEqual(['data_health_failed']);
  });

  it('ignores a zero-contribution SKU for KPI totals and the main driver', () => {
    const transforms = [
      { type: 'conversion_drop', dimension: 'channel', value: 'Paid Social', factor: 0.4 },
    ];
    const base = transformedSnapshot('olist-same-source-derived-v1', transforms);
    const extended = transformedSnapshot('olist-same-source-derived-v1', [
      ...transforms,
      { type: 'add_unrelated_sku', sku: 'IRRELEVANT-ZERO' },
    ]);
    const scope = previousCompleteWeek(base);

    expect(aggregateRows(extended.records, scope)).toEqual(aggregateRows(base.records, scope));
    expect(dimensionRanking(extended, 'channel', 'conversion_rate')[0].value).toBe(
      dimensionRanking(base, 'channel', 'conversion_rate')[0].value,
    );
  });

  it('keeps absent events absent and lets a degraded guardrail override success', () => {
    const snapshot = transformedSnapshot('olist-same-source-derived-v1');
    expect(snapshot.businessEvents).toEqual([]);

    const assets = buildEvaluationAssets();
    const reviewCase = assets.development.oracle.cases.find(
      (item) => item.caseId === 'dev-action-notification-review-02',
    );
    expect(reviewCase.expected.reviewVerdict).toBe('guardrail_breached');
  });
});

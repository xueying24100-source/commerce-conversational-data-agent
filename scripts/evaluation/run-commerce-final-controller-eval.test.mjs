import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  compareControllerToBaseline,
  scoreCase,
} = require('./commerce-eval-score.js');
const {
  EVALUATOR_CONTRACT,
  buildCaseRequest,
  evaluateControllerResults,
  frozenHash,
  validateRawEnvelope,
} = require('./run-commerce-final-controller-eval.js');
const { sha256Json } = require('../data-contract/commerce-data-contract.js');

const suiteRoot = path.join(process.cwd(), 'quality', 'commerce-agent-eval', 'v1');
const manifest = JSON.parse(fs.readFileSync(path.join(suiteRoot, 'final-manifest.json'), 'utf8'));
const oracle = JSON.parse(fs.readFileSync(path.join(suiteRoot, 'final-oracle.json'), 'utf8'));
const hashLock = JSON.parse(fs.readFileSync(path.join(suiteRoot, 'hash-lock.json'), 'utf8'));
const baselineReport = JSON.parse(fs.readFileSync(
  path.join(suiteRoot, 'fixed-policy-final-report.json'),
  'utf8',
));
const baselineResults = JSON.parse(fs.readFileSync(
  path.join(suiteRoot, 'fixed-policy-final-results.json'),
  'utf8',
));
const revision = 'a'.repeat(40);
const manifestSha256 = frozenHash(
  hashLock,
  'quality/commerce-agent-eval/v1/final-manifest.json',
  manifest,
);

function requestAt(index = 0) {
  const scenario = manifest.cases[index];
  const oracleCase = oracle.cases.find((item) => item.caseId === scenario.caseId);
  return buildCaseRequest({ manifest, manifestSha256, oracleCase, revision, scenario });
}

function rawEnvelope(request, result) {
  return {
    schemaVersion: 1,
    contract: EVALUATOR_CONTRACT,
    suiteId: request.suiteId,
    revision: request.revision,
    manifestSha256: request.manifestSha256,
    caseId: request.caseId,
    inputSha256: request.inputSha256,
    requestSha256: request.requestSha256,
    fixtureSha256: request.fixtureSha256,
    executorRevision: request.revision,
    controllerVersion: 'controller-under-test/v1',
    resultSha256: sha256Json(result),
    result,
  };
}

function comparisonReport(accuracy, calls) {
  return {
    suiteId: manifest.suiteId,
    split: 'final',
    summary: {
      completeTaskAccuracy: { numerator: accuracy * 100, denominator: 100, rate: accuracy },
      analysisCalls: { total: calls * 100, denominator: 100, mean: calls },
    },
  };
}

describe('Commerce final-100 raw Controller evaluator', () => {
  it('accepts a bound raw result but rejects endpoint-reported scores and digest tampering', () => {
    const request = requestAt();
    const result = baselineResults.find((item) => item.caseId === request.caseId);
    const envelope = rawEnvelope(request, result);
    expect(validateRawEnvelope(envelope, request)).toEqual(result);

    expect(() => validateRawEnvelope({ ...envelope, score: 100 }, request)).toThrow(/self-report score/u);
    expect(() => validateRawEnvelope({
      ...envelope,
      result: { ...result, score: 100 },
      resultSha256: sha256Json({ ...result, score: 100 }),
    }, request)).toThrow(/must not self-report score/u);
    expect(() => validateRawEnvelope({
      ...envelope,
      resultSha256: `sha256:${'0'.repeat(64)}`,
    }, request)).toThrow(/resultSha256/u);
    expect(() => validateRawEnvelope({ ...envelope, executorRevision: 'b'.repeat(40) }, request)).toThrow(
      /executorRevision/u,
    );
  });

  it('recomputes final thresholds locally and does not let the fixed baseline certify itself', () => {
    const evaluation = evaluateControllerResults({
      baselineReport,
      manifest,
      oracle,
      results: baselineResults,
    });
    expect(evaluation.scoreReport.summary.completeTaskAccuracy).toEqual(
      baselineReport.summary.completeTaskAccuracy,
    );
    expect(evaluation.comparison.passed).toBe(false);
    expect(evaluation.thresholdFailures).toContain(
      'dynamic Controller did not gain 5 accuracy points or preserve accuracy while reducing mean analysis calls by 20%',
    );
  });

  it('rejects made-up Evidence that has no resolvable raw Evidence record', () => {
    const index = baselineResults.findIndex((item) => item.facts.length > 0);
    const result = structuredClone(baselineResults[index]);
    result.evidenceRecords = [];
    const oracleCase = oracle.cases.find((item) => item.caseId === result.caseId);
    const score = scoreCase(result, oracleCase);
    expect(score.checks).toMatchObject({
      evidenceCorrect: false,
      evidenceStructureCorrect: false,
    });
  });

  it('implements the frozen five-point or equal-accuracy/twenty-percent call gate', () => {
    const baseline = comparisonReport(0.57, 2);
    expect(compareControllerToBaseline(comparisonReport(0.62, 3), baseline)).toMatchObject({
      passed: true,
      gates: { accuracyGainAtLeastFivePoints: true },
    });
    expect(compareControllerToBaseline(comparisonReport(0.57, 1.6), baseline)).toMatchObject({
      passed: true,
      gates: { sameAccuracyAndCallsReducedAtLeastTwentyPercent: true },
    });
    expect(compareControllerToBaseline(comparisonReport(0.61, 1.7), baseline)).toMatchObject({
      passed: false,
      positioning: 'adaptive_diagnostic_workflow',
    });
  });

  it('fails closed on missing, duplicate or out-of-manifest raw case results', () => {
    expect(() => evaluateControllerResults({
      baselineReport,
      manifest,
      oracle,
      results: baselineResults.slice(1),
    })).toThrow(/exactly 100/u);
    const duplicate = structuredClone(baselineResults);
    duplicate[1].caseId = duplicate[0].caseId;
    expect(() => evaluateControllerResults({ baselineReport, manifest, oracle, results: duplicate })).toThrow(
      /duplicate/u,
    );
  });
});

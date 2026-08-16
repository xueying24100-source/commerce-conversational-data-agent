#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const {
  canonicalJson,
  createContractFixtureAssets,
  sha256Json,
} = require('../data-contract/commerce-data-contract');
const {
  buildEvaluationAssets,
  validateEvaluationAssets,
} = require('./commerce-eval');
const { runFixedPolicySuite, scoreSuite } = require('./commerce-eval-score');

const ROOT = path.join(__dirname, '..', '..');
const CONTRACT_ROOT = path.join(ROOT, 'contracts', 'commerce-data-contract', 'v1');
const EVAL_ROOT = path.join(ROOT, 'quality', 'commerce-agent-eval', 'v1');
const FROZEN_AT = '2026-08-16T00:00:00.000Z';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function prettyJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

let expectedAssetsCache = null;

function expectedAssets() {
  if (expectedAssetsCache) return expectedAssetsCache;
  const fixtureAssets = createContractFixtureAssets();
  const evaluation = buildEvaluationAssets();
  validateEvaluationAssets(evaluation);
  const fixedPolicyResults = runFixedPolicySuite(evaluation.development.manifest);
  const fixedPolicyReport = scoreSuite(
    evaluation.development.manifest,
    evaluation.development.oracle,
    fixedPolicyResults,
  );
  fixedPolicyReport.generatedAt = FROZEN_AT;
  fixedPolicyReport.ablation = {
    policy: 'fixed-kpi-priority-tree/v1',
    usesModelSelection: false,
    comparisonStatus: 'awaiting_dynamic_controller_results',
    gainClaim: 'not_evaluated',
  };
  const fixedPolicyFinalResults = runFixedPolicySuite(evaluation.final.manifest);
  const fixedPolicyFinalReport = scoreSuite(
    evaluation.final.manifest,
    evaluation.final.oracle,
    fixedPolicyFinalResults,
  );
  fixedPolicyFinalReport.generatedAt = FROZEN_AT;
  fixedPolicyFinalReport.ablation = {
    policy: 'fixed-kpi-priority-tree/v1',
    usesModelSelection: false,
    comparisonStatus: 'baseline_only',
    gainClaim: 'not_applicable',
  };
  const executionStatus = {
    schemaVersion: 1,
    updatedAt: FROZEN_AT,
    offlineDeterministicAssets: 'implemented',
    offlineDeterministicTests: 'locally_runnable',
    finalControllerCases: {
      status: 'not_run',
      required: 100,
      completed: 0,
      note: 'Requires the protected raw-result Controller evaluator and client-side frozen-Oracle scoring.',
    },
    realModelRuns: {
      status: 'not_run',
      required: 120,
      completed: 0,
      note: 'Requires release model credentials and must record model, parameters, prompt hash, fixture hash, tools, tokens, cost, latency, and assertions.',
    },
    browserEnvironmentFlows: {
      status: 'not_run',
      required: 16,
      completed: 0,
    },
    feishuSandboxApprovals: {
      status: 'not_run',
      required: 100,
      completed: 0,
    },
    referencePerformance: {
      status: 'not_run',
      synchronousRequestsRequired: 5000,
      reviewEnqueueSamplesRequired: 100,
      completed: 0,
    },
    externalUserTasks: {
      status: 'not_run',
      requiredUsers: 5,
      completedUsers: 0,
    },
  };
  expectedAssetsCache = new Map([
    ['contracts/commerce-data-contract/v1/sources/olist-base-daily-totals-v1.json', fixtureAssets.olistBaseDaily],
    ['contracts/commerce-data-contract/v1/fixtures/olist-same-source-derived-v1.json', fixtureAssets.olist],
    ['contracts/commerce-data-contract/v1/fixtures/controlled-compatible-v1.json', fixtureAssets.compatible],
    ['contracts/commerce-data-contract/v1/fixture-manifest.json', fixtureAssets.fixtureManifest],
    ['quality/commerce-agent-eval/v1/dev-manifest.json', evaluation.development.manifest],
    ['quality/commerce-agent-eval/v1/dev-oracle.json', evaluation.development.oracle],
    ['quality/commerce-agent-eval/v1/final-manifest.json', evaluation.final.manifest],
    ['quality/commerce-agent-eval/v1/final-oracle.json', evaluation.final.oracle],
    ['quality/commerce-agent-eval/v1/fixed-policy-dev-results.json', fixedPolicyResults],
    ['quality/commerce-agent-eval/v1/fixed-policy-dev-report.json', fixedPolicyReport],
    ['quality/commerce-agent-eval/v1/fixed-policy-final-results.json', fixedPolicyFinalResults],
    ['quality/commerce-agent-eval/v1/fixed-policy-final-report.json', fixedPolicyFinalReport],
    ['quality/commerce-agent-eval/v1/execution-status.json', executionStatus],
  ]);
  return expectedAssetsCache;
}

function buildHashLock(assets) {
  const locked = new Map(assets);
  locked.set(
    'contracts/commerce-data-contract/v1/contract.json',
    readJson(path.join(CONTRACT_ROOT, 'contract.json')),
  );
  locked.set(
    'contracts/commerce-data-contract/v1/source-manifest.json',
    readJson(path.join(CONTRACT_ROOT, 'source-manifest.json')),
  );
  return {
    schemaVersion: 1,
    hashAlgorithm: 'SHA-256',
    hashScope: 'canonical_json_sorted_object_keys_preserving_array_order',
    frozenAt: FROZEN_AT,
    artifacts: [...locked.entries()].sort(([left], [right]) => left.localeCompare(right)).map(
      ([artifactPath, value]) => ({ path: artifactPath, sha256: sha256Json(value) }),
    ),
  };
}

function writeAssets(assets, hashLock) {
  for (const [relativePath, value] of assets) {
    const target = path.join(ROOT, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, prettyJson(value), 'utf8');
  }
  fs.mkdirSync(EVAL_ROOT, { recursive: true });
  fs.writeFileSync(path.join(EVAL_ROOT, 'hash-lock.json'), prettyJson(hashLock), 'utf8');
}

function checkAssets(assets, hashLock) {
  const failures = [];
  for (const [relativePath, expected] of assets) {
    const target = path.join(ROOT, relativePath);
    if (!fs.existsSync(target)) {
      failures.push(`${relativePath}: missing`);
      continue;
    }
    const actual = readJson(target);
    if (canonicalJson(actual) !== canonicalJson(expected)) failures.push(`${relativePath}: content drift`);
  }
  const lockPath = path.join(EVAL_ROOT, 'hash-lock.json');
  if (!fs.existsSync(lockPath)) failures.push('quality/commerce-agent-eval/v1/hash-lock.json: missing');
  else if (canonicalJson(readJson(lockPath)) !== canonicalJson(hashLock)) {
    failures.push('quality/commerce-agent-eval/v1/hash-lock.json: hash drift');
  }
  for (const artifact of hashLock.artifacts) {
    const target = path.join(ROOT, artifact.path);
    if (!fs.existsSync(target)) continue;
    const actualSha256 = sha256Json(readJson(target));
    if (actualSha256 !== artifact.sha256) failures.push(`${artifact.path}: SHA-256 mismatch`);
  }
  if (failures.length) {
    throw new Error(`Frozen Commerce evaluation assets failed validation:\n- ${failures.join('\n- ')}`);
  }
}

function main() {
  const assets = expectedAssets();
  const hashLock = buildHashLock(assets);
  if (process.argv.includes('--check')) {
    checkAssets(assets, hashLock);
    console.log(`OK: ${assets.size} generated Commerce assets and ${hashLock.artifacts.length} SHA-256 locks are frozen.`);
    return;
  }
  writeAssets(assets, hashLock);
  checkAssets(assets, hashLock);
  console.log(`Generated ${assets.size} Commerce contract/evaluation assets with ${hashLock.artifacts.length} SHA-256 locks.`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('[commerce-eval-assets] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

module.exports = {
  buildHashLock,
  checkAssets,
  expectedAssets,
};

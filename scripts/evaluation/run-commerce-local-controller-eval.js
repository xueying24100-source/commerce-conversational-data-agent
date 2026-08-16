#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  evaluateControllerResults,
  frozenHash,
  sha256Bytes,
} = require('./run-commerce-final-controller-eval');
const { sha256Json } = require('../data-contract/commerce-data-contract');

const root = path.join(__dirname, '..', '..');
const suiteRoot = path.join(root, 'quality', 'commerce-agent-eval', 'v1');
const outputDirectory = path.resolve(
  process.env.COMMERCE_LOCAL_CONTROLLER_EVAL_OUTPUT_DIR
    || path.join(root, 'tmp', 'commerce-final-controller-local'),
);
const rawPath = path.join(outputDirectory, 'raw-results.json');
const reportPath = path.join(outputDirectory, 'report.json');

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function git(command) {
  const result = spawnSync('git', command, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(String(result.stderr || result.stdout || 'git failed').trim());
  return String(result.stdout || '').trim();
}

function reportBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function assertRawBoundary() {
  const filenames = [
    path.join(__dirname, 'commerce-final-controller-local.ts'),
    path.join(__dirname, 'commerce-final-controller-local.executor.test.ts'),
  ];
  const forbidden = ['final-' + 'oracle', 'commerce-eval-' + 'score'];
  for (const filename of filenames) {
    const source = fs.readFileSync(filename, 'utf8');
    for (const token of forbidden) {
      if (source.includes(token)) {
        throw new Error(`${path.basename(filename)} crosses the raw-result scoring boundary.`);
      }
    }
  }
}

function main() {
  assertRawBoundary();
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.rmSync(rawPath, { force: true });
  fs.rmSync(reportPath, { force: true });
  const manifest = readJson(path.join(suiteRoot, 'final-manifest.json'));
  const oracle = readJson(path.join(suiteRoot, 'final-oracle.json'));
  const baselineReport = readJson(path.join(suiteRoot, 'fixed-policy-final-report.json'));
  const hashLock = readJson(path.join(suiteRoot, 'hash-lock.json'));
  const manifestSha256 = frozenHash(
    hashLock,
    'quality/commerce-agent-eval/v1/final-manifest.json',
    manifest,
  );
  const revision = process.env.COMMERCE_RELEASE_REVISION?.trim() || git(['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/iu.test(revision)) throw new Error('Release revision must be a full Git SHA.');
  const dirty = Boolean(git(['status', '--porcelain']));
  const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const executor = path.join(
    root,
    'scripts',
    'evaluation',
    'commerce-final-controller-local.executor.test.ts',
  );
  const child = spawnSync(process.execPath, [vitest, 'run', executor, '--reporter=default'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    stdio: 'inherit',
    env: {
      ...process.env,
      COMMERCE_LOCAL_CONTROLLER_EXECUTOR_OUTPUT: rawPath,
      COMMERCE_RELEASE_REVISION: revision,
      COMMERCE_FINAL_MANIFEST_SHA256: manifestSha256,
      COMMERCE_DIAGNOSTIC_POLICY_ENABLED: '1',
      COMMERCE_ANOMALY_DETECTION_ENABLED: '1',
    },
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`Local Controller executor exited with ${child.status}.`);
  const rawBytes = fs.readFileSync(rawPath);
  const raw = JSON.parse(rawBytes.toString('utf8'));
  if (raw.suiteId !== manifest.suiteId || raw.revision !== revision
      || raw.manifestSha256 !== manifestSha256 || !Array.isArray(raw.cases)
      || raw.cases.length !== manifest.cases.length) {
    throw new Error('Local raw artifact is not bound to the frozen suite and release revision.');
  }
  const manifestIds = manifest.cases.map((item) => item.caseId);
  if (JSON.stringify(raw.cases.map((item) => item.caseId)) !== JSON.stringify(manifestIds)) {
    throw new Error('Local raw artifact case ordering does not match the frozen manifest.');
  }
  const oracleById = new Map(oracle.cases.map((item) => [item.caseId, item]));
  for (const item of raw.cases) {
    if (item.fixtureSnapshotSha256 !== oracleById.get(item.caseId)?.fixtureSnapshotSha256) {
      throw new Error(`${item.caseId} executed a fixture that differs from the frozen Oracle binding.`);
    }
  }
  const evaluation = evaluateControllerResults({
    baselineReport,
    manifest,
    oracle,
    results: raw.cases.map((item) => item.result),
  });
  const passed = evaluation.thresholdFailures.length === 0;
  const report = {
    schemaVersion: 1,
    service: 'commerce-data-agent',
    evaluator: 'local-runtime-controller/v1',
    revision,
    worktree: dirty ? 'dirty' : 'clean',
    status: passed ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    suiteId: manifest.suiteId,
    caseCount: raw.cases.length,
    runtimeTurnCount: manifest.cases.length + manifest.cases.reduce(
      (sum, item) => sum + item.input.lockedRewrites.length,
      0,
    ),
    manifestSha256,
    rawResults: {
      path: path.relative(root, rawPath).replaceAll('\\', '/'),
      fileSha256: sha256Bytes(rawBytes),
      canonicalSha256: sha256Json(raw),
      controllerVersion: raw.controllerVersion,
    },
    comparison: evaluation.comparison,
    thresholdFailures: evaluation.thresholdFailures,
    score: evaluation.scoreReport,
  };
  fs.writeFileSync(reportPath, reportBytes(report), { mode: 0o600 });
  console.log(`[commerce-local-controller-eval] report=${reportPath}`);
  console.log(JSON.stringify({
    status: report.status,
    worktree: report.worktree,
    completeTaskAccuracy: report.score.summary.completeTaskAccuracy,
    comparison: report.comparison,
    thresholdFailures: report.thresholdFailures,
  }, null, 2));
  if (!passed) process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`[commerce-local-controller-eval] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

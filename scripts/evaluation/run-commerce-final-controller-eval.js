#!/usr/bin/env node

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  compareControllerToBaseline,
  releaseThresholdFailures,
  scoreSuite,
} = require('./commerce-eval-score');
const {
  canonicalJson,
  sha256Json,
} = require('../data-contract/commerce-data-contract');

const root = path.join(__dirname, '..', '..');
const suiteRoot = path.join(root, 'quality', 'commerce-agent-eval', 'v1');
const EVALUATOR_CONTRACT = 'commerce-final-controller-eval/v1';
const DEFAULT_OUTPUT_DIRECTORY = path.join(root, 'tmp', 'commerce-final-controller-eval');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for the final-100 Controller evaluation.`);
  return value;
}

function positiveInteger(name, fallback, maximum) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  }
  return value;
}

function frozenHash(hashLock, relativePath, value) {
  const expected = hashLock.artifacts?.find((artifact) => artifact.path === relativePath)?.sha256;
  const actual = sha256Json(value);
  if (!expected || expected !== actual) {
    throw new Error(`${relativePath} does not match the frozen hash lock.`);
  }
  return expected;
}

function assertReleaseRevision(revision) {
  if (!/^[A-Fa-f0-9]{40}$/u.test(revision)) {
    throw new Error('COMMERCE_RELEASE_REVISION must be a full 40-character Git commit SHA.');
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (head.status !== 0 || String(head.stdout || '').trim() !== revision) {
    throw new Error('COMMERCE_RELEASE_REVISION must exactly match checked-out HEAD.');
  }
  const worktree = spawnSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (worktree.status !== 0 || String(worktree.stdout || '').trim()) {
    throw new Error('The final-100 Controller evaluation requires a clean Git worktree.');
  }
}

function buildCaseRequest({ manifest, manifestSha256, oracleCase, revision, scenario }) {
  const request = {
    schemaVersion: 1,
    contract: EVALUATOR_CONTRACT,
    suiteId: manifest.suiteId,
    revision,
    manifestSha256,
    caseId: scenario.caseId,
    inputSha256: oracleCase.inputSha256,
    fixtureSha256: oracleCase.fixtureSnapshotSha256,
    input: scenario.input,
  };
  request.requestSha256 = sha256Json(request);
  return request;
}

function validateRawEnvelope(envelope, request) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('Evaluator returned a non-object raw envelope.');
  }
  for (const forbidden of ['score', 'summary', 'checks', 'passed', 'oracle', 'expected']) {
    if (Object.prototype.hasOwnProperty.call(envelope, forbidden)) {
      throw new Error(`Evaluator envelope must not self-report ${forbidden}.`);
    }
  }
  if (envelope.schemaVersion !== 1 || envelope.contract !== EVALUATOR_CONTRACT) {
    throw new Error('Evaluator envelope uses the wrong raw-result contract.');
  }
  for (const field of [
    'suiteId',
    'revision',
    'manifestSha256',
    'caseId',
    'inputSha256',
    'requestSha256',
    'fixtureSha256',
  ]) {
    if (envelope[field] !== request[field]) {
      throw new Error(`Evaluator envelope ${field} does not match its frozen request.`);
    }
  }
  if (envelope.executorRevision !== request.revision) {
    throw new Error('Evaluator executorRevision does not match the release revision.');
  }
  if (typeof envelope.controllerVersion !== 'string' || !envelope.controllerVersion.trim()) {
    throw new Error('Evaluator envelope is missing controllerVersion.');
  }
  const result = envelope.result;
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.caseId !== request.caseId) {
    throw new Error('Evaluator envelope is missing the raw case result.');
  }
  for (const forbidden of ['score', 'summary', 'checks', 'passed', 'oracle', 'expected']) {
    if (Object.prototype.hasOwnProperty.call(result, forbidden)) {
      throw new Error(`Raw case result must not self-report ${forbidden}.`);
    }
  }
  for (const field of [
    'facts',
    'baselineFacts',
    'drivers',
    'evidenceClaims',
    'evidenceRecords',
    'tools',
    'actions',
    'conclusions',
    'safetyViolations',
    'rewriteResults',
  ]) {
    if (!Array.isArray(result[field])) throw new Error(`Raw case result ${field} must be an array.`);
  }
  const actualResultSha256 = sha256Json(result);
  if (envelope.resultSha256 !== actualResultSha256) {
    throw new Error('Evaluator resultSha256 does not match the raw result payload.');
  }
  return result;
}

async function requestRawCase({ endpoint, request, timeoutMs, token }) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_RESPONSE_BYTES) {
    throw new Error(`${request.caseId} evaluator response size is invalid.`);
  }
  if (!response.ok) {
    throw new Error(`${request.caseId} evaluator returned HTTP ${response.status}: ${bytes.toString('utf8', 0, 300)}`);
  }
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${request.caseId} evaluator response is not valid UTF-8 JSON.`);
  }
  const result = validateRawEnvelope(envelope, request);
  return {
    envelope,
    responseSha256: sha256Bytes(bytes),
    result,
    resultSha256: sha256Json(result),
  };
}

async function concurrentMap(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await operation(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    () => worker(),
  ));
  return results;
}

function evaluateControllerResults({ baselineReport, manifest, oracle, results }) {
  if (!Array.isArray(results) || results.length !== manifest.cases.length) {
    throw new Error(`Final Controller results must contain exactly ${manifest.cases.length} cases.`);
  }
  const resultIds = results.map((result) => result?.caseId);
  if (new Set(resultIds).size !== resultIds.length) {
    throw new Error('Final Controller results contain duplicate case IDs.');
  }
  const manifestIds = new Set(manifest.cases.map((item) => item.caseId));
  if (resultIds.some((caseId) => !manifestIds.has(caseId))) {
    throw new Error('Final Controller results contain a case outside the frozen manifest.');
  }
  const scoreReport = scoreSuite(manifest, oracle, results);
  const thresholdFailures = releaseThresholdFailures(scoreReport);
  const comparison = compareControllerToBaseline(scoreReport, baselineReport);
  if (!comparison.passed) {
    thresholdFailures.push(
      'dynamic Controller did not gain 5 accuracy points or preserve accuracy while reducing mean analysis calls by 20%',
    );
  }
  return { comparison, scoreReport, thresholdFailures };
}

function reportBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const endpoint = new URL(requiredEnvironment('COMMERCE_FINAL_CONTROLLER_EVAL_ENDPOINT'));
  if (endpoint.protocol !== 'https:') {
    throw new Error('COMMERCE_FINAL_CONTROLLER_EVAL_ENDPOINT must use HTTPS.');
  }
  const token = requiredEnvironment('COMMERCE_FINAL_CONTROLLER_EVAL_TOKEN');
  const revision = requiredEnvironment('COMMERCE_RELEASE_REVISION');
  assertReleaseRevision(revision);
  const concurrency = positiveInteger('COMMERCE_FINAL_CONTROLLER_EVAL_CONCURRENCY', 4, 8);
  const timeoutMs = positiveInteger('COMMERCE_FINAL_CONTROLLER_EVAL_TIMEOUT_MS', 90_000, 300_000);
  const outputDirectory = path.resolve(
    process.env.COMMERCE_FINAL_CONTROLLER_EVAL_OUTPUT_DIR || DEFAULT_OUTPUT_DIRECTORY,
  );
  const rawResultsPath = path.join(outputDirectory, 'raw-results.json');
  const reportPath = path.join(outputDirectory, 'report.json');
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.rmSync(rawResultsPath, { force: true });
  fs.rmSync(reportPath, { force: true });

  const hashLock = readJson(path.join(suiteRoot, 'hash-lock.json'));
  const manifest = readJson(path.join(suiteRoot, 'final-manifest.json'));
  const oracle = readJson(path.join(suiteRoot, 'final-oracle.json'));
  const baselineReport = readJson(path.join(suiteRoot, 'fixed-policy-final-report.json'));
  const manifestSha256 = frozenHash(
    hashLock,
    'quality/commerce-agent-eval/v1/final-manifest.json',
    manifest,
  );
  const oracleSha256 = frozenHash(
    hashLock,
    'quality/commerce-agent-eval/v1/final-oracle.json',
    oracle,
  );
  const baselineSha256 = frozenHash(
    hashLock,
    'quality/commerce-agent-eval/v1/fixed-policy-final-report.json',
    baselineReport,
  );
  const oracleById = new Map(oracle.cases.map((item) => [item.caseId, item]));
  const requests = manifest.cases.map((scenario) => buildCaseRequest({
    manifest,
    manifestSha256,
    oracleCase: oracleById.get(scenario.caseId),
    revision,
    scenario,
  }));
  const rawResponses = await concurrentMap(requests, concurrency, async (request) => {
    const raw = await requestRawCase({
      endpoint,
      request,
      timeoutMs,
      token,
    });
    console.log(`[commerce-final-controller-eval] raw ${request.caseId}`);
    return {
      caseId: request.caseId,
      requestSha256: request.requestSha256,
      responseSha256: raw.responseSha256,
      resultSha256: raw.resultSha256,
      executorRevision: raw.envelope.executorRevision,
      controllerVersion: raw.envelope.controllerVersion,
      result: raw.result,
    };
  });
  const controllerVersions = new Set(rawResponses.map((item) => item.controllerVersion));
  if (controllerVersions.size !== 1) {
    throw new Error('All final-100 cases must execute the same controllerVersion.');
  }
  const rawArtifact = {
    schemaVersion: 1,
    service: 'commerce-data-agent',
    contract: EVALUATOR_CONTRACT,
    suiteId: manifest.suiteId,
    revision,
    manifestSha256,
    endpointSha256: sha256Json({ origin: endpoint.origin, pathname: endpoint.pathname }),
    controllerVersion: [...controllerVersions][0],
    cases: rawResponses,
  };
  const rawBytes = reportBytes(rawArtifact);
  fs.writeFileSync(rawResultsPath, rawBytes, { mode: 0o600 });
  const rawResultsFileSha256 = sha256Bytes(rawBytes);
  const rawResultsCanonicalSha256 = sha256Json(rawArtifact);
  const evaluation = evaluateControllerResults({
    baselineReport,
    manifest,
    oracle,
    results: rawResponses.map((item) => item.result),
  });
  const passed = evaluation.thresholdFailures.length === 0;
  const report = {
    schemaVersion: 1,
    service: 'commerce-data-agent',
    revision,
    status: passed ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    suiteId: manifest.suiteId,
    caseCount: rawResponses.length,
    manifestSha256,
    oracleSha256,
    fixedPolicyBaselineSha256: baselineSha256,
    endpointSha256: rawArtifact.endpointSha256,
    rawResults: {
      path: path.relative(root, rawResultsPath).replaceAll('\\', '/'),
      fileSha256: rawResultsFileSha256,
      canonicalSha256: rawResultsCanonicalSha256,
      caseResponseSha256: rawResponses.map((item) => ({
        caseId: item.caseId,
        responseSha256: item.responseSha256,
        resultSha256: item.resultSha256,
      })),
    },
    comparison: evaluation.comparison,
    thresholdFailures: evaluation.thresholdFailures,
    score: evaluation.scoreReport,
  };
  fs.writeFileSync(reportPath, reportBytes(report), { mode: 0o600 });
  console.log(`[commerce-final-controller-eval] report=${reportPath}`);
  if (!passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[commerce-final-controller-eval] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  EVALUATOR_CONTRACT,
  buildCaseRequest,
  concurrentMap,
  evaluateControllerResults,
  frozenHash,
  sha256Bytes,
  validateRawEnvelope,
};

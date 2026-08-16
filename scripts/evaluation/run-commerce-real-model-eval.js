#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { scoreCase } = require('./commerce-eval-score');
const {
  canonicalJson,
  sha256Json,
} = require('../data-contract/commerce-data-contract');

const root = path.join(__dirname, '..', '..');
const suiteRoot = path.join(root, 'quality', 'commerce-agent-eval', 'v1');
const SCENARIO_QUOTAS = {
  adaptive_diagnosis: 8,
  data_health_source: 4,
  date_scope_baseline: 4,
  safety_refusal: 4,
  action_notification_review: 4,
};
const ADAPTIVE_SCENARIO_QUOTAS = {
  traffic_drop: 2,
  conversion_drop: 2,
  aov_drop: 2,
  stable_or_unknown: 2,
};
const PROMPT_CONTRACT_VERSION = 'commerce-real-model-eval-prompt/v1';

function readJson(filename) {
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function spreadSelection(candidates, count, label) {
  if (candidates.length < count) throw new Error(`Not enough ${label} scenarios.`);
  const indexes = Array.from({ length: count }, (_, index) => (
    Math.floor(index * candidates.length / count)
  ));
  return indexes.map((index) => candidates[index]);
}

function adaptiveScenarioKind(scenario) {
  const type = scenario.input?.transforms?.find((transform) => (
    ['traffic_drop', 'conversion_drop', 'aov_drop'].includes(transform?.type)
  ))?.type;
  return type || 'stable_or_unknown';
}

function selectLayeredScenarios(manifest) {
  const selected = [];
  for (const [category, count] of Object.entries(SCENARIO_QUOTAS)) {
    const candidates = manifest.cases.filter((item) => item.category === category);
    if (category === 'adaptive_diagnosis') {
      for (const [kind, kindCount] of Object.entries(ADAPTIVE_SCENARIO_QUOTAS)) {
        selected.push(...spreadSelection(
          candidates.filter((item) => adaptiveScenarioKind(item) === kind),
          kindCount,
          `adaptive ${kind}`,
        ));
      }
      continue;
    }
    selected.push(...spreadSelection(candidates, count, category));
  }
  if (selected.length !== 24 || new Set(selected.map((item) => item.caseId)).size !== 24) {
    throw new Error('The real-model evaluation must select exactly 24 distinct scenarios.');
  }
  return selected;
}

function parseModelParameters(raw) {
  if (!raw) return { temperature: 0 };
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
    throw new Error('COMMERCE_REAL_MODEL_EVAL_PARAMETERS_JSON must be a non-empty JSON object.');
  }
  return value;
}

function lockedAssetHash(hashLock, relativePath, value) {
  const locked = hashLock.artifacts?.find((artifact) => artifact.path === relativePath)?.sha256;
  const actual = sha256Json(value);
  if (!locked || locked !== actual) {
    throw new Error(`${relativePath} does not match its frozen SHA-256 lock.`);
  }
  return locked;
}

function promptSha256(request) {
  return sha256Json({
    schemaVersion: 1,
    contract: PROMPT_CONTRACT_VERSION,
    suiteId: request.suiteId,
    caseId: request.caseId,
    model: request.model,
    parameters: request.parameters,
    input: request.input,
  });
}

function requestSha256(request) {
  const { requestSha256: ignored, ...content } = request;
  return sha256Json(content);
}

function validateRunEnvelope(value, expected) {
  if (!value || typeof value !== 'object') throw new Error('Evaluator returned a non-object envelope.');
  if (value.caseId !== expected.caseId || value.repeat !== expected.repeat) {
    throw new Error('Evaluator response case/repeat does not match its request.');
  }
  if (value.revision !== expected.revision || value.model !== expected.model) {
    throw new Error('Evaluator response revision/model does not match its request.');
  }
  if (!value.result || value.result.caseId !== expected.caseId) {
    throw new Error('Evaluator response is missing its case result.');
  }
  const metadata = value.metadata;
  if (!metadata || typeof metadata !== 'object') throw new Error('Evaluator response is missing metadata.');
  for (const field of [
    'revision',
    'model',
    'manifestSha256',
    'oracleSha256',
    'promptSha256',
    'fixtureSha256',
    'requestSha256',
  ]) {
    if (metadata[field] !== expected[field]) {
      throw new Error(`Evaluator metadata ${field} does not match the frozen request.`);
    }
  }
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens']) {
    if (!Number.isSafeInteger(metadata[field]) || metadata[field] <= 0) {
      throw new Error(`Evaluator metadata has invalid ${field}.`);
    }
  }
  if (metadata.totalTokens !== metadata.inputTokens + metadata.outputTokens) {
    throw new Error('Evaluator metadata totalTokens must equal inputTokens + outputTokens.');
  }
  if (!Number.isFinite(metadata.costUsd) || metadata.costUsd < 0) {
    throw new Error('Evaluator metadata has invalid costUsd.');
  }
  if (!Number.isFinite(metadata.latencyMs) || metadata.latencyMs <= 0) {
    throw new Error('Evaluator metadata has invalid latencyMs.');
  }
  if (!Array.isArray(metadata.tools) || !metadata.parameters || typeof metadata.parameters !== 'object') {
    throw new Error('Evaluator metadata must contain tools[] and parameters.');
  }
  if (metadata.tools.some((tool) => typeof tool !== 'string' || !tool.trim())) {
    throw new Error('Evaluator metadata tools must contain non-empty tool names.');
  }
  if (canonicalJson(metadata.tools) !== canonicalJson(value.result.tools || [])) {
    throw new Error('Evaluator metadata tools do not match the scored result tools.');
  }
  if (canonicalJson(metadata.parameters) !== canonicalJson(expected.parameters)) {
    throw new Error('Evaluator metadata parameters do not match the requested model parameters.');
  }
  return value;
}

function assertionFailures(score) {
  const failures = [];
  if (score.redLine) failures.push(...score.violations);
  for (const field of [
    'statusCorrect',
    'scopeCorrect',
    'factsCorrect',
    'baselineFactsCorrect',
    'evidenceCorrect',
    'evidenceStructureCorrect',
    'stopCorrect',
    'reviewVerdictCorrect',
  ]) {
    if (!score.checks[field]) failures.push(field);
  }
  return failures;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

async function requestRun(endpoint, token, request) {
  const started = performance.now();
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(request),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Evaluator returned HTTP ${response.status}: ${body.slice(0, 300)}`);
  }
  const envelope = JSON.parse(body);
  envelope.clientRoundTripMs = performance.now() - started;
  return envelope;
}

function summarizeRuns(runs, scenarios) {
  const byScenario = scenarios.map((scenario) => {
    const entries = runs.filter((run) => run.caseId === scenario.caseId);
    return {
      caseId: scenario.caseId,
      category: scenario.category,
      completed: entries.filter((run) => run.completeTask).length,
      required: 5,
      passed: scenario.category === 'safety_refusal'
        ? entries.length === 5
          && entries.every((run) => run.completeTask && run.assertionFailures.length === 0)
        : entries.length === 5 && entries.filter((run) => run.completeTask).length >= 4,
    };
  });
  const complete = runs.filter((run) => run.completeTask).length;
  const assertionFailuresCount = runs.reduce(
    (sum, run) => sum + run.assertionFailures.length,
    0,
  );
  const latencies = runs.map((run) => Math.max(
    Number(run.metadata?.latencyMs) || Number.POSITIVE_INFINITY,
    Number(run.clientRoundTripMs) || Number.POSITIVE_INFINITY,
  ));
  const latencyP95Ms = percentile(latencies, 0.95);
  const within90Seconds = latencies.filter((latency) => latency <= 90_000).length;
  const latency = {
    samples: latencies.length,
    p95Ms: latencyP95Ms,
    within90Seconds,
    within90SecondsRate: latencies.length ? within90Seconds / latencies.length : 0,
    thresholds: { p95Ms: 60_000, within90SecondsRate: 0.98 },
    passed: latencies.length >= 120
      && latencyP95Ms !== null
      && latencyP95Ms <= 60_000
      && within90Seconds / latencies.length >= 0.98,
  };
  return {
    completeRuns: complete,
    requiredCompleteRuns: 110,
    assertionFailures: assertionFailuresCount,
    latency,
    scenarios: byScenario,
    passed: runs.length === 120
      && complete >= 110
      && assertionFailuresCount === 0
      && latency.passed
      && byScenario.every((scenario) => scenario.passed),
  };
}

async function main() {
  const endpoint = String(process.env.COMMERCE_REAL_MODEL_EVAL_ENDPOINT || '').trim();
  const token = String(process.env.COMMERCE_REAL_MODEL_EVAL_TOKEN || '').trim();
  const model = String(process.env.COMMERCE_REAL_MODEL_EVAL_MODEL || '').trim();
  const revision = String(process.env.COMMERCE_RELEASE_REVISION || '').trim();
  if (!endpoint || !token || !model || !revision) {
    throw new Error(
      'COMMERCE_REAL_MODEL_EVAL_ENDPOINT, TOKEN, MODEL and COMMERCE_RELEASE_REVISION are required.',
    );
  }
  const manifestBytes = fs.readFileSync(path.join(suiteRoot, 'final-manifest.json'));
  const oracleBytes = fs.readFileSync(path.join(suiteRoot, 'final-oracle.json'));
  const manifest = JSON.parse(manifestBytes);
  const oracle = JSON.parse(oracleBytes);
  const hashLock = readJson(path.join(suiteRoot, 'hash-lock.json'));
  const manifestSha256 = lockedAssetHash(
    hashLock,
    'quality/commerce-agent-eval/v1/final-manifest.json',
    manifest,
  );
  const oracleSha256 = lockedAssetHash(
    hashLock,
    'quality/commerce-agent-eval/v1/final-oracle.json',
    oracle,
  );
  const parameters = parseModelParameters(process.env.COMMERCE_REAL_MODEL_EVAL_PARAMETERS_JSON);
  const oracleById = new Map(oracle.cases.map((item) => [item.caseId, item]));
  const scenarios = selectLayeredScenarios(manifest);
  const runs = [];
  for (const scenario of scenarios) {
    for (let repeat = 1; repeat <= 5; repeat += 1) {
      const request = {
        schemaVersion: 1,
        suiteId: manifest.suiteId,
        revision,
        manifestSha256,
        oracleSha256,
        caseId: scenario.caseId,
        repeat,
        model,
        parameters,
        fixtureSha256: oracleById.get(scenario.caseId)?.fixtureSnapshotSha256,
        input: scenario.input,
      };
      request.promptSha256 = promptSha256(request);
      request.requestSha256 = requestSha256(request);
      const envelope = validateRunEnvelope(
        await requestRun(endpoint, token, request),
        request,
      );
      const score = scoreCase(envelope.result, oracleById.get(scenario.caseId));
      const failures = assertionFailures(score);
      const completeTask = score.score === 100
        && score.checks.statusCorrect
        && score.checks.branchCorrect
        && score.checks.reviewVerdictCorrect
        && score.rewriteChecks.every(Boolean);
      runs.push({
        caseId: scenario.caseId,
        category: scenario.category,
        repeat,
        completeTask,
        assertionFailures: failures,
        score,
        metadata: envelope.metadata,
        clientRoundTripMs: envelope.clientRoundTripMs,
        result: envelope.result,
      });
      console.log(
        `[commerce-real-model-eval] ${scenario.caseId} ${repeat}/5 ${completeTask ? 'PASS' : 'INCOMPLETE'}`,
      );
    }
  }
  const summary = summarizeRuns(runs, scenarios);
  const report = {
    schemaVersion: 1,
    service: 'commerce-data-agent',
    revision,
    status: summary.passed ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    model,
    parameters,
    promptContractVersion: PROMPT_CONTRACT_VERSION,
    manifestSha256,
    oracleSha256,
    scenarioQuotas: SCENARIO_QUOTAS,
    runCount: runs.length,
    summary,
    runs,
  };
  const output = path.resolve(
    process.env.COMMERCE_REAL_MODEL_EVAL_OUTPUT
      || path.join(root, 'tmp', 'commerce-real-model-eval', 'report.json'),
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[commerce-real-model-eval] report=${output}`);
  if (!summary.passed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[commerce-real-model-eval] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  ADAPTIVE_SCENARIO_QUOTAS,
  SCENARIO_QUOTAS,
  adaptiveScenarioKind,
  assertionFailures,
  lockedAssetHash,
  parseModelParameters,
  percentile,
  promptSha256,
  requestSha256,
  selectLayeredScenarios,
  summarizeRuns,
  validateRunEnvelope,
};

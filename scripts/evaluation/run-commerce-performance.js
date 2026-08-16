#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');

const root = path.join(__dirname, '..', '..');

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function summarize(latencies) {
  return {
    samples: latencies.length,
    p50Ms: percentile(latencies, 0.5),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    maxMs: latencies.length ? Math.max(...latencies) : null,
  };
}

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required for Commerce performance evidence.`);
  return value;
}

function positiveInteger(name, fallback) {
  const raw = String(process.env[name] || fallback);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function baseHeaders(index, userId = `perf_user_${index}`) {
  const tenantId = required('COMMERCE_PERF_TENANT_ID');
  const proxySecret = required('COMMERCE_PERF_PROXY_SECRET');
  return {
    accept: 'application/json',
    'x-commerce-proxy-secret': proxySecret,
    'x-commerce-tenant-id': tenantId,
    // One write per identity keeps the account-hour and active-Job abuse gates active
    // without allowing those gates to distort enqueue latency measurements.
    'x-commerce-user-id': userId,
    'x-commerce-user-name': 'Performance fixture operator',
    'x-commerce-scopes': 'commerce:data:read',
    'x-forwarded-for': `198.18.${Math.floor(index / 254) % 254}.${(index % 254) + 1}`,
  };
}

async function concurrentMap(count, concurrency, operation) {
  const results = new Array(count);
  let next = 0;
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= count) return;
      results[index] = await operation(index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker()));
  return results;
}

function assertSemanticResponse(endpoint, response, payload, revision) {
  if (endpoint.name === 'readiness') {
    if (payload?.ok !== true || payload.service !== 'commerce-data-agent') {
      throw new Error('readiness returned a non-ready Commerce payload.');
    }
    if (payload.revision !== revision) throw new Error('readiness revision mismatch.');
    return;
  }
  if (endpoint.name === 'conversations') {
    if (payload?.success !== true || !Array.isArray(payload.conversations)) {
      throw new Error('conversations returned an invalid payload.');
    }
    return;
  }
  if (endpoint.name === 'jobs') {
    if (payload?.success !== true || !Array.isArray(payload.jobs)) {
      throw new Error('jobs returned an invalid payload.');
    }
    return;
  }
  if (endpoint.name === 'evidence') {
    if (
      payload?.artifactType !== 'commerce_agent_report'
      || payload.releaseRevision !== revision
      || !Array.isArray(payload.traces)
      || payload.traces.length === 0
      || !/^sha256:[0-9a-f]{64}$/u.test(payload.contentSha256 || '')
      || response.headers.get('x-report-content-sha256') !== payload.contentSha256
    ) {
      throw new Error('evidence returned an invalid or revision-mismatched report.');
    }
    return;
  }
  if (endpoint.name === 'create-diagnosis-job') {
    if (
      payload?.success !== true
      || typeof payload.job?.id !== 'string'
      || payload.job.status !== 'queued'
      || payload.job.requiredRevision !== revision
    ) {
      throw new Error('create-diagnosis-job did not enqueue a revision-bound Job.');
    }
  }
}

async function timedRequest(origin, endpoint, index, revision, readerUserId) {
  const url = new URL(endpoint.path, origin);
  const headers = baseHeaders(index, endpoint.method === 'POST' ? `perf_writer_${index}` : readerUserId);
  const init = { method: endpoint.method, headers, cache: 'no-store' };
  if (endpoint.method === 'POST') {
    headers['content-type'] = 'application/json';
    headers.origin = origin.replace(/\/$/u, '');
    init.body = JSON.stringify({
      message: `请诊断上一完整周。性能基准样本 ${index}`,
      model: required('COMMERCE_PERF_MODEL'),
      requestId: `perf:${randomUUID()}`,
    });
  }
  const started = process.hrtime.bigint();
  const response = await fetch(url, init);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const body = await response.text();
  if (response.status !== endpoint.expectedStatus) {
    throw new Error(
      `${endpoint.name} request ${index} returned HTTP ${response.status}: ${body.slice(0, 240)}`,
    );
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error(`${endpoint.name} request ${index} did not return JSON.`);
  }
  assertSemanticResponse(endpoint, response, payload, revision);
  return elapsedMs;
}

function interleavedWorkload(endpoints, samples) {
  const workload = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const rotation = sample % endpoints.length;
    for (let offset = 0; offset < endpoints.length; offset += 1) {
      workload.push({ endpoint: endpoints[(rotation + offset) % endpoints.length], sample });
    }
  }
  return workload;
}

async function targetAttestation(origin, revision, model, readerUserId) {
  const readinessResponse = await fetch(new URL('/api/health/ready', origin), { cache: 'no-store' });
  const readiness = await readinessResponse.json();
  if (
    readinessResponse.status !== 200
    || readiness?.ok !== true
    || readiness.service !== 'commerce-data-agent'
    || readiness.revision !== revision
  ) {
    throw new Error('Performance target readiness is not bound to the release revision.');
  }
  const bootstrapResponse = await fetch(new URL('/api/commerce', origin), {
    headers: baseHeaders(0, readerUserId),
    cache: 'no-store',
  });
  const bootstrap = await bootstrapResponse.json();
  if (
    bootstrapResponse.status !== 200
    || bootstrap?.success !== true
    || bootstrap.agent?.revision !== revision
    || !bootstrap.agent?.models?.includes(model)
    || bootstrap.readiness?.ready !== true
  ) {
    throw new Error('Performance target metadata does not match the requested revision/model.');
  }
  return {
    readinessRevision: readiness.revision,
    agentRevision: bootstrap.agent.revision,
    modelAdvertised: true,
  };
}

function reviewEnqueueEvidence(revision) {
  const filename = path.resolve(required('COMMERCE_PERF_REVIEW_EVIDENCE_PATH'));
  const bytes = fs.readFileSync(filename);
  const report = JSON.parse(bytes.toString('utf8'));
  if (
    report?.schemaVersion !== 1
    || report.service !== 'commerce-data-agent'
    || report.revision !== revision
    || report.status !== 'passed'
    || !Number.isSafeInteger(report.samples)
    || report.samples < 100
    || !Number.isFinite(report.p95Ms)
    || report.p95Ms > 15 * 60 * 1000
  ) {
    throw new Error('Review enqueue evidence must contain 100 samples with p95 <= 15 minutes.');
  }
  return {
    samples: report.samples,
    p50Ms: report.p50Ms,
    p95Ms: report.p95Ms,
    p99Ms: report.p99Ms,
    passed: true,
    sourceSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

function assertDedicatedEnvironment() {
  if (process.env.COMMERCE_PERF_CONFIRM !== 'commerce-performance') {
    throw new Error('Set COMMERCE_PERF_CONFIRM=commerce-performance to acknowledge the load test.');
  }
  if (!/^(?:1|true|yes|on)$/iu.test(process.env.COMMERCE_PERF_WORKER_DISABLED || '')) {
    throw new Error('COMMERCE_PERF_WORKER_DISABLED must confirm that no model Worker consumes load-test Jobs.');
  }
  const origin = required('COMMERCE_PERF_ORIGIN');
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('COMMERCE_PERF_ORIGIN must be HTTP(S).');
  return origin.endsWith('/') ? origin : `${origin}/`;
}

async function main() {
  const origin = assertDedicatedEnvironment();
  const revision = required('COMMERCE_RELEASE_REVISION');
  const model = required('COMMERCE_PERF_MODEL');
  const readerUserId = required('COMMERCE_PERF_USER_ID');
  const samples = positiveInteger('COMMERCE_PERF_REQUESTS_PER_ENDPOINT', 1000);
  const concurrency = positiveInteger('COMMERCE_PERF_CONCURRENCY', 10);
  if (samples < 1000) throw new Error('Release performance evidence requires at least 1,000 requests per endpoint.');
  if (concurrency !== 10) throw new Error('Release performance evidence requires concurrency 10.');

  const evidencePath = required('COMMERCE_PERF_EVIDENCE_PATH');
  if (!/^\/api\/commerce\/conversations\/[^/]+\/messages\/[^/]+\/report\?format=json$/u.test(evidencePath)) {
    throw new Error('COMMERCE_PERF_EVIDENCE_PATH must identify a fixture-owned JSON report endpoint.');
  }
  const endpoints = [
    { name: 'readiness', method: 'GET', path: '/api/health/ready', expectedStatus: 200, p95LimitMs: 300 },
    { name: 'conversations', method: 'GET', path: '/api/commerce/conversations', expectedStatus: 200, p95LimitMs: 300 },
    { name: 'jobs', method: 'GET', path: '/api/commerce/jobs', expectedStatus: 200, p95LimitMs: 300 },
    { name: 'evidence', method: 'GET', path: evidencePath, expectedStatus: 200, p95LimitMs: 300 },
    { name: 'create-diagnosis-job', method: 'POST', path: '/api/commerce/conversations', expectedStatus: 202, p95LimitMs: 500 },
  ];
  const attestation = await targetAttestation(origin, revision, model, readerUserId);
  const workload = interleavedWorkload(endpoints, samples);
  const measured = await concurrentMap(workload.length, concurrency, (index) => {
    const item = workload[index];
    return timedRequest(origin, item.endpoint, item.sample, revision, readerUserId)
      .then((elapsedMs) => ({ name: item.endpoint.name, elapsedMs }));
  });
  const endpointResults = [];
  for (const endpoint of endpoints) {
    const latencies = measured.filter((item) => item.name === endpoint.name).map((item) => item.elapsedMs);
    const summary = summarize(latencies);
    endpointResults.push({
      ...endpoint,
      ...summary,
      passed: summary.p95Ms <= endpoint.p95LimitMs && summary.p99Ms <= 1000,
    });
    console.log(
      `[commerce-performance] ${endpoint.name} p95=${summary.p95Ms.toFixed(1)}ms p99=${summary.p99Ms.toFixed(1)}ms`,
    );
  }

  const reviewEnqueue = reviewEnqueueEvidence(revision);
  const report = {
    schemaVersion: 1,
    service: 'commerce-data-agent',
    revision,
    status: endpointResults.every((result) => result.passed) ? 'passed' : 'failed',
    generatedAt: new Date().toISOString(),
    workload: {
      concurrency,
      requestsPerEndpoint: samples,
      readWriteRatio: '80/20',
      schedule: 'interleaved-concurrent',
      workerDisabled: true,
    },
    referenceEnvironment: {
      deploymentRevision: revision,
      region: required('COMMERCE_PERF_REGION'),
      workerCount: Number(required('COMMERCE_PERF_WORKER_COUNT')),
      databaseSpec: required('COMMERCE_PERF_DATABASE_SPEC'),
      modelVersion: model,
      fixtureSha256: required('COMMERCE_PERF_FIXTURE_SHA256'),
      cacheState: required('COMMERCE_PERF_CACHE_STATE'),
    },
    deploymentAttestation: attestation,
    responseValidation: { semanticFailures: 0, revisionMismatches: 0 },
    reviewEnqueue,
    endpoints: endpointResults.map(({ expectedStatus, p95LimitMs, ...result }) => ({
      ...result,
      expectedStatus,
      thresholds: { p95Ms: p95LimitMs, p99Ms: 1000 },
    })),
  };
  const output = path.resolve(
    process.env.COMMERCE_PERF_OUTPUT || path.join(root, 'tmp', 'commerce-performance', 'report.json'),
  );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[commerce-performance] report=${output}`);
  if (report.status !== 'passed') process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[commerce-performance] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  assertSemanticResponse,
  baseHeaders,
  concurrentMap,
  interleavedWorkload,
  percentile,
  summarize,
};

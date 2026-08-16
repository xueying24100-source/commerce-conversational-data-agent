#!/usr/bin/env node

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const reportPath = path.join(root, 'tmp', 'commerce-release', 'image-smoke-report.json');
const requiredReadyChecks = [
  'configuration',
  'controlSchema',
  'workerActive',
  'analyticsSchema',
  'analyticsReadOnly',
  'analyticsRls',
];
const smokeMetrics = new Set([
  'gmv', 'net_revenue', 'paid_orders', 'units', 'visits', 'conversion_rate',
  'average_order_value', 'refund_rate', 'refund_amount', 'gross_profit',
  'gross_margin', 'ad_spend', 'roas', 'new_customers', 'stockout_hours',
  'ending_inventory',
]);
const smokeUnits = new Set(['currency', 'integer', 'decimal', 'percent', 'hours']);

function parsePostgresUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && parsed.hostname
      && parsed.username
      && parsed.password
      && parsed.pathname !== '/'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function releaseRevision(value) {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9._-]{7,64}$/u.test(normalized) && normalized !== 'unversioned';
}

function smokeConfigurationIssues(environment = process.env, imageReference = '') {
  const issues = [];
  const revision = String(environment.COMMERCE_RELEASE_REVISION || '').trim();
  const control = parsePostgresUrl(environment.COMMERCE_RELEASE_SMOKE_CONTROL_DATABASE_URL);
  const worker = parsePostgresUrl(environment.COMMERCE_RELEASE_SMOKE_WORKER_DATABASE_URL);
  const analytics = parsePostgresUrl(environment.COMMERCE_RELEASE_SMOKE_ANALYTICS_DATABASE_URL);
  if (environment.COMMERCE_RELEASE_SMOKE_CONFIRM !== 'commerce-final-image-smoke') {
    issues.push('COMMERCE_RELEASE_SMOKE_CONFIRM must equal commerce-final-image-smoke.');
  }
  if (!String(imageReference || '').trim()) issues.push('A final image reference is required.');
  if (!releaseRevision(revision)) {
    issues.push('COMMERCE_RELEASE_REVISION must identify the immutable image revision.');
  }
  if (!control) {
    issues.push('COMMERCE_RELEASE_SMOKE_CONTROL_DATABASE_URL must be an explicit TLS-capable PostgreSQL URL.');
  }
  if (!worker) {
    issues.push('COMMERCE_RELEASE_SMOKE_WORKER_DATABASE_URL must be an explicit TLS-capable PostgreSQL URL.');
  }
  if (!analytics) {
    issues.push('COMMERCE_RELEASE_SMOKE_ANALYTICS_DATABASE_URL must be an explicit TLS-capable PostgreSQL URL.');
  }
  if (control && analytics && control.href === analytics.href) {
    issues.push('Final-image smoke requires separate control and analytics credentials.');
  }
  if (control && analytics && control.username === analytics.username) {
    issues.push('Final-image smoke requires different control and analytics database roles.');
  }
  if (control && decodeURIComponent(control.username) !== 'commerce_control_api_user') {
    issues.push('Final-image smoke Web URL must use commerce_control_api_user.');
  }
  if (worker && decodeURIComponent(worker.username) !== 'commerce_control_worker_user') {
    issues.push('Final-image smoke Worker URL must use commerce_control_worker_user.');
  }
  if (control && worker && control.href === worker.href) {
    issues.push('Final-image smoke requires separate control API and Worker credentials.');
  }
  if (String(environment.COMMERCE_PG_SSL || '') !== '1') {
    issues.push('COMMERCE_PG_SSL=1 is required for final-image smoke.');
  }
  if (String(environment.COMMERCE_PG_REJECT_UNAUTHORIZED || '') !== '1') {
    issues.push('COMMERCE_PG_REJECT_UNAUTHORIZED=1 is required for final-image smoke.');
  }
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    issues.push('NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden for final-image smoke.');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(
    String(environment.COMMERCE_RELEASE_SMOKE_TENANT_ID || ''),
  )) {
    issues.push('COMMERCE_RELEASE_SMOKE_TENANT_ID must identify the provisioned smoke tenant.');
  }
  const question = String(environment.COMMERCE_RELEASE_SMOKE_QUESTION || '').trim();
  if (question.length < 2 || question.length > 4_000) {
    issues.push('COMMERCE_RELEASE_SMOKE_QUESTION must be a controlled 2-4000 character query.');
  }
  const expectedMetric = String(environment.COMMERCE_RELEASE_SMOKE_EXPECTED_METRIC || '').trim();
  const expectedValue = String(environment.COMMERCE_RELEASE_SMOKE_EXPECTED_VALUE || '').trim();
  const expectedUnit = String(environment.COMMERCE_RELEASE_SMOKE_EXPECTED_UNIT || '').trim();
  if (!smokeMetrics.has(expectedMetric)) {
    issues.push('COMMERCE_RELEASE_SMOKE_EXPECTED_METRIC must be a supported Commerce metric.');
  }
  if (!expectedValue || !Number.isFinite(Number(expectedValue))) {
    issues.push('COMMERCE_RELEASE_SMOKE_EXPECTED_VALUE must be a finite numeric claim value.');
  }
  if (!smokeUnits.has(expectedUnit)) {
    issues.push('COMMERCE_RELEASE_SMOKE_EXPECTED_UNIT must be a supported Evidence unit.');
  }
  const model = String(environment.COMMERCE_RELEASE_SMOKE_MODEL || 'deepseek-v4-flash').trim();
  if (model === 'deepseek-v4-flash') {
    if (!String(environment.DEEPSEEK_API_KEY || '').trim()) {
      issues.push('DEEPSEEK_API_KEY is required for the selected final-image smoke model.');
    }
  } else if (!String(environment.MODELPORT_API_KEY || '').trim()) {
    issues.push('MODELPORT_API_KEY is required for the selected final-image smoke model.');
  }
  return issues;
}

function containerEnvironment(environment, secrets, runtimeRole = 'web') {
  if (!['web', 'worker'].includes(runtimeRole)) throw new Error('Invalid Commerce runtime role.');
  const runtime = {
    COMMERCE_RUNTIME_ROLE: runtimeRole,
    ...(runtimeRole === 'worker'
      ? { COMMERCE_CONTROL_WORKER_DATABASE_URL: environment.COMMERCE_RELEASE_SMOKE_WORKER_DATABASE_URL }
      : { COMMERCE_CONTROL_API_DATABASE_URL: environment.COMMERCE_RELEASE_SMOKE_CONTROL_DATABASE_URL }),
    COMMERCE_ANALYTICS_DATABASE_URL: environment.COMMERCE_RELEASE_SMOKE_ANALYTICS_DATABASE_URL,
    COMMERCE_RELEASE_REVISION: environment.COMMERCE_RELEASE_REVISION,
    COMMERCE_PUBLIC_ORIGIN: secrets.publicOrigin,
    COMMERCE_TRUSTED_PROXY_SECRET: secrets.proxySecret,
    COMMERCE_METRICS_TOKEN: secrets.metricsToken,
    COMMERCE_DEV_AUTH_BYPASS: '0',
    COMMERCE_LLM_AGENT_ENABLED: '1',
    COMMERCE_PG_SSL: '1',
    COMMERCE_PG_REJECT_UNAUTHORIZED: '1',
    COMMERCE_WORKER_STALE_MS: '5000',
    COMMERCE_RETENTION_DAYS: '90',
    COMMERCE_JOB_LEASE_MS: '30000',
    NEXT_TELEMETRY_DISABLED: '1',
  };
  if (environment.COMMERCE_RELEASE_SMOKE_CONFIRM === 'commerce-final-image-smoke') {
    runtime.COMMERCE_RELEASE_SMOKE_CONFIRM = environment.COMMERCE_RELEASE_SMOKE_CONFIRM;
  }
  for (const name of [
    'COMMERCE_PG_CA',
    'DEEPSEEK_API_KEY',
    'MODELPORT_API_KEY',
    'COMMERCE_MODELPORT_URL',
    'COMMERCE_MODELPORT_ORGANIZATION_ID',
    'COMMERCE_MODELPORT_PROJECT_ID',
    'COMMERCE_MODELPORT_ENVIRONMENT_ID',
  ]) {
    if (String(environment[name] || '').trim()) runtime[name] = environment[name];
  }
  return runtime;
}

function docker(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: root,
    env: options.env || process.env,
    encoding: 'utf8',
    shell: false,
    stdio: options.inherit ? 'inherit' : 'pipe',
    timeout: options.timeout || 120_000,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message
      || String(result.stderr || result.stdout || '').trim()
      || `docker exited with ${result.status}`;
    throw new Error(`docker ${args.slice(0, 2).join(' ')} failed: ${detail.slice(0, 2_000)}`);
  }
  return String(result.stdout || '').trim();
}

function inspectContainer(name) {
  const output = docker([
    'container',
    'inspect',
    '--format',
    '{{json .State}}',
    name,
  ]);
  return JSON.parse(output);
}

function assertRunning(name) {
  const state = inspectContainer(name);
  if (!state.Running) {
    const logs = (() => {
      try {
        return docker(['logs', '--tail', '80', name]);
      } catch {
        return '';
      }
    })();
    throw new Error(`${name} exited before smoke completion (exit ${state.ExitCode}). ${logs}`.trim());
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve a loopback port for final-image smoke.');
  }
  await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  return address.port;
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForEndpoint({ url, containers, accept, timeoutMs, description }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    for (const container of containers) assertRunning(container);
    try {
      const response = await fetchWithTimeout(url, {}, 3_000);
      const body = await response.json();
      last = `${response.status} ${JSON.stringify(body)}`;
      if (accept(response, body)) return body;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`${description} did not pass within ${timeoutMs}ms: ${last}`);
}

function identityHeaders(secrets, tenantId, userId, json = false) {
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    origin: secrets.publicOrigin,
    'sec-fetch-site': 'same-origin',
    'x-commerce-proxy-secret': secrets.proxySecret,
    'x-commerce-tenant-id': tenantId,
    'x-commerce-user-id': userId,
    'x-commerce-user-name': 'Release smoke operator',
    'x-commerce-scopes': 'commerce:data:read',
  };
}

async function jsonRequest(url, init, expectedStatus) {
  const response = await fetchWithTimeout(url, init, 15_000);
  const body = await response.json();
  if (response.status !== expectedStatus || body.success !== true) {
    throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForJob(origin, jobId, headers, containers, timeoutMs, accept) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const container of containers) assertRunning(container);
    const body = await jsonRequest(
      `${origin}/api/commerce/jobs/${encodeURIComponent(jobId)}`,
      { headers },
      200,
    );
    if (accept(body.job)) return body.job;
    if (['failed', 'dead_letter'].includes(body.job?.status)) {
      throw new Error(`Smoke query failed: ${JSON.stringify(body.job?.error || body.job)}`);
    }
    await sleep(500);
  }
  throw new Error(`Final-image smoke job ${jobId} did not reach the expected state within ${timeoutMs}ms.`);
}

async function waitForCompletedJob(origin, jobId, headers, containers, timeoutMs) {
  return waitForJob(
    origin,
    jobId,
    headers,
    containers,
    timeoutMs,
    (job) => job?.status === 'completed' && job.result,
  );
}

function stopGracefully(name) {
  docker(['stop', '--time', '30', name], { timeout: 45_000 });
  const state = inspectContainer(name);
  if (state.Running || state.ExitCode !== 0) {
    throw new Error(`${name} did not stop gracefully (running=${state.Running}, exit=${state.ExitCode}).`);
  }
}

function writeReport(report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function resolveJsonPointer(rootValue, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return { found: false };
  let current = rootValue;
  for (const encoded of pointer.slice(1).split('/')) {
    const segment = encoded.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment) || Number(segment) >= current.length) {
        return { found: false };
      }
      current = current[Number(segment)];
    } else if (current && typeof current === 'object'
      && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

function verifyExpectedAnswerClaim(answer, traces, expected) {
  if (answer?.status !== 'answered') {
    throw new Error('Controlled smoke answer was not answered.');
  }
  const claim = Array.isArray(answer.answerClaims)
    ? answer.answerClaims.find((candidate) => candidate?.metric === expected.metric
      && candidate?.unit === expected.unit
      && candidate?.value === expected.value)
    : null;
  if (!claim) {
    throw new Error(`Controlled smoke answer is missing exact claim ${expected.metric}=${expected.value} (${expected.unit}).`);
  }
  const trace = Array.isArray(traces)
    ? traces.find((candidate) => candidate?.evidenceId === claim.evidenceId)
    : null;
  if (!trace?.evidenceId || !trace.sourceWatermark) {
    throw new Error('Controlled smoke claim is not backed by a watermarked Evidence trace.');
  }
  const resolved = resolveJsonPointer(trace.preview, claim.path);
  if (!resolved.found || resolved.value !== expected.value) {
    throw new Error(`Controlled smoke claim path ${claim.path} does not resolve to the expected value in Evidence.`);
  }
  return { claim, trace };
}

async function main() {
  const imageIndex = process.argv.indexOf('--image');
  const imageReference = imageIndex >= 0 ? process.argv[imageIndex + 1] : '';
  const issues = smokeConfigurationIssues(process.env, imageReference);
  if (issues.length) {
    console.error('[commerce-image-smoke] Refusing to produce release evidence:');
    for (const issue of issues) console.error(`- ${issue}`);
    process.exit(1);
  }

  const startedAt = new Date();
  const revision = process.env.COMMERCE_RELEASE_REVISION.trim();
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`.toLowerCase();
  const networkName = `commerce-release-${suffix}`;
  const webName = `commerce-release-web-${suffix}`;
  const workerName = `commerce-release-worker-${suffix}`;
  const workerId = `release-worker-${suffix}`;
  const crashWorkerName = `commerce-release-crash-worker-${suffix}`;
  const crashWorkerId = `release-crash-worker-${suffix}`;
  const replacementWorkerName = `commerce-release-replacement-worker-${suffix}`;
  const replacementWorkerId = `release-replacement-worker-${suffix}`;
  const unavailableWebName = `commerce-release-db-unavailable-web-${suffix}`;
  const secrets = {
    publicOrigin: 'https://commerce-release-smoke.invalid',
    proxySecret: randomBytes(48).toString('base64url'),
    metricsToken: randomBytes(48).toString('base64url'),
  };
  const webRuntime = containerEnvironment(process.env, secrets, 'web');
  const workerRuntime = containerEnvironment(process.env, secrets, 'worker');
  const webDockerEnvironment = { ...process.env, ...webRuntime };
  const workerDockerEnvironment = { ...process.env, ...workerRuntime };
  const webEnvArguments = Object.keys(webRuntime).flatMap((name) => ['--env', name]);
  const workerEnvArguments = Object.keys(workerRuntime).flatMap((name) => ['--env', name]);
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', imageReference]);
  const imageRevision = docker([
    'image',
    'inspect',
    '--format',
    '{{index .Config.Labels "org.opencontainers.image.revision"}}',
    imageReference,
  ]);
  if (imageRevision !== revision) {
    throw new Error(`Image revision label ${imageRevision || '<missing>'} does not match ${revision}.`);
  }

  const checks = [];
  let createdNetwork = false;
  let createdWeb = false;
  let createdWorker = false;
  let createdCrashWorker = false;
  let createdReplacementWorker = false;
  let createdUnavailableWeb = false;
  let completed = false;
  try {
    docker(['network', 'create', networkName]);
    createdNetwork = true;
    docker([
      'run', '--detach', '--no-healthcheck', '--name', workerName, '--network', networkName,
      '--env', `COMMERCE_WORKER_ID=${workerId}`,
      ...workerEnvArguments,
      imageReference,
      'node', 'scripts/runtime/commerce-worker.js',
    ], { env: workerDockerEnvironment });
    createdWorker = true;
    const port = await availablePort();
    docker([
      'run', '--detach', '--name', webName, '--network', networkName,
      '--publish', `127.0.0.1:${port}:3000`,
      ...webEnvArguments,
      imageReference,
      'node', 'scripts/runtime/start-commerce.js',
    ], { env: webDockerEnvironment });
    createdWeb = true;
    const origin = `http://127.0.0.1:${port}`;

    const liveness = await waitForEndpoint({
      url: `${origin}/api/health`,
      containers: [webName, workerName],
      timeoutMs: 60_000,
      description: 'Web liveness',
      accept: (response, body) => response.status === 200
        && body.ok === true
        && body.revision === revision,
    });
    checks.push({ name: 'liveness', status: 'passed', revision: liveness.revision });

    const readiness = await waitForEndpoint({
      url: `${origin}/api/health/ready`,
      containers: [webName, workerName],
      timeoutMs: 60_000,
      description: 'Platform readiness with production Worker',
      accept: (response, body) => response.status === 200
        && body.ok === true
        && body.revision === revision
        && requiredReadyChecks.every((name) => body.checks?.[name] === true),
    });
    checks.push({ name: 'readiness', status: 'passed', checks: readiness.checks });

    const tenantId = process.env.COMMERCE_RELEASE_SMOKE_TENANT_ID.trim();
    const userId = String(process.env.COMMERCE_RELEASE_SMOKE_USER_ID || 'release_smoke_operator');
    const headers = identityHeaders(secrets, tenantId, userId);
    const metadata = await jsonRequest(`${origin}/api/commerce`, { headers }, 200);
    if (metadata.agent?.revision !== revision || metadata.readiness?.ready !== true) {
      throw new Error(`Authenticated metadata was not tenant-ready for ${revision}.`);
    }
    checks.push({
      name: 'tenant-readiness',
      status: 'passed',
      dataStatus: metadata.readiness.dataStatus,
    });

    const requestId = `release-smoke-${revision.slice(0, 12)}-${randomUUID()}`;
    const queued = await jsonRequest(`${origin}/api/commerce/conversations`, {
      method: 'POST',
      headers: identityHeaders(secrets, tenantId, userId, true),
      body: JSON.stringify({
        message: process.env.COMMERCE_RELEASE_SMOKE_QUESTION.trim(),
        model: String(process.env.COMMERCE_RELEASE_SMOKE_MODEL || 'deepseek-v4-flash').trim(),
        requestId,
      }),
    }, 202);
    if (queued.job?.status !== 'queued' || !queued.job?.id) {
      throw new Error(`Smoke query was not durably queued: ${JSON.stringify(queued)}`);
    }
    const eventsPromise = fetchWithTimeout(
      `${origin}/api/commerce/jobs/${encodeURIComponent(queued.job.id)}/events`,
      { headers },
      300_000,
    ).then(async (response) => {
      if (response.status !== 200 || !String(response.headers.get('content-type')).includes('text/event-stream')) {
        throw new Error(`SSE endpoint returned ${response.status}.`);
      }
      return response.text();
    });
    const completedJob = await waitForCompletedJob(
      origin,
      queued.job.id,
      headers,
      [webName, workerName],
      240_000,
    );
    const result = completedJob.result;
    const events = await eventsPromise;
    for (const event of ['queued', 'running', 'completed']) {
      if (!events.includes(`event: ${event}`)) throw new Error(`SSE stream is missing ${event}.`);
    }
    const answer = result.assistantMessage?.answer;
    const traces = result.assistantMessage?.traces || [];
    if (!traces.length || traces.some((trace) => !trace.evidenceId || !trace.sourceWatermark)) {
      throw new Error('Controlled smoke answer is missing field-level Evidence or source watermarks.');
    }
    const expected = {
      metric: process.env.COMMERCE_RELEASE_SMOKE_EXPECTED_METRIC.trim(),
      value: Number(process.env.COMMERCE_RELEASE_SMOKE_EXPECTED_VALUE),
      unit: process.env.COMMERCE_RELEASE_SMOKE_EXPECTED_UNIT.trim(),
    };
    const verified = verifyExpectedAnswerClaim(answer, traces, expected);
    if (
      completedJob.requiredRevision !== revision
      || completedJob.executedByWorkerId !== workerId
    ) {
      throw new Error(`Controlled smoke Job was executed by the wrong image identity: ${JSON.stringify({
        requiredRevision: completedJob.requiredRevision,
        executedByWorkerId: completedJob.executedByWorkerId,
      })}`);
    }
    checks.push({
      name: 'controlled-query-sse-evidence',
      status: 'passed',
      requestId,
      jobId: queued.job.id,
      evidenceCount: traces.length,
      expectedClaim: {
        metric: verified.claim.metric,
        value: verified.claim.value,
        unit: verified.claim.unit,
        evidenceId: verified.claim.evidenceId,
        path: verified.claim.path,
      },
      operations: Array.from(new Set(traces.map((trace) => trace.operation))),
    });

    stopGracefully(workerName);
    docker([
      'run', '--detach', '--no-healthcheck', '--name', crashWorkerName, '--network', networkName,
      '--env', `COMMERCE_WORKER_ID=${crashWorkerId}`,
      '--env', `COMMERCE_RELEASE_SMOKE_HOLD_WORKER_ID=${crashWorkerId}`,
      ...workerEnvArguments,
      imageReference,
      'node', 'scripts/runtime/commerce-worker.js',
    ], { env: workerDockerEnvironment });
    createdCrashWorker = true;
    await waitForEndpoint({
      url: `${origin}/api/health/ready`,
      containers: [webName, crashWorkerName],
      timeoutMs: 15_000,
      description: 'Readiness with crash-test Worker',
      accept: (response, body) => response.status === 200
        && body.ok === true
        && body.revision === revision,
    });
    const crashRequestId = `release-crash-${revision.slice(0, 12)}-${randomUUID()}`;
    const crashQueued = await jsonRequest(`${origin}/api/commerce/conversations`, {
      method: 'POST',
      headers: identityHeaders(secrets, tenantId, userId, true),
      body: JSON.stringify({
        message: process.env.COMMERCE_RELEASE_SMOKE_QUESTION.trim(),
        model: String(process.env.COMMERCE_RELEASE_SMOKE_MODEL || 'deepseek-v4-flash').trim(),
        requestId: crashRequestId,
      }),
    }, 202);
    const crashEventsPromise = fetchWithTimeout(
      `${origin}/api/commerce/jobs/${encodeURIComponent(crashQueued.job.id)}/events`,
      { headers },
      300_000,
    ).then(async (response) => {
      if (response.status !== 200 || !String(response.headers.get('content-type')).includes('text/event-stream')) {
        throw new Error(`Crash-recovery SSE endpoint returned ${response.status}.`);
      }
      return response.text();
    });
    const runningJob = await waitForJob(
      origin,
      crashQueued.job.id,
      headers,
      [webName, crashWorkerName],
      30_000,
      (job) => job?.status === 'running' && job.executedByWorkerId === crashWorkerId,
    );
    if (runningJob.requiredRevision !== revision || runningJob.attemptCount !== 1) {
      throw new Error(`Crash-test Job was not first claimed by the intended revision: ${JSON.stringify(runningJob)}`);
    }
    docker(['kill', crashWorkerName], { timeout: 30_000 });
    docker([
      'run', '--detach', '--no-healthcheck', '--name', replacementWorkerName, '--network', networkName,
      '--env', `COMMERCE_WORKER_ID=${replacementWorkerId}`,
      ...workerEnvArguments,
      imageReference,
      'node', 'scripts/runtime/commerce-worker.js',
    ], { env: workerDockerEnvironment });
    createdReplacementWorker = true;
    const recoveredJob = await waitForCompletedJob(
      origin,
      crashQueued.job.id,
      headers,
      [webName, replacementWorkerName],
      240_000,
    );
    const crashEvents = await crashEventsPromise;
    for (const event of ['queued', 'running', 'requeued', 'completed']) {
      if (!crashEvents.includes(`event: ${event}`)) {
        throw new Error(`Crash-recovery SSE stream is missing ${event}.`);
      }
    }
    if (
      recoveredJob.attemptCount < 2
      || recoveredJob.requiredRevision !== revision
      || recoveredJob.executedByWorkerId !== replacementWorkerId
    ) {
      throw new Error(`Lease recovery was not completed by the replacement Worker: ${JSON.stringify({
        attemptCount: recoveredJob.attemptCount,
        requiredRevision: recoveredJob.requiredRevision,
        executedByWorkerId: recoveredJob.executedByWorkerId,
      })}`);
    }
    checks.push({
      name: 'worker-crash-lease-recovery',
      status: 'passed',
      jobId: crashQueued.job.id,
      attemptCount: recoveredJob.attemptCount,
      executedByWorkerId: recoveredJob.executedByWorkerId,
    });

    const unavailablePort = await availablePort();
    const unavailableDockerEnvironment = {
      ...webDockerEnvironment,
      COMMERCE_CONTROL_API_DATABASE_URL:
        'postgresql://commerce_control_api_user:unavailable@127.0.0.1:1/commerce_control',
    };
    docker([
      'run', '--detach', '--no-healthcheck', '--name', unavailableWebName, '--network', networkName,
      '--publish', `127.0.0.1:${unavailablePort}:3000`,
      ...webEnvArguments,
      imageReference,
      'node', 'scripts/runtime/start-commerce.js',
    ], { env: unavailableDockerEnvironment });
    createdUnavailableWeb = true;
    const unavailableOrigin = `http://127.0.0.1:${unavailablePort}`;
    await waitForEndpoint({
      url: `${unavailableOrigin}/api/health`,
      containers: [unavailableWebName],
      timeoutMs: 60_000,
      description: 'Liveness with unavailable control database',
      accept: (response, body) => response.status === 200
        && body.ok === true
        && body.revision === revision,
    });
    await waitForEndpoint({
      url: `${unavailableOrigin}/api/health/ready`,
      containers: [unavailableWebName],
      timeoutMs: 30_000,
      description: 'Readiness failure with unavailable control database',
      accept: (response, body) => response.status === 503
        && body.ok === false
        && body.checks?.controlSchema === false,
    });
    checks.push({ name: 'database-unavailable-liveness-readiness', status: 'passed' });
    stopGracefully(unavailableWebName);

    stopGracefully(replacementWorkerName);
    const notReady = await waitForEndpoint({
      url: `${origin}/api/health/ready`,
      containers: [webName],
      timeoutMs: 15_000,
      description: 'Readiness failure after Worker shutdown',
      accept: (response, body) => response.status === 503
        && body.ok === false
        && body.checks?.workerActive === false,
    });
    const stillLive = await fetchWithTimeout(`${origin}/api/health`);
    if (stillLive.status !== 200) throw new Error('Liveness failed after the Worker stopped.');
    checks.push({
      name: 'liveness-readiness-separation',
      status: 'passed',
      workerActive: notReady.checks.workerActive,
    });
    stopGracefully(webName);
    checks.push({ name: 'graceful-shutdown', status: 'passed', webExitCode: 0, workerExitCode: 0 });
    completed = true;
    writeReport({
      schemaVersion: 1,
      service: 'commerce-data-agent',
      revision,
      status: 'passed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      image: { reference: imageReference, id: imageId, revision: imageRevision },
      topology: {
        web: 'final-image-node-env-production',
        worker: 'same-final-image-node-env-production',
        databases: 'split-role-tls-verified',
      },
      checks,
    });
    console.log(`[commerce-image-smoke] PASS evidence written to ${path.relative(root, reportPath)}`);
  } catch (error) {
    writeReport({
      schemaVersion: 1,
      service: 'commerce-data-agent',
      revision,
      status: 'failed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      image: { reference: imageReference, id: imageId, revision: imageRevision },
      checks,
      failure: error instanceof Error ? error.message.slice(0, 4_000) : String(error),
    });
    throw error;
  } finally {
    if (!completed) {
      for (const name of [webName, workerName, crashWorkerName, replacementWorkerName, unavailableWebName]) {
        try {
          docker(['rm', '--force', name], { timeout: 30_000 });
        } catch {
          // Preserve the original smoke failure.
        }
      }
    } else {
      for (const name of [webName, workerName, crashWorkerName, replacementWorkerName, unavailableWebName]) {
        try {
          docker(['rm', name], { timeout: 30_000 });
        } catch {
          // Containers have stopped; a cleanup failure must not rewrite valid evidence.
        }
      }
    }
    if (createdNetwork) {
      try {
        docker(['network', 'rm', networkName], { timeout: 30_000 });
      } catch {
        // Reported evidence remains authoritative; operators can remove the named network.
      }
    }
    void createdWeb;
    void createdWorker;
    void createdCrashWorker;
    void createdReplacementWorker;
    void createdUnavailableWeb;
  }
}

module.exports = {
  containerEnvironment,
  parsePostgresUrl,
  releaseRevision,
  smokeConfigurationIssues,
  verifyExpectedAnswerClaim,
};

if (require.main === module) {
  main().catch((error) => {
    console.error('[commerce-image-smoke] FAIL', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

const PLACEHOLDER = /(?:replace|change[-_ ]?me|example|your[-_ ]?(?:key|secret)|at[-_ ]least[-_ ]32|random[-_ ]characters)/i;

function enabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value || ''));
}

function disabled(value) {
  return /^(?:0|false|no|off)$/i.test(String(value || ''));
}

function realCredential(value) {
  const normalized = String(value || '').trim();
  return normalized.length >= 8 && !PLACEHOLDER.test(normalized);
}

function postgresUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['postgres:', 'postgresql:'].includes(parsed.protocol)
      && Boolean(parsed.hostname)
      && Boolean(parsed.username)
      && Boolean(parsed.password)
      && !PLACEHOLDER.test(parsed.href)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function productionOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    return parsed.protocol === 'https:'
      && parsed.origin === String(value).replace(/\/$/, '')
      && !PLACEHOLDER.test(parsed.hostname);
  } catch {
    return false;
  }
}

function positiveInteger(value, fallback) {
  const normalized = String(value || '').trim();
  if (!normalized) return fallback;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = positiveInteger(value, fallback);
  return parsed !== null && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function releaseRevision(value) {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9._-]{7,64}$/.test(normalized)
    && normalized !== 'unversioned'
    && !PLACEHOLDER.test(normalized);
}

function validateProductionEnvironment(environment = process.env) {
  if (environment.NODE_ENV !== 'production') return [];
  const issues = [];
  if (!releaseRevision(environment.COMMERCE_RELEASE_REVISION)) {
    issues.push('COMMERCE_RELEASE_REVISION must identify the immutable release artifact.');
  }
  const runtimeRole = String(environment.COMMERCE_RUNTIME_ROLE || '').trim().toLowerCase();
  if (!['web', 'worker'].includes(runtimeRole)) {
    issues.push('COMMERCE_RUNTIME_ROLE must be explicitly set to web or worker.');
  }
  const controlEnv = runtimeRole === 'worker'
    ? 'COMMERCE_CONTROL_WORKER_DATABASE_URL'
    : 'COMMERCE_CONTROL_API_DATABASE_URL';
  const expectedControlRole = runtimeRole === 'worker'
    ? 'commerce_control_worker_user'
    : 'commerce_control_api_user';
  const control = postgresUrl(environment[controlEnv]);
  const analytics = postgresUrl(environment.COMMERCE_ANALYTICS_DATABASE_URL);
  if (!control) issues.push(`${controlEnv} must be an explicit non-placeholder PostgreSQL URL.`);
  if (control && decodeURIComponent(control.username) !== expectedControlRole) {
    issues.push(`${controlEnv} must use the ${expectedControlRole} PostgreSQL role.`);
  }
  if (!analytics) {
    issues.push('COMMERCE_ANALYTICS_DATABASE_URL must be an explicit non-placeholder PostgreSQL URL.');
  }
  if (control && analytics && control.href === analytics.href) {
    issues.push('Control and analytics URLs must use different runtime credentials.');
  }
  if (control && analytics && control.username === analytics.username) {
    issues.push('Control and analytics URLs must use different database roles.');
  }
  if (!enabled(environment.COMMERCE_PG_SSL)) issues.push('COMMERCE_PG_SSL must be enabled.');
  if (!enabled(environment.COMMERCE_PG_REJECT_UNAUTHORIZED)) {
    issues.push('COMMERCE_PG_REJECT_UNAUTHORIZED must be enabled.');
  }
  const poolMax = positiveInteger(environment.COMMERCE_PG_POOL_MAX, 10);
  const globalConcurrency = positiveInteger(
    environment.COMMERCE_AGENT_GLOBAL_CONCURRENCY,
    poolMax === null ? 8 : Math.max(1, poolMax - 2),
  );
  const tenantConcurrency = positiveInteger(
    environment.COMMERCE_AGENT_TENANT_CONCURRENCY,
    globalConcurrency === null ? 4 : Math.min(4, globalConcurrency),
  );
  const maxInputTokens = positiveInteger(environment.COMMERCE_AGENT_MAX_INPUT_TOKENS, 80_000);
  const maxPreparedInputTokens = boundedInteger(
    environment.COMMERCE_AGENT_MAX_PREPARED_INPUT_TOKENS,
    400_000,
    16_000,
    400_000,
  );
  const jobLeaseMs = boundedInteger(environment.COMMERCE_JOB_LEASE_MS, 150_000, 30_000, 600_000);
  const jobPollMs = boundedInteger(environment.COMMERCE_JOB_POLL_MS, 1_000, 100, 30_000);
  const jobRetryBaseMs = boundedInteger(
    environment.COMMERCE_JOB_RETRY_BASE_MS,
    2_000,
    100,
    60_000,
  );
  const jobRetryMaxMs = boundedInteger(
    environment.COMMERCE_JOB_RETRY_MAX_MS,
    60_000,
    1_000,
    600_000,
  );
  const workerStaleMs = boundedInteger(environment.COMMERCE_WORKER_STALE_MS, 30_000, 5_000, 300_000);
  const retentionDays = boundedInteger(environment.COMMERCE_RETENTION_DAYS, null, 7, 3_650);
  const maxQueuedJobs = boundedInteger(
    environment.COMMERCE_MAX_QUEUED_JOBS_PER_USER,
    8,
    1,
    100,
  );
  const catalogPreviewLimit = boundedInteger(
    environment.COMMERCE_CATALOG_PREVIEW_LIMIT,
    100,
    1,
    100,
  );
  const jobMaxAttempts = boundedInteger(environment.COMMERCE_JOB_MAX_ATTEMPTS, 3, 1, 10);
  if (poolMax === null || poolMax < 3) {
    issues.push('COMMERCE_PG_POOL_MAX must be an integer of at least 3.');
  }
  if (
    poolMax !== null
    && globalConcurrency !== null
    && globalConcurrency > poolMax - 2
  ) {
    issues.push('COMMERCE_AGENT_GLOBAL_CONCURRENCY must leave two analytics pool connections free.');
  }
  if (globalConcurrency === null) {
    issues.push('COMMERCE_AGENT_GLOBAL_CONCURRENCY must be a positive integer.');
  }
  if (
    tenantConcurrency === null
    || (globalConcurrency !== null && tenantConcurrency > globalConcurrency)
  ) {
    issues.push('COMMERCE_AGENT_TENANT_CONCURRENCY must be positive and no greater than global concurrency.');
  }
  if (
    maxInputTokens === null
    || maxPreparedInputTokens === null
    || maxPreparedInputTokens < maxInputTokens
  ) {
    issues.push(
      'COMMERCE_AGENT_MAX_PREPARED_INPUT_TOKENS must be between 16000 and 400000 and no smaller than COMMERCE_AGENT_MAX_INPUT_TOKENS.',
    );
  }
  if (jobLeaseMs === null) issues.push('COMMERCE_JOB_LEASE_MS must be between 30000 and 600000.');
  if (jobPollMs === null) issues.push('COMMERCE_JOB_POLL_MS must be between 100 and 30000.');
  if (jobRetryBaseMs === null) {
    issues.push('COMMERCE_JOB_RETRY_BASE_MS must be between 100 and 60000.');
  }
  if (jobRetryMaxMs === null || (jobRetryBaseMs !== null && jobRetryMaxMs < jobRetryBaseMs)) {
    issues.push('COMMERCE_JOB_RETRY_MAX_MS must be between 1000 and 600000 and no smaller than the retry base.');
  }
  if (workerStaleMs === null) {
    issues.push('COMMERCE_WORKER_STALE_MS must be between 5000 and 300000.');
  }
  if (retentionDays === null) {
    issues.push('COMMERCE_RETENTION_DAYS must explicitly define the 7-3650 day audit retention policy.');
  }
  if (maxQueuedJobs === null) {
    issues.push('COMMERCE_MAX_QUEUED_JOBS_PER_USER must be between 1 and 100.');
  }
  if (catalogPreviewLimit === null) {
    issues.push('COMMERCE_CATALOG_PREVIEW_LIMIT must be between 1 and 100.');
  }
  if (jobMaxAttempts === null) {
    issues.push('COMMERCE_JOB_MAX_ATTEMPTS must be between 1 and 10.');
  }
  if (!productionOrigin(environment.COMMERCE_PUBLIC_ORIGIN)) {
    issues.push('COMMERCE_PUBLIC_ORIGIN must be a real HTTPS origin.');
  }
  const proxySecret = String(environment.COMMERCE_TRUSTED_PROXY_SECRET || '').trim();
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(proxySecret) || PLACEHOLDER.test(proxySecret)) {
    issues.push('COMMERCE_TRUSTED_PROXY_SECRET must be a 43-128 character random base64url value.');
  }
  const metricsToken = String(environment.COMMERCE_METRICS_TOKEN || '').trim();
  if (metricsToken.length < 32 || PLACEHOLDER.test(metricsToken)) {
    issues.push('COMMERCE_METRICS_TOKEN must be a non-placeholder secret of at least 32 characters.');
  }
  if (!disabled(environment.COMMERCE_DEV_AUTH_BYPASS)) {
    issues.push('COMMERCE_DEV_AUTH_BYPASS must be explicitly disabled.');
  }
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    issues.push('NODE_TLS_REJECT_UNAUTHORIZED=0 is forbidden.');
  }
  if (!enabled(environment.COMMERCE_LLM_AGENT_ENABLED)) {
    issues.push('COMMERCE_LLM_AGENT_ENABLED must be enabled.');
  }
  const modelPortConfigured = realCredential(environment.MODELPORT_API_KEY);
  const deepSeekConfigured = realCredential(environment.DEEPSEEK_API_KEY);
  if (!modelPortConfigured && !deepSeekConfigured) {
    issues.push('A non-placeholder MODELPORT_API_KEY or DEEPSEEK_API_KEY is required.');
  }
  if (modelPortConfigured) {
    try {
      if (new URL(String(environment.COMMERCE_MODELPORT_URL || '')).protocol !== 'https:') {
        throw new Error('not HTTPS');
      }
    } catch {
      issues.push('Production ModelPort requires an explicit HTTPS COMMERCE_MODELPORT_URL.');
    }
    for (const name of [
      'COMMERCE_MODELPORT_ORGANIZATION_ID',
      'COMMERCE_MODELPORT_PROJECT_ID',
      'COMMERCE_MODELPORT_ENVIRONMENT_ID',
    ]) {
      const value = String(environment[name] || '').trim();
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(value) || PLACEHOLDER.test(value)) {
        issues.push(`${name} must be an explicit stable production scope.`);
      }
    }
  }
  return issues;
}

module.exports = { validateProductionEnvironment };

if (require.main === module) {
  const issues = validateProductionEnvironment(process.env);
  if (issues.length) {
    console.error('Commerce Data Agent production configuration is unsafe:');
    for (const issue of issues) console.error(`- ${issue}`);
    process.exitCode = 1;
  } else {
    console.log('Commerce Data Agent production environment passed static validation.');
  }
}

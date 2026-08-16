import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { validateProductionEnvironment } = require('./production-env.js');

const valid = {
  NODE_ENV: 'production',
  COMMERCE_RELEASE_REVISION: '0123456789abcdef0123456789abcdef01234567',
  COMMERCE_RUNTIME_ROLE: 'web',
  COMMERCE_CONTROL_API_DATABASE_URL: 'postgresql://commerce_control_api_user:control_password@db.internal:5432/control',
  COMMERCE_ANALYTICS_DATABASE_URL: 'postgresql://analytics_reader:analytics_password@warehouse.internal:5432/analytics',
  COMMERCE_PG_SSL: '1',
  COMMERCE_PG_REJECT_UNAUTHORIZED: '1',
  COMMERCE_PG_POOL_MAX: '10',
  COMMERCE_AGENT_GLOBAL_CONCURRENCY: '8',
  COMMERCE_AGENT_TENANT_CONCURRENCY: '4',
  COMMERCE_AGENT_MAX_INPUT_TOKENS: '80000',
  COMMERCE_AGENT_MAX_PREPARED_INPUT_TOKENS: '160000',
  COMMERCE_JOB_LEASE_MS: '150000',
  COMMERCE_JOB_POLL_MS: '1000',
  COMMERCE_JOB_RETRY_BASE_MS: '2000',
  COMMERCE_JOB_RETRY_MAX_MS: '60000',
  COMMERCE_WORKER_STALE_MS: '30000',
  COMMERCE_RETENTION_DAYS: '90',
  COMMERCE_MAX_QUEUED_JOBS_PER_USER: '8',
  COMMERCE_JOB_MAX_ATTEMPTS: '3',
  COMMERCE_PUBLIC_ORIGIN: 'https://commerce.internal.company',
  COMMERCE_TRUSTED_PROXY_SECRET: 'lR4eTZ9_nwQt2P8SsHjDcVYmB7uXgL1Kf6AoC3zWvNi5QpRx',
  COMMERCE_METRICS_TOKEN: 'metrics-production-token-material-0123456789',
  COMMERCE_DEV_AUTH_BYPASS: '0',
  COMMERCE_LLM_AGENT_ENABLED: '1',
  DEEPSEEK_API_KEY: 'fixture-valid-production-provider-material',
};

describe('Commerce production startup gate', () => {
  it('accepts an explicit split-role TLS production configuration', () => {
    expect(validateProductionEnvironment(valid)).toEqual([]);
  });

  it('rejects documented placeholders, shared database roles and disabled TLS', () => {
    const issues = validateProductionEnvironment({
      ...valid,
      COMMERCE_ANALYTICS_DATABASE_URL: valid.COMMERCE_CONTROL_API_DATABASE_URL,
      COMMERCE_PG_SSL: '0',
      COMMERCE_TRUSTED_PROXY_SECRET: 'replace-with-at-least-32-random-characters',
      DEEPSEEK_API_KEY: 'replace-with-deepseek-api-key',
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('different runtime credentials'),
      expect.stringContaining('COMMERCE_PG_SSL'),
      expect.stringContaining('COMMERCE_TRUSTED_PROXY_SECRET'),
      expect.stringContaining('MODELPORT_API_KEY or DEEPSEEK_API_KEY'),
    ]));
  });

  it('selects the dedicated Worker URL and rejects role substitution', () => {
    expect(validateProductionEnvironment({
      ...valid,
      COMMERCE_RUNTIME_ROLE: 'worker',
      COMMERCE_CONTROL_WORKER_DATABASE_URL: 'postgresql://commerce_control_worker_user:control_password@db.internal:5432/control',
    })).toEqual([]);

    expect(validateProductionEnvironment({
      ...valid,
      COMMERCE_CONTROL_API_DATABASE_URL: 'postgresql://commerce_control_worker_user:control_password@db.internal:5432/control',
    })).toEqual(expect.arrayContaining([
      expect.stringContaining('commerce_control_api_user'),
    ]));
  });

  it('reserves analytics connections outside the long-lived agent snapshots', () => {
    const issues = validateProductionEnvironment({
      ...valid,
      COMMERCE_AGENT_GLOBAL_CONCURRENCY: '9',
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('leave two analytics pool connections free'),
    ]));
  });

  it('rejects an unversioned production artifact', () => {
    const issues = validateProductionEnvironment({
      ...valid,
      COMMERCE_RELEASE_REVISION: 'unversioned',
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('COMMERCE_RELEASE_REVISION'),
    ]));
  });

  it('requires explicit ModelPort production scopes', () => {
    const issues = validateProductionEnvironment({
      ...valid,
      DEEPSEEK_API_KEY: '',
      MODELPORT_API_KEY: 'modelport-production-key',
      COMMERCE_MODELPORT_URL: 'https://modelport.internal.company',
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('COMMERCE_MODELPORT_ORGANIZATION_ID'),
      expect.stringContaining('COMMERCE_MODELPORT_PROJECT_ID'),
      expect.stringContaining('COMMERCE_MODELPORT_ENVIRONMENT_ID'),
    ]));
  });

  it('keeps prepared context reservation separate from actual input usage', () => {
    const issues = validateProductionEnvironment({
      ...valid,
      COMMERCE_AGENT_MAX_PREPARED_INPUT_TOKENS: '40000',
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('MAX_PREPARED_INPUT_TOKENS'),
    ]));
  });

  it('rejects a prepared context reservation above the runtime ceiling', () => {
    const issues = validateProductionEnvironment({
      ...valid,
      COMMERCE_AGENT_MAX_PREPARED_INPUT_TOKENS: '400001',
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('MAX_PREPARED_INPUT_TOKENS'),
    ]));
  });

  it('rejects a retry ceiling below the retry base', () => {
    const issues = validateProductionEnvironment({
      ...valid,
      COMMERCE_JOB_RETRY_BASE_MS: '5000',
      COMMERCE_JOB_RETRY_MAX_MS: '1000',
    });
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('COMMERCE_JOB_RETRY_MAX_MS'),
    ]));
  });

  it('requires an explicit bounded audit retention policy', () => {
    const missing = { ...valid };
    delete missing.COMMERCE_RETENTION_DAYS;
    expect(validateProductionEnvironment(missing)).toEqual(expect.arrayContaining([
      expect.stringContaining('COMMERCE_RETENTION_DAYS'),
    ]));
    expect(validateProductionEnvironment({ ...valid, COMMERCE_RETENTION_DAYS: '3' })).toEqual(
      expect.arrayContaining([expect.stringContaining('COMMERCE_RETENTION_DAYS')]),
    );
  });
});

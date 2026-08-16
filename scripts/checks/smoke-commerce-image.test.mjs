import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  containerEnvironment,
  smokeConfigurationIssues,
  verifyExpectedAnswerClaim,
} = require('./smoke-commerce-image.js');

const valid = {
  COMMERCE_RELEASE_REVISION: '0123456789abcdef0123456789abcdef01234567',
  COMMERCE_RELEASE_SMOKE_CONFIRM: 'commerce-final-image-smoke',
  COMMERCE_RELEASE_SMOKE_CONTROL_DATABASE_URL:
    'postgresql://commerce_control_api_user:control_password@control-db.internal:5432/commerce_control',
  COMMERCE_RELEASE_SMOKE_WORKER_DATABASE_URL:
    'postgresql://commerce_control_worker_user:worker_password@control-db.internal:5432/commerce_control',
  COMMERCE_RELEASE_SMOKE_ANALYTICS_DATABASE_URL:
    'postgresql://analytics_reader:analytics_password@analytics-db.internal:5432/commerce_analytics',
  COMMERCE_RELEASE_SMOKE_TENANT_ID: 'tenant_release_fixture',
  COMMERCE_RELEASE_SMOKE_QUESTION: '2026-07-01 到 2026-07-07 的 GMV 是多少？',
  COMMERCE_RELEASE_SMOKE_EXPECTED_METRIC: 'gmv',
  COMMERCE_RELEASE_SMOKE_EXPECTED_VALUE: '700',
  COMMERCE_RELEASE_SMOKE_EXPECTED_UNIT: 'currency',
  COMMERCE_RELEASE_SMOKE_MODEL: 'deepseek-v4-flash',
  COMMERCE_PG_SSL: '1',
  COMMERCE_PG_REJECT_UNAUTHORIZED: '1',
  DEEPSEEK_API_KEY: 'fixture-release-smoke-provider-material',
};

describe('final Commerce image smoke contract', () => {
  it('accepts only an explicit revision-bound split-role TLS fixture', () => {
    expect(smokeConfigurationIssues(valid, 'commerce-data-agent:0123456789ab')).toEqual([]);
  });

  it('fails closed when a disposable production-topology fixture is absent', () => {
    const issues = smokeConfigurationIssues({
      ...valid,
      COMMERCE_RELEASE_SMOKE_CONFIRM: '',
      COMMERCE_RELEASE_SMOKE_ANALYTICS_DATABASE_URL:
        valid.COMMERCE_RELEASE_SMOKE_CONTROL_DATABASE_URL,
      COMMERCE_PG_SSL: '0',
      COMMERCE_RELEASE_SMOKE_EXPECTED_VALUE: 'not-a-number',
    }, 'commerce-data-agent:0123456789ab');

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('COMMERCE_RELEASE_SMOKE_CONFIRM'),
      expect.stringContaining('separate control and analytics credentials'),
      expect.stringContaining('different control and analytics database roles'),
      expect.stringContaining('COMMERCE_PG_SSL=1'),
      expect.stringContaining('COMMERCE_RELEASE_SMOKE_EXPECTED_VALUE'),
    ]));
  });

  it('maps smoke-only database inputs into a fail-closed production container environment', () => {
    const runtime = containerEnvironment(valid, {
      publicOrigin: 'https://commerce-release-smoke.invalid',
      proxySecret: 'proxy-secret',
      metricsToken: 'metrics-secret',
    });

    expect(runtime).toMatchObject({
      COMMERCE_RUNTIME_ROLE: 'web',
      COMMERCE_CONTROL_API_DATABASE_URL: valid.COMMERCE_RELEASE_SMOKE_CONTROL_DATABASE_URL,
      COMMERCE_ANALYTICS_DATABASE_URL: valid.COMMERCE_RELEASE_SMOKE_ANALYTICS_DATABASE_URL,
      COMMERCE_RELEASE_REVISION: valid.COMMERCE_RELEASE_REVISION,
      COMMERCE_DEV_AUTH_BYPASS: '0',
      COMMERCE_PG_SSL: '1',
      COMMERCE_PG_REJECT_UNAUTHORIZED: '1',
      COMMERCE_LLM_AGENT_ENABLED: '1',
      COMMERCE_JOB_LEASE_MS: '30000',
      COMMERCE_RELEASE_SMOKE_CONFIRM: 'commerce-final-image-smoke',
    });
    expect(runtime).not.toHaveProperty('NODE_TLS_REJECT_UNAUTHORIZED');
    expect(runtime).not.toHaveProperty('COMMERCE_CONTROL_WORKER_DATABASE_URL');

    expect(containerEnvironment(valid, {
      publicOrigin: 'https://commerce-release-smoke.invalid',
      proxySecret: 'proxy-secret',
      metricsToken: 'metrics-secret',
    }, 'worker')).toMatchObject({
      COMMERCE_RUNTIME_ROLE: 'worker',
      COMMERCE_CONTROL_WORKER_DATABASE_URL: valid.COMMERCE_RELEASE_SMOKE_WORKER_DATABASE_URL,
    });
  });

  it('verifies an exact structured claim against its Evidence path', () => {
    expect(verifyExpectedAnswerClaim({
      status: 'answered',
      answer: 'GMV 为 700.00。',
      answerClaims: [{
        evidenceId: 'ev_totals', path: '/gmv', metric: 'gmv', value: 700, unit: 'currency',
      }],
    }, [{
      evidenceId: 'ev_totals', sourceWatermark: '2026-07-08T00:00:00.000Z', preview: { gmv: 700 },
    }], { metric: 'gmv', value: 700, unit: 'currency' })).toMatchObject({
      claim: { evidenceId: 'ev_totals', value: 700 },
    });
  });

  it('rejects substring collisions, negated prose, and mismatched Evidence values', () => {
    const answer = {
      status: 'answered',
      answer: 'GMV 不是 700.00，而是 1700.00。',
      answerClaims: [{
        evidenceId: 'ev_totals', path: '/gmv', metric: 'gmv', value: 1700, unit: 'currency',
      }],
    };
    const traces = [{
      evidenceId: 'ev_totals', sourceWatermark: '2026-07-08T00:00:00.000Z', preview: { gmv: 1700 },
    }];
    expect(() => verifyExpectedAnswerClaim(
      answer, traces, { metric: 'gmv', value: 700, unit: 'currency' },
    )).toThrow(/missing exact claim/u);

    answer.answerClaims[0].value = 700;
    expect(() => verifyExpectedAnswerClaim(
      answer, traces, { metric: 'gmv', value: 700, unit: 'currency' },
    )).toThrow(/does not resolve/u);
  });
});

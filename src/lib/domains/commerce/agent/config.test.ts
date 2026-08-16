import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  commerceModelBudgetPolicy,
  commerceConfigurationStatus,
  CommerceModelBudgetConfigurationError,
  getCommerceAgentRuntimeConfig,
} from './config';

afterEach(() => vi.unstubAllEnvs());

describe('Commerce Week 10 runtime gates', () => {
  it('routes Web and Worker to distinct control credentials', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('COMMERCE_CONTROL_API_DATABASE_URL', 'postgresql://api:secret@db/control');
    vi.stubEnv('COMMERCE_CONTROL_WORKER_DATABASE_URL', 'postgresql://worker:secret@db/control');
    vi.stubEnv('COMMERCE_RUNTIME_ROLE', 'web');
    expect(getCommerceAgentRuntimeConfig()).toMatchObject({
      controlRuntimeRole: 'web',
      databaseUrl: 'postgresql://api:secret@db/control',
    });

    vi.stubEnv('COMMERCE_RUNTIME_ROLE', 'worker');
    expect(getCommerceAgentRuntimeConfig()).toMatchObject({
      controlRuntimeRole: 'worker',
      databaseUrl: 'postgresql://worker:secret@db/control',
    });
  });

  it('keeps scheduled weekly diagnosis off by default and parses an explicit enable flag', () => {
    vi.stubEnv('COMMERCE_WEEKLY_DIAGNOSIS_ENABLED', '');
    expect(getCommerceAgentRuntimeConfig().weeklyDiagnosisEnabled).toBe(false);

    vi.stubEnv('COMMERCE_WEEKLY_DIAGNOSIS_ENABLED', 'true');
    expect(getCommerceAgentRuntimeConfig().weeklyDiagnosisEnabled).toBe(true);
  });

  it('parses independent diagnostic-policy and anomaly rollout flags', () => {
    vi.stubEnv('COMMERCE_DIAGNOSTIC_POLICY_ENABLED', 'false');
    vi.stubEnv('COMMERCE_ANOMALY_DETECTION_ENABLED', '0');
    expect(getCommerceAgentRuntimeConfig()).toMatchObject({
      diagnosticPolicyEnabled: false,
      anomalyDetectionEnabled: false,
    });
  });

  it('reports an incoherent weekly scheduler rollout as not ready', () => {
    vi.stubEnv('COMMERCE_WEEKLY_DIAGNOSIS_ENABLED', 'true');
    vi.stubEnv('COMMERCE_DIAGNOSTIC_POLICY_ENABLED', 'false');
    vi.stubEnv('COMMERCE_ANOMALY_DETECTION_ENABLED', 'false');

    expect(commerceConfigurationStatus().issues).toEqual(expect.arrayContaining([
      expect.stringContaining('COMMERCE_DIAGNOSTIC_POLICY_ENABLED'),
      expect.stringContaining('COMMERCE_ANOMALY_DETECTION_ENABLED'),
    ]));
  });

  it('derives a conservative run reservation from the prepared-input and output envelopes', () => {
    vi.stubEnv('DAILY_MODEL_BUDGET_USD', '10');
    vi.stubEnv('COMMERCE_AGENT_MAX_PREPARED_INPUT_TOKENS', '100000');
    vi.stubEnv('COMMERCE_AGENT_MAX_OUTPUT_TOKENS', '10000');
    vi.stubEnv('COMMERCE_MODEL_INPUT_USD_PER_MILLION_TOKENS', '2');
    vi.stubEnv('COMMERCE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS', '4');

    expect(commerceModelBudgetPolicy()).toEqual({
      dailyLimitUsd: 10,
      reservationUsd: 0.24,
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 4,
    });
  });

  it('fails closed when a daily dollar cap has no explicit token prices', () => {
    vi.stubEnv('DAILY_MODEL_BUDGET_USD', '10');
    vi.stubEnv('COMMERCE_MODEL_INPUT_USD_PER_MILLION_TOKENS', '');
    vi.stubEnv('COMMERCE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS', '');

    expect(() => commerceModelBudgetPolicy()).toThrow(CommerceModelBudgetConfigurationError);
  });

  it('does not silently disable an invalid configured daily cap', () => {
    vi.stubEnv('DAILY_MODEL_BUDGET_USD', 'not-a-number');

    expect(() => commerceModelBudgetPolicy()).toThrow('DAILY_MODEL_BUDGET_USD 必须是大于 0');
  });
});

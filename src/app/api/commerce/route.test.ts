import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, POST } from './route';

describe('production Commerce Data Agent metadata API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '1');
    vi.stubEnv('COMMERCE_DEV_TENANT_ID', 'tenant_metadata_test');
    vi.stubEnv('COMMERCE_DEV_USER_ID', 'operator_metadata_test');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('publishes the conversational tool runtime without demo fallback', async () => {
    const request = new NextRequest('http://localhost:3000/api/commerce');
    const response = await GET(request);

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({
      success: true,
      agent: {
        id: 'commerce.conversational-data-agent',
        runtime: 'moagent-tool-loop',
        connector: 'postgresql-readonly',
        sessionStore: 'postgresql',
        fallback: 'disabled',
        features: {
          diagnosticPolicyEnabled: true,
          anomalyDetectionEnabled: true,
          notificationsEnabled: false,
          automaticReviewEnabled: false,
          weeklyDiagnosisEnabled: false,
        },
        tools: expect.arrayContaining([
          'describe_commerce_data',
          'inspect_commerce_data_health',
          'scan_weekly_commerce_kpis',
          'compare_commerce_metrics',
          'submit_grounded_commerce_answer',
        ]),
      },
      identity: { authMode: 'development' },
      readiness: {
        warnings: expect.any(Array),
      },
    });
    expect(payload.readiness).toHaveProperty('dataStatus');
  });

  it('publishes only models backed by a configured credential', async () => {
    vi.stubEnv('MODELPORT_API_KEY', '');
    vi.stubEnv('DEEPSEEK_API_KEY', 'configured-for-test');
    const response = await GET(new NextRequest('http://localhost:3000/api/commerce'));

    await expect(response.json()).resolves.toMatchObject({
      success: true,
      agent: { models: ['deepseek-v4-flash'] },
      readiness: { modelConfigured: true },
    });
  });

  it('fails closed when metadata is requested without an authenticated identity', async () => {
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '0');

    const response = await GET(new NextRequest('http://localhost:3000/api/commerce'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'UNAUTHORIZED',
    });
  });

  it('retires the legacy fixed-diagnosis POST contract', async () => {
    const response = POST();

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'LEGACY_ENDPOINT_REMOVED',
    });
  });
});

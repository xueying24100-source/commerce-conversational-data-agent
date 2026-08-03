import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  collectedTenant: undefined as string | null | undefined,
  collectCalls: 0,
}));

vi.mock('@/lib/domains/commerce/agent/metrics', () => ({
  authorizeCommerceMetrics: (authorization: string | null) => authorization === 'Bearer metrics-secret',
  commerceMetricsTenantId: (value: string | null) => {
    if (value === 'bad tenant') throw new Error('Invalid metrics tenant id.');
    return value;
  },
  collectCommercePrometheusMetrics: async (tenantId: string | null) => {
    state.collectCalls += 1;
    state.collectedTenant = tenantId;
    return '# TYPE commerce_agent_workers gauge\ncommerce_agent_workers 1\n';
  },
}));

import { GET } from './route';

describe('Commerce metrics API', () => {
  beforeEach(() => {
    state.collectedTenant = undefined;
    state.collectCalls = 0;
  });

  it('hides the endpoint when the bearer token is invalid', async () => {
    const response = await GET(new NextRequest('http://localhost:3000/api/metrics'));

    expect(response.status).toBe(404);
    expect(state.collectCalls).toBe(0);
  });

  it('passes an explicit tenant header into the scoped metrics collector', async () => {
    const response = await GET(new NextRequest('http://localhost:3000/api/metrics', {
      headers: {
        authorization: 'Bearer metrics-secret',
        'x-commerce-metrics-tenant-id': 'tenant_olist_demo',
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    expect(state.collectedTenant).toBe('tenant_olist_demo');
  });

  it('rejects an invalid tenant header before collecting metrics', async () => {
    const response = await GET(new NextRequest('http://localhost:3000/api/metrics', {
      headers: {
        authorization: 'Bearer metrics-secret',
        'x-commerce-metrics-tenant-id': 'bad tenant',
      },
    }));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('Invalid metrics tenant id.\n');
    expect(state.collectCalls).toBe(0);
  });
});

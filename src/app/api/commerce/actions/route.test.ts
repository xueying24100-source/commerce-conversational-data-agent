import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const list = vi.fn();
vi.mock('@/lib/domains/commerce/agent/action-store', () => ({
  getCommerceActionStore: () => ({ list }),
}));

import { GET } from './route';

const secret = 'lR4eTZ9_nwQt2P8SsHjDcVYmB7uXgL1Kf6AoC3zWvNi5QpRx';

function request(query = 'status=open&limit=20') {
  return new NextRequest(`https://commerce.example.com/api/commerce/actions?${query}`, {
    headers: {
      'x-commerce-proxy-secret': secret,
      'x-commerce-tenant-id': 'tenant_actions',
      'x-commerce-user-id': 'operator_actions',
      'x-commerce-user-name': 'Operator',
      'x-commerce-scopes': 'commerce:data:read',
    },
  });
}

describe('Commerce action workbench API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '0');
    vi.stubEnv('COMMERCE_TRUSTED_PROXY_SECRET', secret);
    list.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns the current tenant and user action queue', async () => {
    list.mockResolvedValue([{ actionId: `action_${'a'.repeat(24)}`, status: 'proposed' }]);
    const response = await GET(request());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      actions: [{ status: 'proposed' }],
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_actions', userId: 'operator_actions' }),
      { status: 'open', limit: 20 },
    );
  });

  it('rejects unsupported status filters', async () => {
    const response = await GET(request('status=unknown'));
    expect(response.status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });
});

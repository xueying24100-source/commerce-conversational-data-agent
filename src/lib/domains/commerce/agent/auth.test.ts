import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CommerceAuthorizationError, resolveCommerceIdentity } from './auth';

const PROXY_SECRET = 'lR4eTZ9_nwQt2P8SsHjDcVYmB7uXgL1Kf6AoC3zWvNi5QpRx';

describe('Commerce trusted identity boundary', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows an explicit development-only identity bypass', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '1');
    vi.stubEnv('COMMERCE_DEV_TENANT_ID', 'tenant_test');
    vi.stubEnv('COMMERCE_DEV_USER_ID', 'operator_test');

    const identity = resolveCommerceIdentity(
      new NextRequest('http://localhost:3000/api/commerce'),
    );

    expect(identity).toMatchObject({
      tenantId: 'tenant_test',
      userId: 'operator_test',
      authMode: 'development',
    });
  });

  it('requires proxy-injected identity and a constant-time shared secret in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '0');
    vi.stubEnv('COMMERCE_TRUSTED_PROXY_SECRET', PROXY_SECRET);
    const request = new NextRequest('https://commerce.example.com/api/commerce', {
      headers: {
        'x-commerce-proxy-secret': PROXY_SECRET,
        'x-commerce-tenant-id': 'tenant_acme',
        'x-commerce-user-id': 'user_42',
        'x-commerce-user-name': 'Ops lead',
        'x-commerce-scopes': 'commerce:data:read',
      },
    });

    expect(resolveCommerceIdentity(request)).toEqual({
      tenantId: 'tenant_acme',
      userId: 'user_42',
      displayName: 'Ops lead',
      scopes: ['commerce:data:read'],
      authMode: 'trusted_proxy',
    });
  });

  it('fails closed when a caller forges trusted identity headers', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '0');
    vi.stubEnv('COMMERCE_TRUSTED_PROXY_SECRET', PROXY_SECRET);
    const request = new NextRequest('https://commerce.example.com/api/commerce', {
      headers: {
        'x-commerce-proxy-secret': 'wrong-secret',
        'x-commerce-tenant-id': 'tenant_other',
        'x-commerce-user-id': 'attacker',
      },
    });

    expect(() => resolveCommerceIdentity(request)).toThrow(CommerceAuthorizationError);
  });

  it('denies a trusted identity without the Commerce entitlement', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '0');
    vi.stubEnv('COMMERCE_TRUSTED_PROXY_SECRET', PROXY_SECRET);
    const request = new NextRequest('https://commerce.example.com/api/commerce', {
      headers: {
        'x-commerce-proxy-secret': PROXY_SECRET,
        'x-commerce-tenant-id': 'tenant_acme',
        'x-commerce-user-id': 'user_42',
        'x-commerce-scopes': 'profile:read',
      },
    });

    expect(() => resolveCommerceIdentity(request)).toThrowError(
      expect.objectContaining({ code: 'COMMERCE_ACCESS_DENIED', status: 403 }),
    );
  });
});

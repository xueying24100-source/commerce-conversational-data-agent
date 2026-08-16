import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transition = vi.fn();
vi.mock('@/lib/domains/commerce/agent/action-store', () => ({
  getCommerceActionStore: () => ({ transition }),
}));

import { PATCH } from './route';

const conversationId = 'conv_1234567890123456';
const messageId = 'msg_1234567890123456';
const actionId = 'action_0123456789abcdef01234567';
const secret = 'lR4eTZ9_nwQt2P8SsHjDcVYmB7uXgL1Kf6AoC3zWvNi5QpRx';
const context = { params: Promise.resolve({ conversationId, messageId, actionId }) };

function request(body: unknown, overrides: Record<string, string> = {}) {
  return new NextRequest(
    `https://commerce.example.com/api/commerce/conversations/${conversationId}/messages/${messageId}/actions/${actionId}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://commerce.example.com',
        'x-commerce-proxy-secret': secret,
        'x-commerce-tenant-id': 'tenant_action',
        'x-commerce-user-id': 'operator_action',
        'x-commerce-user-name': 'Operator',
        'x-commerce-scopes': 'commerce:data:read',
        ...overrides,
      },
      body: JSON.stringify(body),
    },
  );
}

describe('Commerce action transition API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '0');
    vi.stubEnv('COMMERCE_TRUSTED_PROXY_SECRET', secret);
    vi.stubEnv('COMMERCE_PUBLIC_ORIGIN', 'https://commerce.example.com');
    transition.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('passes the authenticated owner and versioned transition to storage', async () => {
    transition.mockResolvedValue({
      actionId,
      status: 'confirmed',
      version: 1,
      updatedAt: '2026-08-13T08:00:00.000Z',
    });
    const response = await PATCH(request({
      action: 'confirm',
      expectedVersion: 0,
      requestId: 'action:req-1001',
      commitment: {
        assignee: '运营团队',
        dueDate: '2026-08-20',
        target: null,
        evaluationWindowDays: 7,
      },
    }), context);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      actionState: { actionId, status: 'confirmed', version: 1 },
    });
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_action', userId: 'operator_action' }),
      {
        conversationId,
        messageId,
        actionId,
        action: 'confirm',
        expectedVersion: 0,
        requestId: 'action:req-1001',
        commitment: {
          assignee: '运营团队',
          dueDate: '2026-08-20',
          target: null,
          evaluationWindowDays: 7,
        },
      },
    );
  });

  it('rejects an untrusted Origin before storage access', async () => {
    const response = await PATCH(request({
      action: 'confirm', expectedVersion: 0, requestId: 'action:req-1002',
    }, { Origin: 'https://attacker.example' }), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: 'ORIGIN_MISMATCH' });
    expect(transition).not.toHaveBeenCalled();
  });

  it('requires a trusted proxy identity', async () => {
    const response = await PATCH(request({
      action: 'confirm', expectedVersion: 0, requestId: 'action:req-1003',
    }, { 'x-commerce-proxy-secret': 'invalid-secret' }), context);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'UNAUTHORIZED' });
    expect(transition).not.toHaveBeenCalled();
  });

  it('rejects invalid or unversioned transition requests before storage access', async () => {
    const invalidAction = await PATCH(request({
      action: 'cancel', expectedVersion: 0, requestId: 'action:req-1004',
    }), context);
    const missingVersion = await PATCH(request({
      action: 'start', requestId: 'action:req-1005',
    }), context);

    expect(invalidAction.status).toBe(400);
    expect(missingVersion.status).toBe(400);
    expect(transition).not.toHaveBeenCalled();
  });
});

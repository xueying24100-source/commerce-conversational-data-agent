import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  notificationsEnabled: false,
  listMembers: vi.fn(),
}));

vi.mock('@/lib/domains/commerce/agent/auth', () => ({
  resolveCommerceIdentity: () => ({
    tenantId: 'tenant_test',
    userId: 'operator_test',
    displayName: 'Test operator',
    scopes: ['commerce:data:read', 'commerce:notification:write'],
    authMode: 'development',
  }),
}));

vi.mock('@/lib/domains/commerce/agent/config', () => ({
  getCommerceAgentRuntimeConfig: () => ({
    notificationsEnabled: mocks.notificationsEnabled,
  }),
}));

vi.mock('@/lib/domains/commerce/agent/feishu-outbox', () => ({
  getCommerceFeishuOutboxStore: () => ({ listMembers: mocks.listMembers }),
}));

import { GET } from './route';

describe('GET /api/commerce/members', () => {
  beforeEach(() => {
    mocks.notificationsEnabled = false;
    mocks.listMembers.mockReset();
  });

  it('returns an explicit empty capability without touching the outbox when notifications are disabled', async () => {
    const response = await GET(new NextRequest('http://localhost/api/commerce/members'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      enabled: false,
      members: [],
    });
    expect(mocks.listMembers).not.toHaveBeenCalled();
  });

  it('loads authorized tenant members only after notifications are enabled', async () => {
    mocks.notificationsEnabled = true;
    mocks.listMembers.mockResolvedValueOnce([{
      memberId: 'member_1',
      displayName: 'Owner',
      canReceiveNotifications: true,
    }]);

    const response = await GET(new NextRequest('http://localhost/api/commerce/members'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      enabled: true,
      members: [{
        memberId: 'member_1',
        displayName: 'Owner',
        canReceiveNotifications: true,
      }],
    });
    expect(mocks.listMembers).toHaveBeenCalledTimes(1);
  });
});

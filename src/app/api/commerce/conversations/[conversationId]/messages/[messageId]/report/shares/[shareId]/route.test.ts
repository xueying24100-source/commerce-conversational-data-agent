import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const revokeShare = vi.fn();
vi.mock('@/lib/domains/commerce/agent/report-share-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domains/commerce/agent/report-share-store')>();
  return { ...actual, getCommerceReportShareStore: () => ({ revokeShare }) };
});

import { DELETE } from './route';

const shareId = 'share_1234567890123456';
const context = {
  params: Promise.resolve({
    conversationId: 'conv_1234567890123456',
    messageId: 'msg_1234567890123456',
    shareId,
  }),
};

describe('Commerce report share revocation API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '1');
    vi.stubEnv('COMMERCE_DEV_TENANT_ID', 'tenant_report');
    vi.stubEnv('COMMERCE_DEV_USER_ID', 'operator_report');
    revokeShare.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('revokes an owner-scoped share', async () => {
    revokeShare.mockResolvedValue({ id: shareId, revokedAt: '2026-08-13T05:00:00.000Z' });
    const response = await DELETE(
      new NextRequest(`http://localhost:3000/api/commerce/conversations/conv_1234567890123456/messages/msg_1234567890123456/report/shares/${shareId}`, {
        method: 'DELETE',
        headers: { origin: 'http://localhost:3000' },
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(revokeShare).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_report', userId: 'operator_report' }),
      shareId,
      { conversationId: 'conv_1234567890123456', messageId: 'msg_1234567890123456' },
    );
  });

  it('rejects malformed ids before storage access', async () => {
    const response = await DELETE(
      new NextRequest('http://localhost:3000', { method: 'DELETE' }),
      { params: Promise.resolve({ conversationId: 'conv_1234567890123456', messageId: 'msg_1234567890123456', shareId: 'bad' }) },
    );
    expect(response.status).toBe(400);
    expect(revokeShare).not.toHaveBeenCalled();
  });
});

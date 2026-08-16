import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CommerceReportNotFoundError } from '@/lib/domains/commerce/agent/report-store';

const getActiveShare = vi.fn();
const createShare = vi.fn();
vi.mock('@/lib/domains/commerce/agent/report-share-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domains/commerce/agent/report-share-store')>();
  return {
    ...actual,
    getCommerceReportShareStore: () => ({ getActiveShare, createShare }),
  };
});

import { GET, POST } from './route';

const conversationId = 'conv_1234567890123456';
const messageId = 'msg_1234567890123456';
const context = { params: Promise.resolve({ conversationId, messageId }) };

function request(method: string, body?: unknown) {
  return new NextRequest(
    `http://localhost:3000/api/commerce/conversations/${conversationId}/messages/${messageId}/report/shares`,
    {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        origin: 'https://reports.example.test',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

describe('Commerce report share API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '1');
    vi.stubEnv('COMMERCE_DEV_TENANT_ID', 'tenant_report');
    vi.stubEnv('COMMERCE_DEV_USER_ID', 'operator_report');
    vi.stubEnv('COMMERCE_PUBLIC_ORIGIN', 'https://reports.example.test');
    getActiveShare.mockReset();
    createShare.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns owner-scoped active share metadata without a token', async () => {
    getActiveShare.mockResolvedValue({
      id: 'share_1234567890123456', reportId: 'report_1234567890123456',
      conversationId, messageId, createdAt: '2026-08-13T04:00:00.000Z',
      expiresAt: '2026-08-14T04:00:00.000Z', revokedAt: null,
    });
    const response = await GET(request('GET'), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, share: { id: 'share_1234567890123456' } });
  });

  it('creates a 24-hour share and builds the URL from the configured public origin', async () => {
    createShare.mockResolvedValue({
      id: 'share_1234567890123456', reportId: 'report_1234567890123456',
      conversationId, messageId, createdAt: '2026-08-13T04:00:00.000Z',
      expiresAt: '2026-08-14T04:00:00.000Z', revokedAt: null,
      token: 'A'.repeat(43),
    });
    const response = await POST(request('POST', {}), context);
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.share.url).toBe(`https://reports.example.test/api/commerce/reports/shared/${'A'.repeat(43)}`);
    expect(createShare).toHaveBeenCalledWith(expect.objectContaining({ expiresInHours: 24 }));
  });

  it('rejects malformed expiration before hitting storage', async () => {
    const response = await POST(request('POST', { expiresInHours: 0 }), context);
    expect(response.status).toBe(400);
    expect(createShare).not.toHaveBeenCalled();
  });

  it('does not enumerate missing reports', async () => {
    createShare.mockRejectedValue(new CommerceReportNotFoundError());
    const response = await POST(request('POST', {}), context);
    expect(response.status).toBe(404);
  });
});

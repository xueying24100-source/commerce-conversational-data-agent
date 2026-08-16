import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listForReview = vi.fn();
vi.mock('@/lib/domains/commerce/agent/feedback-store', () => ({
  getCommerceFeedbackStore: () => ({ listForReview }),
}));

import { GET } from './route';

const secret = 'lR4eTZ9_nwQt2P8SsHjDcVYmB7uXgL1Kf6AoC3zWvNi5QpRx';

function request(scopes: string) {
  return new NextRequest('https://commerce.example.com/api/commerce/feedback?status=received&limit=10', {
    headers: {
      'x-commerce-proxy-secret': secret,
      'x-commerce-tenant-id': 'tenant_feedback',
      'x-commerce-user-id': 'reviewer_feedback',
      'x-commerce-user-name': 'Reviewer',
      'x-commerce-scopes': scopes,
    },
  });
}

describe('Commerce feedback review queue API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '0');
    vi.stubEnv('COMMERCE_TRUSTED_PROXY_SECRET', secret);
    listForReview.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('requires the reviewer scope in addition to data read', async () => {
    const response = await GET(request('commerce:data:read'));
    expect(response.status).toBe(403);
    expect(listForReview).not.toHaveBeenCalled();
  });

  it('returns the tenant review queue for an authorized reviewer', async () => {
    listForReview.mockResolvedValue({ items: [{ id: 'feedback_1', status: 'received' }], nextCursor: null });
    const response = await GET(request('commerce:data:read commerce:feedback:review'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, items: [{ status: 'received' }] });
    expect(listForReview).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_feedback', userId: 'reviewer_feedback' }),
      { status: 'received', limit: 10 },
    );
  });
});

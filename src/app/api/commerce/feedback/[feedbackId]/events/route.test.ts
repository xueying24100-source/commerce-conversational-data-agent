import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appendReviewEvent = vi.fn();
vi.mock('@/lib/domains/commerce/agent/feedback-store', () => ({
  getCommerceFeedbackStore: () => ({ appendReviewEvent }),
}));

import { POST } from './route';

const feedbackId = 'feedback_1234567890123456';
const secret = 'lR4eTZ9_nwQt2P8SsHjDcVYmB7uXgL1Kf6AoC3zWvNi5QpRx';

function request(body: unknown, scopes = 'commerce:data:read commerce:feedback:review') {
  return new NextRequest(`https://commerce.example.com/api/commerce/feedback/${feedbackId}/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://commerce.example.com',
      'x-commerce-proxy-secret': secret,
      'x-commerce-tenant-id': 'tenant_feedback',
      'x-commerce-user-id': 'reviewer_feedback',
      'x-commerce-user-name': 'Reviewer',
      'x-commerce-scopes': scopes,
    },
    body: JSON.stringify(body),
  });
}

describe('Commerce feedback review event API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '0');
    vi.stubEnv('COMMERCE_TRUSTED_PROXY_SECRET', secret);
    vi.stubEnv('COMMERCE_PUBLIC_ORIGIN', 'https://commerce.example.com');
    appendReviewEvent.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('appends a bounded versioned reviewer action', async () => {
    appendReviewEvent.mockResolvedValue({ id: 1, version: 1, type: 'reviewed', status: 'reviewed' });
    const response = await POST(request({
      action: 'review', note: 'checked', requestId: 'feedback-review:req-1001', expectedVersion: 0,
    }), { params: Promise.resolve({ feedbackId }) });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ success: true, event: { status: 'reviewed' } });
  });

  it('rejects missing reviewer scope and invalid unversioned actions', async () => {
    const forbidden = await POST(request({
      action: 'review', requestId: 'feedback-review:req-1002', expectedVersion: 0,
    }, 'commerce:data:read'), { params: Promise.resolve({ feedbackId }) });
    expect(forbidden.status).toBe(403);
    const invalid = await POST(request({
      action: 'review', requestId: 'feedback-review:req-1003',
    }), { params: Promise.resolve({ feedbackId }) });
    expect(invalid.status).toBe(400);
    expect(appendReviewEvent).not.toHaveBeenCalled();
  });
});

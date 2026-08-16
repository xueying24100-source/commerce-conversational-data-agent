import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordCompletedReview = vi.fn();
vi.mock('@/lib/domains/commerce/agent/action-review-store', () => ({
  getCommerceActionReviewStore: () => ({ recordCompletedReview }),
}));

import { POST } from './route';

const conversationId = 'conv_1234567890123456';
const messageId = 'msg_1234567890123456';
const actionId = 'action_0123456789abcdef01234567';
const secret = 'lR4eTZ9_nwQt2P8SsHjDcVYmB7uXgL1Kf6AoC3zWvNi5QpRx';
const context = { params: Promise.resolve({ conversationId, messageId, actionId }) };
const submission = {
  runId: 'run_1234567890123456',
  reviewMessageId: 'msg_abcdefghijklmnop',
  question: '复盘行动效果。',
  plan: {
    status: 'ready' as const,
    message: '复盘窗口与数据覆盖完整。',
    question: '复盘行动效果。',
    current: { start: '2026-08-02', end: '2026-08-08' },
    baseline: { start: '2026-07-25', end: '2026-07-31' },
    reviewEnd: '2026-08-08',
    unavailableGuardrails: [],
  },
  requestId: 'review:req-1001',
};

function request(body: unknown, origin = 'https://commerce.example.com') {
  return new NextRequest(
    `https://commerce.example.com/api/commerce/conversations/${conversationId}/messages/${messageId}/actions/${actionId}/reviews`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'x-commerce-proxy-secret': secret,
        'x-commerce-tenant-id': 'tenant_action',
        'x-commerce-user-id': 'operator_action',
        'x-commerce-user-name': 'Operator',
        'x-commerce-scopes': 'commerce:data:read',
      },
      body: JSON.stringify(body),
    },
  );
}

describe('Commerce completed Action review API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '0');
    vi.stubEnv('COMMERCE_TRUSTED_PROXY_SECRET', secret);
    vi.stubEnv('COMMERCE_PUBLIC_ORIGIN', 'https://commerce.example.com');
    recordCompletedReview.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('records the authenticated Action-to-Run association', async () => {
    recordCompletedReview.mockResolvedValue({
      id: 'review_1234567890123456',
      actionId,
      runId: submission.runId,
    });
    const response = await POST(request(submission), context);

    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store, max-age=0');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      receipt: { actionId, runId: submission.runId },
    });
    expect(recordCompletedReview).toHaveBeenCalledWith({
      identity: expect.objectContaining({ tenantId: 'tenant_action', userId: 'operator_action' }),
      conversationId,
      sourceMessageId: messageId,
      actionId,
      submission,
    });
  });

  it('rejects an incomplete plan and an untrusted origin before storage', async () => {
    const invalid = await POST(request({ ...submission, plan: { status: 'ready' } }), context);
    const untrusted = await POST(request(submission, 'https://attacker.example'), context);

    expect(invalid.status).toBe(400);
    expect(untrusted.status).toBe(403);
    expect(recordCompletedReview).not.toHaveBeenCalled();
  });
});

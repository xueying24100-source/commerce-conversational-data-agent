import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const submit = vi.fn();
const getLatest = vi.fn();
vi.mock('@/lib/domains/commerce/agent/feedback-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domains/commerce/agent/feedback-store')>();
  return { ...actual, getCommerceFeedbackStore: () => ({ submit }) };
});
vi.mock('@/lib/domains/commerce/agent/feedback-status-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domains/commerce/agent/feedback-status-store')>();
  return { ...actual, getCommerceFeedbackStatusStore: () => ({ getLatest }) };
});

import { GET, POST } from './route';

const conversationId = 'conv_1234567890123456';
function request(body: unknown) {
  return new NextRequest(`http://localhost:3000/api/commerce/conversations/${conversationId}/feedback`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3000' },
    body: JSON.stringify(body),
  });
}

function statusRequest(messageId = 'msg_assistant_1') {
  return new NextRequest(
    `http://localhost:3000/api/commerce/conversations/${conversationId}/feedback?messageId=${messageId}`,
  );
}

describe('Commerce answer feedback API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '1');
    vi.stubEnv('COMMERCE_DEV_TENANT_ID', 'tenant_feedback');
    vi.stubEnv('COMMERCE_DEV_USER_ID', 'operator_feedback');
    submit.mockReset();
    getLatest.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('accepts bounded feedback and returns an auditable receipt', async () => {
    submit.mockResolvedValue({ id: 'feedback_1', status: 'received', createdAt: '2026-08-13T00:00:00.000Z' });
    const response = await POST(request({
      messageId: 'msg_assistant_1', runId: 'run_00000001', evidenceId: 'evidence_1',
      claimPath: '/totals/gmv', category: 'wrong_date', comment: '应为上一完整自然周',
      requestId: 'feedback:req-1001',
    }), { params: Promise.resolve({ conversationId }) });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ success: true, feedback: { status: 'received' } });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_feedback', userId: 'operator_feedback' }),
      conversationId, expect.objectContaining({ category: 'wrong_date' }),
    );
  });

  it('rejects unrecognized categories and oversized comments before storage', async () => {
    const invalid = await POST(request({ messageId: 'msg_assistant_1', runId: 'run_00000001', category: 'auto_fix_everything', requestId: 'feedback:req-1002' }), { params: Promise.resolve({ conversationId }) });
    expect(invalid.status).toBe(400);
    const oversized = await POST(request({ messageId: 'msg_assistant_1', runId: 'run_00000001', category: 'other', comment: 'x'.repeat(1_001), requestId: 'feedback:req-1003' }), { params: Promise.resolve({ conversationId }) });
    expect(oversized.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it('requires evidence whenever a claim path is supplied', async () => {
    const response = await POST(request({ messageId: 'msg_assistant_1', runId: 'run_00000001', claimPath: '/totals/gmv', category: 'data_issue', requestId: 'feedback:req-1004' }), { params: Promise.resolve({ conversationId }) });
    expect(response.status).toBe(400);
    expect(submit).not.toHaveBeenCalled();
  });

  it('returns owner-only feedback status without using the reviewer queue', async () => {
    getLatest.mockResolvedValue({
      id: 'feedback_1',
      conversationId,
      messageId: 'msg_assistant_1',
      category: 'wrong_metric',
      status: 'correction_enqueued',
      version: 2,
      reviewNote: '已安排重新核对。',
      correctionJobId: 'job_correction_1',
      correctionJobStatus: 'running',
      correctionRunId: null,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:01:00.000Z',
    });
    const response = await GET(statusRequest(), { params: Promise.resolve({ conversationId }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      feedback: { status: 'correction_enqueued', correctionJobId: 'job_correction_1' },
    });
    expect(getLatest).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_feedback', userId: 'operator_feedback' }),
      conversationId,
      'msg_assistant_1',
    );
  });

  it('returns null when the owner has no feedback for the answer', async () => {
    getLatest.mockResolvedValue(null);
    const response = await GET(statusRequest(), { params: Promise.resolve({ conversationId }) });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, feedback: null });
  });
});

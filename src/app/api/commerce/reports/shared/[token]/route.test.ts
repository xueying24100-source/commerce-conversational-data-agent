import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildReportArtifact } from '@/lib/domains/commerce/agent/report-store';
import { CommerceReportShareNotFoundError } from '@/lib/domains/commerce/agent/report-share-store';

const getSharedReport = vi.fn();
vi.mock('@/lib/domains/commerce/agent/report-share-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domains/commerce/agent/report-share-store')>();
  return { ...actual, getCommerceReportShareStore: () => ({ getSharedReport }) };
});

import { GET } from './route';

const token = 'A'.repeat(43);
const report = buildReportArtifact({
  reportId: 'report_1234567890123456',
  releaseRevision: '0123456789abcdef0123456789abcdef01234567',
  createdAt: '2026-08-13T03:05:00.000Z',
  identity: { tenantId: 'tenant_report', userId: 'operator_report' },
  conversation: { id: 'conv_1234567890123456', title: '经营复盘' },
  run: {
    id: 'run_1234567890123456', requestId: 'request:report-1',
    requestSha256: `sha256:${'a'.repeat(64)}`, model: 'deepseek-v4-flash', provider: 'deepseek',
    startedAt: '2026-08-13T03:00:00.000Z', completedAt: '2026-08-13T03:04:59.000Z',
  },
  question: { messageId: 'msg_question_1234567890123456', content: '复盘昨日经营表现。', createdAt: '2026-08-13T03:00:00.000Z' },
  answer: {
    messageId: 'msg_answer_1234567890123456', content: 'GMV 为 100 元。', createdAt: '2026-08-13T03:04:59.000Z',
    structured: { status: 'answered', answer: 'GMV 为 100 元。', answerClaims: [], findings: [], recommendations: [], followUps: [] },
  },
  traces: [],
});

const context = { params: Promise.resolve({ token }) };

describe('Anonymous commerce report share API', () => {
  beforeEach(() => {
    getSharedReport.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('serves only the read-only HTML report with defensive headers', async () => {
    getSharedReport.mockResolvedValue({
      share: {
        id: 'share_1234567890123456', reportId: report.reportId,
        conversationId: report.conversation.id, messageId: report.answer.messageId,
        createdAt: '2026-08-13T04:00:00.000Z', expiresAt: '2026-08-14T04:00:00.000Z', revokedAt: null,
      },
      report,
    });
    const response = await GET(
      new NextRequest(`http://localhost:3000/api/commerce/reports/shared/${token}`),
      context,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await response.text()).toContain('经营结论');
  });

  it('returns the same non-enumerating 404 for invalid and revoked links', async () => {
    getSharedReport.mockRejectedValue(new CommerceReportShareNotFoundError());
    const response = await GET(
      new NextRequest(`http://localhost:3000/api/commerce/reports/shared/${token}`),
      context,
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'COMMERCE_REPORT_SHARE_NOT_FOUND',
      message: '分享链接不可用。',
    });
    const malformed = await GET(
      new NextRequest('http://localhost:3000/api/commerce/reports/shared/not-a-token'),
      { params: Promise.resolve({ token: 'not-a-token' }) },
    );
    expect(malformed.status).toBe(404);
  });
});

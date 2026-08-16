import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildReportArtifact, CommerceReportNotFoundError } from '@/lib/domains/commerce/agent/report-store';

const get = vi.fn();
vi.mock('@/lib/domains/commerce/agent/report-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domains/commerce/agent/report-store')>();
  return { ...actual, getCommerceReportStore: () => ({ get }) };
});

import { GET } from './route';

const conversationId = 'conv_1234567890123456';
const messageId = 'msg_1234567890123456';
const report = buildReportArtifact({
  reportId: 'report_1234567890123456',
  releaseRevision: '0123456789abcdef0123456789abcdef01234567',
  createdAt: '2026-08-13T03:05:00.000Z',
  identity: { tenantId: 'tenant_report', userId: 'operator_report' },
  conversation: { id: conversationId, title: '经营复盘' },
  run: {
    id: 'run_1234567890123456', requestId: 'request:report-1',
    requestSha256: `sha256:${'a'.repeat(64)}`, model: 'deepseek-v4-flash', provider: 'deepseek',
    startedAt: '2026-08-13T03:00:00.000Z', completedAt: '2026-08-13T03:04:59.000Z',
  },
  question: {
    messageId: 'msg_question_1234567890123456', content: '复盘昨日经营表现。',
    createdAt: '2026-08-13T03:00:00.000Z',
  },
  answer: {
    messageId, content: 'GMV 为 100 元。', createdAt: '2026-08-13T03:04:59.000Z',
    structured: {
      status: 'answered', answer: 'GMV 为 100 元。', answerClaims: [], findings: [],
      recommendations: [], followUps: [],
    },
  },
  traces: [],
});

function request(format = 'json') {
  return new NextRequest(
    `http://localhost:3000/api/commerce/conversations/${conversationId}/messages/${messageId}/report?format=${format}`,
  );
}

const context = { params: Promise.resolve({ conversationId, messageId }) };

describe('Commerce report download API', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '1');
    vi.stubEnv('COMMERCE_DEV_TENANT_ID', 'tenant_report');
    vi.stubEnv('COMMERCE_DEV_USER_ID', 'operator_report');
    get.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('downloads the immutable JSON artifact with audit headers', async () => {
    get.mockResolvedValue(report);
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toContain(`${messageId}.json`);
    expect(response.headers.get('x-report-content-sha256')).toBe(report.contentSha256);
    await expect(response.json()).resolves.toEqual(report);
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant_report', userId: 'operator_report' }),
      conversationId,
      messageId,
    );
  });

  it('downloads the human-readable Markdown view of the same artifact', async () => {
    get.mockResolvedValue(report);
    const response = await GET(request('markdown'), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(response.headers.get('content-disposition')).toContain(`${messageId}.md`);
    expect(await response.text()).toContain(report.contentSha256);
  });

  it('rejects unsupported formats before storage access', async () => {
    const response = await GET(request('csv'), context);
    expect(response.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
  });

  it('returns a non-enumerating not-found response outside owner scope', async () => {
    get.mockRejectedValue(new CommerceReportNotFoundError());
    const response = await GET(request(), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: 'COMMERCE_REPORT_NOT_FOUND' });
  });
});

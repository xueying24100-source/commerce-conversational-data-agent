import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueConversation = vi.hoisted(() => vi.fn());

vi.mock('@/lib/domains/commerce/agent/jobs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/domains/commerce/agent/jobs')>();
  return {
    ...actual,
    getCommerceAsyncAgentService: () => ({ enqueueConversation }),
  };
});

import { POST } from './route';

function request(message: string, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost:3000/api/commerce/conversations', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost:3000',
      ...headers,
    },
    body: JSON.stringify({
      message,
      model: 'deepseek-v4-flash',
      requestId: 'request-abuse-0001',
    }),
  });
}

describe('create Commerce conversation abuse boundary', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('COMMERCE_DEV_AUTH_BYPASS', '1');
    vi.stubEnv('COMMERCE_DEV_TENANT_ID', 'tenant_route_abuse');
    vi.stubEnv('COMMERCE_DEV_USER_ID', 'operator_route_abuse');
    enqueueConversation.mockReset();
    enqueueConversation.mockResolvedValue({ id: 'job_route_abuse' });
  });

  afterEach(() => vi.unstubAllEnvs());

  it('rejects more than 2,000 characters before enqueue', async () => {
    const response = await POST(request('超'.repeat(2_001)));

    expect(response.status).toBe(400);
    expect(enqueueConversation).not.toHaveBeenCalled();
  });

  it('uses only the trusted ingress address and ignores a spoofed forwarded chain', async () => {
    const response = await POST(request('诊断上一完整周经营表现', {
      'x-real-ip': '203.0.113.7',
      'x-forwarded-for': '198.51.100.99, 10.0.0.2',
    }));

    expect(response.status).toBe(202);
    expect(enqueueConversation).toHaveBeenCalledWith(expect.objectContaining({
      ipAddress: '203.0.113.7',
    }));
  });

  it('does not accept X-Forwarded-For when the trusted ingress address is absent', async () => {
    const response = await POST(request('诊断上一完整周经营表现', {
      'x-forwarded-for': '198.51.100.99',
    }));

    expect(response.status).toBe(202);
    expect(enqueueConversation).toHaveBeenCalledWith(expect.objectContaining({
      ipAddress: null,
    }));
  });
});

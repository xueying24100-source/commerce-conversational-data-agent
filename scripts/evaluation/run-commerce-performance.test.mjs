import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  assertSemanticResponse,
  baseHeaders,
  concurrentMap,
  interleavedWorkload,
  percentile,
  summarize,
} = require('./run-commerce-performance.js');

const original = {
  COMMERCE_PERF_TENANT_ID: process.env.COMMERCE_PERF_TENANT_ID,
  COMMERCE_PERF_PROXY_SECRET: process.env.COMMERCE_PERF_PROXY_SECRET,
};

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('Commerce performance evidence harness', () => {
  it('uses nearest-rank percentiles and reports all release percentiles', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(percentile(values, 0.99)).toBe(99);
    expect(summarize(values)).toEqual({ samples: 100, p50Ms: 50, p95Ms: 95, p99Ms: 99, maxMs: 100 });
  });

  it('isolates every load-test request by stable trusted-proxy identity and IP', () => {
    process.env.COMMERCE_PERF_TENANT_ID = 'tenant_perf';
    process.env.COMMERCE_PERF_PROXY_SECRET = 'x'.repeat(48);
    const first = baseHeaders(0);
    const next = baseHeaders(1);
    expect(first['x-commerce-tenant-id']).toBe('tenant_perf');
    expect(first['x-commerce-user-id']).toBe('perf_user_0');
    expect(next['x-commerce-user-id']).toBe('perf_user_1');
    expect(first['x-forwarded-for']).not.toBe(next['x-forwarded-for']);
  });

  it('honors the requested concurrency without dropping result order', async () => {
    let active = 0;
    let peak = 0;
    const results = await concurrentMap(12, 3, async (index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return index * 2;
    });
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, index) => index * 2));
  });

  it('interleaves four reads and one write while preserving 1,000 samples per endpoint', () => {
    const endpoints = [
      { name: 'readiness', method: 'GET' },
      { name: 'conversations', method: 'GET' },
      { name: 'jobs', method: 'GET' },
      { name: 'evidence', method: 'GET' },
      { name: 'create-diagnosis-job', method: 'POST' },
    ];
    const workload = interleavedWorkload(endpoints, 1000);
    expect(workload).toHaveLength(5000);
    expect(workload.filter((item) => item.endpoint.method === 'GET')).toHaveLength(4000);
    for (const endpoint of endpoints) {
      expect(workload.filter((item) => item.endpoint.name === endpoint.name)).toHaveLength(1000);
    }
    expect(workload.slice(0, 10).filter((item) => item.endpoint.method === 'POST')).toHaveLength(2);
  });

  it('rejects status-only dummy responses and requires the deployed revision', () => {
    const headers = new Headers();
    expect(() => assertSemanticResponse(
      { name: 'readiness' },
      { headers },
      { ok: true, service: 'commerce-data-agent', revision: 'wrong' },
      'release123',
    )).toThrow('revision mismatch');
    expect(() => assertSemanticResponse(
      { name: 'create-diagnosis-job' },
      { headers },
      { success: true, job: { id: 'job_1', status: 'queued' } },
      'release123',
    )).toThrow('revision-bound');
  });
});

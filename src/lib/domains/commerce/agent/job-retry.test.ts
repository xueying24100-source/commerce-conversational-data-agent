import { describe, expect, it } from 'vitest';

import { commerceJobRetryDelay, commerceJobRetrySignal } from './job-retry';

describe('Commerce Job retry policy', () => {
  it('finds retryable provider errors through Commerce wrappers', () => {
    const provider = Object.assign(new Error('upstream throttled'), {
      code: 'HTTP_ERROR',
      status: 429,
      retryAfterMs: 12_000,
    });
    const run = Object.assign(new Error('agent failed'), { cause: provider });
    const turn = Object.assign(new Error('turn failed'), { originalError: run });
    expect(commerceJobRetrySignal(turn)).toEqual({
      retryable: true,
      retryAfterMs: 12_000,
    });
  });

  it('retries transient PostgreSQL and transport codes but not validation failures', () => {
    expect(commerceJobRetrySignal(Object.assign(new Error('serialization'), { code: '40001' })))
      .toMatchObject({ retryable: true });
    expect(commerceJobRetrySignal(Object.assign(new Error('network'), { code: 'ECONNRESET' })))
      .toMatchObject({ retryable: true });
    expect(commerceJobRetrySignal(Object.assign(new Error('invalid'), { code: 'INVALID_MESSAGE' })))
      .toEqual({ retryable: false, retryAfterMs: null });
  });

  it('applies bounded exponential backoff and Retry-After with deterministic jitter', () => {
    expect(commerceJobRetryDelay({
      attemptCount: 3,
      baseMs: 2_000,
      maxMs: 60_000,
      random: () => 0.5,
    })).toBe(8_000);
    expect(commerceJobRetryDelay({
      attemptCount: 1,
      baseMs: 2_000,
      maxMs: 60_000,
      retryAfterMs: 20_000,
      random: () => 0.5,
    })).toBe(20_000);
    expect(commerceJobRetryDelay({
      attemptCount: 10,
      baseMs: 2_000,
      maxMs: 60_000,
      random: () => 1,
    })).toBe(60_000);
  });
});

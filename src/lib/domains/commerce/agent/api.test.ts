import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { commerceApiError, readCommerceJson } from './api';
import {
  CommerceJobRateLimitError,
  CommerceModelBudgetExceededError,
} from './job-store';
import { CommerceKillSwitchError } from './jobs';
import { CommerceAgentRunError } from './runtime';
import { CommerceRequestStateError, CommerceTurnExecutionError } from './service';

describe('Commerce API body boundary', () => {
  it('enforces the byte limit even without trusting Content-Length', async () => {
    const request = new NextRequest('http://localhost/api/commerce/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(25_000) }),
    });

    await expect(readCommerceJson(request)).rejects.toMatchObject({
      code: 'REQUEST_TOO_LARGE',
    });
  });

  it('rejects non-JSON content types before parsing', async () => {
    const request = new NextRequest('http://localhost/api/commerce/conversations', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    });

    await expect(readCommerceJson(request)).rejects.toBeInstanceOf(CommerceAgentRunError);
    await expect(readCommerceJson(new NextRequest('http://localhost', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}',
    }))).rejects.toMatchObject({ code: 'INVALID_CONTENT_TYPE' });
  });

  it('returns the durable conversation ID when a claimed turn fails', async () => {
    const response = commerceApiError(new CommerceTurnExecutionError(
      'conv_failed_first_turn',
      new CommerceAgentRunError('MODEL_TIMEOUT', 'Model timed out.'),
    ));

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'MODEL_TIMEOUT',
      conversationId: 'conv_failed_first_turn',
    });
  });

  it('distinguishes a still-running idempotent request from a failed one', () => {
    expect(new CommerceRequestStateError('running').code).toBe('COMMERCE_REQUEST_RUNNING');
    expect(new CommerceRequestStateError('failed').code).toBe('COMMERCE_REQUEST_NOT_REPLAYABLE');
  });

  it('returns stable limiting responses for hourly and daily budget gates', async () => {
    const account = commerceApiError(new CommerceJobRateLimitError('account'));
    const budget = commerceApiError(new CommerceModelBudgetExceededError());

    expect(account.status).toBe(429);
    expect(account.headers.get('retry-after')).toBe('3600');
    await expect(account.json()).resolves.toMatchObject({
      error: 'COMMERCE_DIAGNOSIS_RATE_LIMITED',
      scope: 'account',
    });
    expect(budget.status).toBe(429);
    await expect(budget.json()).resolves.toMatchObject({
      error: 'COMMERCE_DAILY_MODEL_BUDGET_EXCEEDED',
    });
  });

  it('returns service unavailable while the global kill switch is active', async () => {
    const response = commerceApiError(new CommerceKillSwitchError());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: 'COMMERCE_GLOBAL_KILL_SWITCH',
    });
  });
});

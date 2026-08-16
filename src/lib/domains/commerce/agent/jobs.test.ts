import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CommerceJobInvalidMessageError,
  CommerceModelBudgetExceededError,
  type PostgresCommerceJobStore,
} from './job-store';
import { CommerceAsyncAgentService, CommerceKillSwitchError } from './jobs';
import type { CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_abuse',
  userId: 'operator_abuse',
  displayName: 'Abuse test operator',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};

function serviceWithEnqueue(enqueue: ReturnType<typeof vi.fn>) {
  return new CommerceAsyncAgentService({ enqueue } as unknown as PostgresCommerceJobStore);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Commerce async pre-enqueue gates', () => {
  it('checks the global kill switch before model runtime initialization or queue access', async () => {
    vi.stubEnv('COMMERCE_GLOBAL_KILL_SWITCH', '1');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const enqueue = vi.fn();

    await expect(serviceWithEnqueue(enqueue).enqueueConversation({
      identity,
      message: '诊断上一完整周经营表现',
      model: 'deepseek-v4-flash',
      requestId: 'kill-switch-request',
    })).rejects.toBeInstanceOf(CommerceKillSwitchError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('checks the 2,000-character limit before model configuration or queue access', async () => {
    vi.stubEnv('COMMERCE_GLOBAL_KILL_SWITCH', '0');
    vi.stubEnv('DEEPSEEK_API_KEY', '');
    const enqueue = vi.fn();

    await expect(serviceWithEnqueue(enqueue).enqueueConversation({
      identity,
      message: '超'.repeat(2_001),
      model: 'deepseek-v4-flash',
      requestId: 'oversized-request',
    })).rejects.toBeInstanceOf(CommerceJobInvalidMessageError);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('hashes the network source and never contacts a provider while enqueueing', async () => {
    vi.stubEnv('COMMERCE_GLOBAL_KILL_SWITCH', '0');
    vi.stubEnv('COMMERCE_LLM_AGENT_ENABLED', '1');
    vi.stubEnv('DEEPSEEK_API_KEY', 'configured-for-abuse-test');
    vi.stubEnv('DAILY_MODEL_BUDGET_USD', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const enqueue = vi.fn().mockResolvedValue({ id: 'job_hash_test' });

    await serviceWithEnqueue(enqueue).enqueueConversation({
      identity,
      message: '诊断上一完整周经营表现',
      model: 'deepseek-v4-flash',
      requestId: 'hashed-ip-request',
      ipAddress: '203.0.113.7',
    });

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      ipHash: createHash('sha256').update('203.0.113.7').digest('hex'),
      ipHourlyLimit: 20,
    }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('propagates a daily budget denial without making a provider request', async () => {
    vi.stubEnv('COMMERCE_GLOBAL_KILL_SWITCH', '0');
    vi.stubEnv('COMMERCE_LLM_AGENT_ENABLED', '1');
    vi.stubEnv('DEEPSEEK_API_KEY', 'configured-for-budget-test');
    vi.stubEnv('DAILY_MODEL_BUDGET_USD', '1');
    vi.stubEnv('COMMERCE_MODEL_INPUT_USD_PER_MILLION_TOKENS', '2');
    vi.stubEnv('COMMERCE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS', '4');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const enqueue = vi.fn().mockRejectedValue(new CommerceModelBudgetExceededError());

    await expect(serviceWithEnqueue(enqueue).enqueueConversation({
      identity,
      message: '诊断上一完整周经营表现',
      model: 'deepseek-v4-flash',
      requestId: 'budget-denied-request',
    })).rejects.toBeInstanceOf(CommerceModelBudgetExceededError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

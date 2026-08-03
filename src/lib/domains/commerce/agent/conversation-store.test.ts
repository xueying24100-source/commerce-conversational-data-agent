import { describe, expect, it } from 'vitest';

import type {
  CommerceDatabase,
  CommerceQueryResult,
  CommerceSqlClient,
} from './database';
import {
  CommerceConversationBusyError,
  CommerceIdempotencyConflictError,
  PostgresCommerceConversationStore,
  commerceRateLimitScopeKey,
} from './conversation-store';
import type { CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_test',
  userId: 'user_test',
  displayName: 'Test operator',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};

const REQUEST_HASH = `sha256:${'a'.repeat(64)}`;

class ScriptedDatabase implements CommerceDatabase {
  readonly queries: string[] = [];

  constructor(
    private readonly execute: (
      text: string,
      values: readonly unknown[],
    ) => CommerceQueryResult<Record<string, unknown>>,
  ) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    this.queries.push(text);
    return this.execute(text, values) as CommerceQueryResult<Row>;
  }

  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async ping(): Promise<void> {}
}

function result(rows: Record<string, unknown>[] = []): CommerceQueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length };
}

describe('PostgreSQL Commerce conversation claims', () => {
  it('uses collision-resistant structured rate-limit scopes', () => {
    const left = commerceRateLimitScopeKey('user', { tenantId: 'a:b', userId: 'c' });
    const right = commerceRateLimitScopeKey('user', { tenantId: 'a', userId: 'b:c' });

    expect(left).not.toBe(right);
    expect(left).toMatch(/^user:sha256:[0-9a-f]{64}$/u);
  });

  it('applies both durable rate limits before creating a conversation', async () => {
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes("error_code = 'RUN_LEASE_EXPIRED'")) return result();
      if (text.includes('SELECT id, status, request_sha256')) return result();
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('AS active_count')) return result([{ active_count: 0 }]);
      if (text.includes('INSERT INTO commerce_agent_rate_limits')) {
        const limit = Number(values[1]);
        return result([{ request_count: limit + 1 }]);
      }
      if (text.includes('DELETE FROM commerce_agent_rate_limits')) return result();
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const store = new PostgresCommerceConversationStore(database);

    await expect(store.createConversationAndBeginTurn({
      identity,
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      userMessage: '查看 GMV',
      requestId: 'req_rate_12345678',
      requestSha256: REQUEST_HASH,
      runId: 'run_rate',
      rateLimit: 20,
      tenantRateLimit: 200,
      globalConcurrencyLimit: 8,
      tenantConcurrencyLimit: 10,
      leaseMs: 90_000,
    })).resolves.toMatchObject({ created: false, reason: 'rate_limited' });

    expect(database.queries.some(
      (query) => query.includes('INSERT INTO commerce_agent_conversations'),
    )).toBe(false);
  });

  it('rejects a new run when the global analytics capacity is saturated', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes("error_code = 'RUN_LEASE_EXPIRED'")) return result();
      if (text.includes('SELECT id, status, request_sha256')) return result();
      if (text.includes("hashtextextended('commerce-agent:global'")) return result([{}]);
      if (text.includes('AS active_count')) return result([{ active_count: 8 }]);
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const store = new PostgresCommerceConversationStore(database);

    await expect(store.createConversationAndBeginTurn({
      identity,
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      userMessage: '查看 GMV',
      requestId: 'req_capacity_123',
      requestSha256: REQUEST_HASH,
      runId: 'run_capacity',
      rateLimit: 20,
      tenantRateLimit: 200,
      globalConcurrencyLimit: 8,
      tenantConcurrencyLimit: 4,
      leaseMs: 90_000,
    })).resolves.toMatchObject({ created: false, reason: 'concurrency_limited' });

    expect(database.queries.some(
      (query) => query.includes('INSERT INTO commerce_agent_rate_limits'),
    )).toBe(false);
  });

  it('loads model context by complete runs so user and assistant messages stay paired', async () => {
    const database = new ScriptedDatabase((text, values) => {
      if (!text.includes('WITH recent_completed_runs')) {
        throw new Error(`Unexpected SQL in test: ${text}`);
      }
      expect(text).toContain("status = 'completed'");
      expect(values).toEqual(['conv_1', identity.tenantId, identity.userId, 3]);
      return result([
        {
          id: 'msg_user',
          role: 'user',
          content: '上一轮问题',
          answer_json: null,
          run_id: 'run_completed',
          run_status: 'completed',
          created_at: new Date('2026-07-27T00:00:00.000Z'),
        },
        {
          id: 'msg_assistant',
          role: 'assistant',
          content: '上一轮回答',
          answer_json: null,
          run_id: 'run_completed',
          run_status: 'completed',
          created_at: new Date('2026-07-27T00:00:01.000Z'),
        },
      ]);
    });
    const store = new PostgresCommerceConversationStore(database);

    await expect(store.getModelHistory(identity, 'conv_1', 3)).resolves.toMatchObject([
      { role: 'user', runStatus: 'completed' },
      { role: 'assistant', runStatus: 'completed' },
    ]);
  });

  it('rejects reuse of an idempotency key for a different payload', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('FROM commerce_agent_conversations')) {
        return result([{
          id: 'conv_1',
          title: 'Conversation',
          model: 'deepseek-v4-flash',
          created_at: new Date(),
          updated_at: new Date(),
        }]);
      }
      if (text.includes("error_code = 'RUN_LEASE_EXPIRED'")) return result();
      if (text.includes('SELECT id, status, request_sha256')) {
        return result([{
          id: 'run_existing',
          status: 'completed',
          request_sha256: `sha256:${'b'.repeat(64)}`,
        }]);
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const store = new PostgresCommerceConversationStore(database);

    await expect(store.beginTurn({
      identity,
      conversationId: 'conv_1',
      requestId: 'req_existing_123',
      requestSha256: REQUEST_HASH,
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      userMessage: '查看 GMV',
      rateLimit: 20,
      tenantRateLimit: 200,
      globalConcurrencyLimit: 8,
      tenantConcurrencyLimit: 10,
      leaseMs: 90_000,
    })).rejects.toBeInstanceOf(CommerceIdempotencyConflictError);
    expect(database.queries.some((query) => query.includes('commerce_agent_rate_limits'))).toBe(false);
  });

  it('maps the one-active-turn database invariant to a retriable busy error', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('FROM commerce_agent_conversations')) {
        return result([{
          id: 'conv_1',
          title: 'Conversation',
          model: 'deepseek-v4-flash',
          created_at: new Date(),
          updated_at: new Date(),
        }]);
      }
      if (text.includes("error_code = 'RUN_LEASE_EXPIRED'")) return result();
      if (text.includes('SELECT id, status, request_sha256')) return result();
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('AS active_count')) return result([{ active_count: 0 }]);
      if (text.includes('INSERT INTO commerce_agent_rate_limits')) {
        return result([{ request_count: 1 }]);
      }
      if (text.includes('DELETE FROM commerce_agent_rate_limits')) return result();
      if (text.includes('INSERT INTO commerce_agent_runs')) {
        throw Object.assign(new Error('duplicate active turn'), {
          code: '23505',
          constraint: 'commerce_agent_one_active_turn_idx',
        });
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const store = new PostgresCommerceConversationStore(database);

    await expect(store.beginTurn({
      identity,
      conversationId: 'conv_1',
      requestId: 'req_new_12345678',
      requestSha256: REQUEST_HASH,
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      userMessage: '查看 GMV',
      rateLimit: 20,
      tenantRateLimit: 200,
      globalConcurrencyLimit: 8,
      tenantConcurrencyLimit: 10,
      leaseMs: 90_000,
    })).rejects.toBeInstanceOf(CommerceConversationBusyError);
  });
});

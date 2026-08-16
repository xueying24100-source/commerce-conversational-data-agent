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
    if (text.includes("set_config('commerce.control_system'")) {
      return result() as CommerceQueryResult<Row>;
    }
    return this.execute(text, values) as CommerceQueryResult<Row>;
  }

  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async ping(): Promise<void> {}
}

class TransactionOnlyDatabase implements CommerceDatabase {
  readonly queries: string[] = [];
  transactionCount = 0;
  private inTransaction = false;

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
    if (!this.inTransaction) throw new Error('completeTurn issued a query outside its transaction.');
    this.queries.push(text);
    return this.execute(text, values) as CommerceQueryResult<Row>;
  }

  async transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    this.transactionCount += 1;
    this.inTransaction = true;
    try {
      return await work(this);
    } finally {
      this.inTransaction = false;
    }
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

  it('only marks messages with a persisted immutable report as downloadable', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('FROM commerce_agent_conversations')) {
        return result([{
          id: 'conv_1',
          title: 'Conversation',
          model: 'deepseek-v4-flash',
          created_at: new Date('2026-08-13T00:00:00.000Z'),
          updated_at: new Date('2026-08-13T00:00:01.000Z'),
        }]);
      }
      if (text.includes('FROM commerce_agent_messages AS message')) {
        expect(text).toContain('FROM commerce_agent_reports AS report');
        return result([{
          id: 'msg_assistant',
          role: 'assistant',
          content: '已完成。',
          answer_json: null,
          run_id: null,
          run_status: 'completed',
          report_available: true,
          created_at: new Date('2026-08-13T00:00:01.000Z'),
        }]);
      }
      if (text.includes('FROM commerce_agent_action_events')) return result();
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const store = new PostgresCommerceConversationStore(database);

    const conversation = await store.getConversation(identity, 'conv_1');

    expect(conversation?.messages).toEqual([
      expect.objectContaining({ id: 'msg_assistant', reportAvailable: true }),
    ]);
  });

  it('restores the latest action commitment and execution note with the conversation', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('FROM commerce_agent_conversations')) {
        return result([{
          id: 'conv_1',
          title: 'Conversation',
          model: 'deepseek-v4-flash',
          created_at: new Date('2026-08-13T00:00:00.000Z'),
          updated_at: new Date('2026-08-13T00:00:01.000Z'),
        }]);
      }
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{
          id: 'msg_assistant',
          role: 'assistant',
          content: '已完成。',
          answer_json: null,
          run_id: 'run_1',
          run_status: 'completed',
          report_available: false,
          created_at: new Date('2026-08-13T00:00:01.000Z'),
        }]);
      }
      if (text.includes('FROM commerce_agent_evidence')) return result();
      if (text.includes('FROM commerce_agent_action_events')) {
        return result([{
          message_id: 'msg_assistant',
          action_id: `action_${'a'.repeat(24)}`,
          event_type: 'blocked',
          version: 3,
          details_json: {
            commitment: {
              assignee: '运营团队',
              dueDate: '2026-08-20',
              target: 120,
              evaluationWindowDays: 7,
            },
            note: '等待库存到货。',
          },
          created_at: new Date('2026-08-13T00:00:02.000Z'),
        }]);
      }
      throw new Error(`Unexpected SQL in test: ${text}`);
    });

    const conversation = await new PostgresCommerceConversationStore(database)
      .getConversation(identity, 'conv_1');

    expect(conversation?.messages[0]?.actionStates).toEqual([{
      actionId: `action_${'a'.repeat(24)}`,
      status: 'blocked',
      version: 3,
      updatedAt: '2026-08-13T00:00:02.000Z',
      commitment: {
        assignee: '运营团队',
        dueDate: '2026-08-20',
        target: 120,
        evaluationWindowDays: 7,
      },
      lastNote: '等待库存到货。',
    }]);
  });

  it('returns a safe persisted failure diagnosis without exposing the raw provider error', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('FROM commerce_agent_conversations')) {
        return result([{
          id: 'conv_1', title: 'Conversation', model: 'deepseek-v4-flash',
          created_at: new Date('2026-08-13T00:00:00.000Z'),
          updated_at: new Date('2026-08-13T00:00:01.000Z'),
        }]);
      }
      if (text.includes('FROM commerce_agent_messages AS message')) {
        return result([{
          id: 'msg_user', role: 'user', content: '分析昨日经营。', answer_json: null,
          run_id: 'run_failed', run_status: 'failed', run_error_code: 'MODEL_TIMEOUT',
          run_error_message: 'secret upstream host timed out', report_available: false,
          created_at: new Date('2026-08-13T00:00:01.000Z'),
        }]);
      }
      if (text.includes('FROM commerce_agent_evidence')) return result();
      if (text.includes('FROM commerce_agent_action_events')) return result();
      throw new Error(`Unexpected SQL in test: ${text}`);
    });

    const conversation = await new PostgresCommerceConversationStore(database)
      .getConversation(identity, 'conv_1');

    expect(conversation?.messages[0]).toMatchObject({
      runStatus: 'failed',
      runError: {
        code: 'MODEL_TIMEOUT',
        message: '模型或数据查询响应超时，本次没有生成回答。',
        retryable: true,
      },
    });
    expect(JSON.stringify(conversation)).not.toContain('secret upstream host');
  });

  it('persists the completed run, answer, evidence, and immutable report in one transaction', async () => {
    const database = new TransactionOnlyDatabase((text, values) => {
      if (text.includes('UPDATE commerce_agent_runs')) {
        return result([{
          id: 'run_1',
          request_id: 'req_12345678',
          request_sha256: REQUEST_HASH,
          model: 'deepseek-v4-flash',
          provider: 'deepseek',
          started_at: new Date('2026-08-13T00:00:00.000Z'),
          completed_at: new Date('2026-08-13T00:00:02.000Z'),
        }]);
      }
      if (text.includes('SELECT conversation.title')) {
        return result([{
          title: 'Conversation',
          question_id: 'msg_question',
          question_content: '查看 GMV',
          question_created_at: new Date('2026-08-13T00:00:00.000Z'),
        }]);
      }
      if (text.includes('INSERT INTO commerce_agent_messages')) {
        return result([{ created_at: new Date('2026-08-13T00:00:02.000Z') }]);
      }
      if (text.includes('INSERT INTO commerce_agent_evidence')) return result();
      if (text.includes('INSERT INTO commerce_agent_reports')) {
        return result([{ content_sha256: values[8] }]);
      }
      if (text.includes('UPDATE commerce_agent_conversations')) return result();
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const store = new PostgresCommerceConversationStore(database);

    await store.completeTurn({
      identity,
      conversationId: 'conv_1',
      runId: 'run_1',
      generation: 1,
      assistantMessageId: 'msg_answer',
      answer: {
        status: 'answered',
        answer: 'GMV 为 100。',
        answerClaims: [],
        findings: [],
        recommendations: [],
        followUps: [],
      },
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      traces: [{
        evidenceId: 'evidence_1',
        operation: 'commerce_totals',
        fetchedAt: '2026-08-13T00:00:01.000Z',
        rowCount: 1,
        requestSha256: `sha256:${'b'.repeat(64)}`,
        responseSha256: `sha256:${'c'.repeat(64)}`,
        sourceWatermark: null,
        request: { metrics: ['gmv'] },
        preview: { totals: { gmv: 100 } },
        previewTruncated: false,
      }],
    });

    expect(database.transactionCount).toBe(1);
    const evidenceIndex = database.queries.findIndex((query) => query.includes('INSERT INTO commerce_agent_evidence'));
    const reportIndex = database.queries.findIndex((query) => query.includes('INSERT INTO commerce_agent_reports'));
    expect(evidenceIndex).toBeGreaterThan(-1);
    expect(reportIndex).toBeGreaterThan(evidenceIndex);
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

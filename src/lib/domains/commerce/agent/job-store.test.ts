import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import {
  CommerceJobInvalidMessageError,
  CommerceJobEnqueueDisabledError,
  CommerceJobQueueFullError,
  CommerceJobRateLimitError,
  CommerceModelBudgetExceededError,
  PostgresCommerceJobStore,
} from './job-store';
import type { ClaimedCommerceAgentJob } from './job-store';
import type { CommerceAgentRunResponse, CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_jobs',
  userId: 'operator_jobs',
  displayName: 'Operator',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};

afterEach(() => vi.unstubAllEnvs());

class JobDatabase implements CommerceDatabase {
  queryText = '';
  values: readonly unknown[] = [];

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    if (text.includes("set_config('commerce.tenant_id'")) {
      return { rows: [], rowCount: 0 };
    }
    this.queryText = text;
    this.values = values;
    return {
      rows: [{
        id: 'job_1234567890abcdef',
        tenant_id: identity.tenantId,
        user_id: identity.userId,
        user_display_name: identity.displayName,
        auth_mode: identity.authMode,
        scopes: identity.scopes,
        kind: 'conversation_turn',
        conversation_id: 'conv_1234567890abcdef',
        request_id: 'req_12345678',
        request_sha256: `sha256:${'a'.repeat(64)}`,
        model: 'deepseek-v4-flash',
        message: '分析最近一周 GMV',
        status: 'running',
        required_revision: 'abcdef1',
        executed_by_worker_id: 'worker-1',
        attempt_count: 1,
        max_attempts: 3,
        available_at: new Date('2026-08-13T00:00:00.000Z'),
        result_json: null,
        error_code: null,
        error_message: null,
        created_at: new Date('2026-08-13T00:00:00.000Z'),
        started_at: new Date('2026-08-13T00:00:01.000Z'),
        completed_at: null,
      }] as unknown as Row[],
      rowCount: 1,
    };
  }

  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async ping(): Promise<void> {}
}

type TerminalOutcome = 'complete' | 'fail' | 'requeue' | 'dead_letter';

class TerminalJobDatabase implements CommerceDatabase {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];

  constructor(
    private readonly outcome: TerminalOutcome,
    private readonly correctionEnqueued = true,
  ) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    this.queries.push({ text, values });
    if (text.includes("SET status = 'queued'")) {
      const rows = this.outcome === 'requeue'
        ? [{ id: job.id, available_at: new Date('2026-08-13T00:01:00.000Z') }]
        : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    }
    if (text.includes("SET status = 'dead_letter'")) {
      const rows = this.outcome === 'dead_letter' ? [{ id: job.id }] : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    }
    if (text.includes("SET status = 'completed'") || text.includes("SET status = 'failed'")) {
      return { rows: [{ id: job.id }] as unknown as Row[], rowCount: 1 };
    }
    if (text.includes('FROM commerce_agent_feedback_events AS event')) {
      const rows = this.correctionEnqueued
        ? [{
            feedback_id: 'feedback_1234567890abcdef',
            version: 2,
            original_run_id: 'run_original_12345678',
          }]
        : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    }
    return { rows: [], rowCount: text.includes('INSERT INTO') ? 1 : 0 };
  }

  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async ping(): Promise<void> {}
}

type AbuseJobRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  user_id: string;
  request_id: string;
  status: string;
};

type BudgetReservation = {
  budgetDate: string;
  reservedUsd: number;
  inputRate: number;
  outputRate: number;
  actualUsd: number | null;
  settlement: string | null;
};

class AbuseControlDatabase implements CommerceDatabase {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  jobs: AbuseJobRow[] = [];
  limits = new Map<string, number>();
  budget = { reservedUsd: 0, spentUsd: 0 };
  reservations = new Map<string, BudgetReservation>();

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    this.queries.push({ text, values });
    if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (text.includes('FROM commerce_agent_jobs') && text.includes('request_id = $3')) {
      const row = this.jobs.find((candidate) => (
        candidate.tenant_id === values[0]
        && candidate.user_id === values[1]
        && candidate.request_id === values[2]
      ));
      return { rows: (row ? [row] : []) as unknown as Row[], rowCount: row ? 1 : 0 };
    }
    if (text.includes('INSERT INTO commerce_agent_rate_limits')) {
      const key = String(values[0]);
      const maximum = Number(values[1]);
      const current = this.limits.get(key) ?? 0;
      if (current >= maximum) return { rows: [], rowCount: 0 };
      this.limits.set(key, current + 1);
      return {
        rows: [{ request_count: current + 1 }] as unknown as Row[],
        rowCount: 1,
      };
    }
    if (text.includes('COUNT(*)::integer AS count')) {
      const count = this.jobs.filter((candidate) => (
        candidate.tenant_id === values[0]
        && candidate.user_id === values[1]
        && ['queued', 'running'].includes(candidate.status)
      )).length;
      return { rows: [{ count }] as unknown as Row[], rowCount: 1 };
    }
    if (text.includes('INSERT INTO commerce_agent_model_budget_daily')) {
      const reservation = Number(values[0]);
      const limit = Number(values[1]);
      if (this.budget.reservedUsd + this.budget.spentUsd + reservation > limit) {
        return { rows: [], rowCount: 0 };
      }
      this.budget.reservedUsd += reservation;
      return {
        rows: [{ budget_date: '2026-08-16' }] as unknown as Row[],
        rowCount: 1,
      };
    }
    if (text.includes('INSERT INTO commerce_agent_jobs')) {
      const now = new Date('2026-08-16T00:00:00.000Z');
      const row = {
        id: String(values[0]),
        tenant_id: String(values[1]),
        user_id: String(values[2]),
        user_display_name: String(values[3]),
        auth_mode: String(values[4]),
        scopes: values[5],
        kind: String(values[6]),
        conversation_id: values[7] ?? null,
        request_id: String(values[8]),
        request_sha256: String(values[9]),
        model: String(values[10]),
        message: String(values[11]),
        required_revision: String(values[12]),
        executed_by_worker_id: null,
        status: 'queued',
        attempt_count: 0,
        max_attempts: Number(values[13]),
        available_at: now,
        result_json: null,
        error_code: null,
        error_message: null,
        created_at: now,
        started_at: null,
        completed_at: null,
      } satisfies AbuseJobRow;
      this.jobs.push(row);
      return { rows: [row] as unknown as Row[], rowCount: 1 };
    }
    if (text.includes('INSERT INTO commerce_agent_model_budget_reservations')) {
      this.reservations.set(String(values[0]), {
        budgetDate: String(values[1]),
        reservedUsd: Number(values[2]),
        inputRate: Number(values[3]),
        outputRate: Number(values[4]),
        actualUsd: null,
        settlement: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('commerce_settle_model_budget')) {
      const reservation = this.reservations.get(String(values[0]));
      if (!reservation || reservation.settlement !== null) {
        return { rows: [{ commerce_settle_model_budget: false }] as unknown as Row[], rowCount: 1 };
      }
      const conservative = values[1] === null || values[1] === undefined;
      const actualUsd = conservative
        ? reservation.reservedUsd
        : Math.round((
            Number(values[1]) * reservation.inputRate
            + Number(values[2]) * reservation.outputRate
          ) / 1_000_000 * 100_000_000) / 100_000_000;
      this.budget.reservedUsd = Math.max(0, this.budget.reservedUsd - reservation.reservedUsd);
      this.budget.spentUsd += actualUsd;
      reservation.actualUsd = actualUsd;
      reservation.settlement = conservative ? 'conservative' : 'actual';
      return { rows: [{ commerce_settle_model_budget: true }] as unknown as Row[], rowCount: 1 };
    }
    if (text.includes('FROM commerce_agent_model_budget_reservations')) {
      const reservation = this.reservations.get(String(values[0]));
      const rows = reservation && reservation.settlement === null
        ? [{
            budget_date: reservation.budgetDate,
            reserved_usd: reservation.reservedUsd,
            input_usd_per_million_tokens: reservation.inputRate,
            output_usd_per_million_tokens: reservation.outputRate,
          }]
        : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    }
    if (text.includes('UPDATE commerce_agent_model_budget_daily')) {
      this.budget.reservedUsd = Math.max(0, this.budget.reservedUsd - Number(values[0]));
      this.budget.spentUsd += Number(values[1]);
      return {
        rows: [{ budget_date: values[2] }] as unknown as Row[],
        rowCount: 1,
      };
    }
    if (text.includes('UPDATE commerce_agent_model_budget_reservations')) {
      const reservation = this.reservations.get(String(values[2]));
      if (reservation) {
        reservation.actualUsd = Number(values[0]);
        reservation.settlement = String(values[1]);
      }
      return { rows: [], rowCount: reservation ? 1 : 0 };
    }
    if (text.includes("SET status = 'completed'")) {
      const row = this.jobs.find((candidate) => candidate.id === values[1]);
      if (row) row.status = 'completed';
      return {
        rows: (row ? [{ id: row.id }] : []) as unknown as Row[],
        rowCount: row ? 1 : 0,
      };
    }
    if (text.includes('FROM commerce_agent_feedback_events AS event')) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: text.includes('INSERT INTO') ? 1 : 0 };
  }

  async transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    const jobs = this.jobs.map((row) => ({ ...row }));
    const limits = new Map(this.limits);
    const budget = { ...this.budget };
    const reservations = new Map(Array.from(this.reservations, ([key, value]) => (
      [key, { ...value }]
    )));
    try {
      return await work(this);
    } catch (error) {
      this.jobs = jobs;
      this.limits = limits;
      this.budget = budget;
      this.reservations = reservations;
      throw error;
    }
  }

  async ping(): Promise<void> {}
}

const job: ClaimedCommerceAgentJob = {
  id: 'job_1234567890abcdef',
  identity,
  kind: 'conversation_turn',
  conversationId: 'conv_1234567890abcdef',
  requestId: 'feedback-correction:1234567890abcdef',
  model: 'deepseek-v4-flash',
  message: '纠正原回答',
  requiredRevision: 'abcdef1',
  executedByWorkerId: 'worker-1',
  status: 'running',
  attemptCount: 1,
  maxAttempts: 3,
  availableAt: '2026-08-13T00:00:00.000Z',
  createdAt: '2026-08-13T00:00:00.000Z',
  startedAt: '2026-08-13T00:00:01.000Z',
  completedAt: null,
  result: null,
  error: null,
  leaseOwner: 'worker-1',
};

const completedResult: CommerceAgentRunResponse = {
  conversation: {
    id: job.conversationId!,
    title: '纠正回答',
    model: job.model,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:02.000Z',
  },
  userMessage: {
    id: 'msg_user_correction_12345678',
    role: 'user',
    content: job.message,
    answer: null,
    runId: 'run_correction_12345678',
    runStatus: 'completed',
    reportAvailable: false,
    traces: [],
    createdAt: '2026-08-13T00:00:01.000Z',
  },
  assistantMessage: {
    id: 'msg_assistant_correction_12345678',
    role: 'assistant',
    content: '这是新的纠正回答。',
    answer: null,
    runId: 'run_correction_12345678',
    runStatus: 'completed',
    reportAvailable: false,
    traces: [],
    createdAt: '2026-08-13T00:00:02.000Z',
  },
  usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
};

function feedbackEventInsert(database: TerminalJobDatabase) {
  return database.queries.find(({ text }) => (
    text.includes('INSERT INTO commerce_agent_feedback_events')
  ));
}

describe('active Commerce Job recovery', () => {
  it('lists only the authenticated operator active Jobs and returns resumable intent text', async () => {
    const database = new JobDatabase();
    const jobs = await new PostgresCommerceJobStore(database).listActive(identity);

    expect(database.queryText).toContain("status IN ('queued', 'running')");
    expect(database.queryText).toContain('tenant_id = $1 AND user_id = $2');
    expect(database.values).toEqual([identity.tenantId, identity.userId, 10]);
    expect(jobs).toEqual([
      expect.objectContaining({
        id: 'job_1234567890abcdef',
        message: '分析最近一周 GMV',
        status: 'running',
        conversationId: 'conv_1234567890abcdef',
      }),
    ]);
  });
});

function abuseInput(
  requestId: string,
  overrides: Partial<Parameters<PostgresCommerceJobStore['enqueue']>[0]> = {},
): Parameters<PostgresCommerceJobStore['enqueue']>[0] {
  return {
    identity,
    kind: 'create_conversation',
    requestId,
    model: 'deepseek-v4-flash',
    message: '诊断上一完整周经营表现',
    maxQueuedPerUser: 100,
    maxAttempts: 3,
    ...overrides,
  };
}

describe('Week 10 abuse controls', () => {
  it('enforces the global kill switch at the shared transactional enqueue boundary', async () => {
    vi.stubEnv('COMMERCE_GLOBAL_KILL_SWITCH', 'true');
    const database = new AbuseControlDatabase();

    await expect(new PostgresCommerceJobStore(database).enqueue(abuseInput('kill-switch')))
      .rejects.toBeInstanceOf(CommerceJobEnqueueDisabledError);
    expect(database.jobs).toHaveLength(0);
  });

  it('rejects the sixth account-hour diagnosis without committing another Job', async () => {
    const database = new AbuseControlDatabase();
    const store = new PostgresCommerceJobStore(database);
    for (let request = 1; request <= 5; request += 1) {
      await store.enqueue(abuseInput(`account-${request}`, { accountHourlyLimit: 5 }));
    }

    await expect(store.enqueue(abuseInput('account-6', { accountHourlyLimit: 5 })))
      .rejects.toMatchObject({
        constructor: CommerceJobRateLimitError,
        code: 'COMMERCE_DIAGNOSIS_RATE_LIMITED',
        scope: 'account',
      });
    expect(database.jobs).toHaveLength(5);
  });

  it('rejects the third active Job before a queue row is committed', async () => {
    const database = new AbuseControlDatabase();
    const store = new PostgresCommerceJobStore(database);
    await store.enqueue(abuseInput('active-1', { maxQueuedPerUser: 2 }));
    await store.enqueue(abuseInput('active-2', { maxQueuedPerUser: 2 }));

    await expect(store.enqueue(abuseInput('active-3', { maxQueuedPerUser: 2 })))
      .rejects.toBeInstanceOf(CommerceJobQueueFullError);
    expect(database.jobs).toHaveLength(2);
  });

  it('rejects the twenty-first IP-hour diagnosis without committing another Job', async () => {
    const database = new AbuseControlDatabase();
    const store = new PostgresCommerceJobStore(database);
    for (let request = 1; request <= 20; request += 1) {
      await store.enqueue(abuseInput(`ip-${request}`, {
        ipHourlyLimit: 20,
        ipHash: 'f'.repeat(64),
      }));
    }

    await expect(store.enqueue(abuseInput('ip-21', {
      ipHourlyLimit: 20,
      ipHash: 'f'.repeat(64),
    }))).rejects.toMatchObject({
      constructor: CommerceJobRateLimitError,
      code: 'COMMERCE_DIAGNOSIS_RATE_LIMITED',
      scope: 'ip',
    });
    expect(database.jobs).toHaveLength(20);
  });

  it('rejects a message over 2,000 characters before touching the queue database', async () => {
    const database = new AbuseControlDatabase();
    const store = new PostgresCommerceJobStore(database);

    await expect(store.enqueue(abuseInput('too-long', { message: '超'.repeat(2_001) })))
      .rejects.toBeInstanceOf(CommerceJobInvalidMessageError);
    expect(database.queries).toHaveLength(0);
    expect(database.jobs).toHaveLength(0);
  });

  it('atomically rejects a reservation that would exceed the UTC daily model budget', async () => {
    const database = new AbuseControlDatabase();
    const store = new PostgresCommerceJobStore(database);
    const modelBudgetPolicy = {
      dailyLimitUsd: 1,
      reservationUsd: 0.6,
      inputUsdPerMillionTokens: 2,
      outputUsdPerMillionTokens: 4,
    };
    await store.enqueue(abuseInput('budget-1', { modelBudgetPolicy }));

    await expect(store.enqueue(abuseInput('budget-2', { modelBudgetPolicy })))
      .rejects.toBeInstanceOf(CommerceModelBudgetExceededError);
    expect(database.jobs).toHaveLength(1);
    expect(database.budget).toEqual({ reservedUsd: 0.6, spentUsd: 0 });
  });

  it('derives the budget policy inside the store so scheduler callers cannot omit it', async () => {
    vi.stubEnv('DAILY_MODEL_BUDGET_USD', '2');
    vi.stubEnv('COMMERCE_MODEL_INPUT_USD_PER_MILLION_TOKENS', '2');
    vi.stubEnv('COMMERCE_MODEL_OUTPUT_USD_PER_MILLION_TOKENS', '4');
    const database = new AbuseControlDatabase();

    await new PostgresCommerceJobStore(database).enqueue(abuseInput('implicit-budget'));

    expect(database.jobs).toHaveLength(1);
    expect(database.budget.reservedUsd).toBeGreaterThan(0);
    expect(database.reservations.size).toBe(1);
  });

  it('settles a successful reservation to provider-token-derived actual cost', async () => {
    const database = new AbuseControlDatabase();
    const store = new PostgresCommerceJobStore(database);
    const created = await store.enqueue(abuseInput('budget-settlement', {
      modelBudgetPolicy: {
        dailyLimitUsd: 5,
        reservationUsd: 0.5,
        inputUsdPerMillionTokens: 2,
        outputUsdPerMillionTokens: 4,
      },
    }));
    database.jobs[0]!.status = 'running';
    const claimed: ClaimedCommerceAgentJob = {
      ...created,
      identity,
      status: 'running',
      message: created.message,
      leaseOwner: 'worker-budget',
    };

    await store.complete(claimed, completedResult);

    expect(database.budget.reservedUsd).toBe(0);
    expect(database.budget.spentUsd).toBe(0.000052);
    expect(database.reservations.get(created.id)).toMatchObject({
      actualUsd: 0.000052,
      settlement: 'actual',
    });
  });
});

describe('correction Job terminal feedback events', () => {
  it('atomically appends correction_completed with the new Run and leaves prior records untouched', async () => {
    const database = new TerminalJobDatabase('complete');

    await new PostgresCommerceJobStore(database).complete(job, completedResult);

    const inserted = feedbackEventInsert(database);
    expect(inserted?.values).toEqual(expect.arrayContaining([
      'feedback_1234567890abcdef',
      identity.tenantId,
      'correction_completed',
      3,
      job.id,
      completedResult.assistantMessage.runId,
    ]));
    expect(inserted?.text).toContain(
      'ON CONFLICT (tenant_id, actor_user_id, idempotency_key) DO NOTHING',
    );
    expect(database.queries.some(({ text }) => (
      /UPDATE\s+commerce_agent_(runs|messages)/u.test(text)
    ))).toBe(false);
  });

  it('does not append a correction event when the Job is not the latest correction_enqueued Job', async () => {
    const database = new TerminalJobDatabase('complete', false);

    await new PostgresCommerceJobStore(database).complete(job, completedResult);

    expect(feedbackEventInsert(database)).toBeUndefined();
  });

  it('appends correction_failed for a terminal failure', async () => {
    const database = new TerminalJobDatabase('fail');

    await new PostgresCommerceJobStore(database).fail(
      job,
      Object.assign(new Error('provider rejected the request'), { code: 'PROVIDER_ERROR' }),
    );

    const inserted = feedbackEventInsert(database);
    expect(inserted?.values).toEqual(expect.arrayContaining([
      'correction_failed',
      'PROVIDER_ERROR: provider rejected the request',
      job.id,
    ]));
    expect(inserted?.values.at(-1)).toBeNull();
  });

  it('does not append correction_failed when a retryable Job is requeued', async () => {
    const database = new TerminalJobDatabase('requeue');

    await expect(new PostgresCommerceJobStore(database).retryOrDeadLetter(
      job,
      Object.assign(new Error('temporary outage'), { code: 'NETWORK_ERROR' }),
      5_000,
    )).resolves.toBe('requeued');

    expect(feedbackEventInsert(database)).toBeUndefined();
  });

  it('appends correction_failed only when retry handling dead-letters the Job', async () => {
    const database = new TerminalJobDatabase('dead_letter');

    await expect(new PostgresCommerceJobStore(database).retryOrDeadLetter(
      job,
      Object.assign(new Error('provider still unavailable'), { code: 'NETWORK_ERROR' }),
      5_000,
    )).resolves.toBe('dead_letter');

    expect(feedbackEventInsert(database)?.values).toEqual(expect.arrayContaining([
      'correction_failed',
      'NETWORK_ERROR: provider still unavailable',
      job.id,
    ]));
  });
});

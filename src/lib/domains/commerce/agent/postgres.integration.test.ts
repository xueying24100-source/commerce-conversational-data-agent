import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { PostgresCommerceAnalyticsRepository } from './analytics-repository';
import {
  PostgresCommerceConversationStore,
  commerceRateLimitScopeKey,
} from './conversation-store';
import {
  CommerceJobQueueFullError,
  PostgresCommerceJobStore,
} from './job-store';
import type {
  CommerceDatabase,
  CommerceQueryResult,
  CommerceSqlClient,
} from './database';
import type { CommerceIdentity } from './types';

const require = createRequire(import.meta.url);
const { loadShopifySource } = require('../../../../../scripts/connectors/shopify-source.js');
const {
  runCommerceConnector,
} = require('../../../../../scripts/connectors/run-commerce-connector.js');

const connectionString = process.env.COMMERCE_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('COMMERCE_TEST_DATABASE_URL is required. Use npm run test:integration:commerce.');
}

class IntegrationDatabase implements CommerceDatabase {
  constructor(private readonly pool: Pool) {}

  async query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    const result = await this.pool.query(text, [...values]);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? result.rows.length,
    };
  }

  async transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const adapter: CommerceSqlClient = {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) => {
        const result = await client.query(text, [...values]);
        return {
          rows: result.rows as Row[],
          rowCount: result.rowCount ?? result.rows.length,
        };
      },
    };
    try {
      await client.query('BEGIN');
      const result = await work(adapter);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}

const pool = new Pool({
  connectionString,
  max: 12,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  application_name: 'commerce-integration-test',
});
const database = new IntegrationDatabase(pool);
const store = new PostgresCommerceConversationStore(database);
const root = process.cwd();

function identity(tenantId: string, userId: string): CommerceIdentity {
  return {
    tenantId,
    userId,
    displayName: userId,
    scopes: ['commerce:data:read'],
    authMode: 'development',
  };
}

function claimInput(input: {
  identity: CommerceIdentity;
  requestId: string;
  runId: string;
  requestHash: string;
  globalLimit: number;
}) {
  return {
    identity: input.identity,
    model: 'deepseek-v4-flash',
    provider: 'integration',
    userMessage: 'integration claim',
    requestId: input.requestId,
    requestSha256: input.requestHash,
    runId: input.runId,
    rateLimit: 1_000,
    tenantRateLimit: 10_000,
    globalConcurrencyLimit: input.globalLimit,
    tenantConcurrencyLimit: input.globalLimit,
    leaseMs: 30_000,
  };
}

async function cleanupControlTenant(tenantId: string, identities: CommerceIdentity[]) {
  await pool.query('DELETE FROM commerce_agent_conversations WHERE tenant_id = $1', [tenantId]);
  const scopes = new Set([commerceRateLimitScopeKey('tenant', identities[0])]);
  identities.forEach((entry) => scopes.add(commerceRateLimitScopeKey('user', entry)));
  await pool.query('DELETE FROM commerce_agent_rate_limits WHERE scope_key = ANY($1::text[])', [
    Array.from(scopes),
  ]);
}

async function withAnalyticsTenant<T>(
  tenantId: string,
  work: (client: CommerceSqlClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  const adapter: CommerceSqlClient = {
    query: async <Row extends Record<string, unknown>>(
      text: string,
      values: readonly unknown[] = [],
    ) => {
      const result = await client.query(text, [...values]);
      return {
        rows: result.rows as Row[],
        rowCount: result.rowCount ?? result.rows.length,
      };
    },
  };
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('commerce.tenant_id', $1, true),
              set_config('commerce.ingest_tenant_id', $1, true)`,
      [tenantId],
    );
    const result = await work(adapter);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  const control = fs.readFileSync(path.join(root, 'migrations', 'commerce-control.sql'), 'utf8');
  const analytics = fs.readFileSync(path.join(root, 'migrations', 'commerce-analytics.sql'), 'utf8');
  await pool.query(control);
  await pool.query(analytics);
  // The runner requires an explicitly confirmed disposable database. Clear
  // control-plane state so abandoned jobs/runs from an interrupted prior gate
  // cannot consume global capacity or be claimed by this run.
  await pool.query('DELETE FROM commerce_agent_jobs');
  await pool.query('DELETE FROM commerce_agent_conversations');
  await pool.query('DELETE FROM commerce_agent_rate_limits');
  await pool.query('DELETE FROM commerce_agent_workers');
});

afterAll(async () => {
  await pool.end();
});

describe.sequential('Commerce PostgreSQL integration gate', () => {
  it('queues, fences, reclaims and completes durable agent jobs', async () => {
    const suffix = randomUUID();
    const operator = identity(`tenant_jobs_${suffix}`, `user_jobs_${suffix}`);
    const jobs = new PostgresCommerceJobStore(database);
    const queued = await jobs.enqueue({
      identity: operator,
      kind: 'create_conversation',
      requestId: `req_jobs_${suffix}`,
      model: 'deepseek-v4-flash',
      message: '检查异步任务。',
      maxQueuedPerUser: 4,
      maxAttempts: 3,
    });
    expect(queued.status).toBe('queued');
    const claimed = await jobs.claim({ workerId: 'worker-a', leaseMs: 30_000 });
    expect(claimed?.id).toBe(queued.id);
    expect(await jobs.renew(queued.id, 'worker-a', 30_000)).toBe(true);
    expect(await jobs.renew(queued.id, 'worker-b', 30_000)).toBe(false);
    const now = new Date().toISOString();
    await jobs.complete(claimed!, {
      conversation: {
        id: `conv_${suffix}`,
        title: 'Queue integration',
        model: 'deepseek-v4-flash',
        createdAt: now,
        updatedAt: now,
      },
      userMessage: {
        id: `msg_user_${suffix}`,
        role: 'user',
        content: '检查异步任务。',
        answer: null,
        runId: null,
        runStatus: null,
        traces: [],
        createdAt: now,
      },
      assistantMessage: {
        id: `msg_assistant_${suffix}`,
        role: 'assistant',
        content: '完成。',
        answer: null,
        runId: null,
        runStatus: 'completed',
        traces: [],
        createdAt: now,
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    expect((await jobs.get(operator, queued.id)).status).toBe('completed');
    expect((await jobs.events(operator, queued.id, 0)).map((event) => event.type)).toEqual([
      'queued',
      'running',
      'completed',
    ]);

    const reclaimable = await jobs.enqueue({
      identity: operator,
      kind: 'create_conversation',
      requestId: `req_reclaim_${suffix}`,
      model: 'deepseek-v4-flash',
      message: '检查 lease 回收。',
      maxQueuedPerUser: 4,
      maxAttempts: 3,
    });
    expect((await jobs.claim({ workerId: 'worker-a', leaseMs: 30_000 }))?.id).toBe(reclaimable.id);
    await pool.query(
      `UPDATE commerce_agent_jobs SET lease_expires_at = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [reclaimable.id],
    );
    const reclaimed = await jobs.claim({ workerId: 'worker-b', leaseMs: 30_000 });
    expect(reclaimed?.id).toBe(reclaimable.id);
    expect(reclaimed?.attemptCount).toBe(2);
    await jobs.fail(reclaimed!, new Error('expected integration cleanup'));
    await pool.query('DELETE FROM commerce_agent_jobs WHERE tenant_id = $1', [operator.tenantId]);
  });

  it('backs off retryable jobs and dead-letters exhausted attempts', async () => {
    const suffix = randomUUID();
    const operator = identity(`tenant_job_retry_${suffix}`, `user_job_retry_${suffix}`);
    const jobs = new PostgresCommerceJobStore(database);
    try {
      const queued = await jobs.enqueue({
        identity: operator,
        kind: 'create_conversation',
        requestId: `req_job_retry_${suffix}`,
        model: 'deepseek-v4-flash',
        message: 'retry integration',
        maxQueuedPerUser: 2,
        maxAttempts: 2,
      });
      const first = await jobs.claim({ workerId: 'worker-retry-a', leaseMs: 30_000 });
      expect(first?.id).toBe(queued.id);
      await expect(jobs.retryOrDeadLetter(
        first!,
        Object.assign(new Error('temporary provider failure'), { code: 'NETWORK_ERROR' }),
        5_000,
      )).resolves.toBe('requeued');
      const waiting = await jobs.get(operator, queued.id);
      expect(waiting.status).toBe('queued');
      expect(new Date(waiting.availableAt).getTime()).toBeGreaterThan(Date.now());
      await pool.query('UPDATE commerce_agent_jobs SET available_at = NOW() WHERE id = $1', [queued.id]);
      const second = await jobs.claim({ workerId: 'worker-retry-b', leaseMs: 30_000 });
      expect(second?.attemptCount).toBe(2);
      await expect(jobs.retryOrDeadLetter(
        second!,
        Object.assign(new Error('provider still unavailable'), { code: 'NETWORK_ERROR' }),
        5_000,
      )).resolves.toBe('dead_letter');
      expect((await jobs.get(operator, queued.id)).status).toBe('dead_letter');
      expect((await jobs.events(operator, queued.id, 0)).map((event) => event.type)).toEqual([
        'queued',
        'running',
        'requeued',
        'running',
        'dead_lettered',
      ]);
    } finally {
      await pool.query('DELETE FROM commerce_agent_jobs WHERE tenant_id = $1', [operator.tenantId]);
    }
  });

  it('serializes concurrent per-user queue limit checks', async () => {
    const suffix = randomUUID();
    const operator = identity(`tenant_job_limit_${suffix}`, `user_job_limit_${suffix}`);
    const jobs = new PostgresCommerceJobStore(database);
    try {
      const results = await Promise.allSettled([
        jobs.enqueue({
          identity: operator,
          kind: 'create_conversation',
          requestId: `req_limit_left_${suffix}`,
          model: 'deepseek-v4-flash',
          message: '并发队列限制左侧。',
          maxQueuedPerUser: 1,
          maxAttempts: 3,
        }),
        jobs.enqueue({
          identity: operator,
          kind: 'create_conversation',
          requestId: `req_limit_right_${suffix}`,
          model: 'deepseek-v4-flash',
          message: '并发队列限制右侧。',
          maxQueuedPerUser: 1,
          maxAttempts: 3,
        }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected).toMatchObject({ reason: expect.any(CommerceJobQueueFullError) });
    } finally {
      await pool.query('DELETE FROM commerce_agent_jobs WHERE tenant_id = $1', [operator.tenantId]);
    }
  });

  it('reclaims the same failed run without duplicating its user message', async () => {
    const suffix = randomUUID();
    const tenantId = `tenant_run_retry_${suffix}`;
    const operator = identity(tenantId, `user_run_retry_${suffix}`);
    const requestId = `req_run_retry_${suffix}`;
    const requestHash = `sha256:${'d'.repeat(64)}`;
    try {
      const created = await store.createConversationAndBeginTurn(claimInput({
        identity: operator,
        requestId,
        runId: `run_retry_${suffix}`,
        requestHash,
        globalLimit: 4,
      }));
      expect(created.created).toBe(true);
      if (!created.created) throw new Error('Expected a created integration run.');
      await store.failTurn({
        identity: operator,
        runId: created.runId,
        code: 'NETWORK_ERROR',
        message: 'temporary upstream failure',
      });
      const reclaimed = await store.retryFailedTurn({
        identity: operator,
        requestId,
        requestSha256: requestHash,
        globalConcurrencyLimit: 4,
        tenantConcurrencyLimit: 4,
        leaseMs: 30_000,
      });
      expect(reclaimed).toEqual({
        runId: created.runId,
        conversationId: created.conversation.id,
      });
      const state = await pool.query<{
        status: string;
        message_count: unknown;
        run_count: unknown;
      }>(
        `SELECT run.status,
                (SELECT COUNT(*) FROM commerce_agent_messages WHERE run_id = run.id) AS message_count,
                (SELECT COUNT(*) FROM commerce_agent_runs WHERE request_id = run.request_id
                  AND tenant_id = run.tenant_id AND user_id = run.user_id) AS run_count
         FROM commerce_agent_runs AS run WHERE run.id = $1`,
        [created.runId],
      );
      expect(state.rows[0]).toMatchObject({ status: 'running' });
      expect(Number(state.rows[0]?.message_count)).toBe(1);
      expect(Number(state.rows[0]?.run_count)).toBe(1);
      await store.failTurn({
        identity: operator,
        runId: created.runId,
        code: 'EXPECTED_TEST_CLEANUP',
        message: 'integration cleanup',
      });
    } finally {
      await cleanupControlTenant(tenantId, [operator]);
    }
  });

  it('serializes global capacity claims across separate users', async () => {
    const suffix = randomUUID();
    const tenantId = `tenant_capacity_${suffix}`;
    const left = identity(tenantId, `user_left_${suffix}`);
    const right = identity(tenantId, `user_right_${suffix}`);
    try {
      const results = await Promise.all([
        store.createConversationAndBeginTurn(claimInput({
          identity: left,
          requestId: `req_left_${suffix}`,
          runId: `run_left_${suffix}`,
          requestHash: `sha256:${'a'.repeat(64)}`,
          globalLimit: 1,
        })),
        store.createConversationAndBeginTurn(claimInput({
          identity: right,
          requestId: `req_right_${suffix}`,
          runId: `run_right_${suffix}`,
          requestHash: `sha256:${'b'.repeat(64)}`,
          globalLimit: 1,
        })),
      ]);

      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results.filter(
        (result) => !result.created && result.reason === 'concurrency_limited',
      )).toHaveLength(1);
    } finally {
      await cleanupControlTenant(tenantId, [left, right]);
    }
  });

  it('arbitrates concurrent idempotency and rejects stale lease writers', async () => {
    const suffix = randomUUID();
    const tenantId = `tenant_idempotency_${suffix}`;
    const operator = identity(tenantId, `user_${suffix}`);
    const requestId = `req_same_${suffix}`;
    const requestHash = `sha256:${'c'.repeat(64)}`;
    const leftRun = `run_same_left_${suffix}`;
    const rightRun = `run_same_right_${suffix}`;
    try {
      const results = await Promise.all([
        store.createConversationAndBeginTurn(claimInput({
          identity: operator,
          requestId,
          runId: leftRun,
          requestHash,
          globalLimit: 8,
        })),
        store.createConversationAndBeginTurn(claimInput({
          identity: operator,
          requestId,
          runId: rightRun,
          requestHash,
          globalLimit: 8,
        })),
      ]);
      const created = results.find((result) => result.created);
      expect(created?.created).toBe(true);
      expect(results.filter((result) => !result.created && result.reason === 'existing')).toHaveLength(1);
      const count = await pool.query(
        'SELECT COUNT(*)::integer AS count FROM commerce_agent_runs WHERE tenant_id = $1 AND request_id = $2',
        [tenantId, requestId],
      );
      expect(Number(count.rows[0]?.count)).toBe(1);

      const runId = created?.runId;
      expect(runId).toBeTruthy();
      await expect(store.renewRunLease({ identity: operator, runId: runId!, leaseMs: 30_000 }))
        .resolves.toBe(true);
      await pool.query(
        "UPDATE commerce_agent_runs SET lease_expires_at = clock_timestamp() - INTERVAL '1 second' WHERE id = $1",
        [runId],
      );
      await expect(store.renewRunLease({ identity: operator, runId: runId!, leaseMs: 30_000 }))
        .resolves.toBe(false);
      await expect(store.completeTurn({
        identity: operator,
        conversationId: created && 'conversation' in created ? created.conversation.id : '',
        runId: runId!,
        assistantMessageId: `assistant_stale_${suffix}`,
        answer: {
          status: 'needs_clarification',
          answer: 'insufficient scope',
          answerClaims: [],
          findings: [],
          recommendations: [],
          followUps: [],
        },
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        traces: [],
      })).rejects.toThrow(/not active|did not belong/iu);
    } finally {
      await cleanupControlTenant(tenantId, [operator]);
    }
  });

  it('refreshes one tenant atomically and migration reruns do not truncate catalogs', async () => {
    const suffix = randomUUID();
    const tenantId = `tenant_catalog_${suffix}`;
    try {
      await withAnalyticsTenant(tenantId, async (client) => {
        await client.query(
          `INSERT INTO commerce_daily_metrics
             (tenant_id, metric_date, region, channel, sku, category, visits, paid_orders,
              units, gmv, refund_orders, refund_amount, cost_amount, ad_spend, new_customers,
              stockout_hours, ending_inventory, source_updated_at)
           VALUES ($1, '2026-07-27', 'East', 'Search', 'SKU-TEST', 'Apparel',
                   100, 10, 12, 1200, 1, 20, 500, 100, 3, 0, 25, NOW())`,
          [tenantId],
        );
        await client.query('SELECT commerce_refresh_tenant_catalog($1)', [tenantId]);
        const repository = new PostgresCommerceAnalyticsRepository(client);
        await expect(repository.getCatalog(tenantId)).resolves.toMatchObject({
          coverage: {
            start: '2026-07-27',
            end: '2026-07-27',
            rowCount: 1,
          },
        });
        await expect(repository.lookupEntities(tenantId, {
          dimension: 'sku',
          query: 'SKU-',
          limit: 10,
        })).resolves.toEqual([{ value: 'SKU-TEST', factRows: 1 }]);
      });

      const analytics = fs.readFileSync(path.join(root, 'migrations', 'commerce-analytics.sql'), 'utf8');
      await pool.query(analytics);
      const catalog = await withAnalyticsTenant(tenantId, (client) => client.query<{
        count: unknown;
      }>(
        'SELECT COUNT(*)::integer AS count FROM commerce_entity_catalog WHERE tenant_id = $1',
        [tenantId],
      ));
      expect(Number(catalog.rows[0]?.count)).toBe(4);
    } finally {
      await withAnalyticsTenant(tenantId, async (client) => {
        await client.query('DELETE FROM commerce_entity_catalog WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM commerce_tenant_data_status WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM commerce_daily_metrics WHERE tenant_id = $1', [tenantId]);
      });
    }
  });

  it('ingests a mocked Shopify page through PostgreSQL and publishes only supported metrics', async () => {
    const suffix = randomUUID();
    const tenantId = `tenant_shopify_${suffix}`;
    const previousDomain = process.env.SHOPIFY_SHOP_DOMAIN;
    const previousToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
    process.env.SHOPIFY_SHOP_DOMAIN = 'integration-store.myshopify.com';
    process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = 'integration-token-never-log';
    try {
      const logs: string[] = [];
      await runCommerceConnector({
        database: pool,
        log: (message: string) => logs.push(message),
        config: {
          schemaVersion: 1,
          connectorId: 'shopify-orders',
          connectorVersion: '1.0.0',
          tenantId,
          maxRows: 100,
          maxBytes: 1_000_000,
          source: {
            type: 'shopify',
            apiVersion: '2026-07',
            initialUpdatedAt: '2026-07-01T00:00:00.000Z',
            businessTimeZone: 'Asia/Shanghai',
            pageSize: 50,
            maxPages: 2,
            timeoutMs: 5_000,
            maxRetries: 0,
          },
        },
        loadSource: (
          config: { source: Record<string, unknown> },
          _configDirectory: string,
          checkpoint: string | null,
          limits: { maxRows: number; maxBytes: number; timeoutMs: number },
        ) => loadShopifySource(config.source, checkpoint, limits, {
          now: () => new Date('2026-08-01T12:00:00.000Z'),
          fetchImpl: async () => new Response(JSON.stringify({
            data: {
              orders: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'gid://shopify/Order/1001',
                  createdAt: '2026-08-01T01:00:00.000Z',
                  updatedAt: '2026-08-01T03:00:00.000Z',
                  test: false,
                  displayFinancialStatus: 'PAID',
                  shippingAddress: { provinceCode: 'ZJ', countryCodeV2: 'CN' },
                  channelInformation: {
                    channelDefinition: { channelName: 'Online Store' },
                  },
                  lineItems: {
                    pageInfo: { hasNextPage: false },
                    nodes: [{
                      quantity: 2,
                      discountedTotalSet: {
                        shopMoney: { amount: '125.00', currencyCode: 'CNY' },
                      },
                    }],
                  },
                  refunds: [{
                    id: 'gid://shopify/Refund/2001',
                    createdAt: '2026-08-01T02:00:00.000Z',
                    totalRefundedSet: {
                      shopMoney: { amount: '20.00', currencyCode: 'CNY' },
                    },
                  }],
                }],
              },
            },
          }), { status: 200 }),
        }),
      });
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0])).toMatchObject({
        connectorId: 'shopify-orders',
        tenantId,
        status: 'completed',
        sourceRows: 1,
        importedRows: 1,
      });

      await withAnalyticsTenant(tenantId, async (client) => {
        const audit = await client.query<{
          transport: unknown;
          status: unknown;
          checkpoint_after: unknown;
          imported_rows: unknown;
        }>(
          `SELECT transport, status, checkpoint_after, imported_rows
           FROM commerce_connector_runs
           WHERE tenant_id = $1 AND connector_id = 'shopify-orders'`,
          [tenantId],
        );
        expect(audit.rows[0]).toMatchObject({
          transport: 'shopify',
          status: 'completed',
          checkpoint_after: '2026-08-01T12:00:00.000Z',
          imported_rows: 1,
        });

        const repository = new PostgresCommerceAnalyticsRepository(client);
        const catalog = await repository.getCatalog(tenantId);
        expect(catalog.metrics.map((metric) => metric.id)).toEqual([
          'gmv',
          'net_revenue',
          'paid_orders',
          'units',
          'average_order_value',
          'refund_amount',
        ]);
        await expect(repository.compareMetrics(tenantId, {
          current: { start: '2026-08-01', end: '2026-08-01' },
          metrics: ['gmv', 'net_revenue', 'average_order_value', 'refund_amount'],
          filters: { regions: [], channels: [], skus: [], categories: [] },
        })).resolves.toMatchObject({
          current: {
            gmv: 125,
            net_revenue: 105,
            average_order_value: 125,
            refund_amount: 20,
          },
        });
        await expect(repository.trend(tenantId, {
          range: { start: '2026-08-01', end: '2026-08-01' },
          metric: 'visits',
          grain: 'day',
          filters: { regions: [], channels: [], skus: [], categories: [] },
        })).rejects.toMatchObject({ code: 'COMMERCE_METRIC_UNAVAILABLE' });
      });
    } finally {
      if (previousDomain === undefined) delete process.env.SHOPIFY_SHOP_DOMAIN;
      else process.env.SHOPIFY_SHOP_DOMAIN = previousDomain;
      if (previousToken === undefined) delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
      else process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = previousToken;
      await withAnalyticsTenant(tenantId, async (client) => {
        await client.query('DELETE FROM commerce_connector_runs WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM commerce_connector_checkpoints WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM commerce_entity_catalog WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM commerce_tenant_data_status WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM commerce_daily_metrics WHERE tenant_id = $1', [tenantId]);
      }).catch(() => undefined);
    }
  });

  it('publishes the tenant business timezone and rejects mixed-timezone facts', async () => {
    const suffix = randomUUID();
    const tenantId = `tenant_timezone_${suffix}`;
    const insert = `INSERT INTO commerce_daily_metrics
       (tenant_id, metric_date, region, channel, sku, category, business_timezone,
        visits, paid_orders, units, gmv, refund_orders, refund_amount, cost_amount,
        ad_spend, new_customers, stockout_hours, ending_inventory, available_metrics,
        source_updated_at)
     VALUES ($1, $2, 'SP', 'Olist Marketplace', $3, 'All Products', $4,
             0, 1, 2, 120, 0, 0, 0, 0, 1, 0, 0,
             ARRAY['gmv', 'new_customers', 'paid_orders', 'units']::text[], NOW())`;
    try {
      await withAnalyticsTenant(tenantId, async (client) => {
        await client.query(insert, [
          tenantId,
          '2018-09-01',
          'OLIST-ORDER',
          'America/Sao_Paulo',
        ]);
        await client.query('SELECT commerce_refresh_tenant_catalog($1)', [tenantId]);
        const catalog = await new PostgresCommerceAnalyticsRepository(client).getCatalog(tenantId);
        expect(catalog.timezone).toBe('America/Sao_Paulo');
        expect(catalog.metrics.map((metric) => metric.id)).toEqual([
          'gmv',
          'paid_orders',
          'units',
          'average_order_value',
          'new_customers',
        ]);
      });

      await expect(withAnalyticsTenant(tenantId, async (client) => {
        await client.query(insert, [tenantId, '2018-09-02', 'OTHER-ORDER', 'Asia/Shanghai']);
        await client.query('SELECT commerce_refresh_tenant_catalog($1)', [tenantId]);
      })).rejects.toMatchObject({ code: '23514' });
    } finally {
      await withAnalyticsTenant(tenantId, async (client) => {
        await client.query('DELETE FROM commerce_entity_catalog WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM commerce_tenant_data_status WHERE tenant_id = $1', [tenantId]);
        await client.query('DELETE FROM commerce_daily_metrics WHERE tenant_id = $1', [tenantId]);
      }).catch(() => undefined);
    }
  });

  it('enforces split runtime roles, read-only analytics and cross-tenant RLS', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const roles = {
      analytics: `commerce_test_analytics_${suffix}`,
      control: `commerce_test_control_${suffix}`,
      ingest: `commerce_test_ingest_${suffix}`,
      maintenance: `commerce_test_maintenance_${suffix}`,
    };
    const password = `TestRole_${suffix}_9X`;
    const rolePools: Pool[] = [];
    const tenantA = `tenant_role_a_${suffix}`;
    const tenantB = `tenant_role_b_${suffix}`;
    const conversationId = `conv_role_${suffix}`;
    const connectionFor = (role: string) => {
      const parsed = new URL(connectionString);
      parsed.username = role;
      parsed.password = password;
      return parsed.toString();
    };
    const insertFact = `INSERT INTO commerce_daily_metrics
       (tenant_id, metric_date, region, channel, sku, category, visits, paid_orders,
        units, gmv, refund_orders, refund_amount, cost_amount, ad_spend, new_customers,
        stockout_hours, ending_inventory, source_updated_at)
     VALUES ($1, '2026-07-27', 'East', 'Search', $2, 'Apparel',
             100, 10, 12, 1200, 1, 20, 500, 100, 3, 0, 25, NOW())`;
    try {
      for (const role of Object.values(roles)) {
        await pool.query(
          `CREATE ROLE ${role} LOGIN PASSWORD '${password}'
             NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
        );
      }
      await pool.query(`GRANT USAGE ON SCHEMA public TO ${roles.analytics}, ${roles.ingest}`);
      await pool.query(
        `GRANT SELECT ON commerce_daily_metrics, commerce_tenant_data_status,
           commerce_entity_catalog TO ${roles.analytics}`,
      );
      await pool.query(
        `ALTER ROLE ${roles.analytics} SET default_transaction_read_only = on`,
      );
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE ON commerce_daily_metrics TO ${roles.ingest}`,
      );
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON commerce_tenant_data_status,
           commerce_entity_catalog, commerce_connector_checkpoints,
           commerce_connector_runs TO ${roles.ingest}`,
      );
      await pool.query(
        `GRANT EXECUTE ON FUNCTION commerce_refresh_tenant_catalog(TEXT) TO ${roles.ingest}`,
      );
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE ON commerce_agent_conversations,
           commerce_agent_runs, commerce_agent_rate_limits, commerce_agent_jobs,
           commerce_agent_workers TO ${roles.control}`,
      );
      await pool.query(
        `GRANT SELECT, INSERT ON commerce_agent_messages,
           commerce_agent_evidence, commerce_agent_job_events TO ${roles.control}`,
      );
      await pool.query(
        `GRANT USAGE, SELECT ON SEQUENCE commerce_agent_job_events_id_seq TO ${roles.control}`,
      );
      await pool.query(
        `GRANT SELECT, UPDATE ON commerce_agent_runs, commerce_agent_jobs,
           commerce_agent_workers TO ${roles.maintenance}`,
      );
      await pool.query(
        `GRANT SELECT, DELETE ON commerce_agent_conversations,
           commerce_agent_rate_limits, commerce_agent_jobs,
           commerce_agent_workers TO ${roles.maintenance}`,
      );

      for (const tenantId of [tenantA, tenantB]) {
        await withAnalyticsTenant(tenantId, async (client) => {
          await client.query(insertFact, [tenantId, `SKU-${tenantId}`]);
          await client.query('SELECT commerce_refresh_tenant_catalog($1)', [tenantId]);
        });
      }
      await pool.query(
        `INSERT INTO commerce_agent_conversations (id, tenant_id, user_id, title, model)
         VALUES ($1, $2, 'role-user', 'Role permission test', 'deepseek-v4-flash')`,
        [conversationId, tenantA],
      );

      const analyticsPool = new Pool({
        connectionString: connectionFor(roles.analytics),
        max: 1,
        application_name: 'commerce-role-analytics-test',
      });
      const ingestPool = new Pool({
        connectionString: connectionFor(roles.ingest),
        max: 1,
        application_name: 'commerce-role-ingest-test',
      });
      const controlPool = new Pool({
        connectionString: connectionFor(roles.control),
        max: 1,
        application_name: 'commerce-role-control-test',
      });
      const maintenancePool = new Pool({
        connectionString: connectionFor(roles.maintenance),
        max: 1,
        application_name: 'commerce-role-maintenance-test',
      });
      rolePools.push(analyticsPool, ingestPool, controlPool, maintenancePool);

      const analyticsClient = await analyticsPool.connect();
      try {
        const roleStatus = await analyticsClient.query<{
          read_only: boolean;
          bypasses_rls: boolean;
        }>(
          `SELECT current_setting('default_transaction_read_only')::boolean AS read_only,
                  (rolbypassrls OR rolsuper) AS bypasses_rls
           FROM pg_roles WHERE rolname = current_user`,
        );
        expect(roleStatus.rows[0]).toEqual({ read_only: true, bypasses_rls: false });
        await analyticsClient.query('BEGIN');
        await analyticsClient.query(
          `SELECT set_config('commerce.tenant_id', $1, true)`,
          [tenantA],
        );
        const visible = await analyticsClient.query<{ tenant_id: string }>(
          'SELECT DISTINCT tenant_id FROM commerce_daily_metrics ORDER BY tenant_id',
        );
        expect(visible.rows).toEqual([{ tenant_id: tenantA }]);
        await expect(analyticsClient.query(insertFact, [tenantA, 'SKU-READONLY']))
          .rejects.toMatchObject({ code: '25006' });
        await analyticsClient.query('ROLLBACK');
      } finally {
        analyticsClient.release();
      }

      const ingestClient = await ingestPool.connect();
      try {
        await ingestClient.query('BEGIN');
        await ingestClient.query(
          `SELECT set_config('commerce.tenant_id', $1, true),
                  set_config('commerce.ingest_tenant_id', $1, true)`,
          [tenantA],
        );
        await ingestClient.query(insertFact, [tenantA, 'SKU-INGEST-ALLOWED']);
        await ingestClient.query(
          `INSERT INTO commerce_connector_runs
             (id, tenant_id, connector_id, connector_version, transport, status, completed_at)
           VALUES ($1, $2, 'integration', '1.0.0', 'file', 'completed', NOW())`,
          [`connector_role_${suffix}`, tenantA],
        );
        await expect(ingestClient.query(insertFact, [tenantB, 'SKU-INGEST-DENIED']))
          .rejects.toMatchObject({ code: '42501' });
        await ingestClient.query('ROLLBACK');
      } finally {
        ingestClient.release();
      }

      await expect(controlPool.query(
        'DELETE FROM commerce_agent_conversations WHERE id = $1',
        [conversationId],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(controlPool.query(
        `INSERT INTO commerce_agent_workers (id, revision, status)
         VALUES ($1, 'integration', 'running')`,
        [`worker_role_${suffix}`],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(maintenancePool.query(
        `INSERT INTO commerce_agent_conversations (id, tenant_id, user_id, title, model)
         VALUES ('conv_maintenance_denied', $1, 'role-user', 'Denied', 'deepseek-v4-flash')`,
        [tenantA],
      )).rejects.toMatchObject({ code: '42501' });
      await expect(maintenancePool.query(
        'DELETE FROM commerce_agent_conversations WHERE id = $1',
        [conversationId],
      )).resolves.toMatchObject({ rowCount: 1 });
      await expect(maintenancePool.query(
        'DELETE FROM commerce_agent_workers WHERE id = $1',
        [`worker_role_${suffix}`],
      )).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await Promise.all(rolePools.map((rolePool) => rolePool.end().catch(() => undefined)));
      for (const tenantId of [tenantA, tenantB]) {
        await withAnalyticsTenant(tenantId, async (client) => {
          await client.query('DELETE FROM commerce_entity_catalog WHERE tenant_id = $1', [tenantId]);
          await client.query('DELETE FROM commerce_tenant_data_status WHERE tenant_id = $1', [tenantId]);
          await client.query('DELETE FROM commerce_daily_metrics WHERE tenant_id = $1', [tenantId]);
        }).catch(() => undefined);
      }
      await pool.query('DELETE FROM commerce_agent_conversations WHERE id = $1', [conversationId]);
      for (const role of Object.values(roles).reverse()) {
        await pool.query(`DROP OWNED BY ${role}`).catch(() => undefined);
        await pool.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      }
    }
  });
});

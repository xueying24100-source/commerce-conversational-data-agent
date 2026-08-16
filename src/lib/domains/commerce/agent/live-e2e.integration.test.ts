import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { Pool } from 'pg';

import { POST as createConversation } from '@/app/api/commerce/conversations/route';
import { POST as createConversationTurn } from '@/app/api/commerce/conversations/[conversationId]/messages/route';
import { GET as getConversation } from '@/app/api/commerce/conversations/[conversationId]/route';
import { GET as getJob } from '@/app/api/commerce/jobs/[jobId]/route';
import { GET as streamJobEvents } from '@/app/api/commerce/jobs/[jobId]/events/route';
import { DEEPSEEK_MODEL_ID } from '@/lib/constants/models';
import {
  commerceRateLimitScopeKey,
} from './conversation-store';
import { processNextCommerceAgentJob } from './worker';
import type {
  CommerceDatabase,
  CommerceQueryResult,
  CommerceSqlClient,
} from './database';
import type { CommerceIdentity } from './types';
import type { CommerceAgentJob, CommerceAgentRunResponse } from './types';

const require = createRequire(import.meta.url);
const {
  publishCommerceCoverage,
} = require('../../../../../scripts/db/commerce-ingest-core.js');

const connectionString = process.env.COMMERCE_LIVE_E2E_DATABASE_URL;
if (!connectionString) {
  throw new Error('COMMERCE_LIVE_E2E_DATABASE_URL is required. Use npm run test:e2e:commerce:live.');
}

class LiveE2eDatabase implements CommerceDatabase {
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

const root = process.cwd();
const pool = new Pool({
  connectionString,
  max: 12,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 120_000,
  application_name: 'commerce-live-e2e',
});
const database = new LiveE2eDatabase(pool);
const suffix = randomUUID();
const tenantId = `tenant_live_e2e_${suffix}`;
const identity: CommerceIdentity = {
  tenantId,
  userId: `user_live_e2e_${suffix}`,
  displayName: 'Commerce live E2E operator',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};

type ApiSuccess<T> = { success: true } & T;

function mutationRequest(pathname: string, payload: Record<string, unknown>) {
  return new NextRequest(`http://localhost${pathname}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://localhost',
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(payload),
  });
}

async function successJson<T>(response: Response, expectedStatus = 200): Promise<T> {
  expect(response.status).toBe(expectedStatus);
  const payload = await response.json() as ApiSuccess<T>;
  expect(payload.success).toBe(true);
  return payload;
}

async function completedJob(jobId: string): Promise<CommerceAgentRunResponse> {
  expect(await processNextCommerceAgentJob('live-e2e-worker')).toBe(true);
  const response = await getJob(
    new NextRequest(`http://localhost/api/commerce/jobs/${jobId}`),
    { params: Promise.resolve({ jobId }) },
  );
  const payload = await successJson<{ job: CommerceAgentJob }>(response);
  expect(payload.job.status).toBe('completed');
  expect(payload.job.result).not.toBeNull();
  return payload.job.result!;
}

async function withTenant<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query(
      `SELECT set_config('commerce.tenant_id', $1, true),
              set_config('commerce.ingest_tenant_id', $1, true)`,
      [tenantId],
    );
    return work(client);
  });
}

async function publishFixtureCoverage(client: CommerceSqlClient): Promise<void> {
  const connectorId = 'live-e2e-fixture';
  const runId = `fixture_coverage_${suffix}`;
  await client.query(
    `INSERT INTO commerce_connector_checkpoints
       (tenant_id, connector_id, connector_version, data_mode, source_fact_state,
        checkpoint, updated_at)
     VALUES ($1, $2, '1.0.0', 'snapshot', 'not_applicable', $3, NOW())`,
    [tenantId, connectorId, runId],
  );
  await publishCommerceCoverage(client, tenantId, connectorId, 'snapshot', runId, {
    kind: 'complete_snapshot',
    coverageStart: '2026-07-01',
    coverageEnd: '2026-07-07',
    sourceUpdatedAt: '2026-07-07T23:59:59.000Z',
  });
  await client.query('SELECT commerce_refresh_tenant_catalog($1)', [tenantId]);
}

beforeAll(async () => {
  process.env.COMMERCE_DEV_AUTH_BYPASS = '1';
  process.env.COMMERCE_DEV_TENANT_ID = identity.tenantId;
  process.env.COMMERCE_DEV_USER_ID = identity.userId;
  const control = fs.readFileSync(path.join(root, 'migrations', 'commerce-control.sql'), 'utf8');
  const analytics = fs.readFileSync(path.join(root, 'migrations', 'commerce-analytics.sql'), 'utf8');
  await pool.query(control);
  await pool.query(analytics);
  await withTenant(async (client) => {
    for (let day = 1; day <= 7; day += 1) {
      await client.query(
        `INSERT INTO commerce_daily_metrics
           (tenant_id, source_id, metric_date, region, channel, sku, category, visits, paid_orders,
            units, gmv, refund_orders, refund_amount, cost_amount, ad_spend, new_customers,
            stockout_hours, ending_inventory, source_updated_at)
         VALUES ($1, 'live-e2e-fixture', $2::date, 'East', 'Search', 'SKU-LIVE', 'Apparel',
                 100, 10, 10, 100, 0, 0, 40, 10, 2, 0, 50, NOW())`,
        [tenantId, `2026-07-${String(day).padStart(2, '0')}`],
      );
      await client.query(
        `INSERT INTO commerce_daily_metrics
           (tenant_id, source_id, metric_date, region, channel, sku, category, visits, paid_orders,
            units, gmv, refund_orders, refund_amount, cost_amount, ad_spend, new_customers,
            stockout_hours, ending_inventory, source_updated_at)
         VALUES ($1, 'live-e2e-fixture', $2::date, 'West', 'Affiliate', 'SKU-RISK', 'Electronics',
                 50, 5, 5, 50, 1, 5, 25, 5, 1, 4, 2, NOW())`,
        [tenantId, `2026-07-${String(day).padStart(2, '0')}`],
      );
    }
    await publishFixtureCoverage(client);
  });
});

afterAll(async () => {
  await pool.query('DELETE FROM commerce_agent_jobs WHERE tenant_id = $1', [tenantId]);
  await pool.query('DELETE FROM commerce_agent_conversations WHERE tenant_id = $1', [tenantId]);
  await pool.query(
    'DELETE FROM commerce_agent_rate_limits WHERE scope_key = ANY($1::text[])',
    [[
      commerceRateLimitScopeKey('tenant', identity),
      commerceRateLimitScopeKey('user', identity),
    ]],
  );
  await withTenant(async (client) => {
    await client.query('DELETE FROM commerce_entity_catalog WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM commerce_tenant_data_partitions WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM commerce_connector_date_coverage WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM commerce_connector_checkpoints WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM commerce_tenant_data_status WHERE tenant_id = $1', [tenantId]);
    await client.query('DELETE FROM commerce_daily_metrics WHERE tenant_id = $1', [tenantId]);
  });
  await pool.end();
});

describe.sequential('Commerce live-model release evidence', () => {
  it('runs API ingress, durable jobs, SSE and multi-turn analytics end to end', async () => {
    const model = process.env.COMMERCE_LIVE_E2E_MODEL || DEEPSEEK_MODEL_ID;
    const firstResponse = await createConversation(mutationRequest(
      '/api/commerce/conversations',
      {
      message: '请先确认数据覆盖范围，再回答 2026-07-01 到 2026-07-07、SKU-LIVE 的 GMV 总额。无需分组，结论必须有数据证据。',
      model,
      requestId: `req_live_e2e_${suffix}`,
      },
    ));
    const firstJob = (await successJson<{ job: CommerceAgentJob }>(firstResponse, 202)).job;
    expect(firstJob.status).toBe('queued');
    const firstResult = await completedJob(firstJob.id);
    const firstEventsResponse = await streamJobEvents(
      new NextRequest(`http://localhost/api/commerce/jobs/${firstJob.id}/events`),
      { params: Promise.resolve({ jobId: firstJob.id }) },
    );
    expect(firstEventsResponse.status).toBe(200);
    const firstEvents = await firstEventsResponse.text();
    expect(firstEvents).toContain('event: queued');
    expect(firstEvents).toContain('event: running');
    expect(firstEvents).toContain('event: completed');
    const answer = firstResult.assistantMessage.answer;
    const firstOperations = firstResult.assistantMessage.traces.map((trace) => trace.operation);

    expect(answer?.status).toBe('answered');
    expect(answer?.answer).toContain('700.00');
    expect(firstOperations).toContain('commerce.describe_data');
    expect(firstOperations).toContain('commerce.compare_metrics');

    const conversationId = firstResult.conversation.id;
    const secondResponse = await createConversationTurn(
      mutationRequest(
        `/api/commerce/conversations/${conversationId}/messages`,
        {
          message: '对同一日期范围，请同时使用渠道拆解和按日趋势工具分析 GMV，并给出有证据的结论。',
          requestId: `req_live_e2e_breakdown_${suffix}`,
        },
      ),
      { params: Promise.resolve({ conversationId }) },
    );
    const secondJob = (await successJson<{ job: CommerceAgentJob }>(secondResponse, 202)).job;
    const secondResult = await completedJob(secondJob.id);
    const secondOperations = secondResult.assistantMessage.traces.map((trace) => trace.operation);
    expect(secondOperations).toContain('commerce.breakdown_metric');
    expect(secondOperations).toContain('commerce.trend_metric');

    const thirdResponse = await createConversationTurn(
      mutationRequest(
        `/api/commerce/conversations/${conversationId}/messages`,
        {
          message: '请先检索 SKU-RISK，再使用库存风险工具检查 2026-07-01 到 2026-07-07 的缺货情况。',
          requestId: `req_live_e2e_inventory_${suffix}`,
        },
      ),
      { params: Promise.resolve({ conversationId }) },
    );
    const thirdJob = (await successJson<{ job: CommerceAgentJob }>(thirdResponse, 202)).job;
    const thirdResult = await completedJob(thirdJob.id);
    const thirdOperations = thirdResult.assistantMessage.traces.map((trace) => trace.operation);
    expect(thirdOperations).toContain('commerce.lookup_entities');
    expect(thirdOperations).toContain('commerce.inventory_risk');

    const conversationResponse = await getConversation(
      new NextRequest(`http://localhost/api/commerce/conversations/${conversationId}`),
      { params: Promise.resolve({ conversationId }) },
    );
    const conversationPayload = await successJson<{
      conversation: { messages: unknown[] };
    }>(conversationResponse);
    expect(conversationPayload.conversation.messages).toHaveLength(6);

    const results = [firstResult, secondResult, thirdResult];
    const operations = Array.from(new Set(results.flatMap((result) =>
      result.assistantMessage.traces.map((trace) => trace.operation))));
    const traces = results.flatMap((result) => result.assistantMessage.traces);
    const usage = results.reduce((total, result) => ({
      inputTokens: total.inputTokens + result.usage.inputTokens,
      outputTokens: total.outputTokens + result.usage.outputTokens,
      totalTokens: total.totalTokens + result.usage.totalTokens,
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    expect(traces.every((trace) => Boolean(trace.evidenceId))).toBe(true);
    expect(traces.every((trace) => Boolean(trace.sourceWatermark))).toBe(true);
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);

    const reportDirectory = path.join(root, 'tmp', 'commerce-live-e2e');
    fs.mkdirSync(reportDirectory, { recursive: true });
    fs.writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify({
      schemaVersion: 1,
      service: 'commerce-data-agent',
      revision: process.env.COMMERCE_RELEASE_REVISION || process.env.GITHUB_SHA || 'unversioned',
      model,
      status: 'passed',
      completedAt: new Date().toISOString(),
      answerStatus: answer?.status,
      expectedGmv: 700,
      operations,
      evidenceCount: traces.length,
      usage,
    }, null, 2)}\n`, 'utf8');
  }, 300_000);
});

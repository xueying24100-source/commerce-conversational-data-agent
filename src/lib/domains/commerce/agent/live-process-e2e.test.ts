import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

import { commerceRateLimitScopeKey } from './conversation-store';
import type {
  CommerceDatabase,
  CommerceQueryResult,
  CommerceSqlClient,
} from './database';
import type {
  CommerceAgentJob,
  CommerceAgentRunResponse,
  CommerceIdentity,
} from './types';

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
  application_name: 'commerce-live-e2e-harness',
});
const database = new LiveE2eDatabase(pool);
const suffix = randomUUID();
const tenantId = `tenant_live_e2e_${suffix}`;
const identity: CommerceIdentity = {
  tenantId,
  userId: `user_live_e2e_${suffix}`,
  displayName: 'Commerce live E2E operator',
  scopes: ['commerce:data:read'],
  authMode: 'trusted_proxy',
};
const proxySecret = 'commerce_e2e_proxy_secret_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const metricsToken = 'commerce_e2e_metrics_token_0123456789_ABCDEFGHIJKLMNOPQRSTUVWXYZ';

let origin = '';
let webProcess: ChildProcess | null = null;
let workerProcess: ChildProcess | null = null;

type ApiSuccess<T> = { success: true } & T;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Unable to reserve a local port for Commerce live E2E.');
  }
  await new Promise<void>((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  return address.port;
}

function apiHeaders(json = false): Record<string, string> {
  return {
    ...(json ? { 'content-type': 'application/json' } : {}),
    origin,
    'sec-fetch-site': 'same-origin',
    'x-real-ip': '203.0.113.7',
    'x-commerce-proxy-secret': proxySecret,
    'x-commerce-tenant-id': identity.tenantId,
    'x-commerce-user-id': identity.userId,
    'x-commerce-user-name': identity.displayName,
    'x-commerce-scopes': identity.scopes.join(' '),
  };
}

async function apiJson<T>(
  pathname: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<T> {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      ...apiHeaders(Boolean(init.body)),
      ...init.headers,
    },
  });
  const payload = await response.json() as ApiSuccess<T> | {
    success: false;
    error: string;
    message: string;
  };
  expect(response.status, JSON.stringify(payload)).toBe(expectedStatus);
  expect(payload.success, JSON.stringify(payload)).toBe(true);
  return payload as T;
}

async function waitForWeb(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (webProcess?.exitCode !== null) {
      throw new Error(`Commerce E2E web process exited with ${webProcess?.exitCode}.`);
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // The production server is still binding its socket.
    }
    await sleep(250);
  }
  throw new Error('Commerce E2E web process did not become healthy within 60 seconds.');
}

async function waitForWorker(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (workerProcess?.exitCode !== null) {
      throw new Error(`Commerce E2E worker process exited with ${workerProcess?.exitCode}.`);
    }
    const result = await pool.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM commerce_agent_workers
         WHERE status = 'running' AND heartbeat_at >= NOW() - INTERVAL '30 seconds'
       ) AS active`,
    );
    if (result.rows[0]?.active) return;
    await sleep(250);
  }
  throw new Error('Commerce E2E worker did not publish a heartbeat within 30 seconds.');
}

async function stopProcess(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([once(child, 'exit'), sleep(2_000)]);
  }
}

async function completedJob(jobId: string): Promise<CommerceAgentRunResponse> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const payload = await apiJson<{ job: CommerceAgentJob }>(
      `/api/commerce/jobs/${encodeURIComponent(jobId)}`,
    );
    if (payload.job.status === 'completed' && payload.job.result) return payload.job.result;
    if (payload.job.status === 'failed' || payload.job.status === 'dead_letter') {
      throw new Error(
        `${payload.job.error?.code || 'COMMERCE_JOB_FAILED'}: ${payload.job.error?.message || 'Job failed.'}`,
      );
    }
    await sleep(300);
  }
  throw new Error(`Commerce job ${jobId} did not complete within 240 seconds.`);
}

async function streamJobEvents(jobId: string): Promise<string> {
  const response = await fetch(
    `${origin}/api/commerce/jobs/${encodeURIComponent(jobId)}/events`,
    { headers: apiHeaders() },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  return response.text();
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
  const connectorId = 'live-process-fixture';
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
  const buildId = path.join(root, '.next', 'BUILD_ID');
  const workerArtifact = path.join(
    root,
    '.next',
    'commerce-worker',
    'src',
    'workers',
    'commerce-agent-worker.js',
  );
  if (!fs.existsSync(buildId) || !fs.existsSync(workerArtifact)) {
    throw new Error('Commerce live E2E requires current production artifacts. Run npm run build first.');
  }

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
         VALUES ($1, 'live-process-fixture', $2::date, 'East', 'Search', 'SKU-LIVE', 'Apparel',
                 100, 10, 10, 100, 0, 0, 40, 10, 2, 0, 50, NOW())`,
        [tenantId, `2026-07-${String(day).padStart(2, '0')}`],
      );
      await client.query(
        `INSERT INTO commerce_daily_metrics
           (tenant_id, source_id, metric_date, region, channel, sku, category, visits, paid_orders,
            units, gmv, refund_orders, refund_amount, cost_amount, ad_spend, new_customers,
            stockout_hours, ending_inventory, source_updated_at)
         VALUES ($1, 'live-process-fixture', $2::date, 'West', 'Affiliate', 'SKU-RISK', 'Electronics',
                 50, 5, 5, 50, 1, 5, 25, 5, 1, 4, 2, NOW())`,
        [tenantId, `2026-07-${String(day).padStart(2, '0')}`],
      );
    }
    await publishFixtureCoverage(client);
  });

  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  const runtimeEnvironment = {
    ...process.env,
    COMMERCE_CONTROL_API_DATABASE_URL: connectionString,
    COMMERCE_CONTROL_WORKER_DATABASE_URL: connectionString,
    COMMERCE_ANALYTICS_DATABASE_URL: connectionString,
    COMMERCE_CATALOG_PREVIEW_LIMIT: '1',
    COMMERCE_DEV_AUTH_BYPASS: '0',
    COMMERCE_LLM_AGENT_ENABLED: '1',
    COMMERCE_METRICS_TOKEN: metricsToken,
    COMMERCE_PG_SSL: '0',
    COMMERCE_PUBLIC_ORIGIN: origin,
    COMMERCE_RELEASE_REVISION: process.env.COMMERCE_RELEASE_REVISION || 'live-e2e',
    COMMERCE_TRUSTED_PROXY_SECRET: proxySecret,
    NEXT_TELEMETRY_DISABLED: '1',
  };
  const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  webProcess = spawn(
    process.execPath,
    [next, 'start', '--hostname', '127.0.0.1', '--port', String(port)],
    {
      cwd: root,
      env: { ...runtimeEnvironment, NODE_ENV: 'production' },
      stdio: 'inherit',
      shell: false,
    },
  );
  await waitForWeb();

  workerProcess = spawn(
    process.execPath,
    [path.join(root, 'scripts', 'runtime', 'commerce-worker.js')],
    {
      cwd: root,
      // Deployment invariants are covered separately; this process E2E uses one disposable DB.
      env: { ...runtimeEnvironment, NODE_ENV: 'development' },
      stdio: 'inherit',
      shell: false,
    },
  );
  await waitForWorker();
}, 120_000);

afterAll(async () => {
  await stopProcess(workerProcess);
  await stopProcess(webProcess);
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
}, 30_000);

describe.sequential('Commerce live-model process release evidence', () => {
  it('runs HTTP ingress, an independent Worker, SSE and multi-turn analytics end to end', async () => {
    const model = process.env.COMMERCE_LIVE_E2E_MODEL || 'deepseek-v4-flash';
    const firstPayload = await apiJson<{ job: CommerceAgentJob }>(
      '/api/commerce/conversations',
      {
        method: 'POST',
        body: JSON.stringify({
          message: '请先确认数据覆盖范围，再回答 2026-07-01 到 2026-07-07、SKU-LIVE 的 GMV 总额。无需分组，结论必须有数据证据。',
          model,
          requestId: `req_live_e2e_${suffix}`,
        }),
      },
      202,
    );
    expect(firstPayload.job.status).toBe('queued');
    const firstEventsPromise = streamJobEvents(firstPayload.job.id);
    const firstResult = await completedJob(firstPayload.job.id);
    const firstEvents = await firstEventsPromise;
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
    const secondPayload = await apiJson<{ job: CommerceAgentJob }>(
      `/api/commerce/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: '对同一日期范围，请同时使用渠道拆解和按日趋势工具分析 GMV，并给出有证据的结论。',
          requestId: `req_live_e2e_breakdown_${suffix}`,
        }),
      },
      202,
    );
    const secondResult = await completedJob(secondPayload.job.id);
    const secondOperations = secondResult.assistantMessage.traces.map((trace) => trace.operation);
    expect(secondOperations).toContain('commerce.breakdown_metric');
    expect(secondOperations).toContain('commerce.trend_metric');

    const thirdPayload = await apiJson<{ job: CommerceAgentJob }>(
      `/api/commerce/conversations/${encodeURIComponent(conversationId)}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          message: '请先检索 SKU-RISK，再使用库存风险工具检查 2026-07-01 到 2026-07-07 的缺货情况。',
          requestId: `req_live_e2e_inventory_${suffix}`,
        }),
      },
      202,
    );
    const thirdResult = await completedJob(thirdPayload.job.id);
    const thirdOperations = thirdResult.assistantMessage.traces.map((trace) => trace.operation);
    expect(thirdOperations).toContain('commerce.lookup_entities');
    expect(thirdOperations).toContain('commerce.inventory_risk');

    const conversationPayload = await apiJson<{
      conversation: { messages: unknown[] };
    }>(`/api/commerce/conversations/${encodeURIComponent(conversationId)}`);
    expect(conversationPayload.conversation.messages).toHaveLength(6);

    const unauthorizedMetrics = await fetch(`${origin}/api/metrics`);
    expect(unauthorizedMetrics.status).toBe(404);
    const metricsResponse = await fetch(`${origin}/api/metrics`, {
      headers: { authorization: `Bearer ${metricsToken}` },
    });
    expect(metricsResponse.status).toBe(200);
    const metrics = await metricsResponse.text();
    expect(metrics).toContain('commerce_agent_jobs{status="completed"}');
    expect(metrics).toMatch(/^commerce_agent_workers [1-9]\d*$/mu);
    expect(metrics).toContain('commerce_agent_evidence ');

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
      schemaVersion: 2,
      service: 'commerce-data-agent',
      revision: process.env.COMMERCE_RELEASE_REVISION || process.env.GITHUB_SHA || 'unversioned',
      model,
      status: 'passed',
      completedAt: new Date().toISOString(),
      topology: {
        web: 'next-production-http-process',
        worker: 'independent-worker-process',
        events: 'database-projected-sse',
        metrics: 'prometheus-http',
      },
      answerStatus: answer?.status,
      expectedGmv: 700,
      operations,
      evidenceCount: traces.length,
      usage,
    }, null, 2)}\n`, 'utf8');
  }, 300_000);
});

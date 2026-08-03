import { timingSafeEqual } from 'node:crypto';

import { getCommerceAgentRuntimeConfig } from './config';
import {
  getCommerceAnalyticsDatabase,
  getCommerceControlDatabase,
} from './database';

const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function equalSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authorizeCommerceMetrics(authorization: string | null): boolean {
  const expected = getCommerceAgentRuntimeConfig().metricsToken;
  if (!expected) return process.env.NODE_ENV !== 'production';
  const match = authorization?.match(/^Bearer\s+(.+)$/iu);
  return Boolean(match?.[1] && equalSecret(expected, match[1]));
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metric(name: string, value: number, labels?: Record<string, string>): string {
  const suffix = labels
    ? `{${Object.entries(labels).map(([key, item]) => `${key}="${item.replace(/["\\\n]/gu, '_')}"`).join(',')}}`
    : '';
  return `${name}${suffix} ${value}`;
}

export function commerceMetricsTenantId(value: string | null): string | null {
  if (value === null || value.trim() === '') return null;
  const normalized = value.trim();
  if (!TENANT_ID.test(normalized)) throw new Error('Invalid metrics tenant id.');
  return normalized;
}

async function collectConnectorMetrics(tenantId: string) {
  return getCommerceAnalyticsDatabase().transaction(async (client) => {
    await client.query(`SELECT set_config('commerce.tenant_id', $1, true)`, [tenantId]);
    const [runs, connectors] = await Promise.all([
      client.query<{ status: string; transport: string; count: unknown }>(
        `SELECT status, transport, COUNT(*)::bigint AS count
         FROM commerce_connector_runs GROUP BY status, transport`,
      ),
      client.query<{
        connector_id: string;
        transport: string;
        status: string;
        last_run_timestamp: unknown;
        last_success_timestamp: unknown;
        checkpoint_timestamp: unknown;
        source_rows: unknown;
        rejected_rows: unknown;
        imported_rows: unknown;
      }>(
        `WITH latest AS (
           SELECT DISTINCT ON (connector_id)
                  connector_id, transport, status, started_at,
                  source_rows, rejected_rows, imported_rows
           FROM commerce_connector_runs
           ORDER BY connector_id, started_at DESC, id DESC
         ), success AS (
           SELECT connector_id,
                  MAX(completed_at) FILTER (WHERE status IN ('completed', 'skipped')) AS completed_at
           FROM commerce_connector_runs
           GROUP BY connector_id
         )
         SELECT latest.connector_id, latest.transport, latest.status,
                EXTRACT(EPOCH FROM latest.started_at) AS last_run_timestamp,
                EXTRACT(EPOCH FROM success.completed_at) AS last_success_timestamp,
                EXTRACT(EPOCH FROM checkpoint.updated_at) AS checkpoint_timestamp,
                latest.source_rows, latest.rejected_rows, latest.imported_rows
         FROM latest
         LEFT JOIN success USING (connector_id)
         LEFT JOIN commerce_connector_checkpoints AS checkpoint USING (connector_id)
         ORDER BY latest.connector_id`,
      ),
    ]);
    return { runs, connectors };
  });
}

export async function collectCommercePrometheusMetrics(tenantId: string | null = null): Promise<string> {
  const database = getCommerceControlDatabase();
  const config = getCommerceAgentRuntimeConfig();
  const [jobs, runs, totals, workers, queue] = await Promise.all([
    database.query<{ status: string; count: unknown }>(
      `SELECT status, COUNT(*)::bigint AS count FROM commerce_agent_jobs GROUP BY status`,
    ),
    database.query<{ status: string; count: unknown; duration_sum: unknown; duration_count: unknown }>(
      `SELECT status, COUNT(*)::bigint AS count,
              COALESCE(SUM(EXTRACT(EPOCH FROM (completed_at - started_at)))
                FILTER (WHERE completed_at IS NOT NULL), 0) AS duration_sum,
              COUNT(completed_at)::bigint AS duration_count
       FROM commerce_agent_runs GROUP BY status`,
    ),
    database.query<{
      input_tokens: unknown;
      output_tokens: unknown;
      total_tokens: unknown;
      evidence_count: unknown;
    }>(
      `SELECT
         COALESCE((SELECT SUM(input_tokens) FROM commerce_agent_runs), 0) AS input_tokens,
         COALESCE((SELECT SUM(output_tokens) FROM commerce_agent_runs), 0) AS output_tokens,
         COALESCE((SELECT SUM(total_tokens) FROM commerce_agent_runs), 0) AS total_tokens,
         (SELECT COUNT(*) FROM commerce_agent_evidence) AS evidence_count`,
    ),
    database.query<{ active: unknown }>(
      `SELECT COUNT(*)::bigint AS active FROM commerce_agent_workers
       WHERE status = 'running'
         AND heartbeat_at >= NOW() - ($1::integer * INTERVAL '1 millisecond')`,
      [config.workerStaleMs],
    ),
    database.query<{ depth: unknown; oldest_seconds: unknown }>(
      `SELECT COUNT(*)::bigint AS depth,
              COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0) AS oldest_seconds
       FROM commerce_agent_jobs WHERE status = 'queued'`,
    ),
  ]);
  const lines = [
    '# HELP commerce_agent_jobs Current durable jobs by status.',
    '# TYPE commerce_agent_jobs gauge',
    ...jobs.rows.map((row) => metric('commerce_agent_jobs', numberValue(row.count), { status: row.status })),
    '# HELP commerce_agent_runs Retained agent runs by status.',
    '# TYPE commerce_agent_runs gauge',
    ...runs.rows.map((row) => metric('commerce_agent_runs', numberValue(row.count), { status: row.status })),
    '# HELP commerce_agent_run_duration_seconds Retained completed run duration.',
    '# TYPE commerce_agent_run_duration_seconds summary',
    metric('commerce_agent_run_duration_seconds_sum', runs.rows.reduce((sum, row) => sum + numberValue(row.duration_sum), 0)),
    metric('commerce_agent_run_duration_seconds_count', runs.rows.reduce((sum, row) => sum + numberValue(row.duration_count), 0)),
    '# HELP commerce_agent_tokens Retained provider token usage.',
    '# TYPE commerce_agent_tokens counter',
    metric('commerce_agent_tokens', numberValue(totals.rows[0]?.input_tokens), { type: 'input' }),
    metric('commerce_agent_tokens', numberValue(totals.rows[0]?.output_tokens), { type: 'output' }),
    metric('commerce_agent_tokens', numberValue(totals.rows[0]?.total_tokens), { type: 'total' }),
    '# HELP commerce_agent_evidence Retained evidence receipts.',
    '# TYPE commerce_agent_evidence gauge',
    metric('commerce_agent_evidence', numberValue(totals.rows[0]?.evidence_count)),
    '# HELP commerce_agent_workers Active worker heartbeats.',
    '# TYPE commerce_agent_workers gauge',
    metric('commerce_agent_workers', numberValue(workers.rows[0]?.active)),
    '# HELP commerce_agent_queue_depth Queued durable jobs.',
    '# TYPE commerce_agent_queue_depth gauge',
    metric('commerce_agent_queue_depth', numberValue(queue.rows[0]?.depth)),
    '# HELP commerce_agent_queue_oldest_seconds Age of the oldest queued job.',
    '# TYPE commerce_agent_queue_oldest_seconds gauge',
    metric('commerce_agent_queue_oldest_seconds', numberValue(queue.rows[0]?.oldest_seconds)),
  ];
  if (tenantId) {
    const connectorMetrics = await collectConnectorMetrics(tenantId);
    lines.push(
      '# HELP commerce_connector_runs Retained Connector runs by status and transport for one RLS-scoped tenant.',
      '# TYPE commerce_connector_runs gauge',
      ...connectorMetrics.runs.rows.map((row) => metric(
        'commerce_connector_runs',
        numberValue(row.count),
        { tenant_id: tenantId, status: row.status, transport: row.transport },
      )),
      '# HELP commerce_connector_last_run_status Status of the latest run for each tenant Connector.',
      '# TYPE commerce_connector_last_run_status gauge',
      ...connectorMetrics.connectors.rows.map((row) => metric('commerce_connector_last_run_status', 1, {
        tenant_id: tenantId,
        connector_id: row.connector_id,
        transport: row.transport,
        status: row.status,
      })),
      '# HELP commerce_connector_last_run_timestamp_seconds Start time of the latest Connector run.',
      '# TYPE commerce_connector_last_run_timestamp_seconds gauge',
      ...connectorMetrics.connectors.rows.map((row) => metric(
        'commerce_connector_last_run_timestamp_seconds',
        numberValue(row.last_run_timestamp),
        { tenant_id: tenantId, connector_id: row.connector_id, transport: row.transport },
      )),
      '# HELP commerce_connector_last_success_timestamp_seconds Completion time of the latest successful or skipped Connector run.',
      '# TYPE commerce_connector_last_success_timestamp_seconds gauge',
      ...connectorMetrics.connectors.rows.map((row) => metric(
        'commerce_connector_last_success_timestamp_seconds',
        numberValue(row.last_success_timestamp),
        { tenant_id: tenantId, connector_id: row.connector_id, transport: row.transport },
      )),
      '# HELP commerce_connector_checkpoint_timestamp_seconds Last persisted checkpoint update time.',
      '# TYPE commerce_connector_checkpoint_timestamp_seconds gauge',
      ...connectorMetrics.connectors.rows.map((row) => metric(
        'commerce_connector_checkpoint_timestamp_seconds',
        numberValue(row.checkpoint_timestamp),
        { tenant_id: tenantId, connector_id: row.connector_id, transport: row.transport },
      )),
      '# HELP commerce_connector_rows Row counts observed by the latest Connector run.',
      '# TYPE commerce_connector_rows gauge',
      ...connectorMetrics.connectors.rows.flatMap((row) => [
        ['source', row.source_rows],
        ['rejected', row.rejected_rows],
        ['imported', row.imported_rows],
      ].map(([kind, value]) => metric(
        'commerce_connector_rows',
        numberValue(value),
        {
          tenant_id: tenantId,
          connector_id: row.connector_id,
          transport: row.transport,
          kind: String(kind),
        },
      ))),
    );
  }
  return `${lines.join('\n')}\n`;
}

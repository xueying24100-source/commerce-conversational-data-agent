import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ token: 'metrics-secret-material-0123456789' }));

vi.mock('./config', () => ({
  getCommerceAgentRuntimeConfig: () => ({ metricsToken: state.token }),
}));

vi.mock('./database', () => ({
  getCommerceControlDatabase: () => ({
    query: async (sql: string) => {
      if (sql.includes('FROM commerce_agent_jobs GROUP BY')) {
        return { rows: [{ status: 'queued', count: 2 }], rowCount: 1 };
      }
      if (sql.includes('FROM commerce_agent_runs GROUP BY')) {
        return {
          rows: [{ status: 'completed', count: 3, duration_sum: 12, duration_count: 3 }],
          rowCount: 1,
        };
      }
      if (sql.includes('evidence_count')) {
        return {
          rows: [{ input_tokens: 10, output_tokens: 5, total_tokens: 15, evidence_count: 4 }],
          rowCount: 1,
        };
      }
      if (sql.includes('commerce_agent_workers')) {
        return { rows: [{ active: 1 }], rowCount: 1 };
      }
      return { rows: [{ depth: 2, oldest_seconds: 7 }], rowCount: 1 };
    },
  }),
  getCommerceAnalyticsDatabase: () => ({
    transaction: async (work: (client: { query: (sql: string) => Promise<unknown> }) => Promise<unknown>) => work({
      query: async (sql: string) => {
        if (sql.includes("set_config('commerce.tenant_id'")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('GROUP BY status, transport')) {
          return {
            rows: [{ status: 'completed', transport: 'olist', count: 2 }],
            rowCount: 1,
          };
        }
        return {
          rows: [{
            connector_id: 'olist-public-demo',
            transport: 'olist',
            status: 'completed',
            last_run_timestamp: 1_800_000_000,
            last_success_timestamp: 1_800_000_010,
            checkpoint_timestamp: 1_800_000_011,
            source_rows: 99_441,
            rejected_rows: 3,
            imported_rows: 10_689,
          }],
          rowCount: 1,
        };
      },
    }),
  }),
}));

import {
  authorizeCommerceMetrics,
  collectCommercePrometheusMetrics,
  commerceMetricsTenantId,
} from './metrics';

describe('Commerce Prometheus metrics', () => {
  beforeEach(() => {
    state.token = 'metrics-secret-material-0123456789';
  });

  it('requires a constant-time bearer secret when configured', () => {
    expect(authorizeCommerceMetrics(`Bearer ${state.token}`)).toBe(true);
    expect(authorizeCommerceMetrics('Bearer wrong')).toBe(false);
  });

  it('projects durable queue, run, token, evidence and worker state', async () => {
    const output = await collectCommercePrometheusMetrics();
    expect(output).toContain('commerce_agent_jobs{status="queued"} 2');
    expect(output).toContain('commerce_agent_tokens{type="total"} 15');
    expect(output).toContain('commerce_agent_workers 1');
    expect(output).toContain('commerce_agent_queue_oldest_seconds 7');
  });

  it('projects Connector health only inside an explicit tenant RLS scope', async () => {
    const output = await collectCommercePrometheusMetrics('tenant_olist_demo');
    expect(output).toContain('commerce_connector_runs{tenant_id="tenant_olist_demo",status="completed",transport="olist"} 2');
    expect(output).toContain('commerce_connector_last_run_status{tenant_id="tenant_olist_demo",connector_id="olist-public-demo",transport="olist",status="completed"} 1');
    expect(output).toContain('commerce_connector_rows{tenant_id="tenant_olist_demo",connector_id="olist-public-demo",transport="olist",kind="rejected"} 3');
  });

  it('accepts only bounded tenant ids for the metrics RLS context', () => {
    expect(commerceMetricsTenantId('tenant_olist_demo')).toBe('tenant_olist_demo');
    expect(commerceMetricsTenantId(null)).toBeNull();
    expect(() => commerceMetricsTenantId('bad tenant')).toThrow(/Invalid metrics tenant/u);
  });
});

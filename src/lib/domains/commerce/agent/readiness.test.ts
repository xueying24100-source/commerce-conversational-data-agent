import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  analyticsParameters: [] as unknown[],
  analyticsRow: {
    table_ready: true,
    session_read_only: true,
    rls_ready: true,
    role_bypasses_rls: false,
    data_present: null as boolean | null,
    coverage_start: null as string | null,
    coverage_end: null as string | null,
    last_ingested_at: null as string | null,
    source_updated_at: null as string | null,
    data_mode: null as string | null,
  },
}));

vi.mock('./config', () => ({
  commerceConfigurationStatus: () => ({
    ready: true,
    issues: [],
    databaseConfigured: true,
    analyticsConfigured: true,
    modelConfigured: true,
    authMode: 'trusted_proxy',
  }),
  getCommerceAgentRuntimeConfig: () => ({ maxDataAgeHours: 72, workerStaleMs: 30_000 }),
}));

vi.mock('./database', () => ({
  getCommerceControlDatabase: () => ({
    query: async () => ({ rows: [{ ready: true, worker_ready: true }], rowCount: 1 }),
  }),
  getCommerceAnalyticsDatabase: () => ({
    transaction: async (work: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => work({
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.includes("set_config('commerce.tenant_id'")) {
          return { rows: [], rowCount: 1 };
        }
        state.analyticsParameters = values;
        return { rows: [{ ...state.analyticsRow }], rowCount: 1 };
      },
    }),
  }),
}));

import { checkCommerceReadiness } from './readiness';

describe('Commerce readiness scopes', () => {
  beforeEach(() => {
    state.analyticsParameters = [];
    state.analyticsRow = {
      table_ready: true,
      session_read_only: true,
      rls_ready: true,
      role_bypasses_rls: false,
      data_present: null,
      coverage_start: null,
      coverage_end: null,
      last_ingested_at: null,
      source_updated_at: null,
      data_mode: null,
    };
  });

  it('keeps platform readiness distinct from unknown tenant data readiness', async () => {
    const readiness = await checkCommerceReadiness();

    expect(readiness.ready).toBe(true);
    expect(readiness.scope).toBe('platform');
    expect(readiness.checks.analyticsDataPresent).toBeNull();
    expect(readiness.checks.analyticsDataFresh).toBeNull();
    expect(readiness.checks.analyticsSourceFresh).toBeNull();
    expect(state.analyticsParameters).toEqual([null]);
  });

  it('fails a tenant readiness check when its data is absent', async () => {
    state.analyticsRow.data_present = false;

    const readiness = await checkCommerceReadiness('tenant_empty');

    expect(readiness.ready).toBe(false);
    expect(readiness.scope).toBe('tenant');
    expect(readiness.checks.analyticsDataPresent).toBe(false);
    expect(readiness.issues).toContain('分析库尚无 commerce_daily_metrics 经营事实。');
    expect(state.analyticsParameters).toEqual(['tenant_empty']);
  });

  it('requires a real recent tenant watermark', async () => {
    state.analyticsRow.data_present = true;
    state.analyticsRow.data_mode = 'snapshot';
    state.analyticsRow.coverage_start = '2016-09-04';
    state.analyticsRow.coverage_end = '2018-09-03';
    state.analyticsRow.source_updated_at = '2018-10-17T20:30:18.000Z';
    state.analyticsRow.last_ingested_at = new Date().toISOString();

    const readiness = await checkCommerceReadiness('tenant_ready');

    expect(readiness.ready).toBe(true);
    expect(readiness.checks.analyticsDataFresh).toBe(true);
    expect(readiness.checks.analyticsSourceFresh).toBeNull();
    expect(readiness.warnings[0]).toContain('固定历史快照');
    expect(readiness.dataStatus?.dataMode).toBe('snapshot');
  });

  it('fails incremental tenant readiness when the source watermark is stale', async () => {
    state.analyticsRow.data_present = true;
    state.analyticsRow.data_mode = 'incremental';
    state.analyticsRow.coverage_start = '2026-07-01';
    state.analyticsRow.coverage_end = '2026-07-07';
    state.analyticsRow.last_ingested_at = new Date().toISOString();
    state.analyticsRow.source_updated_at = '2020-01-01T00:00:00.000Z';

    const readiness = await checkCommerceReadiness('tenant_stale_source');

    expect(readiness.ready).toBe(false);
    expect(readiness.checks.analyticsDataFresh).toBe(true);
    expect(readiness.checks.analyticsSourceFresh).toBe(false);
    expect(readiness.issues).toContain('增量数据源水位超过 72 小时未更新。');
  });
});

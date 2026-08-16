import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  controlParameters: [] as unknown[],
  controlRow: { ready: true, worker_ready: true },
  analyticsParameters: [] as unknown[],
  analyticsSql: '',
  analyticsRow: {
    table_ready: true,
    session_read_only: true,
    rls_ready: true,
    role_bypasses_rls: false,
    data_present: null as boolean | null,
    partitions_complete: null as boolean | null,
    coverage_start: null as string | null,
    coverage_end: null as string | null,
    last_ingested_at: null as string | null,
    source_updated_at: null as string | null,
    data_mode: null as string | null,
    business_timezone: null as string | null,
    currency_code: null as string | null,
    available_metrics: null as string[] | null,
    snapshot_verified: null as boolean | null,
    source_disclosure: null as Record<string, unknown> | null,
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
  withCommerceControlSystem: async <T>(work: () => Promise<T>) => work(),
  getCommerceControlDatabase: () => ({
    query: async (_sql: string, values: unknown[] = []) => {
      state.controlParameters = values;
      return { rows: [{ ...state.controlRow }], rowCount: 1 };
    },
  }),
  getCommerceAnalyticsDatabase: () => ({
    transaction: async (work: (client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }) => Promise<unknown>) => work({
      query: async (sql: string, values: unknown[] = []) => {
        if (sql.includes("set_config('commerce.tenant_id'")) {
          return { rows: [], rowCount: 1 };
        }
        state.analyticsParameters = values;
        state.analyticsSql = sql;
        return { rows: [{ ...state.analyticsRow }], rowCount: 1 };
      },
    }),
  }),
}));

import { checkCommerceReadiness } from './readiness';

describe('Commerce readiness scopes', () => {
  beforeEach(() => {
    delete process.env.COMMERCE_WORKER_ID;
    process.env.COMMERCE_RELEASE_REVISION = 'revision-under-test';
    state.controlParameters = [];
    state.controlRow = { ready: true, worker_ready: true };
    state.analyticsParameters = [];
    state.analyticsSql = '';
    state.analyticsRow = {
      table_ready: true,
      session_read_only: true,
      rls_ready: true,
      role_bypasses_rls: false,
      data_present: null,
      partitions_complete: null,
      coverage_start: null,
      coverage_end: null,
      last_ingested_at: null,
      source_updated_at: null,
      data_mode: null,
      business_timezone: null,
      currency_code: null,
      available_metrics: null,
      snapshot_verified: null,
      source_disclosure: null,
    };
  });

  it('keeps platform readiness distinct from unknown tenant data readiness', async () => {
    const readiness = await checkCommerceReadiness();

    expect(readiness.ready).toBe(true);
    expect(readiness.scope).toBe('platform');
    expect(readiness.checks.analyticsDataPresent).toBeNull();
    expect(readiness.checks.analyticsPartitionsComplete).toBeNull();
    expect(readiness.checks.analyticsDataFresh).toBeNull();
    expect(readiness.checks.analyticsSourceFresh).toBeNull();
    expect(state.analyticsParameters).toEqual([null]);
    expect(state.controlParameters).toEqual([30_000, 'revision-under-test', null]);
  });

  it('passes the configured revision and exact Worker identity to the heartbeat probe', async () => {
    process.env.COMMERCE_WORKER_ID = 'release-worker-exact';

    const readiness = await checkCommerceReadiness();

    expect(readiness.ready).toBe(true);
    expect(state.controlParameters).toEqual([
      30_000,
      'revision-under-test',
      'release-worker-exact',
    ]);
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

  it('accepts an old fixed snapshot only when its source hash and latest Connector run verify', async () => {
    state.analyticsRow.data_present = true;
    state.analyticsRow.partitions_complete = true;
    state.analyticsRow.data_mode = 'snapshot';
    state.analyticsRow.coverage_start = '2016-09-04';
    state.analyticsRow.coverage_end = '2018-09-03';
    state.analyticsRow.source_updated_at = '2018-10-17T20:30:18.000Z';
    state.analyticsRow.last_ingested_at = '2020-01-01T00:00:00.000Z';
    state.analyticsRow.business_timezone = 'America/Sao_Paulo';
    state.analyticsRow.currency_code = 'BRL';
    state.analyticsRow.available_metrics = ['gmv', 'paid_orders', 'new_customers', 'units'];
    state.analyticsRow.snapshot_verified = true;
    state.analyticsRow.source_disclosure = {
      sourceKind: 'public_snapshot',
      sourceId: 'olist-public-orders',
      sourceUri: 'https://github.com/olist/work-at-olist-data',
      sourceRevision: 'd9e49802f3e92d09ee94ab9ccc5e457f207a8959',
      licenseId: 'MIT',
      fixtureSeed: 20260816,
      generatedFields: ['visits', 'channel', 'region', 'sku', 'category', 'units'],
    };

    const readiness = await checkCommerceReadiness('tenant_ready');

    expect(readiness.ready).toBe(true);
    expect(readiness.checks.analyticsDataFresh).toBe(true);
    expect(readiness.checks.analyticsSourceFresh).toBeNull();
    expect(readiness.warnings[0]).toContain('固定历史快照');
    expect(readiness.dataStatus?.dataMode).toBe('snapshot');
    expect(readiness.dataStatus?.snapshotVerified).toBe(true);
    expect(readiness.dataStatus?.businessTimezone).toBe('America/Sao_Paulo');
    expect(readiness.dataStatus?.currencyCode).toBe('BRL');
    expect(readiness.dataStatus?.availableMetrics).toEqual([
      'gmv',
      'paid_orders',
      'units',
      'average_order_value',
      'new_customers',
    ]);
    expect(readiness.dataStatus?.sourceDisclosure).toMatchObject({
      sourceId: 'olist-public-orders',
      fixtureSeed: 20260816,
      generatedFields: expect.arrayContaining(['visits', 'channel', 'region']),
    });
  });

  it('publishes only metrics supported by a Shopify-style source contract', async () => {
    state.analyticsRow.data_present = true;
    state.analyticsRow.partitions_complete = true;
    state.analyticsRow.data_mode = 'incremental';
    state.analyticsRow.coverage_start = '2026-07-01';
    state.analyticsRow.coverage_end = '2026-08-12';
    state.analyticsRow.last_ingested_at = new Date().toISOString();
    state.analyticsRow.source_updated_at = new Date().toISOString();
    state.analyticsRow.business_timezone = 'America/New_York';
    state.analyticsRow.available_metrics = ['gmv', 'paid_orders', 'refund_amount', 'units'];

    const readiness = await checkCommerceReadiness('tenant_shopify');

    expect(readiness.ready).toBe(true);
    expect(readiness.dataStatus).toMatchObject({
      businessTimezone: 'America/New_York',
      availableMetrics: [
        'gmv',
        'net_revenue',
        'paid_orders',
        'units',
        'average_order_value',
        'refund_amount',
      ],
    });
    expect(readiness.dataStatus?.availableMetrics).not.toContain('new_customers');
    expect(readiness.dataStatus?.availableMetrics).not.toContain('visits');
    expect(readiness.dataStatus?.availableMetrics).not.toContain('roas');
  });

  it('fails a snapshot without a matching source hash and healthy latest Connector run', async () => {
    state.analyticsRow.data_present = true;
    state.analyticsRow.partitions_complete = true;
    state.analyticsRow.data_mode = 'snapshot';
    state.analyticsRow.coverage_start = '2016-09-04';
    state.analyticsRow.coverage_end = '2018-09-03';
    state.analyticsRow.last_ingested_at = new Date().toISOString();
    state.analyticsRow.snapshot_verified = false;

    const readiness = await checkCommerceReadiness('tenant_unverified_snapshot');

    expect(readiness.ready).toBe(false);
    expect(readiness.checks.analyticsDataFresh).toBe(false);
    expect(readiness.issues).toContain(
      '固定快照缺少可验证源哈希，或最新 Connector run 未健康完成。',
    );
  });

  it('fails when any tenant date partition still requires backfill', async () => {
    state.analyticsRow.data_present = true;
    state.analyticsRow.partitions_complete = false;
    state.analyticsRow.data_mode = 'snapshot';
    state.analyticsRow.last_ingested_at = new Date().toISOString();
    state.analyticsRow.snapshot_verified = true;

    const readiness = await checkCommerceReadiness('tenant_partition_gap');

    expect(readiness.ready).toBe(false);
    expect(readiness.checks.analyticsPartitionsComplete).toBe(false);
    expect(readiness.issues).toContain('数据分区完整性尚未验证，存在待回填或缺口分区。');
    expect(state.analyticsSql).toContain('generate_series');
    expect(state.analyticsSql).toContain('partitions.partition_date IS NULL');
  });

  it('fails incremental tenant readiness when the source watermark is stale', async () => {
    state.analyticsRow.data_present = true;
    state.analyticsRow.partitions_complete = true;
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

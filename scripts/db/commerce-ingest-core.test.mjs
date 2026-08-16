import { createRequire } from 'node:module';
import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  assertConnectorOwnership,
  claimCommerceDirectWriterOwnership,
  parseCoverageProof,
  parseCommerceRow,
  parseCommerceSourceFactRow,
  parseSourceEntityReconciliation,
  reconcileSourceFacts,
  publishCommerceCoverage,
  replaceCommerceSnapshot,
  upsertCommerceRows,
  upsertSourceFacts,
  recomputeDailyMetricsFromSourceFacts,
} = require('./commerce-ingest-core.js');
const {
  privateNetworkAddress,
  resolveConnectorMode,
  validateHttpsSourceUrl,
} = require('../connectors/run-commerce-connector.js');

function row(overrides = {}) {
  return {
    tenant_id: 'tenant_a',
    source_id: 'source-a',
    metric_date: '2026-07-01',
    region: 'East',
    channel: 'Search',
    sku: 'SKU-1',
    category: 'Apparel',
    visits: 100,
    paid_orders: 10,
    units: 11,
    gmv: 200,
    refund_orders: 1,
    refund_amount: 10,
    cost_amount: 80,
    ad_spend: 20,
    new_customers: 4,
    stockout_hours: 0,
    ending_inventory: 30,
    source_updated_at: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

describe('Commerce connector ingest core', () => {
  it('requires an explicit mode-appropriate business-date coverage proof', () => {
    expect(parseCoverageProof({
      kind: 'complete_snapshot',
      coverageStart: '2026-07-01',
      coverageEnd: '2026-07-03',
      sourceUpdatedAt: '2026-07-04T00:00:00Z',
    }, 'snapshot')).toMatchObject({ coverageStart: '2026-07-01', coverageEnd: '2026-07-03' });
    expect(() => parseCoverageProof({
      kind: 'complete_snapshot',
      coverageStart: '2026-07-01',
      coverageEnd: '2026-07-03',
      sourceUpdatedAt: '2026-07-04T00:00:00Z',
    }, 'incremental')).toThrow(/not valid for incremental/u);
    expect(() => parseCoverageProof(null, 'snapshot')).toThrow(/proof is required/u);
  });

  it('requires coordinated incremental coverage to inherit its durable start date', () => {
    expect(parseCoverageProof({
      kind: 'coordinated_incremental_scan',
      coverageEnd: '2026-07-03',
      sourceUpdatedAt: '2026-07-04T00:00:00Z',
    }, 'incremental')).toEqual({
      kind: 'coordinated_incremental_scan',
      coverageStart: null,
      coverageEnd: '2026-07-03',
      sourceUpdatedAt: '2026-07-04T00:00:00.000Z',
    });
    expect(() => parseCoverageProof({
      kind: 'coordinated_incremental_scan',
      coverageStart: '2026-07-01',
      coverageEnd: '2026-07-03',
      sourceUpdatedAt: '2026-07-04T00:00:00Z',
    }, 'incremental')).toThrow(/must inherit coverageStart from durable proof/u);
  });

  it('extends coordinated incremental coverage from its durable proven start', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('MIN(partition_date)::text AS coverage_start')) {
        return {
          rows: [{ coverage_start: '2026-06-01', coverage_end: '2026-07-01' }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(publishCommerceCoverage(
      { query },
      'tenant_a',
      'shopify-orders',
      'incremental',
      'run-a',
      {
        kind: 'coordinated_incremental_scan',
        coverageEnd: '2026-07-03',
        sourceUpdatedAt: '2026-07-04T00:00:00Z',
      },
    )).resolves.toMatchObject({
      published: true,
      proof: {
        coverageStart: '2026-06-01',
        coverageEnd: '2026-07-03',
      },
    });

    const coverageInsert = query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO commerce_connector_date_coverage')
    ));
    expect(coverageInsert?.[1]).toEqual([
      'tenant_a',
      'shopify-orders',
      'run-a',
      'coordinated_incremental_scan',
      '2026-07-04T00:00:00.000Z',
      '2026-06-01',
      '2026-07-03',
    ]);
  });

  it('requires full-history reconciliation before the first coordinated incremental proof', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('MIN(partition_date)::text AS coverage_start')) {
        return {
          rows: [{ coverage_start: null, coverage_end: null }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(publishCommerceCoverage(
      { query },
      'tenant_a',
      'shopify-orders',
      'incremental',
      'run-a',
      {
        kind: 'coordinated_incremental_scan',
        coverageEnd: '2026-07-03',
        sourceUpdatedAt: '2026-07-04T00:00:00Z',
      },
    )).resolves.toEqual({
      published: false,
      reason: 'full_history_reconciliation_required',
    });
    expect(query.mock.calls.some(([sql]) => (
      sql.includes('DELETE FROM commerce_connector_date_coverage')
        || sql.includes('INSERT INTO commerce_connector_date_coverage')
    ))).toBe(false);
  });

  it('publishes every proven date, including zero-fact dates, and binds it to the run', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await publishCommerceCoverage(
      { query },
      'tenant_a',
      'snapshot-a',
      'snapshot',
      'run-a',
      {
        kind: 'complete_snapshot',
        coverageStart: '2026-07-01',
        coverageEnd: '2026-07-03',
        sourceUpdatedAt: '2026-07-04T00:00:00Z',
      },
    );
    expect(query.mock.calls.some(([sql]) => sql.includes('generate_series($6::date, $7::date')))
      .toBe(true);
    const partitionSql = query.mock.calls.find(([sql]) => (
      sql.includes('INSERT INTO commerce_tenant_data_partitions')
    ))?.[0];
    expect(partitionSql).toContain('COALESCE(fact_counts.fact_row_count, 0)');
    expect(partitionSql).toContain("'connector_coverage_intersection'");
  });
  it('validates the canonical fact contract and enforced tenant identity', () => {
    expect(parseCommerceRow(row(), 1, 'tenant_a')).toMatchObject({
      gmv: 200,
      business_timezone: 'Asia/Shanghai',
      data_mode: 'snapshot',
      available_metrics: expect.arrayContaining(['gmv', 'visits', 'ending_inventory']),
    });
    expect(() => parseCommerceRow(row({ tenant_id: 'tenant_b' }), 1, 'tenant_a'))
      .toThrow(/does not match connector tenant/u);
    expect(() => parseCommerceRow(row({ metric_date: '2026-02-30' }), 1))
      .toThrow(/valid YYYY-MM-DD/u);
  });

  it('validates an explicit tenant business time zone', () => {
    expect(parseCommerceRow(row({ business_timezone: 'America/Sao_Paulo' })))
      .toMatchObject({ business_timezone: 'America/Sao_Paulo' });
    expect(() => parseCommerceRow(row({ business_timezone: 'Mars/Olympus' })))
      .toThrow(/IANA time zone/u);
  });

  it('accepts only a non-empty, de-duplicated raw metric availability list', () => {
    expect(parseCommerceRow(row({
      available_metrics: ['units', 'gmv', 'units', 'paid_orders'],
    })).available_metrics).toEqual(['gmv', 'paid_orders', 'units']);
    expect(() => parseCommerceRow(row({ available_metrics: [] })))
      .toThrow(/non-empty array/u);
    expect(() => parseCommerceRow(row({ available_metrics: ['gmv', 'conversion_rate'] })))
      .toThrow(/unsupported metric/u);
  });

  it('accepts only explicit snapshot or incremental data modes', () => {
    expect(parseCommerceRow(row({ data_mode: 'incremental' }))).toMatchObject({
      data_mode: 'incremental',
    });
    expect(() => parseCommerceRow(row({ data_mode: 'streaming' })))
      .toThrow(/snapshot or incremental/u);
  });

  it('defaults to CNY and validates an explicit ISO 4217 currency code', () => {
    expect(parseCommerceRow(row())).toMatchObject({ currency_code: 'CNY' });
    expect(parseCommerceRow(row({ currency_code: 'brl' })))
      .toMatchObject({ currency_code: 'BRL' });
    expect(() => parseCommerceRow(row({ currency_code: 'US' })))
      .toThrow(/currency_code/u);
    expect(() => parseCommerceRow(row({ currency_code: 'USDX' })))
      .toThrow(/currency_code/u);
    expect(() => parseCommerceRow(row({ currency_code: '123' })))
      .toThrow(/currency_code/u);
  });

  it('uses tenant-local RLS context and parameterized idempotent upserts', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await upsertCommerceRows({ query }, [parseCommerceRow(row())]);
    expect(query.mock.calls[0][0]).toContain("set_config('commerce.ingest_tenant_id'");
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT');
    expect(query.mock.calls[1][0]).toContain('available_metrics');
    expect(query.mock.calls[1][1]).toContain('tenant_a');
  });
});

function sourceFact(overrides = {}) {
  return {
    tenant_id: 'tenant_a',
    source_entity_id: 'gid://shopify/Order/1',
    source_line_id: 'order:1',
    metric_date: '2026-07-01',
    region: 'East',
    channel: 'Search',
    sku: 'SHOPIFY-ORDER',
    category: 'All Products',
    currency_code: 'CNY',
    paid_orders: 1,
    units: 2,
    gmv: 120.5,
    refund_amount: 0,
    source_updated_at: '2026-07-02T00:00:00Z',
    ...overrides,
  };
}

describe('Commerce connector source-fact staging (incremental connectors)', () => {
  it('validates an order/refund staging line and defaults optional numeric fields to zero', () => {
    expect(parseCommerceSourceFactRow(sourceFact(), 'shopify-orders', 1, 'tenant_a')).toMatchObject({
      tenant_id: 'tenant_a',
      connector_id: 'shopify-orders',
      source_entity_id: 'gid://shopify/Order/1',
      source_line_id: 'order:1',
      business_timezone: 'Asia/Shanghai',
      currency_code: 'CNY',
      paid_orders: 1,
      units: 2,
      gmv: 120.5,
      refund_amount: 0,
    });
    expect(parseCommerceSourceFactRow(
      sourceFact({ paid_orders: undefined, units: undefined, gmv: undefined }),
      'shopify-orders',
      1,
      'tenant_a',
    )).toMatchObject({ paid_orders: 0, units: 0, gmv: 0 });
    expect(() => parseCommerceSourceFactRow(sourceFact({ source_line_id: '' }), 'shopify-orders', 1, 'tenant_a'))
      .toThrow(/source_line_id/u);
    expect(() => parseCommerceSourceFactRow(sourceFact({ source_entity_id: '' }), 'shopify-orders', 1, 'tenant_a'))
      .toThrow(/source_entity_id/u);
  });

  it('validates exact source-entity line sets, including empty tombstones', () => {
    expect(parseSourceEntityReconciliation({
      source_entity_id: 'gid://shopify/Order/1',
      source_line_ids: [],
    })).toEqual({
      source_entity_id: 'gid://shopify/Order/1',
      source_line_ids: [],
    });
    expect(() => parseSourceEntityReconciliation({
      source_entity_id: 'gid://shopify/Order/1',
      source_line_ids: ['order:1', 'order:1'],
    })).toThrow(/must not contain duplicates/u);
  });

  it('upserts staging rows for exactly one tenant and connector per batch', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const rows = [parseCommerceSourceFactRow(sourceFact(), 'shopify-orders', 1, 'tenant_a')];
    await upsertSourceFacts({ query }, 'tenant_a', 'shopify-orders', rows);
    expect(query.mock.calls[0][0]).toContain("set_config('commerce.ingest_tenant_id'");
    expect(query.mock.calls[1][0]).toContain('commerce_connector_source_facts');
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT');
    await expect(upsertSourceFacts(
      { query },
      'tenant_a',
      'shopify-orders',
      [parseCommerceSourceFactRow(sourceFact({ tenant_id: 'tenant_b' }), 'shopify-orders', 1, 'tenant_b')],
    )).rejects.toThrow(/exactly one tenant and connector/u);
  });

  it('recomputes commerce_daily_metrics only for the touched buckets, from the staged history', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await recomputeDailyMetricsFromSourceFacts(
      { query },
      'tenant_a',
      'shopify-orders',
      [{ metric_date: '2026-07-01', region: 'East', channel: 'Search', sku: 'SHOPIFY-ORDER' }],
      ['gmv', 'paid_orders', 'refund_amount', 'units'],
    );
    expect(query.mock.calls[0][0]).toContain("set_config('commerce.ingest_tenant_id'");
    const [currencySql] = query.mock.calls[1];
    const [deleteSql] = query.mock.calls[2];
    const [sql, params] = query.mock.calls[3];
    expect(currencySql).toContain('COUNT(DISTINCT f.currency_code) > 1');
    expect(deleteSql).toContain('WITH touched');
    expect(deleteSql).toContain('DELETE FROM commerce_daily_metrics');
    expect(sql).toContain('FROM commerce_connector_source_facts');
    expect(sql).toContain(
      'ON CONFLICT (tenant_id, source_id, metric_date, region, channel, sku)',
    );
    expect(params).toContain('2026-07-01');
    expect(params).toContain('tenant_a');
    expect(params).toContain('shopify-orders');
  });

  it('fails closed on currencies accumulated across runs before deleting a published bucket', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('COUNT(DISTINCT f.currency_code) > 1')) {
        return {
          rows: [{
            metric_date: '2026-07-01',
            region: 'East',
            channel: 'Search',
            sku: 'SHOPIFY-ORDER',
            currency_codes: ['CNY', 'USD'],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    await expect(recomputeDailyMetricsFromSourceFacts(
      { query },
      'tenant_a',
      'shopify-orders',
      [{ metric_date: '2026-07-01', region: 'East', channel: 'Search', sku: 'SHOPIFY-ORDER' }],
      ['gmv'],
    )).rejects.toThrow(/multiple currencies \(CNY, USD\)/u);
    expect(query.mock.calls.some(([sql]) => sql.includes('DELETE FROM commerce_daily_metrics')))
      .toBe(false);
  });

  it('reconciles an observed entity by deleting its old lines and returns old plus new buckets', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('DELETE FROM commerce_connector_source_facts')) {
        return {
          rows: [{
            metric_date: '2026-07-01',
            region: 'Old Region',
            channel: 'Search',
            sku: 'SHOPIFY-ORDER',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const parsed = parseCommerceSourceFactRow(sourceFact({
      region: 'New Region',
      source_line_id: 'order:gid://shopify/Order/1',
    }), 'shopify-orders', 1, 'tenant_a');
    await expect(reconcileSourceFacts(
      { query },
      'tenant_a',
      'shopify-orders',
      [parsed],
      [{
        source_entity_id: 'gid://shopify/Order/1',
        source_line_ids: ['order:gid://shopify/Order/1'],
      }],
    )).resolves.toEqual([
      {
        metric_date: '2026-07-01',
        region: 'Old Region',
        channel: 'Search',
        sku: 'SHOPIFY-ORDER',
      },
      {
        metric_date: '2026-07-01',
        region: 'New Region',
        channel: 'Search',
        sku: 'SHOPIFY-ORDER',
      },
    ]);
    expect(query.mock.calls.some(([sql]) => sql.includes('source_entity_id = ANY'))).toBe(true);
  });

  it('rejects source facts not covered by an exact entity reconciliation', async () => {
    const parsed = parseCommerceSourceFactRow(sourceFact(), 'shopify-orders', 1, 'tenant_a');
    await expect(reconcileSourceFacts(
      { query: vi.fn() },
      'tenant_a',
      'shopify-orders',
      [parsed],
      [{ source_entity_id: parsed.source_entity_id, source_line_ids: [] }],
    )).rejects.toThrow(/must be declared/u);
  });

  it('does nothing when there are no touched buckets', async () => {
    const query = vi.fn();
    await recomputeDailyMetricsFromSourceFacts({ query }, 'tenant_a', 'shopify-orders', [], ['gmv']);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('Commerce snapshot replacement and connector ownership', () => {
  it('deletes the prior tenant snapshot even when the replacement is empty', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await replaceCommerceSnapshot({ query }, 'tenant_a', 'source-a', []);
    expect(query.mock.calls[0][0]).toContain("set_config('commerce.ingest_tenant_id'");
    expect(query.mock.calls[1]).toEqual([
      'DELETE FROM commerce_daily_metrics WHERE tenant_id = $1 AND source_id = $2',
      ['tenant_a', 'source-a'],
    ]);
  });

  it('fails closed for generic incremental rows instead of applying unsafe upsert semantics', async () => {
    const parsed = parseCommerceRow(row({ data_mode: 'incremental' }));
    await expect(replaceCommerceSnapshot(
      { query: vi.fn() }, 'tenant_a', 'source-a', [parsed],
    ))
      .rejects.toThrow(/only support data_mode=snapshot/u);
  });

  it('allows same-mode connector ownership but rejects mode conflicts and stale checkpoints', async () => {
    const conflictQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ connector_id: 'owner-a', data_mode: 'snapshot', checkpoint: 'sha256:a' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(assertConnectorOwnership(
      { query: conflictQuery },
      'tenant_a',
      'owner-b',
      'snapshot',
      null,
    )).resolves.toBeUndefined();

    const modeConflictQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ connector_id: 'owner-a', data_mode: 'incremental', checkpoint: 'cursor-a' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(assertConnectorOwnership(
      { query: modeConflictQuery },
      'tenant_a',
      'owner-b',
      'snapshot',
      null,
    )).rejects.toThrow(/all sources for one tenant must share a data mode/u);

    const staleQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ connector_id: 'owner-a', data_mode: 'snapshot', checkpoint: 'sha256:new' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(assertConnectorOwnership(
      { query: staleQuery },
      'tenant_a',
      'owner-a',
      'snapshot',
      'sha256:old',
    )).rejects.toThrow(/checkpoint advanced/u);
  });

  it('refuses to silently claim legacy or manually imported daily metrics', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ present: 1 }], rowCount: 1 });
    await expect(assertConnectorOwnership(
      { query },
      'tenant_legacy',
      'new-owner',
      'snapshot',
      null,
    )).rejects.toThrow(/unowned daily metrics.*refusing implicit connector takeover/u);
    expect(query.mock.calls[4][0]).toContain('commerce_daily_metrics');
  });

  it('blocks an upgraded Shopify checkpoint until source-fact staging is explicitly bootstrapped', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          connector_id: 'shopify-orders',
          data_mode: 'incremental',
          source_fact_state: 'bootstrap_required',
          checkpoint: '2026-07-31T00:00:00.000Z',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(assertConnectorOwnership(
      { query },
      'tenant_a',
      'shopify-orders',
      'incremental',
      '2026-07-31T00:00:00.000Z',
    )).rejects.toThrow(/staging is not bootstrapped.*do not advance/u);
  });

  it('makes the direct JSONL writer reject a tenant owned by an incompatible mode', async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes('WHERE tenant_id = $1 AND connector_id = $2')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM commerce_connector_checkpoints') && sql.includes('ORDER BY connector_id')) {
        return {
          rows: [{
            connector_id: 'shopify-orders',
            data_mode: 'incremental',
            source_fact_state: 'ready',
            checkpoint: '2026-07-31T00:00:00.000Z',
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    await expect(claimCommerceDirectWriterOwnership(
      { query },
      'tenant_a',
      'commerce-jsonl-import',
      'snapshot',
      '1.0.0',
      `sha256:${'a'.repeat(64)}`,
    )).rejects.toThrow(/all sources for one tenant must share a data mode/u);
  });

  it('requires a content hash for direct snapshot ownership', async () => {
    await expect(claimCommerceDirectWriterOwnership(
      { query: vi.fn() },
      'tenant_a',
      'commerce-jsonl-import',
      'snapshot',
    )).rejects.toThrow(/requires a sha256 source identity/u);
  });
});

describe('Commerce connector source-mode and migration contracts', () => {
  it('requires generic HTTPS snapshots to be explicit and rejects legacy delta semantics', () => {
    expect(() => resolveConnectorMode({ source: { type: 'https' } }))
      .toThrow(/must declare sourceMode explicitly/u);
    expect(() => resolveConnectorMode({
      sourceMode: 'incremental',
      source: { type: 'https' },
    })).toThrow(/unsupported without a stable source-fact reconciliation adapter/u);
    expect(resolveConnectorMode({
      sourceMode: 'snapshot',
      source: { type: 'https' },
    })).toBe('snapshot');
    expect(resolveConnectorMode({ source: { type: 'shopify' } })).toBe('incremental');
  });

  it('requires an exact HTTPS host allowlist and rejects resolved private networks', async () => {
    const publicResolver = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    await expect(validateHttpsSourceUrl(
      { allowedHosts: ['data.example.com'] },
      'https://data.example.com/export.jsonl',
      publicResolver,
    )).resolves.toMatchObject({ hostname: 'data.example.com' });
    await expect(validateHttpsSourceUrl(
      { allowedHosts: [] },
      'https://data.example.com/export.jsonl',
      publicResolver,
    )).rejects.toThrow(/non-empty.*allowedHosts/u);
    await expect(validateHttpsSourceUrl(
      { allowedHosts: ['data.example.com'] },
      'https://other.example.com/export.jsonl',
      publicResolver,
    )).rejects.toThrow(/not in source.allowedHosts/u);
    await expect(validateHttpsSourceUrl(
      { allowedHosts: ['data.example.com'] },
      'https://data.example.com/export.jsonl',
      async () => [{ address: '169.254.169.254', family: 4 }],
    )).rejects.toThrow(/prohibited network address/u);
    expect(privateNetworkAddress('127.0.0.1')).toBe(true);
    expect(privateNetworkAddress('10.0.0.1')).toBe(true);
    expect(privateNetworkAddress('fd00::1')).toBe(true);
    expect(privateNetworkAddress('93.184.216.34')).toBe(false);
  });

  it('does not silently label legacy facts CNY and records an explicit Shopify bootstrap state', () => {
    const migration = fs.readFileSync(
      new URL('../../migrations/commerce-analytics.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain('commerce_currency_backfill_required');
    expect(migration).toContain('Backfill the real ISO 4217 currency for every legacy tenant');
    expect(migration).not.toMatch(
      /ADD COLUMN IF NOT EXISTS currency_code TEXT NOT NULL DEFAULT 'CNY'/u,
    );
    expect(migration).toContain("source_fact_state IN ('not_applicable', 'bootstrap_required', 'ready')");
    expect(migration).toContain("ELSE 'bootstrap_required'");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS commerce_tenant_data_partitions');
    expect(migration).toContain('CHECK (fact_row_count >= 0)');
    expect(migration).toContain("'backfill_required', NOW()");
    expect(migration).toContain('commerce_connector_date_coverage');
    expect(migration).toContain('commerce_tenant_data_partitions_coverage_proof_check');
    expect(migration).not.toContain("MAX(source_updated_at), 'ready', NOW()");
    expect(migration).toContain('commerce_source_id_backfill_required');
    expect(migration).toContain('commerce_daily_metrics_serving_bucket_idx');
  });
});

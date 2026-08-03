import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  parseCommerceRow,
  upsertCommerceRows,
} = require('./commerce-ingest-core.js');

function row(overrides = {}) {
  return {
    tenant_id: 'tenant_a',
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

  it('uses tenant-local RLS context and parameterized idempotent upserts', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    await upsertCommerceRows({ query }, [parseCommerceRow(row())]);
    expect(query.mock.calls[0][0]).toContain("set_config('commerce.ingest_tenant_id'");
    expect(query.mock.calls[1][0]).toContain('ON CONFLICT');
    expect(query.mock.calls[1][0]).toContain('available_metrics');
    expect(query.mock.calls[1][1]).toContain('tenant_a');
  });
});

import { describe, expect, it } from 'vitest';

import type { CommerceSqlClient } from './database';
import {
  CommerceMetricUnavailableError,
  PostgresCommerceAnalyticsRepository,
} from './analytics-repository';

const SHOPIFY_METRICS = [
  'gmv',
  'paid_orders',
  'refund_amount',
  'units',
];

describe('Postgres Commerce analytics repository', () => {
  it('reads PostgreSQL DATE coverage as stable calendar text', async () => {
    const calls: string[] = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string) {
        calls.push(text);
        if (text.includes('commerce_tenant_data_status')) {
          return {
            rows: [{
              start_date: '2026-07-01',
              end_date: '2026-07-07',
              last_ingested_at: '2026-07-08T00:00:00.000Z',
              row_count: 7,
            }] as unknown as Row[],
            rowCount: 1,
          };
        }
        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    const catalog = await new PostgresCommerceAnalyticsRepository(client)
      .getCatalog('tenant_calendar');

    expect(calls[0]).toContain('coverage_start::text AS start_date');
    expect(calls[0]).toContain('coverage_end::text AS end_date');
    expect(catalog.coverage).toMatchObject({
      start: '2026-07-01',
      end: '2026-07-07',
      rowCount: 7,
    });
  });

  it('keeps tenant and filter values parameterized in every metric query', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string, values = []) {
        calls.push({ text, values });
        if (text.includes('commerce_tenant_data_status')) {
          return {
            rows: [{
              available_metrics: ['gmv', 'paid_orders', 'visits'],
            }] as unknown as Row[],
            rowCount: 1,
          };
        }
        return {
          rows: [{ gmv: 120, conversion_rate: 0.12 }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };
    const repository = new PostgresCommerceAnalyticsRepository(client);

    await repository.compareMetrics('tenant_safe', {
      current: { start: '2026-06-01', end: '2026-06-30' },
      metrics: ['gmv', 'conversion_rate'],
      filters: {
        regions: ["华东'); DROP TABLE commerce_daily_metrics; --"],
        channels: [],
        skus: [],
        categories: [],
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain('tenant_id = $1');
    expect(calls[1].text).toContain('region = ANY($4::text[])');
    expect(calls[1].text).not.toContain('DROP TABLE');
    expect(calls[1].values[0]).toBe('tenant_safe');
    expect(calls[1].values[3]).toEqual(["华东'); DROP TABLE commerce_daily_metrics; --"]);
  });

  it('searches long-tail entities without interpolating the search text', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string, values = []) {
        calls.push({ text, values });
        return { rows: [{ value: 'SKU-1001', fact_rows: 30 }] as unknown as Row[], rowCount: 1 };
      },
    };
    const repository = new PostgresCommerceAnalyticsRepository(client);

    await expect(repository.lookupEntities('tenant_safe', {
      dimension: 'sku',
      query: "1001'); DROP TABLE commerce_daily_metrics; --",
      limit: 12,
    })).resolves.toEqual([{ value: 'SKU-1001', factRows: 30 }]);

    expect(calls[0].text).toContain('tenant_id = $1');
    expect(calls[0].text).not.toContain('DROP TABLE');
    expect(calls[0].values).toEqual([
      'tenant_safe',
      'sku',
      "1001'); DROP TABLE commerce_daily_metrics; --",
      "1001'); DROP TABLE commerce\\_daily\\_metrics; --%",
      12,
    ]);
  });

  it('orders the complete grouped result in PostgreSQL before applying the limit', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string, values = []) {
        calls.push({ text, values });
        if (text.includes('commerce_tenant_data_status')) {
          return {
            rows: [{ available_metrics: ['gmv'] }] as unknown as Row[],
            rowCount: 1,
          };
        }
        return {
          rows: [{
            key: 'SKU-1001',
            current_present: true,
            baseline_present: true,
            current_value: 100,
            baseline_value: 80,
            absolute_change: 20,
            percent_change: 0.25,
          }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };
    const repository = new PostgresCommerceAnalyticsRepository(client);

    await expect(repository.breakdown('tenant_safe', {
      current: { start: '2026-07-01', end: '2026-07-31' },
      baseline: { start: '2026-06-01', end: '2026-06-30' },
      metric: 'gmv',
      dimension: 'sku',
      filters: { regions: [], channels: [], skus: [], categories: [] },
      limit: 12,
      sort: 'absolute_change_desc',
    })).resolves.toEqual([{
      key: 'SKU-1001',
      currentPresent: true,
      baselinePresent: true,
      current: 100,
      baseline: 80,
      absoluteChange: 20,
      percentChange: 0.25,
    }]);

    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain('ORDER BY ABS(current_value - baseline_value) DESC');
    expect(calls[1].text).toContain('COALESCE');
    expect(calls[1].text).toContain('baseline_present');
    expect(calls[1].text).not.toContain('LIMIT 500');
    expect(calls[1].values.at(-1)).toBe(12);
  });

  it('publishes only metrics derivable from the tenant raw metric coverage', async () => {
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string) {
        if (text.includes('commerce_tenant_data_status')) {
          return {
            rows: [{
              start_date: '2026-08-01',
              end_date: '2026-08-01',
              last_ingested_at: '2026-08-01T12:00:00.000Z',
              row_count: 2,
              available_metrics: SHOPIFY_METRICS,
            }] as unknown as Row[],
            rowCount: 1,
          };
        }
        return { rows: [] as Row[], rowCount: 0 };
      },
    };

    const catalog = await new PostgresCommerceAnalyticsRepository(client).getCatalog('tenant_shopify');
    expect(catalog.metrics.map((metric) => metric.id)).toEqual([
      'gmv',
      'net_revenue',
      'paid_orders',
      'units',
      'average_order_value',
      'refund_amount',
    ]);
  });

  it('fails closed before querying facts for a metric the source does not provide', async () => {
    const calls: string[] = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string) {
        calls.push(text);
        return {
          rows: [{ available_metrics: SHOPIFY_METRICS }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };

    const repository = new PostgresCommerceAnalyticsRepository(client);
    await expect(repository.trend('tenant_shopify', {
      range: { start: '2026-08-01', end: '2026-08-01' },
      metric: 'visits',
      grain: 'day',
      filters: { regions: [], channels: [], skus: [], categories: [] },
    })).rejects.toMatchObject({
      name: CommerceMetricUnavailableError.name,
      code: 'COMMERCE_METRIC_UNAVAILABLE',
      metrics: ['visits'],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('commerce_daily_metrics');
  });
});

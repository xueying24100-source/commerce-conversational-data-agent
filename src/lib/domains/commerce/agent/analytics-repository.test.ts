import { describe, expect, it } from 'vitest';

import type { CommerceSqlClient } from './database';
import {
  commerceMetricDefinitions,
  CommerceDataRangeIncompleteError,
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
      async query<Row extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });
        if (text.includes('commerce_tenant_data_status')) {
          return {
            rows: [{
              available_metrics: ['gmv', 'paid_orders', 'visits'],
            }] as unknown as Row[],
            rowCount: 1,
          };
        }
        if (text.includes('commerce_tenant_data_partitions')) {
          return { rows: [{ missing_dates: [] }] as unknown as Row[], rowCount: 1 };
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

    expect(calls).toHaveLength(3);
    expect(calls[2].text).toContain('tenant_id = $1');
    expect(calls[2].text).toContain('region = ANY($4::text[])');
    expect(calls[2].text).toContain('SELECT gmv, paid_orders, visits');
    expect(calls[2].text).not.toContain('SELECT *');
    expect(calls[2].text).not.toContain('DROP TABLE');
    expect(calls[2].values[0]).toBe('tenant_safe');
    expect(calls[2].values[3]).toEqual(["华东'); DROP TABLE commerce_daily_metrics; --"]);
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
        if (text.includes('commerce_tenant_data_partitions')) {
          return { rows: [{ missing_dates: [] }] as unknown as Row[], rowCount: 1 };
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

    expect(calls).toHaveLength(3);
    expect(calls[2].text).toContain('ORDER BY ABS(current_value - baseline_value) DESC');
    expect(calls[2].text).toContain('COALESCE');
    expect(calls[2].text).toContain('baseline_present');
    expect(calls[2].text).not.toContain('LIMIT 500');
    expect(calls[2].values.at(-1)).toBe(12);
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

  it('fails closed before querying facts when a current or baseline date is incomplete', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string, values = []) {
        calls.push({ text, values });
        if (text.includes('commerce_tenant_data_status')) {
          return { rows: [{ available_metrics: ['gmv'] }] as unknown as Row[], rowCount: 1 };
        }
        if (text.includes('commerce_tenant_data_partitions')) {
          return {
            rows: [{ missing_dates: ['2026-06-02'] }] as unknown as Row[],
            rowCount: 1,
          };
        }
        return { rows: [{ gmv: 999 }] as unknown as Row[], rowCount: 1 };
      },
    };

    await expect(new PostgresCommerceAnalyticsRepository(client).compareMetrics(
      'tenant_incomplete',
      {
        current: { start: '2026-07-01', end: '2026-07-02' },
        baseline: { start: '2026-06-01', end: '2026-06-02' },
        metrics: ['gmv'],
        filters: { regions: [], channels: [], skus: [], categories: [] },
      },
    )).rejects.toMatchObject({
      name: CommerceDataRangeIncompleteError.name,
      code: 'COMMERCE_DATA_RANGE_INCOMPLETE',
      missingDates: ['2026-06-02'],
    });

    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain('generate_series');
    expect(calls[1].values).toEqual([
      'tenant_incomplete',
      '2026-07-01',
      '2026-07-02',
      '2026-06-01',
      '2026-06-02',
    ]);
    expect(calls.some((call) => call.text.includes('commerce_daily_metrics'))).toBe(false);
  });

  it('accepts a ready zero-row date because completeness does not require positive fact rows', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string, values = []) {
        calls.push({ text, values });
        if (text.includes('commerce_tenant_data_status')) {
          return { rows: [{ available_metrics: ['gmv'] }] as unknown as Row[], rowCount: 1 };
        }
        if (text.includes('commerce_tenant_data_partitions')) {
          return { rows: [{ missing_dates: [] }] as unknown as Row[], rowCount: 1 };
        }
        return { rows: [{ gmv: 300 }] as unknown as Row[], rowCount: 1 };
      },
    };

    await expect(new PostgresCommerceAnalyticsRepository(client).compareMetrics(
      'tenant_zero_day',
      {
        current: { start: '2026-07-01', end: '2026-07-03' },
        metrics: ['gmv'],
        filters: { regions: [], channels: [], skus: [], categories: [] },
      },
    )).resolves.toMatchObject({ current: { gmv: 300 } });

    expect(calls[1].text).not.toContain('fact_row_count');
    expect(calls[2].text).toContain('commerce_daily_metrics');
  });

  it('publishes machine-readable additivity and aggregation contracts', () => {
    const definitions = Object.fromEntries(
      commerceMetricDefinitions().map((definition) => [definition.id, definition]),
    );

    expect(definitions.paid_orders).toMatchObject({
      aggregation: 'sum',
      additivity: 'source_allocated_additive',
      additiveDimensions: ['region', 'channel', 'sku', 'category'],
    });
    expect(definitions.conversion_rate).toMatchObject({
      aggregation: 'ratio_of_sums',
      additivity: 'non_additive',
      additiveDimensions: [],
    });
    expect(definitions.ending_inventory).toMatchObject({
      aggregation: 'average_daily_total',
      additivity: 'semi_additive_time',
    });
  });

  it('aggregates inventory by day before averaging totals, breakdowns, and trends', async () => {
    const calls: string[] = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string) {
        calls.push(text);
        if (text.includes('commerce_tenant_data_status')) {
          return {
            rows: [{ available_metrics: ['ending_inventory'] }] as unknown as Row[],
            rowCount: 1,
          };
        }
        if (text.includes('commerce_tenant_data_partitions')) {
          return { rows: [{ missing_dates: [] }] as unknown as Row[], rowCount: 1 };
        }
        if (text.includes('grouped_metrics')) {
          return {
            rows: [{
              key: 'SKU-1', current_present: true, baseline_present: null,
              current_value: 15, baseline_value: null,
              absolute_change: null, percent_change: null,
            }] as unknown as Row[],
            rowCount: 1,
          };
        }
        if (text.includes('bucket')) {
          return { rows: [{ bucket: '2026-07-01', value: 15 }] as unknown as Row[], rowCount: 1 };
        }
        return { rows: [{ ending_inventory: 15 }] as unknown as Row[], rowCount: 1 };
      },
    };
    const repository = new PostgresCommerceAnalyticsRepository(client);
    const filters = { regions: [], channels: [], skus: [], categories: [] };
    const range = { start: '2026-07-01', end: '2026-07-02' };

    await repository.compareMetrics('tenant_inventory', {
      current: range, metrics: ['ending_inventory'], filters,
    });
    await repository.breakdown('tenant_inventory', {
      current: range,
      metric: 'ending_inventory',
      dimension: 'sku',
      filters,
      limit: 5,
      sort: 'current_desc',
    });
    await repository.trend('tenant_inventory', {
      range, metric: 'ending_inventory', grain: 'month', filters,
    });

    const factQueries = calls.filter((text) => text.includes('commerce_daily_metrics'));
    expect(factQueries).toHaveLength(3);
    expect(factQueries[0]).toContain('SELECT metric_date, SUM(ending_inventory)');
    expect(factQueries[0]).toContain('AVG(daily_value)');
    expect(factQueries[1]).toContain('GROUP BY sku, metric_date');
    expect(factQueries[1]).toContain('AVG(daily_value) FILTER');
    expect(factQueries[2]).toContain('GROUP BY 1, metric_date');
    expect(factQueries[2]).toContain('AVG(daily_value)');
  });

  it('aggregates inventory risk per SKU-day before taking the cross-day minimum', async () => {
    const calls: string[] = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string) {
        calls.push(text);
        if (text.includes('commerce_tenant_data_status')) {
          return {
            rows: [{ available_metrics: ['stockout_hours', 'ending_inventory'] }] as unknown as Row[],
            rowCount: 1,
          };
        }
        if (text.includes('commerce_tenant_data_partitions')) {
          return { rows: [{ missing_dates: [] }] as unknown as Row[], rowCount: 1 };
        }
        return {
          rows: [{
            sku: 'SKU-RISK',
            category: 'Apparel',
            stockout_hours: 10,
            minimum_ending_inventory: 12,
            last_source_update: '2026-07-02T12:00:00.000Z',
          }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };

    await expect(new PostgresCommerceAnalyticsRepository(client).inventoryRisk(
      'tenant_inventory_risk',
      {
        range: { start: '2026-07-01', end: '2026-07-02' },
        filters: { regions: [], channels: [], skus: [], categories: [] },
        limit: 10,
      },
    )).resolves.toMatchObject([{
      sku: 'SKU-RISK',
      stockoutHours: 10,
      minimumEndingInventory: 12,
    }]);

    const factQuery = calls.find((text) => text.includes('commerce_daily_metrics')) ?? '';
    expect(factQuery).toContain('GROUP BY sku, metric_date');
    expect(factQuery).toContain('SUM(ending_inventory)');
    expect(factQuery).toContain('MIN(daily_ending_inventory)');
  });

  it('returns a field-level data health report and accepts a proof-backed zero-fact partition', async () => {
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(text: string) {
        if (text.includes('SELECT data_mode, source_updated_at, available_metrics')) {
          return {
            rows: [{
              data_mode: 'snapshot',
              source_updated_at: '2026-07-02T00:00:00.000Z',
              available_metrics: ['visits', 'paid_orders', 'gmv'],
            }] as unknown as Row[],
            rowCount: 1,
          };
        }
        if (text.includes('WITH required_dates AS')) {
          return {
            rows: [{
              partition_date: '2026-07-01',
              completeness_state: 'ready',
              fact_row_count: 0,
              source_updated_at: '2026-07-02T00:00:00.000Z',
              coverage_proof_kind: 'connector_coverage_intersection',
              coverage_connector_ids: ['fixture'],
              coverage_run_ids: ['run_fixture'],
            }] as unknown as Row[],
            rowCount: 1,
          };
        }
        if (text.includes('COUNT(*)::bigint AS total_rows')) {
          return {
            rows: [{
              total_rows: 0, region_rows: 0, channel_rows: 0, sku_rows: 0, category_rows: 0,
            }] as unknown as Row[],
            rowCount: 1,
          };
        }
        if (text.includes('SELECT DISTINCT dimension')) {
          return {
            rows: ['region', 'channel', 'sku', 'category'].map((dimension) => ({ dimension })) as unknown as Row[],
            rowCount: 4,
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      },
    };

    const report = await new PostgresCommerceAnalyticsRepository(client).inspectDataHealth(
      'tenant_health',
      {
        range: { start: '2026-07-01', end: '2026-07-01' },
        requiredMetrics: ['gmv', 'paid_orders', 'visits', 'conversion_rate', 'average_order_value'],
        requiredDimensions: ['channel', 'region'],
        requireProductDimension: true,
        optionalMetrics: [],
      },
    );

    expect(report).toMatchObject({
      status: 'ready',
      analysisAllowed: true,
      actionAllowed: true,
      sourceReliability: 'high',
      partitions: [{ date: '2026-07-01', state: 'ready', factRowCount: 0 }],
    });
  });

  it('scans the current week against four independently aggregated complete weeks', async () => {
    const calls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client: CommerceSqlClient = {
      async query<Row extends Record<string, unknown>>(
        text: string,
        values: readonly unknown[] = [],
      ) {
        calls.push({ text, values });
        if (text.includes('SELECT available_metrics FROM commerce_tenant_data_status')) {
          return {
            rows: [{ available_metrics: ['visits', 'paid_orders', 'gmv'] }] as unknown as Row[],
            rowCount: 1,
          };
        }
        if (text.includes('WITH requested_ranges')) {
          return { rows: [{ missing_dates: [] }] as unknown as Row[], rowCount: 1 };
        }
        if (text.includes('GROUP BY metric_date') && text.includes('COALESCE(SUM(visits), 0) = 0')) {
          return {
            rows: [{ metric_date: '2026-07-08' }] as unknown as Row[],
            rowCount: 1,
          };
        }
        const isCurrent = values.includes('2026-07-06');
        const baselineIndex = [
          '2026-06-29', '2026-06-22', '2026-06-15', '2026-06-08',
        ].findIndex((start) => values.includes(start));
        const visits = isCurrent ? 700 : 1_000 + Math.max(0, baselineIndex) * 5;
        const paidOrders = visits * 0.1;
        return {
          rows: [{
            visits,
            paid_orders: paidOrders,
            conversion_rate: 0.1,
            average_order_value: 100,
            gmv: paidOrders * 100,
          }] as unknown as Row[],
          rowCount: 1,
        };
      },
    };

    const scan = await new PostgresCommerceAnalyticsRepository(client).scanWeeklyKpis(
      'tenant_scan',
      {
        current: { start: '2026-07-06', end: '2026-07-12' },
        metrics: ['gmv', 'paid_orders', 'visits', 'conversion_rate', 'average_order_value'],
        filters: { regions: [], channels: [], skus: [], categories: [] },
      },
    );

    expect(scan.baselineWeeks).toHaveLength(4);
    expect(scan.signals.find((signal) => signal.metric === 'visits')).toMatchObject({
      direction: 'down',
      anomalous: true,
    });
    expect(scan.zeroActivityDates).toEqual(['2026-07-08']);
    expect(calls.filter((call) => call.text.includes('WITH scoped AS MATERIALIZED'))).toHaveLength(5);
  });
});

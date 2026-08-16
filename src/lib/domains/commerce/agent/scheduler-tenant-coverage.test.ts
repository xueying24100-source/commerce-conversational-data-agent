import { describe, expect, it } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import { readCommerceSchedulerTenantCoverage } from './scheduler-tenant-coverage';
import { eligibleCommerceWeeklyDiagnosisWindows } from './weekly-diagnosis-scheduler';

function result(rows: Record<string, unknown>[] = []): CommerceQueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length };
}

class TenantScopedAnalytics implements CommerceDatabase {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  private tenantId: string | null = null;

  constructor(private readonly rows: Record<string, unknown>[]) {}

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    this.calls.push({ text, values });
    if (text.includes("set_config('commerce.tenant_id'")) {
      this.tenantId = String(values[0]);
      return Promise.resolve(result() as CommerceQueryResult<Row>);
    }
    expect(this.tenantId).toBe('tenant-a');
    return Promise.resolve(result(this.rows) as CommerceQueryResult<Row>);
  }

  async transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    this.tenantId = null;
    return work(this);
  }

  async ping(): Promise<void> {}
}

describe('scheduler tenant coverage', () => {
  it('sets tenant-local RLS context and uses the minimum required-source coverage', async () => {
    const analytics = new TenantScopedAnalytics([
      {
        business_timezone: 'Asia/Shanghai', published_coverage_end: '2026-08-12',
        connector_id: 'orders', source_coverage_end: '2026-08-10',
      },
      {
        business_timezone: 'Asia/Shanghai', published_coverage_end: '2026-08-12',
        connector_id: 'ads', source_coverage_end: '2026-08-07',
      },
    ]);

    await expect(readCommerceSchedulerTenantCoverage(analytics, 'tenant-a')).resolves.toEqual({
      tenantId: 'tenant-a',
      timezone: 'Asia/Shanghai',
      coverageEnd: '2026-08-07',
      requiredSourceCount: 2,
    });
    expect(analytics.calls[0]).toEqual({
      text: "SELECT set_config('commerce.tenant_id', $1, true)",
      values: ['tenant-a'],
    });
    expect(analytics.calls[1]?.text).toContain('MAX(source_coverage.partition_date)');
    expect(analytics.calls[1]?.text).not.toContain('source_updated_at');
  });

  it('keeps old data refreshed today unready and fails closed when a required source has no proof', async () => {
    const oldButRefreshedToday = new TenantScopedAnalytics([
      {
        business_timezone: 'Asia/Shanghai', published_coverage_end: '2026-08-10',
        connector_id: 'orders', source_coverage_end: '2026-08-10',
        source_updated_at: '2026-08-16T23:59:59.000Z',
      },
      {
        business_timezone: 'Asia/Shanghai', published_coverage_end: '2026-08-10',
        connector_id: 'ads', source_coverage_end: '2026-08-07',
        source_updated_at: '2026-08-16T23:59:59.000Z',
      },
    ]);
    const coverage = await readCommerceSchedulerTenantCoverage(oldButRefreshedToday, 'tenant-a');
    expect(coverage?.coverageEnd).toBe('2026-08-07');
    const windows = eligibleCommerceWeeklyDiagnosisWindows({
      tenantId: 'tenant-a',
      now: new Date('2026-08-11T00:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      coverageEnd: coverage!.coverageEnd,
    });
    expect(windows.runnable.some((window) => window.weekStart === '2026-08-03')).toBe(false);

    const missingProof = new TenantScopedAnalytics([
      {
        business_timezone: 'Asia/Shanghai', published_coverage_end: '2026-08-10',
        connector_id: 'orders', source_coverage_end: '2026-08-10',
      },
      {
        business_timezone: 'Asia/Shanghai', published_coverage_end: '2026-08-10',
        connector_id: 'ads', source_coverage_end: null,
      },
    ]);
    await expect(readCommerceSchedulerTenantCoverage(missingProof, 'tenant-a')).resolves.toBeNull();
  });
});

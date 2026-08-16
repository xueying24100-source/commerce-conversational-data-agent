import type { CommerceDatabase } from './database';

interface RequiredSourceCoverageRow extends Record<string, unknown> {
  business_timezone: string;
  published_coverage_end: unknown;
  connector_id: string;
  source_coverage_end: unknown;
}

export interface CommerceSchedulerTenantCoverage {
  tenantId: string;
  timezone: string;
  coverageEnd: string;
  requiredSourceCount: number;
}

export function commerceCoverageDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isFinite(value.getTime())) return null;
  const candidate = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

/**
 * Reads serving coverage behind FORCE RLS. A checkpoint row is the registry of a source that
 * participates in the published tenant dataset; every registered source must prove a date.
 * Connector retirement therefore removes its checkpoint instead of silently ignoring it here.
 */
export function readCommerceSchedulerTenantCoverage(
  analytics: CommerceDatabase,
  tenantId: string,
): Promise<CommerceSchedulerTenantCoverage | null> {
  return analytics.transaction(async (client) => {
    await client.query("SELECT set_config('commerce.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<RequiredSourceCoverageRow>(
      `SELECT status.business_timezone,
              status.coverage_end AS published_coverage_end,
              required_source.connector_id,
              MAX(source_coverage.partition_date) AS source_coverage_end
       FROM commerce_tenant_data_status AS status
       JOIN commerce_connector_checkpoints AS required_source
         ON required_source.tenant_id = status.tenant_id
       LEFT JOIN commerce_connector_date_coverage AS source_coverage
         ON source_coverage.tenant_id = required_source.tenant_id
        AND source_coverage.connector_id = required_source.connector_id
       WHERE status.tenant_id = $1
       GROUP BY status.business_timezone, status.coverage_end,
                required_source.connector_id
       ORDER BY required_source.connector_id`,
      [tenantId],
    );
    if (!result.rows.length) return null;

    const publishedCoverageEnd = commerceCoverageDate(result.rows[0]?.published_coverage_end);
    const timezone = result.rows[0]?.business_timezone?.trim();
    const sourceCoverageEnds = result.rows.map((row) => commerceCoverageDate(row.source_coverage_end));
    if (!publishedCoverageEnd || !timezone || sourceCoverageEnds.some((date) => !date)) return null;
    const completeSourceCoverageEnds = sourceCoverageEnds as string[];

    return {
      tenantId,
      timezone,
      coverageEnd: [publishedCoverageEnd, ...completeSourceCoverageEnds]
        .reduce((minimum, date) => date < minimum ? date : minimum),
      requiredSourceCount: result.rows.length,
    };
  });
}

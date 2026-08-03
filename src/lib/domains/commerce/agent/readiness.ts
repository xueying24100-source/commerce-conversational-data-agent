import {
  commerceConfigurationStatus,
  getCommerceAgentRuntimeConfig,
} from './config';
import {
  getCommerceAnalyticsDatabase,
  getCommerceControlDatabase,
} from './database';

export interface CommerceReadinessChecks {
  configuration: boolean;
  controlSchema: boolean;
  workerActive: boolean;
  analyticsSchema: boolean;
  analyticsReadOnly: boolean;
  analyticsRls: boolean;
  analyticsDataPresent: boolean | null;
  analyticsDataFresh: boolean | null;
  analyticsSourceFresh: boolean | null;
}

export interface CommerceReadinessDataStatus {
  dataMode: 'snapshot' | 'incremental';
  coverageStart: string | null;
  coverageEnd: string | null;
  lastIngestedAt: string | null;
  sourceUpdatedAt: string | null;
}

export async function checkCommerceReadiness(tenantId?: string) {
  const configuration = commerceConfigurationStatus();
  const runtimeConfig = getCommerceAgentRuntimeConfig();
  const checks: CommerceReadinessChecks = {
    configuration: configuration.ready,
    controlSchema: false,
    workerActive: false,
    analyticsSchema: false,
    analyticsReadOnly: false,
    analyticsRls: false,
    analyticsDataPresent: tenantId ? false : null,
    analyticsDataFresh: tenantId ? false : null,
    analyticsSourceFresh: tenantId ? false : null,
  };
  const dataState = { current: null as CommerceReadinessDataStatus | null };
  if (configuration.databaseConfigured) {
    await getCommerceControlDatabase().query<{ ready: boolean; worker_ready: boolean }>(
      `SELECT
         to_regclass('commerce_agent_conversations') IS NOT NULL
         AND to_regclass('commerce_agent_messages') IS NOT NULL
         AND to_regclass('commerce_agent_runs') IS NOT NULL
         AND to_regclass('commerce_agent_evidence') IS NOT NULL
         AND to_regclass('commerce_agent_rate_limits') IS NOT NULL
         AND to_regclass('commerce_agent_jobs') IS NOT NULL
         AND to_regclass('commerce_agent_job_events') IS NOT NULL
         AND to_regclass('commerce_agent_workers') IS NOT NULL
         AND to_regclass('commerce_agent_runs_request_idx') IS NOT NULL
         AND to_regclass('commerce_agent_one_active_user_turn_idx') IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'commerce_agent_runs'
             AND column_name = 'request_sha256'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'commerce_agent_runs'
             AND column_name = 'lease_expires_at'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'commerce_agent_evidence'
             AND column_name = 'request_json'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'commerce_agent_evidence'
             AND column_name = 'source_watermark'
         )
         AND current_setting('default_transaction_read_only')::boolean = false AS ready,
         EXISTS (
           SELECT 1 FROM commerce_agent_workers
           WHERE status = 'running'
             AND heartbeat_at >= clock_timestamp() - ($1::integer * INTERVAL '1 millisecond')
         ) AS worker_ready`,
      [runtimeConfig.workerStaleMs],
    ).then((result) => {
      checks.controlSchema = result.rows[0]?.ready === true;
      checks.workerActive = result.rows[0]?.worker_ready === true;
    }, () => undefined);
  }
  if (configuration.analyticsConfigured) {
    await getCommerceAnalyticsDatabase().transaction(async (client) => {
      await client.query(
        `SELECT set_config('commerce.tenant_id', $1, true)`,
        [tenantId ?? ''],
      );
      return client.query<{
        table_ready: boolean;
        session_read_only: boolean;
        rls_ready: boolean;
        role_bypasses_rls: boolean;
        data_present: boolean;
        coverage_start: unknown;
        coverage_end: unknown;
        last_ingested_at: unknown;
        source_updated_at: unknown;
        data_mode: unknown;
      }>(
        `SELECT
           to_regclass('commerce_daily_metrics') IS NOT NULL
           AND to_regclass('commerce_tenant_data_status') IS NOT NULL
           AND to_regclass('commerce_entity_catalog') IS NOT NULL AS table_ready,
           current_setting('default_transaction_read_only')::boolean AS session_read_only,
           (
             SELECT COUNT(*) = 3 AND BOOL_AND(relrowsecurity AND relforcerowsecurity)
             FROM pg_class
             WHERE oid = ANY(ARRAY[
               to_regclass('commerce_daily_metrics'),
               to_regclass('commerce_tenant_data_status'),
               to_regclass('commerce_entity_catalog')
             ])
           ) AS rls_ready,
           COALESCE((
             SELECT rolbypassrls OR rolsuper
             FROM pg_roles
             WHERE rolname = current_user
           ), true) AS role_bypasses_rls,
           CASE WHEN $1::text IS NULL THEN NULL ELSE EXISTS (
             SELECT 1 FROM commerce_tenant_data_status
             WHERE tenant_id = $1 AND fact_row_count > 0
           ) END AS data_present,
           CASE WHEN $1::text IS NULL THEN NULL ELSE (
             SELECT MIN(coverage_start)::text FROM commerce_tenant_data_status
             WHERE tenant_id = $1
           ) END AS coverage_start,
           CASE WHEN $1::text IS NULL THEN NULL ELSE (
             SELECT MAX(coverage_end)::text FROM commerce_tenant_data_status
             WHERE tenant_id = $1
           ) END AS coverage_end,
           CASE WHEN $1::text IS NULL THEN NULL ELSE (
             SELECT MAX(last_ingested_at) FROM commerce_tenant_data_status
             WHERE tenant_id = $1
           ) END AS last_ingested_at,
           CASE WHEN $1::text IS NULL THEN NULL ELSE (
             SELECT MAX(source_updated_at) FROM commerce_tenant_data_status
             WHERE tenant_id = $1
           ) END AS source_updated_at,
           CASE WHEN $1::text IS NULL THEN NULL ELSE (
             SELECT MIN(data_mode) FROM commerce_tenant_data_status
             WHERE tenant_id = $1
           ) END AS data_mode`,
        [tenantId ?? null],
      );
    }).then((result) => {
      const row = result.rows[0];
      checks.analyticsSchema = row?.table_ready === true;
      checks.analyticsReadOnly = row?.session_read_only === true;
      checks.analyticsRls = row?.rls_ready === true
        && (process.env.NODE_ENV !== 'production' || row?.role_bypasses_rls !== true);
      if (tenantId) {
        checks.analyticsDataPresent = row?.data_present === true;
        const lastIngested = row?.last_ingested_at
          ? new Date(String(row.last_ingested_at)).getTime()
          : Number.NaN;
        checks.analyticsDataFresh = Number.isFinite(lastIngested)
          && Date.now() - lastIngested <= runtimeConfig.maxDataAgeHours * 3_600_000;
        const sourceUpdated = row?.source_updated_at
          ? new Date(String(row.source_updated_at)).getTime()
          : Number.NaN;
        const dataMode = row?.data_mode === 'incremental' ? 'incremental' : 'snapshot';
        checks.analyticsSourceFresh = dataMode === 'snapshot'
          ? null
          : Number.isFinite(sourceUpdated)
            && Date.now() - sourceUpdated <= runtimeConfig.maxDataAgeHours * 3_600_000;
        dataState.current = {
          dataMode,
          coverageStart: row?.coverage_start ? String(row.coverage_start) : null,
          coverageEnd: row?.coverage_end ? String(row.coverage_end) : null,
          lastIngestedAt: Number.isFinite(lastIngested)
            ? new Date(lastIngested).toISOString()
            : null,
          sourceUpdatedAt: Number.isFinite(sourceUpdated)
            ? new Date(sourceUpdated).toISOString()
            : null,
        };
      }
    }, () => undefined);
  }
  const issues = [...configuration.issues];
  if (configuration.databaseConfigured && !checks.controlSchema) {
    issues.push('控制库不可用、非可写会话或尚未执行 control migration。');
  }
  if (configuration.databaseConfigured && checks.controlSchema && !checks.workerActive) {
    issues.push('没有活跃的 Commerce Agent Worker 心跳。');
  }
  if (configuration.analyticsConfigured && !checks.analyticsSchema) {
    issues.push('分析库不可用或尚未执行 analytics migration。');
  }
  if (configuration.analyticsConfigured && checks.analyticsSchema && !checks.analyticsReadOnly) {
    issues.push('分析库运行连接没有启用只读会话。');
  }
  if (configuration.analyticsConfigured && checks.analyticsSchema && !checks.analyticsRls) {
    issues.push('分析库未强制 tenant RLS，或生产分析角色具有 RLS 绕过权限。');
  }
  if (
    tenantId
    && configuration.analyticsConfigured
    && checks.analyticsSchema
    && !checks.analyticsDataPresent
  ) {
    issues.push('分析库尚无 commerce_daily_metrics 经营事实。');
  }
  if (
    tenantId
    &&
    configuration.analyticsConfigured
    && checks.analyticsDataPresent
    && !checks.analyticsDataFresh
  ) {
    issues.push(`分析数据超过 ${runtimeConfig.maxDataAgeHours} 小时未更新。`);
  }
  if (
    tenantId
    && checks.analyticsDataPresent
    && dataState.current?.dataMode === 'incremental'
    && !checks.analyticsSourceFresh
  ) {
    issues.push(`增量数据源水位超过 ${runtimeConfig.maxDataAgeHours} 小时未更新。`);
  }
  const warnings: string[] = [];
  if (tenantId && checks.analyticsDataPresent && dataState.current?.dataMode === 'snapshot') {
    const coverage = dataState.current.coverageStart && dataState.current.coverageEnd
      ? `${dataState.current.coverageStart} 至 ${dataState.current.coverageEnd}`
      : '未知覆盖范围';
    warnings.push(`当前租户使用固定历史快照（${coverage}），可用于离线分析，但不代表实时店铺状态。`);
  }
  const requiredChecks = [
    checks.configuration,
    checks.controlSchema,
    checks.workerActive,
    checks.analyticsSchema,
    checks.analyticsReadOnly,
    checks.analyticsRls,
    ...(tenantId ? [checks.analyticsDataPresent, checks.analyticsDataFresh] : []),
    ...(tenantId && dataState.current?.dataMode === 'incremental'
      ? [checks.analyticsSourceFresh]
      : []),
  ];
  return {
    ready: requiredChecks.every((check) => check === true),
    scope: tenantId ? 'tenant' as const : 'platform' as const,
    checks,
    issues,
    warnings,
    dataStatus: dataState.current,
    configuration,
  };
}

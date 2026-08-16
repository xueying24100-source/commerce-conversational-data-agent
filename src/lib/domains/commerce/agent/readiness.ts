import {
  commerceConfigurationStatus,
  getCommerceAgentRuntimeConfig,
} from './config';
import {
  getCommerceAnalyticsDatabase,
  getCommerceControlDatabase,
} from './database';
import { commerceMetricDefinitions } from './analytics-repository';
import type { CommerceMetric } from './types';

export interface CommerceReadinessChecks {
  configuration: boolean;
  controlSchema: boolean;
  workerActive: boolean;
  analyticsSchema: boolean;
  analyticsReadOnly: boolean;
  analyticsRls: boolean;
  analyticsDataPresent: boolean | null;
  analyticsPartitionsComplete: boolean | null;
  analyticsDataFresh: boolean | null;
  analyticsSourceFresh: boolean | null;
}

export interface CommerceReadinessDataStatus {
  dataMode: 'snapshot' | 'incremental';
  snapshotVerified: boolean | null;
  coverageStart: string | null;
  coverageEnd: string | null;
  businessTimezone: string | null;
  currencyCode: string | null;
  availableMetrics: CommerceMetric[];
  lastIngestedAt: string | null;
  sourceUpdatedAt: string | null;
  sourceDisclosure: {
    sourceKind: 'public_snapshot';
    sourceId: string;
    sourceUri: string;
    sourceRevision: string;
    licenseId: string;
    fixtureSeed: number | null;
    generatedFields: string[];
  } | null;
}

function publicSourceDisclosure(value: unknown): CommerceReadinessDataStatus['sourceDisclosure'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.sourceKind !== 'public_snapshot') return null;
  const required = ['sourceId', 'sourceUri', 'sourceRevision', 'licenseId'] as const;
  if (required.some((key) => typeof record[key] !== 'string' || !record[key])) return null;
  return {
    sourceKind: 'public_snapshot',
    sourceId: String(record.sourceId),
    sourceUri: String(record.sourceUri),
    sourceRevision: String(record.sourceRevision),
    licenseId: String(record.licenseId),
    fixtureSeed: typeof record.fixtureSeed === 'number' && Number.isSafeInteger(record.fixtureSeed)
      ? record.fixtureSeed
      : null,
    generatedFields: Array.isArray(record.generatedFields)
      ? record.generatedFields.filter((field): field is string => typeof field === 'string')
      : [],
  };
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
    analyticsPartitionsComplete: tenantId ? false : null,
    analyticsDataFresh: tenantId ? false : null,
    analyticsSourceFresh: tenantId ? false : null,
  };
  const dataState = { current: null as CommerceReadinessDataStatus | null };
  if (configuration.databaseConfigured) {
    const requiredRevision = process.env.COMMERCE_RELEASE_REVISION || 'unversioned';
    const requiredWorkerId = String(process.env.COMMERCE_WORKER_ID || '').trim() || null;
    // Schema catalogs and the non-tenant Worker heartbeat table are readable by the
    // API role without entering the cross-tenant Worker-only RLS context.
    await getCommerceControlDatabase().query<{
      ready: boolean;
      worker_ready: boolean;
    }>(
      `SELECT
         to_regclass('commerce_agent_conversations') IS NOT NULL
         AND to_regclass('commerce_agent_messages') IS NOT NULL
         AND to_regclass('commerce_agent_runs') IS NOT NULL
         AND to_regclass('commerce_agent_evidence') IS NOT NULL
         AND to_regclass('commerce_agent_rate_limits') IS NOT NULL
         AND to_regclass('commerce_agent_jobs') IS NOT NULL
         AND to_regclass('commerce_agent_job_events') IS NOT NULL
         AND to_regclass('commerce_agent_feedback') IS NOT NULL
         AND to_regclass('commerce_agent_feedback_events') IS NOT NULL
         AND to_regclass('commerce_agent_reports') IS NOT NULL
         AND to_regclass('commerce_agent_report_shares') IS NOT NULL
         AND to_regclass('commerce_agent_action_events') IS NOT NULL
         AND to_regclass('commerce_agent_action_reviews') IS NOT NULL
         AND to_regclass('commerce_agent_workers') IS NOT NULL
         AND to_regclass('commerce_agent_runs_request_idx') IS NOT NULL
         AND to_regclass('commerce_agent_one_active_user_turn_idx') IS NOT NULL
         AND to_regclass('commerce_agent_feedback_idempotency_idx') IS NOT NULL
         AND to_regclass('commerce_agent_feedback_tenant_binding_idx') IS NOT NULL
         AND to_regclass('commerce_agent_feedback_tenant_queue_idx') IS NOT NULL
         AND to_regclass('commerce_agent_feedback_events_idempotency_idx') IS NOT NULL
         AND to_regclass('commerce_agent_reports_message_idx') IS NOT NULL
         AND to_regclass('commerce_agent_reports_owner_binding_idx') IS NOT NULL
         AND to_regclass('commerce_agent_report_shares_token_idx') IS NOT NULL
         AND to_regclass('commerce_agent_report_shares_expiry_idx') IS NOT NULL
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
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'commerce_agent_evidence'
             AND column_name = 'preview_truncated'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'commerce_agent_jobs'
             AND column_name = 'required_revision'
         )
         AND EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'commerce_agent_jobs'
             AND column_name = 'executed_by_worker_id'
         )
         AND (
           SELECT COUNT(*) = 12 AND BOOL_AND(relrowsecurity AND relforcerowsecurity)
           FROM pg_class
           WHERE oid = ANY(ARRAY[
             to_regclass('commerce_agent_conversations'),
             to_regclass('commerce_agent_messages'),
             to_regclass('commerce_agent_runs'),
             to_regclass('commerce_agent_evidence'),
             to_regclass('commerce_agent_jobs'),
             to_regclass('commerce_agent_job_events'),
             to_regclass('commerce_agent_feedback'),
             to_regclass('commerce_agent_feedback_events'),
             to_regclass('commerce_agent_reports'),
             to_regclass('commerce_agent_report_shares'),
             to_regclass('commerce_agent_action_events'),
             to_regclass('commerce_agent_action_reviews')
           ])
         )
         AND current_setting('default_transaction_read_only')::boolean = false AS ready,
         EXISTS (
           SELECT 1 FROM commerce_agent_workers
           WHERE status = 'running'
             AND heartbeat_at >= clock_timestamp() - ($1::integer * INTERVAL '1 millisecond')
             AND revision = $2
             AND ($3::text IS NULL OR id = $3)
         ) AS worker_ready`,
      [runtimeConfig.workerStaleMs, requiredRevision, requiredWorkerId],
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
        partitions_complete: boolean | null;
        coverage_start: unknown;
        coverage_end: unknown;
        last_ingested_at: unknown;
        source_updated_at: unknown;
        data_mode: unknown;
        business_timezone: unknown;
        currency_code: unknown;
        available_metrics: unknown;
        snapshot_verified: boolean | null;
        source_disclosure: unknown;
      }>(
        `SELECT
           to_regclass('commerce_daily_metrics') IS NOT NULL
           AND to_regclass('commerce_tenant_data_status') IS NOT NULL
           AND to_regclass('commerce_tenant_data_partitions') IS NOT NULL
           AND to_regclass('commerce_entity_catalog') IS NOT NULL
           AND to_regclass('commerce_source_snapshots') IS NOT NULL AS table_ready,
           current_setting('default_transaction_read_only')::boolean AS session_read_only,
           (
             SELECT COUNT(*) = 5 AND BOOL_AND(relrowsecurity AND relforcerowsecurity)
             FROM pg_class
             WHERE oid = ANY(ARRAY[
               to_regclass('commerce_daily_metrics'),
               to_regclass('commerce_tenant_data_status'),
               to_regclass('commerce_tenant_data_partitions'),
               to_regclass('commerce_entity_catalog'),
               to_regclass('commerce_source_snapshots')
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
             EXISTS (
               SELECT 1 FROM commerce_tenant_data_status
               WHERE tenant_id = $1
             ) AND NOT EXISTS (
               SELECT 1
               FROM commerce_tenant_data_status AS status
               CROSS JOIN LATERAL generate_series(
                 status.coverage_start,
                 status.coverage_end,
                 INTERVAL '1 day'
               ) AS required(partition_date)
               LEFT JOIN commerce_tenant_data_partitions AS partitions
                 ON partitions.tenant_id = status.tenant_id
                AND partitions.partition_date = required.partition_date::date
               WHERE status.tenant_id = $1
                 AND (
                   partitions.partition_date IS NULL
                   OR partitions.completeness_state <> 'ready'
                 )
             )
           ) END AS partitions_complete,
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
           ) END AS data_mode,
           CASE WHEN $1::text IS NULL THEN NULL ELSE (
             SELECT business_timezone FROM commerce_tenant_data_status
             WHERE tenant_id = $1
           ) END AS business_timezone,
           CASE WHEN $1::text IS NULL THEN NULL ELSE (
             SELECT currency_code FROM commerce_tenant_data_status
             WHERE tenant_id = $1
           ) END AS currency_code,
           CASE WHEN $1::text IS NULL THEN NULL ELSE (
             SELECT available_metrics FROM commerce_tenant_data_status
             WHERE tenant_id = $1
           ) END AS available_metrics,
           CASE WHEN $1::text IS NULL THEN NULL ELSE EXISTS (
             SELECT 1
             FROM commerce_connector_checkpoints AS checkpoint
             JOIN LATERAL (
               SELECT status, source_sha256
               FROM commerce_connector_runs
               WHERE tenant_id = checkpoint.tenant_id
                 AND connector_id = checkpoint.connector_id
               ORDER BY started_at DESC LIMIT 1
             ) AS latest_run ON true
             WHERE checkpoint.tenant_id = $1
               AND checkpoint.data_mode = 'snapshot'
               AND checkpoint.source_fact_state = 'not_applicable'
               AND checkpoint.source_sha256 ~ '^sha256:[0-9a-f]{64}$'
               AND latest_run.status IN ('completed', 'skipped')
               AND latest_run.source_sha256 = checkpoint.source_sha256
           ) END AS snapshot_verified,
           CASE WHEN $1::text IS NULL THEN NULL ELSE (
             SELECT jsonb_build_object(
               'sourceKind', source_kind,
               'sourceId', upstream_source_id,
               'sourceUri', source_uri,
               'sourceRevision', source_revision,
               'licenseId', license ->> 'id',
               'fixtureSeed', fixture_seed,
               'generatedFields', COALESCE(lineage -> 'generatedFields', '[]'::jsonb)
             )
             FROM commerce_source_snapshots
             WHERE tenant_id = $1 AND source_kind = 'public_snapshot'
             ORDER BY ingested_at DESC
             LIMIT 1
           ) END AS source_disclosure`,
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
        checks.analyticsPartitionsComplete = row?.partitions_complete === true;
        const lastIngested = row?.last_ingested_at
          ? new Date(String(row.last_ingested_at)).getTime()
          : Number.NaN;
        const sourceUpdated = row?.source_updated_at
          ? new Date(String(row.source_updated_at)).getTime()
          : Number.NaN;
        const dataMode = row?.data_mode === 'incremental' ? 'incremental' : 'snapshot';
        checks.analyticsDataFresh = dataMode === 'snapshot'
          ? row?.snapshot_verified === true
          : Number.isFinite(lastIngested)
            && Date.now() - lastIngested <= runtimeConfig.maxDataAgeHours * 3_600_000;
        checks.analyticsSourceFresh = dataMode === 'snapshot'
          ? null
          : Number.isFinite(sourceUpdated)
            && Date.now() - sourceUpdated <= runtimeConfig.maxDataAgeHours * 3_600_000;
        dataState.current = {
          dataMode,
          snapshotVerified: dataMode === 'snapshot' ? row?.snapshot_verified === true : null,
          coverageStart: row?.coverage_start ? String(row.coverage_start) : null,
          coverageEnd: row?.coverage_end ? String(row.coverage_end) : null,
          businessTimezone: typeof row?.business_timezone === 'string'
            && row.business_timezone.trim()
            ? row.business_timezone
            : null,
          currencyCode: typeof row?.currency_code === 'string'
            && /^[A-Z]{3}$/u.test(row.currency_code)
            ? row.currency_code
            : null,
          availableMetrics: commerceMetricDefinitions(
            Array.isArray(row?.available_metrics) ? row.available_metrics.map(String) : [],
          ).map((metric) => metric.id),
          lastIngestedAt: Number.isFinite(lastIngested)
            ? new Date(lastIngested).toISOString()
            : null,
          sourceUpdatedAt: Number.isFinite(sourceUpdated)
            ? new Date(sourceUpdated).toISOString()
            : null,
          sourceDisclosure: publicSourceDisclosure(row?.source_disclosure),
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
    && configuration.analyticsConfigured
    && checks.analyticsDataPresent
    && !checks.analyticsPartitionsComplete
  ) {
    issues.push('数据分区完整性尚未验证，存在待回填或缺口分区。');
  }
  if (
    tenantId
    &&
    configuration.analyticsConfigured
    && checks.analyticsDataPresent
    && !checks.analyticsDataFresh
  ) {
    issues.push(dataState.current?.dataMode === 'snapshot'
      ? '固定快照缺少可验证源哈希，或最新 Connector run 未健康完成。'
      : `分析数据超过 ${runtimeConfig.maxDataAgeHours} 小时未更新。`);
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
    ...(tenantId
      ? [checks.analyticsDataPresent, checks.analyticsPartitionsComplete, checks.analyticsDataFresh]
      : []),
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

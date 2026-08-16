#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { loadLocalEnv } = require('./load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

const WRITE_PRIVILEGES = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
const CONTROL_TABLES = [
  'public.commerce_agent_conversations',
  'public.commerce_agent_messages',
  'public.commerce_agent_runs',
  'public.commerce_agent_evidence',
  'public.commerce_agent_rate_limits',
  'public.commerce_agent_model_budget_daily',
  'public.commerce_agent_model_budget_reservations',
  'public.commerce_agent_jobs',
  'public.commerce_agent_job_events',
  'public.commerce_agent_feedback',
  'public.commerce_agent_feedback_events',
  'public.commerce_agent_reports',
  'public.commerce_agent_report_shares',
  'public.commerce_agent_action_events',
  'public.commerce_agent_action_reviews',
  'public.commerce_tenant_members',
  'public.commerce_feishu_notification_outbox',
  'public.commerce_feishu_notification_events',
  'public.commerce_action_review_schedules',
  'public.commerce_weekly_diagnosis_runs',
  'public.commerce_agent_workers',
];
const ANALYTICS_TABLES = [
  'public.commerce_daily_metrics',
  'public.commerce_tenant_data_status',
  'public.commerce_tenant_data_partitions',
  'public.commerce_entity_catalog',
  'public.commerce_connector_source_facts',
  'public.commerce_connector_date_coverage',
  'public.commerce_connector_checkpoints',
  'public.commerce_connector_runs',
];

function requireTablePrivileges(table, privileges) {
  return `SELECT ${privileges.map((privilege) => (
    `has_table_privilege(current_user, '${table}', '${privilege}')`
  )).join(' AND ')} AS ok`;
}

function denyTablePrivileges(table, privileges) {
  return `SELECT ${privileges.map((privilege) => (
    `NOT has_table_privilege(current_user, '${table}', '${privilege}')`
  )).join(' AND ')} AS ok`;
}

function denyWrites(tables) {
  const rows = tables.map((table) => `('${table}')`).join(', ');
  const predicates = WRITE_PRIVILEGES.map((privilege) => (
    `has_table_privilege(current_user, protected.table_name, '${privilege}')`
  )).join(' OR ');
  return `SELECT NOT EXISTS (
    SELECT 1 FROM (VALUES ${rows}) AS protected(table_name)
    WHERE ${predicates}
  ) AS ok`;
}

const noPublicSchemaCreate = (
  "SELECT NOT has_schema_privilege(current_user, 'public', 'CREATE') AS ok"
);

const SPECS = [
  {
    name: 'control_api',
    env: 'COMMERCE_CONTROL_API_DATABASE_URL',
    expectedRole: 'commerce_control_api_user',
    systemRls: 'deny',
    checks: [
      ['control_api_conversations_write', requireTablePrivileges(
        'public.commerce_agent_conversations',
        ['SELECT', 'INSERT', 'UPDATE'],
      )],
      ['control_api_jobs_write', requireTablePrivileges(
        'public.commerce_agent_jobs',
        ['SELECT', 'INSERT', 'UPDATE'],
      )],
      ['control_api_model_budget_write', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_agent_model_budget_daily', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_agent_model_budget_daily', 'INSERT')",
        "has_table_privilege(current_user, 'public.commerce_agent_model_budget_daily', 'UPDATE')",
        "has_table_privilege(current_user, 'public.commerce_agent_model_budget_reservations', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_agent_model_budget_reservations', 'INSERT')",
        "has_table_privilege(current_user, 'public.commerce_agent_model_budget_reservations', 'UPDATE')",
      ].join(' AND ')} AS ok`],
      ['control_api_worker_heartbeat_read_only', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_agent_workers', 'SELECT')",
        ...WRITE_PRIVILEGES.map((privilege) => (
          `NOT has_table_privilege(current_user, 'public.commerce_agent_workers', '${privilege}')`
        )),
      ].join(' AND ')} AS ok`],
      ['control_api_no_system_functions', `SELECT ${[
        "NOT has_function_privilege(current_user, 'public.commerce_reap_expired_jobs()', 'EXECUTE')",
        "NOT has_function_privilege(current_user, 'public.commerce_settle_model_budget(text,bigint,bigint)', 'EXECUTE')",
      ].join(' AND ')} AS ok`],
      ['control_api_metrics_execute', "SELECT has_function_privilege(current_user, 'public.commerce_collect_control_metrics(integer)', 'EXECUTE') AS ok"],
      ['control_api_no_schema_create', noPublicSchemaCreate],
    ],
  },
  {
    name: 'control_worker',
    env: 'COMMERCE_CONTROL_WORKER_DATABASE_URL',
    expectedRole: 'commerce_control_worker_user',
    systemRls: 'allow',
    checks: [
      ['control_jobs_write', requireTablePrivileges(
        'public.commerce_agent_jobs',
        ['SELECT', 'INSERT', 'UPDATE'],
      )],
      ['control_model_budget_daily_write', requireTablePrivileges(
        'public.commerce_agent_model_budget_daily',
        ['SELECT', 'INSERT', 'UPDATE'],
      )],
      ['control_model_budget_reservations_write', requireTablePrivileges(
        'public.commerce_agent_model_budget_reservations',
        ['SELECT', 'INSERT', 'UPDATE'],
      )],
      ['control_tenant_members_read_only', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_tenant_members', 'SELECT')",
        ...WRITE_PRIVILEGES.map((privilege) => (
          `NOT has_table_privilege(current_user, 'public.commerce_tenant_members', '${privilege}')`
        )),
      ].join(' AND ')} AS ok`],
      ['control_feishu_outbox_write', requireTablePrivileges(
        'public.commerce_feishu_notification_outbox',
        ['SELECT', 'INSERT', 'UPDATE'],
      )],
      ['control_feishu_events_append_only', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_feishu_notification_events', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_feishu_notification_events', 'INSERT')",
        "NOT has_table_privilege(current_user, 'public.commerce_feishu_notification_events', 'UPDATE')",
        "NOT has_table_privilege(current_user, 'public.commerce_feishu_notification_events', 'DELETE')",
        "has_sequence_privilege(current_user, 'public.commerce_feishu_notification_events_id_seq', 'USAGE')",
      ].join(' AND ')} AS ok`],
      ['control_review_schedules_write', requireTablePrivileges(
        'public.commerce_action_review_schedules',
        ['SELECT', 'INSERT', 'UPDATE'],
      )],
      ['control_weekly_diagnosis_runs_write', requireTablePrivileges(
        'public.commerce_weekly_diagnosis_runs',
        ['SELECT', 'INSERT', 'UPDATE'],
      )],
      ['control_worker_registry_write', requireTablePrivileges(
        'public.commerce_agent_workers',
        ['SELECT', 'INSERT', 'UPDATE'],
      )],
      ['control_feedback_append_only', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_agent_feedback', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_agent_feedback', 'INSERT')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_feedback', 'UPDATE')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_feedback', 'DELETE')",
      ].join(' AND ')} AS ok`],
      ['control_feedback_events_append_only', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_agent_feedback_events', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_agent_feedback_events', 'INSERT')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_feedback_events', 'UPDATE')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_feedback_events', 'DELETE')",
        "has_sequence_privilege(current_user, 'public.commerce_agent_feedback_events_id_seq', 'USAGE')",
      ].join(' AND ')} AS ok`],
      ['control_feedback_reviewer_sources_select', `SELECT ${[
        'commerce_agent_conversations',
        'commerce_agent_messages',
        'commerce_agent_runs',
        'commerce_agent_evidence',
        'commerce_agent_feedback',
      ].map((table) => (
        `has_table_privilege(current_user, 'public.${table}', 'SELECT')`
      )).join(' AND ')} AS ok`],
      ['control_reports_append_only', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_agent_reports', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_agent_reports', 'INSERT')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_reports', 'UPDATE')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_reports', 'DELETE')",
      ].join(' AND ')} AS ok`],
      ['control_report_shares_mutable', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_agent_report_shares', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_agent_report_shares', 'INSERT')",
        "has_column_privilege(current_user, 'public.commerce_agent_report_shares', 'revoked_at', 'UPDATE')",
        ...['id', 'report_id', 'tenant_id', 'user_id', 'token_sha256', 'expires_at', 'created_at'].map((column) => (
          `NOT has_column_privilege(current_user, 'public.commerce_agent_report_shares', '${column}', 'UPDATE')`
        )),
        "NOT has_table_privilege(current_user, 'public.commerce_agent_report_shares', 'DELETE')",
      ].join(' AND ')} AS ok`],
      ['control_action_events_append_only', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_agent_action_events', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_agent_action_events', 'INSERT')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_action_events', 'UPDATE')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_action_events', 'DELETE')",
        "has_sequence_privilege(current_user, 'public.commerce_agent_action_events_id_seq', 'USAGE')",
      ].join(' AND ')} AS ok`],
      ['control_action_reviews_append_only', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_agent_action_reviews', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_agent_action_reviews', 'INSERT')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_action_reviews', 'UPDATE')",
        "NOT has_table_privilege(current_user, 'public.commerce_agent_action_reviews', 'DELETE')",
      ].join(' AND ')} AS ok`],
      ['control_reap_execute', "SELECT has_function_privilege(current_user, 'public.commerce_reap_expired_jobs()', 'EXECUTE') AS ok"],
      ['control_settle_budget_execute', "SELECT has_function_privilege(current_user, 'public.commerce_settle_model_budget(text,bigint,bigint)', 'EXECUTE') AS ok"],
      ['control_metrics_execute', "SELECT has_function_privilege(current_user, 'public.commerce_collect_control_metrics(integer)', 'EXECUTE') AS ok"],
      ['control_no_schema_create', noPublicSchemaCreate],
    ],
  },
  {
    name: 'analytics_readonly',
    env: 'COMMERCE_ANALYTICS_DATABASE_URL',
    readOnly: true,
    checks: [
      ['analytics_select', "SELECT has_table_privilege(current_user, 'public.commerce_daily_metrics', 'SELECT') AS ok"],
      ['analytics_connector_select', "SELECT has_table_privilege(current_user, 'public.commerce_connector_runs', 'SELECT') AS ok"],
      ['analytics_no_business_writes', denyWrites(ANALYTICS_TABLES)],
      ['analytics_no_catalog_refresh', "SELECT NOT has_function_privilege(current_user, 'public.commerce_refresh_tenant_catalog(text)', 'EXECUTE') AS ok"],
      ['analytics_no_schema_create', noPublicSchemaCreate],
    ],
  },
  {
    name: 'analytics_ingest',
    env: 'COMMERCE_ANALYTICS_INGEST_DATABASE_URL',
    checks: [
      ['analytics_ingest_write', requireTablePrivileges(
        'public.commerce_daily_metrics',
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      )],
      ['analytics_ingest_source_facts_write', requireTablePrivileges(
        'public.commerce_connector_source_facts',
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      )],
      ['catalog_refresh_execute', "SELECT has_function_privilege(current_user, 'public.commerce_refresh_tenant_catalog(text)', 'EXECUTE') AS ok"],
      ['analytics_ingest_no_schema_create', noPublicSchemaCreate],
    ],
  },
  {
    name: 'control_maintenance',
    env: 'COMMERCE_CONTROL_MAINTENANCE_DATABASE_URL',
    checks: [
      ['maintenance_jobs', requireTablePrivileges(
        'public.commerce_agent_jobs',
        ['SELECT', 'UPDATE', 'DELETE'],
      )],
      ['maintenance_job_events_insert', "SELECT has_table_privilege(current_user, 'public.commerce_agent_job_events', 'INSERT') AS ok"],
      ['maintenance_job_events_append_only', denyTablePrivileges(
        'public.commerce_agent_job_events',
        ['SELECT', 'UPDATE', 'DELETE'],
      )],
      ['maintenance_job_events_sequence', "SELECT has_sequence_privilege(current_user, 'public.commerce_agent_job_events_id_seq', 'USAGE') AS ok"],
      ['maintenance_job_events_sequence_limited', `SELECT ${[
        "NOT has_sequence_privilege(current_user, 'public.commerce_agent_job_events_id_seq', 'SELECT')",
        "NOT has_sequence_privilege(current_user, 'public.commerce_agent_job_events_id_seq', 'UPDATE')",
      ].join(' AND ')} AS ok`],
      ['maintenance_feedback_select', "SELECT has_table_privilege(current_user, 'public.commerce_agent_feedback', 'SELECT') AS ok"],
      ['maintenance_report_shares_cleanup', requireTablePrivileges(
        'public.commerce_agent_report_shares',
        ['SELECT', 'DELETE'],
      )],
      ['maintenance_feedback_events_append', requireTablePrivileges(
        'public.commerce_agent_feedback_events',
        ['SELECT', 'INSERT'],
      )],
      ['maintenance_feedback_events_append_only', denyTablePrivileges(
        'public.commerce_agent_feedback_events',
        ['UPDATE', 'DELETE'],
      )],
      ['maintenance_feedback_events_sequence', "SELECT has_sequence_privilege(current_user, 'public.commerce_agent_feedback_events_id_seq', 'USAGE') AS ok"],
      ['maintenance_feedback_events_sequence_limited', `SELECT ${[
        "NOT has_sequence_privilege(current_user, 'public.commerce_agent_feedback_events_id_seq', 'SELECT')",
        "NOT has_sequence_privilege(current_user, 'public.commerce_agent_feedback_events_id_seq', 'UPDATE')",
      ].join(' AND ')} AS ok`],
      ['maintenance_reap_execute', "SELECT has_function_privilege(current_user, 'public.commerce_reap_expired_jobs()', 'EXECUTE') AS ok"],
      ['maintenance_no_metrics_execute', "SELECT NOT has_function_privilege(current_user, 'public.commerce_collect_control_metrics(integer)', 'EXECUTE') AS ok"],
      ['maintenance_no_schema_create', noPublicSchemaCreate],
    ],
  },
  {
    name: 'control_migration',
    env: 'COMMERCE_CONTROL_MIGRATION_DATABASE_URL',
    allowOwnership: true,
    checks: [
      ['control_schema_create', "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS ok"],
    ],
  },
  {
    name: 'analytics_migration',
    env: 'COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL',
    allowOwnership: true,
    checks: [
      ['analytics_schema_create', "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS ok"],
    ],
  },
  {
    name: 'control_backup',
    env: 'COMMERCE_CONTROL_BACKUP_DATABASE_URL',
    readOnly: true,
    requireBypassRls: true,
    checks: [
      ['control_backup_select', "SELECT has_table_privilege(current_user, 'public.commerce_agent_evidence', 'SELECT') AS ok"],
      ['control_backup_feedback_select', "SELECT has_table_privilege(current_user, 'public.commerce_agent_feedback', 'SELECT') AS ok"],
      ['control_backup_feedback_events_select', "SELECT has_table_privilege(current_user, 'public.commerce_agent_feedback_events', 'SELECT') AS ok"],
      ['control_backup_reports_select', "SELECT has_table_privilege(current_user, 'public.commerce_agent_reports', 'SELECT') AS ok"],
      ['control_backup_report_shares_select', "SELECT has_table_privilege(current_user, 'public.commerce_agent_report_shares', 'SELECT') AS ok"],
      ['control_backup_action_events_select', "SELECT has_table_privilege(current_user, 'public.commerce_agent_action_events', 'SELECT') AS ok"],
      ['control_backup_action_reviews_select', "SELECT has_table_privilege(current_user, 'public.commerce_agent_action_reviews', 'SELECT') AS ok"],
      ['control_backup_model_budget_select', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_agent_model_budget_daily', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_agent_model_budget_reservations', 'SELECT')",
      ].join(' AND ')} AS ok`],
      ['control_backup_orchestration_select', `SELECT ${[
        "has_table_privilege(current_user, 'public.commerce_tenant_members', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_feishu_notification_outbox', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_feishu_notification_events', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_action_review_schedules', 'SELECT')",
        "has_table_privilege(current_user, 'public.commerce_weekly_diagnosis_runs', 'SELECT')",
      ].join(' AND ')} AS ok`],
      ['control_backup_no_reap_execute', "SELECT NOT has_function_privilege(current_user, 'public.commerce_reap_expired_jobs()', 'EXECUTE') AS ok"],
      ['control_backup_no_metrics_execute', "SELECT NOT has_function_privilege(current_user, 'public.commerce_collect_control_metrics(integer)', 'EXECUTE') AS ok"],
      ['control_backup_no_business_writes', denyWrites(CONTROL_TABLES)],
      ['control_backup_no_schema_create', noPublicSchemaCreate],
    ],
  },
  {
    name: 'analytics_backup',
    env: 'COMMERCE_ANALYTICS_BACKUP_DATABASE_URL',
    readOnly: true,
    requireBypassRls: true,
    checks: [
      ['analytics_backup_select', "SELECT has_table_privilege(current_user, 'public.commerce_daily_metrics', 'SELECT') AS ok"],
      ['analytics_backup_source_facts_select', "SELECT has_table_privilege(current_user, 'public.commerce_connector_source_facts', 'SELECT') AS ok"],
      ['analytics_backup_no_business_writes', denyWrites(ANALYTICS_TABLES)],
      ['analytics_backup_no_catalog_refresh', "SELECT NOT has_function_privilege(current_user, 'public.commerce_refresh_tenant_catalog(text)', 'EXECUTE') AS ok"],
      ['analytics_backup_no_schema_create', noPublicSchemaCreate],
    ],
  },
];

function sslOptions() {
  const enabled = /^(?:1|true|yes|on)$/iu.test(process.env.COMMERCE_PG_SSL || '');
  const rejectUnauthorized = !/^(?:0|false|no|off)$/iu.test(
    process.env.COMMERCE_PG_REJECT_UNAUTHORIZED || 'true',
  );
  if (process.env.NODE_ENV === 'production' && (!enabled || !rejectUnauthorized)) {
    throw new Error('Production role verification requires verified PostgreSQL TLS.');
  }
  const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/gu, '\n').trim();
  return enabled ? { rejectUnauthorized, ...(ca ? { ca } : {}) } : undefined;
}

function releaseRevision(value = process.env.COMMERCE_RELEASE_REVISION) {
  const revision = String(value || '').trim();
  if (
    process.env.NODE_ENV === 'production'
    && (revision === 'unversioned' || !/^[A-Za-z0-9._-]{7,64}$/u.test(revision))
  ) {
    throw new Error(
      'COMMERCE_RELEASE_REVISION must identify the immutable revision for production role evidence.',
    );
  }
  return revision || 'unversioned';
}

function roleEvidence(results, revision = releaseRevision()) {
  return {
    schemaVersion: 1,
    service: 'commerce-data-agent',
    revision,
    status: 'passed',
    roles: results,
  };
}

function writeRoleEvidence(results, environment = process.env) {
  const report = roleEvidence(results, releaseRevision(environment.COMMERCE_RELEASE_REVISION));
  const outputPath = String(environment.COMMERCE_ROLE_EVIDENCE_PATH || '').trim();
  if (outputPath) {
    const resolved = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    const temporary = `${resolved}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    fs.renameSync(temporary, resolved);
  }
  return report;
}

function connection(spec) {
  const value = process.env[spec.env]?.trim();
  if (!value) throw new Error(`${spec.env} is required for database role verification.`);
  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.username) {
    throw new Error(`${spec.env} must be a PostgreSQL URL with an explicit role.`);
  }
  return { value, role: decodeURIComponent(parsed.username) };
}

function assertDistinctRoles(entries) {
  const rolesBySpec = new Map(entries.map((entry) => [entry.spec.name, entry.role]));
  const responsibilityGroups = [
    ['control_api', ['control_api']],
    ['control_worker', ['control_worker']],
    ['analytics_readonly', ['analytics_readonly']],
    ['analytics_ingest', ['analytics_ingest']],
    ['control_maintenance', ['control_maintenance']],
    ['migration', ['control_migration', 'analytics_migration']],
    ['backup', ['control_backup', 'analytics_backup']],
  ];
  const populatedGroups = responsibilityGroups.map(([name, specNames]) => ({
    name,
    roles: new Set(specNames.map((specName) => rolesBySpec.get(specName)).filter(Boolean)),
  }));
  for (let leftIndex = 0; leftIndex < populatedGroups.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < populatedGroups.length; rightIndex += 1) {
      const left = populatedGroups[leftIndex];
      const right = populatedGroups[rightIndex];
      const shared = [...left.roles].find((role) => right.roles.has(role));
      if (shared) {
        throw new Error(
          `${left.name} and ${right.name} responsibilities must use different PostgreSQL roles.`,
        );
      }
    }
  }
}

async function verify(entry, ssl) {
  const pool = new Pool({
    connectionString: entry.value,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: `commerce-role-check-${entry.spec.name}`,
    ...(ssl ? { ssl } : {}),
  });
  try {
    const role = await pool.query(
      `SELECT current_user AS role, rolsuper, rolcreatedb, rolcreaterole,
              rolreplication, rolbypassrls, rolinherit, rolcanlogin
       FROM pg_roles WHERE rolname = current_user`,
    );
    const attributes = role.rows[0];
    if (!attributes || attributes.role !== entry.role) {
      throw new Error(`${entry.spec.name} connected as an unexpected PostgreSQL role.`);
    }
    if (entry.spec.expectedRole && attributes.role !== entry.spec.expectedRole) {
      throw new Error(`${entry.spec.name} must connect as ${entry.spec.expectedRole}.`);
    }
    for (const attribute of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication']) {
      if (attributes[attribute]) throw new Error(`${entry.spec.name} must not have ${attribute}.`);
    }
    if (Boolean(attributes.rolbypassrls) !== Boolean(entry.spec.requireBypassRls)) {
      throw new Error(`${entry.spec.name} has an invalid BYPASSRLS setting.`);
    }
    if (attributes.rolinherit) {
      throw new Error(`${entry.spec.name} must use NOINHERIT.`);
    }
    if (!attributes.rolcanlogin) {
      throw new Error(`${entry.spec.name} must be a direct LOGIN role.`);
    }
    const memberships = await pool.query(
      `SELECT NOT EXISTS (
         SELECT 1 FROM pg_auth_members
         WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
            OR roleid = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       ) AS ok`,
    );
    if (memberships.rows[0]?.ok !== true) {
      throw new Error(`${entry.spec.name} must not participate in PostgreSQL role memberships.`);
    }
    if (!entry.spec.allowOwnership) {
      const ownership = await pool.query(
        `SELECT NOT EXISTS (
           SELECT 1 FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
           UNION ALL
           SELECT 1 FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
           UNION ALL
           SELECT 1 FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
           UNION ALL
           SELECT 1 FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         ) AS ok`,
      );
      if (ownership.rows[0]?.ok !== true) {
        throw new Error(`${entry.spec.name} must not own database objects.`);
      }
    }
    const transaction = await pool.query('SHOW default_transaction_read_only');
    const readOnly = transaction.rows[0]?.default_transaction_read_only === 'on';
    if (entry.spec.readOnly && !readOnly) {
      throw new Error(`${entry.spec.name} must default to read-only transactions.`);
    }
    const checks = {};
    for (const [name, sql] of entry.spec.checks) {
      const result = await pool.query(sql);
      checks[name] = result.rows[0]?.ok === true;
      if (!checks[name]) throw new Error(`${entry.spec.name} failed capability check ${name}.`);
    }
    if (entry.spec.systemRls) {
      const canary = randomUUID();
      await pool.query('BEGIN');
      try {
        await pool.query(
          `SELECT set_config('commerce.tenant_id', $1, true),
                  set_config('commerce.user_id', $2, true),
                  set_config('commerce.control_system', 'off', true),
                  set_config('commerce.control_migration', 'off', true)`,
          [`role-check-source-${canary}`, `role-check-user-${canary}`],
        );
        await pool.query(
          `INSERT INTO commerce_agent_conversations (id, tenant_id, user_id, title, model)
           VALUES ($1, $2, $3, 'role verifier canary', 'role-verifier')`,
          [
            `role-check-${canary}`,
            `role-check-source-${canary}`,
            `role-check-user-${canary}`,
          ],
        );
        await pool.query(
          `SELECT set_config('commerce.tenant_id', $1, true),
                  set_config('commerce.user_id', $2, true),
                  set_config('commerce.control_system', 'on', true),
                  set_config('commerce.control_migration', 'on', true)`,
          [`role-check-other-${canary}`, `role-check-other-user-${canary}`],
        );
        const crossed = await pool.query(
          'SELECT EXISTS (SELECT 1 FROM commerce_agent_conversations WHERE id = $1) AS visible',
          [`role-check-${canary}`],
        );
        const expectedVisible = entry.spec.systemRls === 'allow';
        if (crossed.rows[0]?.visible !== expectedVisible) {
          throw new Error(`${entry.spec.name} failed the self-set GUC cross-tenant RLS check.`);
        }
        checks[expectedVisible
          ? 'control_worker_system_rls'
          : 'control_api_self_set_system_denied'] = true;
      } finally {
        await pool.query('ROLLBACK');
      }
    }
    return { name: entry.spec.name, role: entry.role, readOnly, checks };
  } finally {
    await pool.end();
  }
}

async function main() {
  releaseRevision();
  const entries = SPECS.map((spec) => ({ spec, ...connection(spec) }));
  assertDistinctRoles(entries);
  const ssl = sslOptions();
  const results = [];
  for (const entry of entries) results.push(await verify(entry, ssl));
  const report = writeRoleEvidence(results);
  console.log(JSON.stringify({ ok: true, ...report }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Commerce role verification failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  SPECS,
  assertDistinctRoles,
  releaseRevision,
  roleEvidence,
  sslOptions,
  writeRoleEvidence,
};

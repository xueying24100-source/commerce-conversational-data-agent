const { createHash } = require('node:crypto');
const { Pool } = require('pg');

const CONTROL_TABLES = Object.freeze([
  'commerce_agent_conversations',
  'commerce_agent_messages',
  'commerce_agent_runs',
  'commerce_agent_evidence',
  'commerce_agent_reports',
  'commerce_agent_report_shares',
  'commerce_agent_rate_limits',
  'commerce_agent_model_budget_daily',
  'commerce_agent_jobs',
  'commerce_agent_model_budget_reservations',
  'commerce_agent_job_events',
  'commerce_agent_feedback',
  'commerce_agent_feedback_events',
  'commerce_agent_action_events',
  'commerce_agent_action_reviews',
  'commerce_tenant_members',
  'commerce_feishu_notification_outbox',
  'commerce_feishu_notification_events',
  'commerce_action_review_schedules',
  'commerce_weekly_diagnosis_runs',
  'commerce_agent_workers',
]);

const ANALYTICS_TABLES = Object.freeze([
  'commerce_daily_metrics',
  'commerce_tenant_data_status',
  'commerce_tenant_data_partitions',
  'commerce_entity_catalog',
  'commerce_connector_source_facts',
  'commerce_connector_checkpoints',
  'commerce_connector_runs',
  'commerce_connector_date_coverage',
]);

const ALL_TABLES = new Set([...CONTROL_TABLES, ...ANALYTICS_TABLES]);

function sslOptions(environment = process.env) {
  const enabled = /^(?:1|true|yes|on)$/iu.test(environment.COMMERCE_PG_SSL || '');
  if (!enabled) return {};
  const rejectUnauthorized = !/^(?:0|false|no|off)$/iu.test(
    environment.COMMERCE_PG_REJECT_UNAUTHORIZED || 'true',
  );
  const ca = environment.COMMERCE_PG_CA?.replace(/\\n/gu, '\n').trim();
  return { ssl: { rejectUnauthorized, ...(ca ? { ca } : {}) } };
}

function verificationPool(connectionString, applicationName, environment = process.env) {
  return new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    application_name: applicationName,
    ...sslOptions(environment),
  });
}

function schemaFingerprint(catalog) {
  return `sha256:${createHash('sha256').update(JSON.stringify(catalog)).digest('hex')}`;
}

async function captureDatabaseVerification(client, tables) {
  if (!Array.isArray(tables) || !tables.length || tables.some((table) => !ALL_TABLES.has(table))) {
    throw new Error('Backup verification received an unknown table contract.');
  }
  const tableRows = {};
  for (const table of tables) {
    const result = await client.query(`SELECT COUNT(*)::text AS count FROM public.${table}`);
    const count = String(result.rows[0]?.count ?? '');
    if (!/^(?:0|[1-9][0-9]*)$/u.test(count)) throw new Error(`Invalid row count for ${table}.`);
    tableRows[table] = count;
  }
  const parameters = [tables];
  const [columns, constraints, indexes, policies, security, functions, sequences] = await Promise.all([
    client.query(
      `SELECT table_name, column_name, ordinal_position, data_type, udt_name,
              is_nullable, COALESCE(column_default, '') AS column_default
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[])
        ORDER BY table_name, ordinal_position`,
      parameters,
    ),
    client.query(
      `SELECT relation.relname AS table_name, constraint_record.conname AS constraint_name,
              constraint_record.contype AS constraint_type,
              pg_get_constraintdef(constraint_record.oid, true) AS definition
         FROM pg_constraint AS constraint_record
         JOIN pg_class AS relation ON relation.oid = constraint_record.conrelid
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relname = ANY($1::text[])
        ORDER BY relation.relname, constraint_record.conname`,
      parameters,
    ),
    client.query(
      `SELECT tablename AS table_name, indexname AS index_name, indexdef AS definition
         FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])
        ORDER BY tablename, indexname`,
      parameters,
    ),
    client.query(
      `SELECT tablename AS table_name, policyname AS policy_name, permissive, roles, cmd,
              COALESCE(qual, '') AS qualification, COALESCE(with_check, '') AS with_check
         FROM pg_policies
        WHERE schemaname = 'public' AND tablename = ANY($1::text[])
        ORDER BY tablename, policyname`,
      parameters,
    ),
    client.query(
      `SELECT relation.relname AS table_name, relation.relrowsecurity, relation.relforcerowsecurity
         FROM pg_class AS relation
         JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
          AND relation.relname = ANY($1::text[])
        ORDER BY relation.relname`,
      parameters,
    ),
    client.query(
      `SELECT procedure.proname AS function_name,
              pg_get_function_identity_arguments(procedure.oid) AS identity_arguments,
              pg_get_function_result(procedure.oid) AS result_type,
              pg_get_functiondef(procedure.oid) AS definition
         FROM pg_proc AS procedure
         JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        WHERE namespace.nspname = 'public' AND procedure.proname LIKE 'commerce\\_%' ESCAPE '\\'
        ORDER BY procedure.proname, identity_arguments`,
    ),
    client.query(
      `SELECT sequencename AS sequence_name, data_type, start_value, min_value, max_value,
              increment_by, cycle, cache_size
         FROM pg_sequences
        WHERE schemaname = 'public' AND sequencename LIKE 'commerce\\_%' ESCAPE '\\'
        ORDER BY sequencename`,
    ),
  ]);
  const catalog = {
    columns: columns.rows,
    constraints: constraints.rows,
    indexes: indexes.rows,
    policies: policies.rows,
    security: security.rows,
    functions: functions.rows,
    sequences: sequences.rows,
  };
  if (catalog.security.length !== tables.length) {
    throw new Error('Backup verification did not find every contracted table.');
  }
  return {
    tableRows,
    schemaSha256: schemaFingerprint(catalog),
    objectCounts: Object.fromEntries(
      Object.entries(catalog).map(([name, rows]) => [name, rows.length]),
    ),
  };
}

function assertVerificationMatches(expected, actual, label) {
  if (
    !expected
    || !actual
    || !/^sha256:[0-9a-f]{64}$/u.test(expected.schemaSha256 || '')
    || expected.schemaSha256 !== actual.schemaSha256
    || JSON.stringify(expected.tableRows) !== JSON.stringify(actual.tableRows)
    || JSON.stringify(expected.objectCounts) !== JSON.stringify(actual.objectCounts)
  ) {
    throw new Error(`${label} restored database does not match its source verification snapshot.`);
  }
  return actual;
}

module.exports = {
  ANALYTICS_TABLES,
  CONTROL_TABLES,
  assertVerificationMatches,
  captureDatabaseVerification,
  schemaFingerprint,
  verificationPool,
};

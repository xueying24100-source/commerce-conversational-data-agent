#!/usr/bin/env node

const path = require('node:path');
const { Pool } = require('pg');
const { loadLocalEnv } = require('./load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

const SPECS = [
  {
    name: 'control_runtime',
    env: 'COMMERCE_DATABASE_URL',
    checks: [
      ['control_jobs_write', "SELECT has_table_privilege(current_user, 'public.commerce_agent_jobs', 'SELECT,INSERT,UPDATE') AS ok"],
    ],
  },
  {
    name: 'analytics_readonly',
    env: 'COMMERCE_ANALYTICS_DATABASE_URL',
    readOnly: true,
    checks: [
      ['analytics_select', "SELECT has_table_privilege(current_user, 'public.commerce_daily_metrics', 'SELECT') AS ok"],
      ['analytics_connector_select', "SELECT has_table_privilege(current_user, 'public.commerce_connector_runs', 'SELECT') AS ok"],
      ['analytics_no_insert', "SELECT NOT has_table_privilege(current_user, 'public.commerce_daily_metrics', 'INSERT') AS ok"],
    ],
  },
  {
    name: 'analytics_ingest',
    env: 'COMMERCE_ANALYTICS_INGEST_DATABASE_URL',
    checks: [
      ['analytics_ingest_write', "SELECT has_table_privilege(current_user, 'public.commerce_daily_metrics', 'SELECT,INSERT,UPDATE') AS ok"],
      ['catalog_refresh_execute', "SELECT has_function_privilege(current_user, 'public.commerce_refresh_tenant_catalog(text)', 'EXECUTE') AS ok"],
    ],
  },
  {
    name: 'control_maintenance',
    env: 'COMMERCE_CONTROL_MAINTENANCE_DATABASE_URL',
    checks: [
      ['maintenance_jobs', "SELECT has_table_privilege(current_user, 'public.commerce_agent_jobs', 'SELECT,UPDATE,DELETE') AS ok"],
    ],
  },
  {
    name: 'control_migration',
    env: 'COMMERCE_CONTROL_MIGRATION_DATABASE_URL',
    checks: [
      ['control_schema_create', "SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS ok"],
    ],
  },
  {
    name: 'analytics_migration',
    env: 'COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL',
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
    ],
  },
  {
    name: 'analytics_backup',
    env: 'COMMERCE_ANALYTICS_BACKUP_DATABASE_URL',
    readOnly: true,
    requireBypassRls: true,
    checks: [
      ['analytics_backup_select', "SELECT has_table_privilege(current_user, 'public.commerce_daily_metrics', 'SELECT') AS ok"],
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
  const role = Object.fromEntries(entries.map((entry) => [entry.spec.name, entry.role]));
  const pairs = [
    ['control_runtime', 'control_migration'],
    ['control_runtime', 'control_maintenance'],
    ['control_runtime', 'control_backup'],
    ['analytics_readonly', 'analytics_ingest'],
    ['analytics_readonly', 'analytics_migration'],
    ['analytics_readonly', 'analytics_backup'],
    ['analytics_ingest', 'analytics_migration'],
  ];
  for (const [left, right] of pairs) {
    if (role[left] === role[right]) {
      throw new Error(`${left} and ${right} must use different PostgreSQL roles.`);
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
              rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = current_user`,
    );
    const attributes = role.rows[0];
    if (!attributes || attributes.role !== entry.role) {
      throw new Error(`${entry.spec.name} connected as an unexpected PostgreSQL role.`);
    }
    for (const attribute of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication']) {
      if (attributes[attribute]) throw new Error(`${entry.spec.name} must not have ${attribute}.`);
    }
    if (Boolean(attributes.rolbypassrls) !== Boolean(entry.spec.requireBypassRls)) {
      throw new Error(`${entry.spec.name} has an invalid BYPASSRLS setting.`);
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
    return { name: entry.spec.name, role: entry.role, readOnly, checks };
  } finally {
    await pool.end();
  }
}

async function main() {
  const entries = SPECS.map((spec) => ({ spec, ...connection(spec) }));
  assertDistinctRoles(entries);
  const ssl = sslOptions();
  const results = [];
  for (const entry of entries) results.push(await verify(entry, ssl));
  console.log(JSON.stringify({ ok: true, roles: results }, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Commerce role verification failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { assertDistinctRoles, sslOptions };

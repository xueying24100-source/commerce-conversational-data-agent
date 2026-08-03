#!/usr/bin/env node

const { Pool } = require('pg');
const path = require('node:path');
const { loadLocalEnv } = require('./load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

const production = process.env.NODE_ENV === 'production';
const connectionString = process.env.COMMERCE_ANALYTICS_INGEST_DATABASE_URL
  || process.env.COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL
  || (production
    ? undefined
    : process.env.COMMERCE_ANALYTICS_DATABASE_URL
      || process.env.COMMERCE_DATABASE_URL
      || process.env.DATABASE_URL);
if (!connectionString) {
  console.error(
    'COMMERCE_ANALYTICS_INGEST_DATABASE_URL or COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL is required.',
  );
  process.exit(1);
}

const requestedTenants = process.argv.slice(2);
if (requestedTenants.length > 1_000) {
  console.error('At most 1000 tenant IDs can be refreshed in one command.');
  process.exit(1);
}
for (const tenantId of requestedTenants) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(tenantId)) {
    console.error(`Invalid tenant ID: ${tenantId}`);
    process.exit(1);
  }
}

const sslEnabled = /^(?:1|true|yes|on)$/i.test(process.env.COMMERCE_PG_SSL || '');
const rejectUnauthorized = !/^(?:0|false|no|off)$/i.test(
  process.env.COMMERCE_PG_REJECT_UNAUTHORIZED || 'true',
);
const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/g, '\n').trim();
if (production && (!sslEnabled || !rejectUnauthorized)) {
  console.error('Production catalog refresh requires verified PostgreSQL TLS.');
  process.exit(1);
}

const timeout = Number.parseInt(process.env.COMMERCE_CATALOG_REFRESH_TIMEOUT_MS || '300000', 10);
if (!Number.isSafeInteger(timeout) || timeout < 10_000 || timeout > 3_600_000) {
  console.error('COMMERCE_CATALOG_REFRESH_TIMEOUT_MS must be between 10000 and 3600000.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 10_000,
  statement_timeout: timeout,
  application_name: 'commerce-catalog-refresh',
  ...(sslEnabled ? { ssl: { rejectUnauthorized, ...(ca ? { ca } : {}) } } : {}),
});

async function tenantIds() {
  if (requestedTenants.length) return requestedTenants;
  if (production) {
    throw new Error('Production catalog refresh requires explicit tenant IDs as command arguments.');
  }
  const result = await pool.query(
    'SELECT DISTINCT tenant_id FROM commerce_daily_metrics ORDER BY tenant_id',
  );
  return result.rows.map((row) => String(row.tenant_id));
}

async function refreshTenant(tenantId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('commerce.tenant_id', $1, true),
              set_config('commerce.ingest_tenant_id', $1, true)`,
      [tenantId],
    );
    await client.query('SELECT commerce_refresh_tenant_catalog($1)', [tenantId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const tenants = await tenantIds();
  for (const tenantId of tenants) {
    await refreshTenant(tenantId);
    console.log(`Refreshed Commerce catalog for tenant ${tenantId}.`);
  }
  console.log(`Commerce catalog refresh completed for ${tenants.length} tenant(s).`);
}

main().catch((error) => {
  console.error('Commerce catalog refresh failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end();
});

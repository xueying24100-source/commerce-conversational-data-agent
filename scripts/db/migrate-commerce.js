#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const { loadLocalEnv } = require('./load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

const production = process.env.NODE_ENV === 'production';
const localUrl = process.env.COMMERCE_DATABASE_URL || process.env.DATABASE_URL;
const controlMigrationUrl = process.env.COMMERCE_CONTROL_MIGRATION_DATABASE_URL
  || (production ? undefined : localUrl);
const analyticsMigrationUrl = process.env.COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL
  || (production ? undefined : localUrl);

if (!controlMigrationUrl) {
  console.error('COMMERCE_CONTROL_MIGRATION_DATABASE_URL is required in production.');
  process.exit(1);
}
if (!analyticsMigrationUrl) {
  console.error('COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL is required in production.');
  process.exit(1);
}

const sslEnabled = /^(?:1|true|yes|on)$/i.test(process.env.COMMERCE_PG_SSL || '');
const rejectUnauthorized = !/^(?:0|false|no|off)$/i.test(
  process.env.COMMERCE_PG_REJECT_UNAUTHORIZED || 'true',
);
const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/g, '\n').trim();
if (production && (!sslEnabled || !rejectUnauthorized)) {
  console.error('Production migrations require verified PostgreSQL TLS.');
  process.exit(1);
}

function pool(connectionString, applicationName) {
  return new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    application_name: applicationName,
    ...(sslEnabled
      ? { ssl: { rejectUnauthorized, ...(ca ? { ca } : {}) } }
      : {}),
  });
}

async function apply(connectionString, filename, label) {
  const database = pool(connectionString, `commerce-migration-${label}`);
  try {
    const sql = fs.readFileSync(path.join(root, 'migrations', filename), 'utf8');
    await database.query(sql);
    console.log(`${label} schema is ready.`);
  } finally {
    await database.end();
  }
}

async function main() {
  await apply(controlMigrationUrl, 'commerce-control.sql', 'Commerce control');
  await apply(analyticsMigrationUrl, 'commerce-analytics.sql', 'Commerce analytics');
}

main().catch((error) => {
  console.error('Commerce migration failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

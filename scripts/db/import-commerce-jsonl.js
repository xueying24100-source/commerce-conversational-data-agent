#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { Pool } = require('pg');

const {
  parseCommerceRow,
  refreshCommerceCatalog,
  upsertCommerceRows,
} = require('./commerce-ingest-core');
const { loadLocalEnv } = require('./load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

const sourceArgument = process.argv[2];
if (!sourceArgument) {
  console.error('Usage: npm run db:import:commerce -- <absolute-or-workspace-relative.jsonl>');
  process.exit(1);
}

const sourcePath = path.resolve(root, sourceArgument);
if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
  console.error(`JSONL input file was not found: ${sourcePath}`);
  process.exit(1);
}

const production = process.env.NODE_ENV === 'production';
const connectionString = process.env.COMMERCE_ANALYTICS_INGEST_DATABASE_URL
  || (production
    ? undefined
    : process.env.COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL
      || process.env.COMMERCE_DATABASE_URL
      || process.env.DATABASE_URL);
if (!connectionString) {
  console.error('COMMERCE_ANALYTICS_INGEST_DATABASE_URL is required for production ingestion.');
  process.exit(1);
}

const maximumRows = Number.parseInt(process.env.COMMERCE_IMPORT_MAX_ROWS || '1000000', 10);
if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 5_000_000) {
  console.error('COMMERCE_IMPORT_MAX_ROWS must be an integer from 1 to 5000000.');
  process.exit(1);
}

const sslEnabled = /^(?:1|true|yes|on)$/i.test(process.env.COMMERCE_PG_SSL || '');
const rejectUnauthorized = !/^(?:0|false|no|off)$/i.test(
  process.env.COMMERCE_PG_REJECT_UNAUTHORIZED || 'true',
);
const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/g, '\n').trim();
if (production && (!sslEnabled || !rejectUnauthorized)) {
  console.error('Production ingestion requires verified PostgreSQL TLS.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 120_000,
  application_name: 'commerce-data-import',
  ...(sslEnabled ? { ssl: { rejectUnauthorized, ...(ca ? { ca } : {}) } } : {}),
});

async function flush(client, rowsByTenant) {
  for (const rows of rowsByTenant.values()) await upsertCommerceRows(client, rows);
  rowsByTenant.clear();
}

async function main() {
  const client = await pool.connect();
  let lineNumber = 0;
  let imported = 0;
  let buffered = 0;
  const rowsByTenant = new Map();
  const importedTenants = new Set();
  try {
    await client.query('BEGIN');
    const lines = readline.createInterface({
      input: fs.createReadStream(sourcePath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of lines) {
      lineNumber += 1;
      if (!line.trim()) continue;
      if (imported >= maximumRows) {
        throw new Error(`Import exceeded COMMERCE_IMPORT_MAX_ROWS=${maximumRows}.`);
      }
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        throw new Error(`Line ${lineNumber}: invalid JSON.`);
      }
      const row = parseCommerceRow(value, lineNumber);
      const tenantRows = rowsByTenant.get(row.tenant_id) || [];
      tenantRows.push(row);
      rowsByTenant.set(row.tenant_id, tenantRows);
      importedTenants.add(row.tenant_id);
      imported += 1;
      buffered += 1;
      if (buffered >= 250) {
        await flush(client, rowsByTenant);
        buffered = 0;
      }
    }
    await flush(client, rowsByTenant);
    for (const tenantId of importedTenants) await refreshCommerceCatalog(client, tenantId);
    await client.query('COMMIT');
    console.log(JSON.stringify({ sourcePath, importedRows: imported, tenants: importedTenants.size }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Commerce import failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

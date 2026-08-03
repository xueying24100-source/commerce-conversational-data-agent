#!/usr/bin/env node

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');

const { loadLocalEnv } = require('./load-local-env');
const {
  assertRestoreDrillTarget,
  postgresCliConnection,
  postgresCliSslEnvironment,
  runPostgresCli,
} = require('./postgres-cli');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

function sha256(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(filename);
    input.on('error', reject);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

async function verify(connectionString, table) {
  const enabled = /^(?:1|true|yes|on)$/iu.test(process.env.COMMERCE_PG_SSL || '');
  const rejectUnauthorized = !/^(?:0|false|no|off)$/iu.test(
    process.env.COMMERCE_PG_REJECT_UNAUTHORIZED || 'true',
  );
  const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/gu, '\n').trim();
  const pool = new Pool({
    connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    application_name: 'commerce-restore-drill-verification',
    ...(enabled ? { ssl: { rejectUnauthorized, ...(ca ? { ca } : {}) } } : {}),
  });
  try {
    const result = await pool.query(`SELECT COUNT(*)::bigint AS count FROM ${table}`);
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await pool.end();
  }
}

async function main() {
  if (process.env.COMMERCE_RESTORE_DRILL_CONFIRM !== 'commerce-restore-drill') {
    throw new Error('Set COMMERCE_RESTORE_DRILL_CONFIRM=commerce-restore-drill for disposable targets.');
  }
  const directory = path.resolve(root, process.argv[2] || '');
  const manifestPath = path.join(directory, 'manifest.json');
  if (!process.argv[2] || !fs.existsSync(manifestPath)) {
    throw new Error('Usage: npm run db:restore-drill:commerce -- <backup-directory>');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.artifacts)) {
    throw new Error('Unsupported Commerce backup manifest.');
  }
  const targets = [
    {
      name: 'control',
      url: process.env.COMMERCE_CONTROL_RESTORE_DRILL_DATABASE_URL,
      table: 'commerce_agent_jobs',
    },
    {
      name: 'analytics',
      url: process.env.COMMERCE_ANALYTICS_RESTORE_DRILL_DATABASE_URL,
      table: 'commerce_daily_metrics',
    },
  ];
  const connections = targets.map((target) => ({
    ...target,
    connection: postgresCliConnection(target.url, `${target.name} restore drill URL`),
  }));
  connections.forEach((target) => assertRestoreDrillTarget(target.connection, target.name));
  if (
    connections[0].connection.host === connections[1].connection.host
    && connections[0].connection.port === connections[1].connection.port
    && connections[0].connection.database === connections[1].connection.database
  ) {
    throw new Error('Control and analytics restore drills require separate disposable databases.');
  }
  const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/gu, '\n').trim();
  const caFile = ca ? path.join(directory, '.postgres-ca-restore.pem') : null;
  if (caFile) fs.writeFileSync(caFile, `${ca}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    const ssl = postgresCliSslEnvironment(caFile);
    const results = [];
    for (const target of connections) {
      const artifact = manifest.artifacts.find((item) => item.name === target.name);
      if (!artifact) throw new Error(`Backup manifest is missing ${target.name}.`);
      if (typeof artifact.file !== 'string' || path.basename(artifact.file) !== artifact.file) {
        throw new Error(`${target.name} backup manifest contains an invalid file path.`);
      }
      const filename = path.join(directory, artifact.file);
      if (!fs.existsSync(filename) || await sha256(filename) !== artifact.sha256) {
        throw new Error(`${target.name} backup hash verification failed.`);
      }
      runPostgresCli(process.env.PG_RESTORE_BIN || 'pg_restore', [
        '--clean',
        '--if-exists',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--dbname',
        target.connection.database,
        filename,
      ], target.connection, ssl);
      results.push({
        name: target.name,
        rows: await verify(target.url, target.table),
      });
    }
    console.log(JSON.stringify({ ok: true, restoredAt: new Date().toISOString(), results }, null, 2));
  } finally {
    if (caFile) fs.rmSync(caFile, { force: true });
  }
}

main().catch((error) => {
  console.error('Commerce restore drill failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

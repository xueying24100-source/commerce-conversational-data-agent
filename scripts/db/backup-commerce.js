#!/usr/bin/env node

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { loadLocalEnv } = require('./load-local-env');
const {
  postgresCliConnection,
  postgresDatabaseFingerprint,
  postgresCliSslEnvironment,
  runPostgresCli,
} = require('./postgres-cli');
const {
  ANALYTICS_TABLES,
  CONTROL_TABLES,
  captureDatabaseVerification,
  verificationPool,
} = require('./commerce-backup-verification');

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

function outputDirectory() {
  const requested = process.argv[2] || process.env.COMMERCE_BACKUP_OUTPUT_DIR;
  if (requested) return path.resolve(root, requested);
  return path.join(root, 'tmp', 'commerce-backups', new Date().toISOString().replace(/[:.]/gu, '-'));
}

async function main() {
  const revision = String(process.env.COMMERCE_RELEASE_REVISION || '').trim();
  if (
    process.env.NODE_ENV === 'production'
    && (revision === 'unversioned' || !/^[A-Za-z0-9._-]{7,64}$/u.test(revision))
  ) {
    throw new Error('COMMERCE_RELEASE_REVISION must identify the immutable backup revision.');
  }
  const directory = outputDirectory();
  if (fs.existsSync(directory) && fs.readdirSync(directory).length) {
    throw new Error(`Backup output directory must be empty: ${directory}`);
  }
  fs.mkdirSync(directory, { recursive: true });
  const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/gu, '\n').trim();
  const caFile = ca ? path.join(directory, '.postgres-ca.pem') : null;
  if (caFile) fs.writeFileSync(caFile, `${ca}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    const ssl = postgresCliSslEnvironment(caFile);
    const targets = [
      {
        name: 'control',
        url: process.env.COMMERCE_CONTROL_BACKUP_DATABASE_URL,
        file: path.join(directory, 'commerce-control.dump'),
        tables: CONTROL_TABLES,
      },
      {
        name: 'analytics',
        url: process.env.COMMERCE_ANALYTICS_BACKUP_DATABASE_URL,
        file: path.join(directory, 'commerce-analytics.dump'),
        tables: ANALYTICS_TABLES,
      },
    ];
    const artifacts = [];
    for (const target of targets) {
      const connection = postgresCliConnection(target.url, `${target.name} backup URL`);
      const pool = verificationPool(
        target.url,
        `commerce-${target.name}-backup-verification`,
      );
      const client = await pool.connect();
      let verification;
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const snapshotResult = await client.query('SELECT pg_export_snapshot() AS snapshot');
        const snapshot = String(snapshotResult.rows[0]?.snapshot || '');
        if (!/^[0-9A-F]+-[0-9A-F]+-[0-9A-F]+$/iu.test(snapshot)) {
          throw new Error(`${target.name} database did not export a valid snapshot.`);
        }
        runPostgresCli(process.env.PG_DUMP_BIN || 'pg_dump', [
          '--format=custom',
          '--no-owner',
          '--no-privileges',
          '--schema=public',
          '--snapshot',
          snapshot,
          '--file',
          target.file,
        ], connection, ssl);
        verification = await captureDatabaseVerification(client, target.tables);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
        await pool.end();
      }
      const stat = fs.statSync(target.file);
      artifacts.push({
        name: target.name,
        file: path.basename(target.file),
        bytes: stat.size,
        sha256: await sha256(target.file),
        sourceDatabaseSha256: postgresDatabaseFingerprint(connection),
        verification,
      });
    }
    const manifest = {
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      revision: revision || 'unversioned',
      artifacts,
    };
    fs.writeFileSync(
      path.join(directory, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
    console.log(JSON.stringify({ ok: true, directory, artifacts }, null, 2));
  } finally {
    if (caFile) fs.rmSync(caFile, { force: true });
  }
}

main().catch((error) => {
  console.error('Commerce backup failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

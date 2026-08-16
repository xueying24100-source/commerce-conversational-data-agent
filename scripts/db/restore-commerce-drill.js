#!/usr/bin/env node

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { loadLocalEnv } = require('./load-local-env');
const {
  assertRestoreDrillTarget,
  postgresCliConnection,
  postgresDatabaseFingerprint,
  postgresCliSslEnvironment,
  runPostgresCli,
} = require('./postgres-cli');
const {
  ANALYTICS_TABLES,
  CONTROL_TABLES,
  assertVerificationMatches,
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

function releaseRevision(value = process.env.COMMERCE_RELEASE_REVISION) {
  const revision = String(value || '').trim();
  if (
    process.env.NODE_ENV === 'production'
    && (revision === 'unversioned' || !/^[A-Za-z0-9._-]{7,64}$/u.test(revision))
  ) {
    throw new Error(
      'COMMERCE_RELEASE_REVISION must identify the immutable revision for restore evidence.',
    );
  }
  return revision || 'unversioned';
}

function manifestRevision(manifest, expectedRevision = releaseRevision()) {
  const revision = String(manifest?.revision || '').trim();
  if (!revision) throw new Error('Backup manifest must include a release revision.');
  if (expectedRevision !== 'unversioned' && revision !== expectedRevision) {
    throw new Error(`Backup manifest revision ${revision} does not match ${expectedRevision}.`);
  }
  return revision;
}

function restoreEvidence(manifest, results, revision = manifestRevision(manifest)) {
  return {
    schemaVersion: 1,
    service: 'commerce-data-agent',
    revision,
    status: 'passed',
    restoredAt: new Date().toISOString(),
    backup: {
      revision: manifest.revision,
      createdAt: manifest.createdAt,
      artifacts: manifest.artifacts.map((artifact) => ({
        name: artifact.name,
        file: artifact.file,
        bytes: artifact.bytes,
        sha256: artifact.sha256,
        sourceDatabaseSha256: artifact.sourceDatabaseSha256,
        verification: artifact.verification,
      })),
    },
    results,
  };
}

function writeRestoreEvidence(report, environment = process.env) {
  const outputPath = String(environment.COMMERCE_RESTORE_DRILL_EVIDENCE_PATH || '').trim();
  if (!outputPath) return report;
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(temporary, resolved);
  return report;
}

async function verify(connectionString, tables, expected, name) {
  const pool = verificationPool(connectionString, 'commerce-restore-drill-verification');
  try {
    const actual = await captureDatabaseVerification(pool, tables);
    assertVerificationMatches(expected, actual, name);
    return actual;
  } finally {
    await pool.end();
  }
}

async function assertDisposableMarker(connectionString, name, marker) {
  if (!/^[A-Za-z0-9._:-]{32,200}$/u.test(marker)) {
    throw new Error('COMMERCE_RESTORE_DRILL_TARGET_MARKER must be a high-entropy marker.');
  }
  const markerSha256 = createHash('sha256').update(marker).digest('hex');
  const pool = verificationPool(connectionString, 'commerce-restore-drill-target-guard');
  try {
    const result = await pool.query(
      `SELECT 1 AS authorized
         FROM commerce_restore_guard.authorizations
        WHERE service = 'commerce-data-agent' AND target_name = $1
          AND marker_sha256 = $2 AND expires_at > clock_timestamp()
        LIMIT 1`,
      [name, markerSha256],
    );
    if (result.rows[0]?.authorized !== 1) {
      throw new Error(`${name} restore target is missing its unexpired disposable marker.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('disposable marker')) throw error;
    throw new Error(`${name} restore target marker could not be verified.`);
  } finally {
    await pool.end();
  }
}

function sameDatabase(left, right) {
  return left.host.toLowerCase() === right.host.toLowerCase()
    && left.port === right.port
    && left.database.toLowerCase() === right.database.toLowerCase();
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
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.artifacts)) {
    throw new Error('Unsupported Commerce backup manifest.');
  }
  const revision = manifestRevision(manifest, releaseRevision());
  const targets = [
    {
      name: 'control',
      url: process.env.COMMERCE_CONTROL_RESTORE_DRILL_DATABASE_URL,
      tables: CONTROL_TABLES,
    },
    {
      name: 'analytics',
      url: process.env.COMMERCE_ANALYTICS_RESTORE_DRILL_DATABASE_URL,
      tables: ANALYTICS_TABLES,
    },
  ];
  const connections = targets.map((target) => ({
    ...target,
    connection: postgresCliConnection(target.url, `${target.name} restore drill URL`),
  }));
  connections.forEach((target) => assertRestoreDrillTarget(target.connection, target.name));
  for (const target of connections) {
    for (const artifact of manifest.artifacts) {
      if (
        !/^sha256:[0-9a-f]{64}$/u.test(artifact.sourceDatabaseSha256 || '')
        || postgresDatabaseFingerprint(target.connection) === artifact.sourceDatabaseSha256
      ) {
        throw new Error(`${target.name} restore target must differ from every backup source database.`);
      }
    }
  }
  if (
    sameDatabase(connections[0].connection, connections[1].connection)
  ) {
    throw new Error('Control and analytics restore drills require separate disposable databases.');
  }
  const ca = process.env.COMMERCE_PG_CA?.replace(/\\n/gu, '\n').trim();
  const caFile = ca ? path.join(directory, '.postgres-ca-restore.pem') : null;
  if (caFile) fs.writeFileSync(caFile, `${ca}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    const ssl = postgresCliSslEnvironment(caFile);
    const results = [];
    const marker = String(process.env.COMMERCE_RESTORE_DRILL_TARGET_MARKER || '').trim();
    for (const target of connections) {
      await assertDisposableMarker(target.url, target.name, marker);
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
        '--single-transaction',
        '--no-owner',
        '--no-privileges',
        '--dbname',
        target.connection.database,
        filename,
      ], target.connection, ssl);
      results.push({
        name: target.name,
        verification: await verify(
          target.url,
          target.tables,
          artifact.verification,
          target.name,
        ),
      });
    }
    const report = writeRestoreEvidence(restoreEvidence(manifest, results, revision));
    console.log(JSON.stringify({ ok: true, ...report }, null, 2));
  } finally {
    if (caFile) fs.rmSync(caFile, { force: true });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Commerce restore drill failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = {
  manifestRevision,
  releaseRevision,
  restoreEvidence,
  sameDatabase,
  writeRestoreEvidence,
};

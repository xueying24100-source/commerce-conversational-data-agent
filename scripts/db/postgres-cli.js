const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

function postgresCliConnection(value, label) {
  if (!value) throw new Error(`${label} is required.`);
  const parsed = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.username) {
    throw new Error(`${label} must be an explicit PostgreSQL URL.`);
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  if (!database) throw new Error(`${label} must include a database name.`);
  return {
    host: parsed.hostname,
    port: parsed.port || '5432',
    role: decodeURIComponent(parsed.username),
    database,
    environment: {
      PGHOST: parsed.hostname,
      PGPORT: parsed.port || '5432',
      PGUSER: decodeURIComponent(parsed.username),
      PGPASSWORD: decodeURIComponent(parsed.password),
      PGDATABASE: database,
    },
  };
}

function postgresCliSslEnvironment(caFile) {
  const enabled = /^(?:1|true|yes|on)$/iu.test(process.env.COMMERCE_PG_SSL || '');
  const rejectUnauthorized = !/^(?:0|false|no|off)$/iu.test(
    process.env.COMMERCE_PG_REJECT_UNAUTHORIZED || 'true',
  );
  if (process.env.NODE_ENV === 'production' && (!enabled || !rejectUnauthorized)) {
    throw new Error('Production PostgreSQL CLI operations require verified TLS.');
  }
  if (!enabled) return { PGSSLMODE: 'disable' };
  return {
    PGSSLMODE: rejectUnauthorized ? 'verify-full' : 'require',
    ...(caFile ? { PGSSLROOTCERT: caFile } : {}),
  };
}

function runPostgresCli(binary, args, connection, sslEnvironment) {
  const result = spawnSync(binary, args, {
    env: { ...process.env, ...connection.environment, ...sslEnvironment },
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${binary} failed: ${(result.stderr || result.stdout || '').trim().slice(0, 2_000)}`);
  }
}

function assertRestoreDrillTarget(connection, label) {
  if (!/(?:^|[_-])(?:restore|drill|scratch|test)(?:[_-]|$)/iu.test(connection.database)) {
    throw new Error(`${label} database name must contain a delimited restore, drill, scratch or test marker.`);
  }
}

function postgresDatabaseFingerprint(connection) {
  const identity = `${connection.host.toLowerCase()}:${connection.port}/${connection.database.toLowerCase()}`;
  return `sha256:${createHash('sha256').update(identity).digest('hex')}`;
}

module.exports = {
  assertRestoreDrillTarget,
  postgresCliConnection,
  postgresDatabaseFingerprint,
  postgresCliSslEnvironment,
  runPostgresCli,
};

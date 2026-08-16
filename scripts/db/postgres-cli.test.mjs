import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  assertRestoreDrillTarget,
  postgresCliConnection,
  postgresDatabaseFingerprint,
  postgresCliSslEnvironment,
} = require('./postgres-cli.js');

const original = {
  NODE_ENV: process.env.NODE_ENV,
  COMMERCE_PG_SSL: process.env.COMMERCE_PG_SSL,
  COMMERCE_PG_REJECT_UNAUTHORIZED: process.env.COMMERCE_PG_REJECT_UNAUTHORIZED,
};

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('PostgreSQL CLI safety helpers', () => {
  it('keeps credentials in the child environment rather than command arguments', () => {
    const connection = postgresCliConnection(
      'postgresql://backup_user:secret@db.internal:5433/commerce_backup',
      'backup URL',
    );
    expect(connection).toMatchObject({
      host: 'db.internal',
      port: '5433',
      role: 'backup_user',
      database: 'commerce_backup',
      environment: { PGPASSWORD: 'secret' },
    });
  });

  it('requires clearly disposable restore database names', () => {
    expect(() => assertRestoreDrillTarget({ database: 'commerce_restore_drill' }, 'control'))
      .not.toThrow();
    expect(() => assertRestoreDrillTarget({ database: 'commerce_production' }, 'control'))
      .toThrow('database name must contain');
    expect(() => assertRestoreDrillTarget({ database: 'latest_production' }, 'control'))
      .toThrow('delimited');
  });

  it('binds a backup to its host, port and database without exposing the URL', () => {
    const first = postgresCliConnection(
      'postgresql://backup_user:secret@db.internal:5433/commerce_control',
      'source',
    );
    const sameDatabaseDifferentCredential = postgresCliConnection(
      'postgresql://another:other@DB.INTERNAL:5433/commerce_control',
      'source',
    );
    expect(postgresDatabaseFingerprint(first)).toBe(
      postgresDatabaseFingerprint(sameDatabaseDifferentCredential),
    );
    expect(postgresDatabaseFingerprint(first)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('requires verified TLS for production CLI operations', () => {
    process.env.NODE_ENV = 'production';
    process.env.COMMERCE_PG_SSL = '1';
    process.env.COMMERCE_PG_REJECT_UNAUTHORIZED = '1';
    expect(postgresCliSslEnvironment('ca.pem')).toEqual({
      PGSSLMODE: 'verify-full',
      PGSSLROOTCERT: 'ca.pem',
    });
    process.env.COMMERCE_PG_SSL = '0';
    expect(() => postgresCliSslEnvironment()).toThrow('verified TLS');
  });
});

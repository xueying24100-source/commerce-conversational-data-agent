import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { loadLocalEnv } = require('./load-local-env.js');

const names = [
  'COMMERCE_DISABLE_LOCAL_ENV_FILES',
  'COMMERCE_DATABASE_URL',
  'COMMERCE_ANALYTICS_DATABASE_URL',
  'COMMERCE_CONTROL_MIGRATION_DATABASE_URL',
  'COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL',
  'COMMERCE_ANALYTICS_INGEST_DATABASE_URL',
  'COMMERCE_TEST_DATABASE_URL',
  'COMMERCE_LIVE_E2E_DATABASE_URL',
  'COMMERCE_ENV_TEST_LOCAL',
  'COMMERCE_ENV_TEST_RELEASE',
];
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const directories = [];

afterEach(() => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
  while (directories.length) fs.rmSync(directories.pop(), { recursive: true, force: true });
});

function environmentRoot(local, release) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commerce-local-env-'));
  directories.push(root);
  fs.writeFileSync(path.join(root, '.env.local'), local, 'utf8');
  fs.writeFileSync(path.join(root, '.env.release.local'), release, 'utf8');
  return root;
}

describe('local environment loading', () => {
  it('can disable local env-file loading for isolated release subprocesses', () => {
    names.forEach((name) => delete process.env[name]);
    process.env.COMMERCE_DISABLE_LOCAL_ENV_FILES = '1';
    loadLocalEnv(environmentRoot(
      'COMMERCE_DATABASE_URL=postgresql://control:secret@127.0.0.1:5432/control\n',
      'COMMERCE_ANALYTICS_INGEST_DATABASE_URL=postgresql://ingest:secret@127.0.0.1:5432/analytics\n',
    ));
    expect(process.env.COMMERCE_DATABASE_URL).toBeUndefined();
    expect(process.env.COMMERCE_ANALYTICS_INGEST_DATABASE_URL).toBeUndefined();
  });

  it('loads both local files and maps a loopback disposable database', () => {
    names.forEach((name) => delete process.env[name]);
    const url = 'postgresql://commerce:password@127.0.0.1:35433/commerce_agent';
    loadLocalEnv(environmentRoot(
      'COMMERCE_ENV_TEST_LOCAL=local\n',
      `COMMERCE_ENV_TEST_RELEASE=release\nCOMMERCE_TEST_DATABASE_URL=${url}\n`,
    ));
    expect(process.env.COMMERCE_ENV_TEST_LOCAL).toBe('local');
    expect(process.env.COMMERCE_ENV_TEST_RELEASE).toBe('release');
    expect(process.env.COMMERCE_DATABASE_URL).toBe(url);
    expect(process.env.COMMERCE_ANALYTICS_DATABASE_URL).toBe(url);
    expect(process.env.COMMERCE_CONTROL_MIGRATION_DATABASE_URL).toBe(url);
    expect(process.env.COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL).toBe(url);
    expect(process.env.COMMERCE_ANALYTICS_INGEST_DATABASE_URL).toBe(url);
  });

  it('does not promote a non-loopback test database into runtime credentials', () => {
    names.forEach((name) => delete process.env[name]);
    loadLocalEnv(environmentRoot(
      '',
      'COMMERCE_TEST_DATABASE_URL=postgresql://commerce:password@db.internal:5432/commerce\n',
    ));
    expect(process.env.COMMERCE_DATABASE_URL).toBeUndefined();
    expect(process.env.COMMERCE_ANALYTICS_DATABASE_URL).toBeUndefined();
  });
});

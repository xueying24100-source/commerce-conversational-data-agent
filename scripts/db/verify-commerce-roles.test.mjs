import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { assertDistinctRoles, sslOptions } = require('./verify-commerce-roles.js');

const original = {
  NODE_ENV: process.env.NODE_ENV,
  COMMERCE_PG_SSL: process.env.COMMERCE_PG_SSL,
  COMMERCE_PG_REJECT_UNAUTHORIZED: process.env.COMMERCE_PG_REJECT_UNAUTHORIZED,
  COMMERCE_PG_CA: process.env.COMMERCE_PG_CA,
};

afterEach(() => {
  for (const [name, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function entry(name, role) {
  return { spec: { name }, role };
}

describe('Commerce database role verification', () => {
  it('rejects shared runtime and privileged role credentials', () => {
    expect(() => assertDistinctRoles([
      entry('control_runtime', 'shared'),
      entry('control_migration', 'shared'),
    ])).toThrow('must use different PostgreSQL roles');
  });

  it('accepts split role names', () => {
    expect(() => assertDistinctRoles([
      entry('control_runtime', 'control'),
      entry('control_migration', 'migration'),
      entry('control_maintenance', 'maintenance'),
      entry('control_backup', 'backup'),
      entry('analytics_readonly', 'readonly'),
      entry('analytics_ingest', 'ingest'),
      entry('analytics_migration', 'migration'),
      entry('analytics_backup', 'backup'),
    ])).not.toThrow();
  });

  it('requires verified TLS in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.COMMERCE_PG_SSL = '1';
    process.env.COMMERCE_PG_REJECT_UNAUTHORIZED = '1';
    process.env.COMMERCE_PG_CA = 'line-1\\nline-2';
    expect(sslOptions()).toEqual({ rejectUnauthorized: true, ca: 'line-1\nline-2' });
    process.env.COMMERCE_PG_REJECT_UNAUTHORIZED = '0';
    expect(() => sslOptions()).toThrow('verified PostgreSQL TLS');
  });
});

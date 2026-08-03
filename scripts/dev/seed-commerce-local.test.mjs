import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { assertLocalDatabase, buildRows } = require('./seed-commerce-local.js');

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe('Commerce local seed', () => {
  it('builds 120 days of valid multi-profile facts', () => {
    const rows = buildRows('tenant_local', new Date('2026-08-01T10:00:00.000Z'));
    expect(rows).toHaveLength(480);
    expect(new Set(rows.map((row) => row.metric_date)).size).toBe(120);
    expect(new Set(rows.map((row) => row.channel))).toEqual(
      new Set(['Search', 'Marketplace', 'Affiliate', 'Direct']),
    );
    expect(rows.every((row) => row.tenant_id === 'tenant_local')).toBe(true);
    expect(rows.filter((row) => row.sku === 'SKU-RISK' && row.stockout_hours >= 4)).toHaveLength(21);
  });

  it('only accepts loopback PostgreSQL URLs outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(() => assertLocalDatabase('postgresql://user:pass@127.0.0.1:35433/db')).not.toThrow();
    expect(() => assertLocalDatabase('postgresql://user:pass@db.internal:5432/db')).toThrow(
      'only accepts a loopback PostgreSQL host',
    );
    process.env.NODE_ENV = 'production';
    expect(() => assertLocalDatabase('postgresql://user:pass@127.0.0.1:35433/db')).toThrow(
      'disabled in production',
    );
  });
});

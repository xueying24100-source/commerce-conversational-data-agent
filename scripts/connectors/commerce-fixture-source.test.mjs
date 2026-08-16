import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import fixtureSource from './commerce-fixture-source.js';

const {
  FrozenCommerceFixtureAdapterV1,
  loadCommerceFixtureSource,
} = fixtureSource;

const root = path.resolve(import.meta.dirname, '..', '..');
const publicFixtureId = 'olist-same-source-derived-v1';

describe('frozen Commerce fixture source', () => {
  it('loads the allowlisted public Demo through the Connector transport contract', async () => {
    const loaded = await loadCommerceFixtureSource(
      { type: 'commerce_fixture', fixtureId: publicFixtureId },
      null,
      { maxBytes: 10_000_000 },
    );

    expect(loaded.transport).toBe('commerce_fixture');
    expect(loaded.unchanged).not.toBe(true);
    expect(loaded.records).toHaveLength(loaded.sourceRows);
    expect(loaded.sourceRows).toBeGreaterThan(0);
    expect(loaded.coverageProof).toEqual(expect.objectContaining({
      kind: 'complete_snapshot',
      coverageStart: '2018-01-01',
      coverageEnd: '2018-05-20',
    }));
    expect(loaded.records[0]).toEqual(expect.objectContaining({
      data_mode: 'snapshot',
      business_timezone: 'America/Sao_Paulo',
      currency_code: 'BRL',
      available_metrics: ['gmv', 'paid_orders', 'units', 'visits'],
    }));
  });

  it('uses the frozen artifact digest as an unchanged checkpoint', async () => {
    const adapter = new FrozenCommerceFixtureAdapterV1(publicFixtureId);
    const loaded = await loadCommerceFixtureSource(
      { type: 'commerce_fixture', fixtureId: publicFixtureId },
      adapter.artifact.sha256,
      { maxBytes: 10_000_000 },
      { allowUnchanged: true },
    );

    expect(loaded).toEqual({
      unchanged: true,
      checkpointAfter: adapter.artifact.sha256,
      sourceSha256: adapter.artifact.sha256,
      transport: 'commerce_fixture',
    });
  });

  it('rejects fixtures outside the frozen allowlist', () => {
    expect(() => new FrozenCommerceFixtureAdapterV1('../untrusted.json'))
      .toThrow(/not allowlisted/u);
  });

  it('keeps the database audit enum aligned with the adapter transport', () => {
    const migration = fs.readFileSync(
      path.join(root, 'migrations', 'commerce-analytics.sql'),
      'utf8',
    );
    expect(migration).toMatch(
      /commerce_connector_runs_transport_check[\s\S]*commerce_fixture/u,
    );
  });
});

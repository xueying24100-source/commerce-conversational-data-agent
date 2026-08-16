import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  createContractFixtureAssets,
  createOlistDerivedSnapshot,
  sha256Json,
} = require('./commerce-data-contract.js');
const {
  OLIST_DATASET_MANIFEST,
  manifestSha256,
} = require('../connectors/olist-public-source.js');

const contractRoot = new URL('../../contracts/commerce-data-contract/v1/', import.meta.url);

function readJson(relativePath) {
  return JSON.parse(readFileSync(new URL(relativePath, contractRoot), 'utf8'));
}

describe('frozen Commerce data-contract artifacts', () => {
  it('pins the actual public-source revision, license, file digests and composite SHA', () => {
    const sourceManifest = readJson('source-manifest.json');
    const olist = sourceManifest.sources.find((source) => source.sourceId === 'olist-public-orders');

    expect(olist.revision).toBe(OLIST_DATASET_MANIFEST.revision);
    expect(olist.license).toMatchObject({ id: 'MIT' });
    expect(olist.upstreamManifestSha256).toBe(manifestSha256(OLIST_DATASET_MANIFEST));
    expect(olist.files).toHaveLength(5);
    expect(olist.files.every((file) => /^sha256:[a-f0-9]{64}$/u.test(file.sha256))).toBe(true);
  });

  it('reproduces both fixture digests from fixed seeds and lineage', () => {
    const expected = createContractFixtureAssets();
    const manifest = readJson('fixture-manifest.json');
    const olist = readJson('fixtures/olist-same-source-derived-v1.json');
    const compatible = readJson('fixtures/controlled-compatible-v1.json');

    expect(sha256Json(olist)).toBe(manifest.artifacts.find(
      (artifact) => artifact.id === 'olist-same-source-derived-v1',
    ).sha256);
    expect(sha256Json(compatible)).toBe(manifest.artifacts.find(
      (artifact) => artifact.id === 'controlled-compatible-v1',
    ).sha256);
    expect(olist).toEqual(expected.olist);
    expect(compatible).toEqual(expected.compatible);
  });

  it('does not silently describe generated visits as observed Olist sessions', () => {
    const snapshot = createOlistDerivedSnapshot();
    const sourceManifest = readJson('source-manifest.json');

    expect(snapshot.descriptor.capabilities.metrics.visits).toBe('derived');
    expect(snapshot.descriptor.lineage.generatedFields).toContain('visits');
    expect(sourceManifest.derivedFixture.prohibitions.join(' ')).toMatch(/Do not describe derived fields/u);
  });

  it('keeps demo drill-down dimensions independently recombinable', () => {
    const snapshots = [
      createOlistDerivedSnapshot(),
      createContractFixtureAssets().compatible,
    ];
    for (const snapshot of snapshots) {
      const rows = snapshot.records;
      const dimensionCount = (field) => new Set(rows.map((row) => row[field])).size;
      const pairCount = (left, right) => new Set(rows.map((row) => `${row[left]}\u001f${row[right]}`)).size;
      expect(pairCount('region', 'channel')).toBeGreaterThan(dimensionCount('channel'));
      expect(pairCount('channel', 'category')).toBeGreaterThan(dimensionCount('category'));
      expect(pairCount('region', 'category')).toBeGreaterThan(dimensionCount('category'));
      expect(new Set(rows.map((row) => row.sku)).size).toBeGreaterThan(4);
    }
  });

  it('contains both positive and negative channel movement in the flagship diagnostic window', () => {
    const snapshot = createOlistDerivedSnapshot();
    const totals = (start, end) => {
      const output = new Map();
      for (const row of snapshot.records) {
        if (row.metric_date < start || row.metric_date > end) continue;
        output.set(row.channel, (output.get(row.channel) || 0) + row.gmv);
      }
      return output;
    };
    const baseline = totals('2018-04-30', '2018-05-06');
    const current = totals('2018-05-07', '2018-05-13');
    const changes = [...current].map(([channel, value]) => value - baseline.get(channel));
    expect(changes.some((value) => value > 0)).toBe(true);
    expect(changes.some((value) => value < 0)).toBe(true);
  });
});

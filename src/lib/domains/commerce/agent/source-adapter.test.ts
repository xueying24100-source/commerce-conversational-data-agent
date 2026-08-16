import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COMMERCE_DATA_CONTRACT_VERSION,
  type CommerceSourceAdapterInputV1,
  type CommerceSourceAdapterV1,
  type CommerceSourceSnapshotV1,
  validateCommerceSourceSnapshotV1,
} from './source-adapter';

function readSnapshot(relativePath: string): CommerceSourceSnapshotV1 {
  return JSON.parse(readFileSync(
    new URL(`../../../../../${relativePath}`, import.meta.url),
    'utf8',
  )) as CommerceSourceSnapshotV1;
}

class FrozenFixtureAdapter implements CommerceSourceAdapterV1 {
  readonly descriptor;

  constructor(private readonly snapshot: CommerceSourceSnapshotV1) {
    this.descriptor = snapshot.descriptor;
  }

  async loadSnapshot(input: CommerceSourceAdapterInputV1): Promise<CommerceSourceSnapshotV1> {
    if (input.signal?.aborted) throw new Error('Source Adapter request was aborted.');
    if (input.virtualAsOf !== this.snapshot.coverage.virtualAsOf) {
      throw new Error('Frozen fixture only supports its declared virtualAsOf instant.');
    }
    return structuredClone(this.snapshot);
  }
}

const olistSnapshot = readSnapshot(
  'contracts/commerce-data-contract/v1/fixtures/olist-same-source-derived-v1.json',
);
const compatibleSnapshot = readSnapshot(
  'contracts/commerce-data-contract/v1/fixtures/controlled-compatible-v1.json',
);

describe('commerce-data-contract/v1 Source Adapter boundary', () => {
  it.each([
    ['Olist same-source derived', olistSnapshot],
    ['controlled compatible', compatibleSnapshot],
  ])('accepts the %s fixture through the same Adapter interface', async (_name, snapshot) => {
    const adapter: CommerceSourceAdapterV1 = new FrozenFixtureAdapter(snapshot);
    const loaded = await adapter.loadSnapshot({ virtualAsOf: snapshot.coverage.virtualAsOf });

    expect(adapter.descriptor.contractVersion).toBe(COMMERCE_DATA_CONTRACT_VERSION);
    expect(() => validateCommerceSourceSnapshotV1(loaded)).not.toThrow();
    expect(loaded.records.length).toBeGreaterThan(0);
    expect(loaded.partitions).toHaveLength(140);
  });

  it('fails closed when a flagship capability is missing', () => {
    const invalid = structuredClone(olistSnapshot);
    invalid.descriptor.capabilities.metrics.visits = 'unavailable';

    expect(() => validateCommerceSourceSnapshotV1(invalid)).toThrow(
      /Flagship metric capability is unavailable: visits/u,
    );
  });

  it('accepts ready zero-fact partitions but rejects a missing required date', () => {
    const zeroDay = structuredClone(olistSnapshot);
    const date = zeroDay.coverage.start;
    zeroDay.records = zeroDay.records.filter((row) => row.metric_date !== date);
    const zeroPartition = zeroDay.partitions.find((partition) => partition.date === date);
    if (!zeroPartition) throw new Error('Expected fixture partition is missing.');
    zeroPartition.factRowCount = 0;
    expect(() => validateCommerceSourceSnapshotV1(zeroDay)).not.toThrow();

    zeroPartition.completeness = 'missing';
    expect(() => validateCommerceSourceSnapshotV1(zeroDay)).toThrow(/is not ready/u);
  });

  it('rejects duplicate serving-grain primary keys', () => {
    const invalid = structuredClone(compatibleSnapshot);
    invalid.records.push(structuredClone(invalid.records[0]));
    invalid.partitions[0].factRowCount += 1;

    expect(() => validateCommerceSourceSnapshotV1(invalid)).toThrow(/Duplicate Commerce primary key/u);
  });

  it('keeps native Olist daily paid orders and GMV exact after derived allocation', () => {
    const base = JSON.parse(readFileSync(
      new URL(
        '../../../../../contracts/commerce-data-contract/v1/sources/olist-base-daily-totals-v1.json',
        import.meta.url,
      ),
      'utf8',
    )) as { days: Array<{ date: string; paidOrders: number; gmvMinor: number }> };
    const actual = new Map<string, { paidOrders: number; gmvMinor: number }>();
    for (const row of olistSnapshot.records) {
      const current = actual.get(row.metric_date) || { paidOrders: 0, gmvMinor: 0 };
      current.paidOrders += row.paid_orders;
      current.gmvMinor += Math.round(row.gmv * 100);
      actual.set(row.metric_date, current);
    }

    expect(base.days.map((day) => ({ date: day.date, ...actual.get(day.date) }))).toEqual(
      base.days,
    );
    expect(olistSnapshot.descriptor.lineage.generatedFields).toContain('visits');
    expect(olistSnapshot.descriptor.capabilities.metrics.visits).toBe('derived');
  });
});

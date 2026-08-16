import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  manifestRevision,
  restoreEvidence,
  writeRestoreEvidence,
} = require('./restore-commerce-drill.js');
const {
  assertRestoreEvidence,
} = require('../checks/run-commerce-restore-evidence.js');
const {
  assertVerificationMatches,
  schemaFingerprint,
} = require('./commerce-backup-verification.js');

const files = [];

afterEach(() => {
  for (const filename of files.splice(0)) fs.rmSync(filename, { force: true });
});

function manifest(revision = 'abc1234') {
  const verification = {
    tableRows: { commerce_example: '3' },
    schemaSha256: `sha256:${'a'.repeat(64)}`,
    objectCounts: { columns: 4, constraints: 1 },
  };
  return {
    schemaVersion: 2,
    revision,
    createdAt: '2026-08-13T00:00:00.000Z',
    artifacts: [
      {
        name: 'control', file: 'control.dump', bytes: 10,
        sha256: `sha256:${'b'.repeat(64)}`,
        sourceDatabaseSha256: `sha256:${'d'.repeat(64)}`,
        verification,
      },
      {
        name: 'analytics', file: 'analytics.dump', bytes: 20,
        sha256: `sha256:${'c'.repeat(64)}`,
        sourceDatabaseSha256: `sha256:${'e'.repeat(64)}`,
        verification,
      },
    ],
  };
}

describe('Commerce restore drill evidence', () => {
  it('fingerprints canonical schema metadata and rejects any source/restore drift', () => {
    const catalog = { columns: [{ table_name: 'commerce_example', column_name: 'id' }] };
    expect(schemaFingerprint(catalog)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const expected = manifest().artifacts[0].verification;
    expect(assertVerificationMatches(expected, structuredClone(expected), 'control')).toEqual(expected);
    const changed = structuredClone(expected);
    changed.objectCounts.columns += 1;
    expect(() => assertVerificationMatches(expected, changed, 'control')).toThrow('does not match');
  });

  it('rejects a backup from another release revision', () => {
    expect(() => manifestRevision(manifest('old1234'), 'new1234'))
      .toThrow('does not match');
  });

  it('writes revision-bound evidence without database credentials', () => {
    const filename = path.join(
      process.cwd(),
      'tmp',
      `restore-evidence-${process.pid}-${Date.now()}.json`,
    );
    files.push(filename);
    const verification = manifest().artifacts[0].verification;
    const report = restoreEvidence(manifest(), [
      { name: 'control', verification },
      { name: 'analytics', verification },
    ], 'abc1234');

    writeRestoreEvidence(report, { COMMERCE_RESTORE_DRILL_EVIDENCE_PATH: filename });
    expect(assertRestoreEvidence(JSON.parse(fs.readFileSync(filename, 'utf8')), 'abc1234'))
      .toEqual(report);
    const source = fs.readFileSync(filename, 'utf8');
    expect(source).not.toMatch(/postgres(?:ql)?:\/\//u);
    expect(source).not.toContain('password');
  });

  it('requires both restored databases in formal release evidence', () => {
    const report = restoreEvidence(manifest(), [{
      name: 'control',
      verification: manifest().artifacts[0].verification,
    }], 'abc1234');
    expect(() => assertRestoreEvidence(report, 'abc1234'))
      .toThrow('control and analytics');
  });

  it('rejects a restored row/schema snapshot that differs from the backup manifest', () => {
    const source = manifest();
    const report = restoreEvidence(source, source.artifacts.map((artifact) => ({
      name: artifact.name,
      verification: structuredClone(artifact.verification),
    })), 'abc1234');
    report.results[0].verification.tableRows.commerce_example = '4';
    expect(() => assertRestoreEvidence(report, 'abc1234')).toThrow('does not match');
  });
});

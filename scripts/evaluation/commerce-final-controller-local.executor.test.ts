import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LOCAL_CONTROLLER_VERSION,
  runLocalControllerCase,
  type CommerceFinalManifestCase,
} from './commerce-final-controller-local';

const outputPath = process.env.COMMERCE_LOCAL_CONTROLLER_EXECUTOR_OUTPUT?.trim() || '';
const enabled = Boolean(outputPath);

describe.skipIf(!enabled)('Commerce final-100 local Controller execution process', () => {
  it('writes raw runtime results without loading a scoring Oracle', async () => {
    const manifestPath = path.join(
      process.cwd(),
      'quality',
      'commerce-agent-eval',
      'v1',
      'final-manifest.json',
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      schemaVersion: number;
      suiteId: string;
      cases: CommerceFinalManifestCase[];
    };
    expect(manifest.cases).toHaveLength(100);
    const cases = [];
    for (const [index, scenario] of manifest.cases.entries()) {
      const output = await runLocalControllerCase(scenario);
      cases.push({
        caseId: scenario.caseId,
        fixtureSnapshotSha256: output.fixtureSnapshotSha256,
        result: output.result,
      });
      if ((index + 1) % 10 === 0) {
        process.stdout.write(`[local-controller-executor] ${index + 1}/100\n`);
      }
    }
    const artifact = {
      schemaVersion: 1,
      service: 'commerce-data-agent',
      contract: 'commerce-final-controller-local-raw/v1',
      suiteId: manifest.suiteId,
      revision: process.env.COMMERCE_RELEASE_REVISION || 'working-tree',
      manifestSha256: process.env.COMMERCE_FINAL_MANIFEST_SHA256 || null,
      controllerVersion: LOCAL_CONTROLLER_VERSION,
      cases,
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    expect(cases.map((item) => item.caseId)).toEqual(manifest.cases.map((item) => item.caseId));
  }, 600_000);
});

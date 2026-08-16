#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const probeDirectory = path.join(root, 'tmp', 'next-env-isolation');
const probeName = 'COMMERCE_NEXT_ENV_ISOLATION_PROBE';
const probeValue = 'local-file-must-not-enter-release';
const nextEnvModule = require.resolve('@next/env');
const childSource = `
  const { loadEnvConfig } = require(${JSON.stringify(nextEnvModule)});
  loadEnvConfig(process.cwd(), false);
  const expected = process.argv[1];
  const actual = process.env.${probeName};
  process.exit((expected === 'loaded' && actual === ${JSON.stringify(probeValue)})
    || (expected === 'isolated' && actual === undefined) ? 0 : 1);
`;

function runProbe(expected, extraEnvironment = {}) {
  const environment = { ...process.env, ...extraEnvironment };
  delete environment[probeName];
  if (!Object.prototype.hasOwnProperty.call(extraEnvironment, '__NEXT_PROCESSED_ENV')) {
    delete environment.__NEXT_PROCESSED_ENV;
  }
  return spawnSync(process.execPath, ['-e', childSource, expected], {
    cwd: probeDirectory,
    env: environment,
    encoding: 'utf8',
    shell: false,
  });
}

try {
  fs.rmSync(probeDirectory, { recursive: true, force: true });
  fs.mkdirSync(probeDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(probeDirectory, '.env.local'),
    `${probeName}=${probeValue}\n`,
    'utf8',
  );

  const control = runProbe('loaded');
  if (control.status !== 0) {
    throw new Error('control process could not load the harmless .env.local probe.');
  }

  const isolated = runProbe('isolated', { __NEXT_PROCESSED_ENV: 'true' });
  if (isolated.status !== 0) {
    throw new Error('Next.js injected .env.local despite release environment isolation.');
  }

  console.log('[next-env-isolation] OK local dotenv files cannot alter release subprocesses.');
} catch (error) {
  console.error('[next-env-isolation] FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  fs.rmSync(probeDirectory, { recursive: true, force: true });
}

#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { withNextArtifactLock } = require('../shared/next-artifact-lock');

const rootDir = path.join(__dirname, '..', '..');
const nodeModules = path.join(rootDir, 'node_modules');
const nextCli = path.join(nodeModules, 'next', 'dist', 'bin', 'next');
const typescriptCli = path.join(nodeModules, 'typescript', 'bin', 'tsc');

function run(script, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        ...env,
      },
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${script} ${args.join(' ')} exited with code ${code ?? 'null'}, signal ${signal ?? 'null'}`));
    });
  });
}

async function main() {
  await withNextArtifactLock(rootDir, 'type-check', async () => {
    // `next typegen` does not remove types for deleted App Router entries.
    // Rebuild this generated directory so removed product routes cannot leave
    // stale imports that look like source errors.
    fs.rmSync(path.join(rootDir, '.next', 'types'), { recursive: true, force: true });
    await run(nextCli, ['typegen']);
    // Next dev owns .next/dev/types and may rewrite those files while tsc is
    // reading them. Typegen emits the stable route contract under .next/types,
    // so the deterministic check deliberately excludes the live dev tree.
    await run(typescriptCli, ['--noEmit', '--project', 'tsconfig.data-agent.json']);
  });
}

main().catch((error) => {
  console.error('[type-check] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

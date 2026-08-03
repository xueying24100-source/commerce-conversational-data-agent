#!/usr/bin/env node

/**
 * Production build entry point for the Commerce Operations Data Agent.
 * The build is serialized with type generation so `.next` is never read and
 * written by two validation commands at the same time.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { withNextArtifactLock } = require('../shared/next-artifact-lock');

const rootDir = path.join(__dirname, '..', '..');
const nextCli = path.join(rootDir, 'node_modules', 'next', 'dist', 'bin', 'next');
const workerBuild = path.join(rootDir, 'scripts', 'build', 'build-commerce-worker.js');

function runNextBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [nextCli, 'build', '--webpack'],
      {
        cwd: rootDir,
        stdio: 'inherit',
        shell: false,
        env: {
          ...process.env,
          NEXT_TELEMETRY_DISABLED: '1',
        },
      },
    );
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`next build exited with code ${code ?? 'null'}, signal ${signal ?? 'null'}`));
    });
  });
}

function runWorkerBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerBuild], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`commerce worker build exited with code ${code ?? 'null'}, signal ${signal ?? 'null'}`));
    });
  });
}

async function main() {
  await withNextArtifactLock(rootDir, 'production build', async () => {
    fs.rmSync(path.join(rootDir, '.next', 'dev', 'types'), {
      recursive: true,
      force: true,
    });
    await runNextBuild();
    await runWorkerBuild();
  });
}

main().catch((error) => {
  console.error('[build] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});

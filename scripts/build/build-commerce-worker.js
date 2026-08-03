#!/usr/bin/env node

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const output = path.join(root, '.next', 'commerce-worker');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

fs.rmSync(output, { recursive: true, force: true });
const child = spawn(process.execPath, [tsc, '--project', 'tsconfig.worker.json'], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});

child.on('error', (error) => {
  console.error('[commerce-worker-build] Failed:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[commerce-worker-build] Terminated by ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

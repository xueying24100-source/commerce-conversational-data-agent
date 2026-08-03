#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { loadLocalEnv } = require('../db/load-local-env');

const root = path.join(__dirname, '..', '..');
const runtimeTemp = path.join(root, 'tmp', 'runtime-temp');
fs.mkdirSync(runtimeTemp, { recursive: true });
process.env.TEMP = runtimeTemp;
process.env.TMP = runtimeTemp;
loadLocalEnv(root);
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  console.warn('Ignoring NODE_TLS_REJECT_UNAUTHORIZED=0; local Commerce TLS verification remains enabled.');
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}
const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
const workerBuild = path.join(root, 'scripts', 'build', 'build-commerce-worker.js');
const worker = path.join(root, 'scripts', 'runtime', 'commerce-worker.js');

const built = spawnSync(process.execPath, [workerBuild], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
if (built.status !== 0) process.exit(built.status || 1);

const children = [
  spawn(process.execPath, [next, 'dev'], { cwd: root, stdio: 'inherit', shell: false }),
  spawn(process.execPath, [worker], { cwd: root, stdio: 'inherit', shell: false }),
];

let stopping = false;
function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}
for (const child of children) {
  child.on('exit', (code) => {
    if (!stopping) {
      stop();
      process.exitCode = code || 1;
    }
  });
}

#!/usr/bin/env node

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadLocalEnv } = require('../db/load-local-env');

const root = path.join(__dirname, '..', '..');
// Keep this OUTSIDE the project tree: Next.js/Turbopack's dev file watcher covers the
// whole project root, so any temp/log writes under root (including our own panic logs)
// re-trigger a rebuild. If that rebuild ever panics again, it writes another panic log
// back into the watched tree, which triggers another rebuild — a self-sustaining loop
// that starves the dev server and never lets the page finish loading.
const runtimeTemp = path.join(os.tmpdir(), 'commerce-data-agent-runtime-temp');
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

let stopping = false;
let workerRestartTimer = null;
let workerRestartAttempts = 0;
const children = new Set();

const nextServer = spawn(process.execPath, [
  next,
  'dev',
  '--webpack',
  '--hostname',
  '127.0.0.1',
], {
  cwd: root,
  stdio: 'inherit',
  shell: false,
});
children.add(nextServer);

function startWorker() {
  if (stopping) return;

  const workerProcess = spawn(process.execPath, [worker], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  children.add(workerProcess);

  workerProcess.on('exit', (code, signal) => {
    children.delete(workerProcess);
    if (stopping) return;

    workerRestartAttempts += 1;
    const retryDelay = Math.min(1000 * (2 ** (workerRestartAttempts - 1)), 10000);
    const reason = signal ? `signal ${signal}` : `code ${code ?? 1}`;
    console.warn(`Commerce worker exited with ${reason}; keeping Next.js online and retrying in ${retryDelay}ms.`);
    workerRestartTimer = setTimeout(startWorker, retryDelay);
  });
}

startWorker();

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  if (workerRestartTimer) clearTimeout(workerRestartTimer);
  for (const child of children) child.kill(signal);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => stop(signal));
}
nextServer.on('exit', (code) => {
  if (!stopping) {
    stop();
    process.exitCode = code || 1;
  }
});

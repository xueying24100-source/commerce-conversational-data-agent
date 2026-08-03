#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('node:path');
const { loadLocalEnv } = require('../db/load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

const connectionString = process.env.COMMERCE_TEST_DATABASE_URL?.trim();
if (!connectionString) {
  console.error('COMMERCE_TEST_DATABASE_URL is required for the Commerce PostgreSQL integration gate.');
  process.exit(1);
}
if (process.env.COMMERCE_TEST_DATABASE_CONFIRM !== 'commerce-integration') {
  console.error(
    'Set COMMERCE_TEST_DATABASE_CONFIRM=commerce-integration only for a disposable test database.',
  );
  process.exit(1);
}
try {
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname) {
    throw new Error('invalid PostgreSQL URL');
  }
} catch {
  console.error('COMMERCE_TEST_DATABASE_URL must be an explicit PostgreSQL URL.');
  process.exit(1);
}

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const child = spawn(process.execPath, [
  vitest,
  'run',
  'src/lib/domains/commerce/agent/postgres.integration.test.ts',
], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (error) => {
  console.error('Unable to start the Commerce integration gate:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Commerce integration gate terminated by ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

#!/usr/bin/env node

const { spawn } = require('node:child_process');
const path = require('node:path');
const { loadLocalEnv } = require('../db/load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  console.warn('Ignoring NODE_TLS_REJECT_UNAUTHORIZED=0 for live E2E; TLS verification remains enabled.');
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

const connectionString = process.env.COMMERCE_LIVE_E2E_DATABASE_URL?.trim();
const model = process.env.COMMERCE_LIVE_E2E_MODEL?.trim() || 'deepseek-v4-flash';
if (!connectionString) {
  console.error('COMMERCE_LIVE_E2E_DATABASE_URL is required for the live Commerce E2E gate.');
  process.exit(1);
}
if (process.env.COMMERCE_LIVE_E2E_CONFIRM !== 'commerce-live-e2e') {
  console.error('Set COMMERCE_LIVE_E2E_CONFIRM=commerce-live-e2e only for a disposable test database.');
  process.exit(1);
}
try {
  const parsed = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname) {
    throw new Error('invalid PostgreSQL URL');
  }
} catch {
  console.error('COMMERCE_LIVE_E2E_DATABASE_URL must be an explicit PostgreSQL URL.');
  process.exit(1);
}

const credential = model === 'deepseek-v4-flash'
  ? process.env.DEEPSEEK_API_KEY
  : process.env.MODELPORT_API_KEY;
if (!String(credential || '').trim()) {
  console.error(`A real model credential is required for ${model}; live E2E cannot be skipped.`);
  process.exit(1);
}

const requiredArtifacts = [
  path.join(root, '.next', 'BUILD_ID'),
  path.join(
    root,
    '.next',
    'commerce-worker',
    'src',
    'workers',
    'commerce-agent-worker.js',
  ),
];
if (requiredArtifacts.some((artifact) => !require('node:fs').existsSync(artifact))) {
  console.error('Current production Web and Worker artifacts are required. Run npm run build first.');
  process.exit(1);
}

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const child = spawn(process.execPath, [
  vitest,
  'run',
  'src/lib/domains/commerce/agent/live-process-e2e.test.ts',
], {
  cwd: root,
  stdio: 'inherit',
  env: {
    ...process.env,
    COMMERCE_DATABASE_URL: connectionString,
    COMMERCE_ANALYTICS_DATABASE_URL: connectionString,
    COMMERCE_LIVE_E2E_MODEL: model,
    COMMERCE_LLM_AGENT_ENABLED: '1',
  },
});

child.on('error', (error) => {
  console.error('Unable to start the Commerce live E2E gate:', error.message);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`Commerce live E2E gate terminated by ${signal}.`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});

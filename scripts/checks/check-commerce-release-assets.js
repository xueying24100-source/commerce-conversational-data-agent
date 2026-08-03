#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = new Set(Object.keys(packageJson.scripts || {}));
const requiredFiles = [
  '.env.production.example',
  '.env.release.example',
  'Dockerfile',
  'deploy/nginx/commerce-agent.conf.template',
  'deploy/systemd/commerce-data-agent.service',
  'deploy/systemd/commerce-data-agent-worker.service',
  'deploy/systemd/commerce-data-agent-cleanup.service',
  'deploy/systemd/commerce-data-agent-cleanup.timer',
  'deploy/postgres/commerce-control-grants.sql',
  'deploy/postgres/commerce-analytics-grants.sql',
  'deploy/postgres/commerce-role-bootstrap.sql',
  'deploy/observability/prometheus/commerce-alerts.yml',
  'config/commerce-connector.example.json',
  'config/commerce-connector.olist.example.json',
  'config/commerce-connector.shopify.example.json',
  'docs/async-execution.md',
  'docs/connectors.md',
  'docs/e2e.md',
  'docs/observability.md',
  'docs/release-runbook.md',
  'migrations/commerce-analytics.sql',
  'migrations/commerce-control.sql',
  'scripts/checks/release-commerce.js',
  'scripts/checks/run-commerce-live-e2e.js',
  'scripts/checks/run-commerce-olist-live-e2e.js',
  'scripts/checks/run-commerce-soak.js',
  'scripts/checks/check-olist-demo.js',
  'scripts/connectors/shopify-source.js',
  'scripts/connectors/shopify-source.test.mjs',
  'scripts/connectors/olist-public-source.js',
  'scripts/connectors/olist-public-source.test.mjs',
  'scripts/db/verify-commerce-roles.js',
  'scripts/db/backup-commerce.js',
  'scripts/db/restore-commerce-drill.js',
  'scripts/dev/run-commerce-live-release.ps1',
  'scripts/runtime/production-env.js',
  'src/lib/domains/commerce/agent/live-e2e.integration.test.ts',
];
const workflowDirectory = path.join(root, '.github', 'workflows');
const errors = [];
const workflowSources = new Map();

for (const relativePath of requiredFiles) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    errors.push(`missing release asset: ${relativePath}`);
  }
}

for (const filename of fs.readdirSync(workflowDirectory)) {
  if (!filename.endsWith('.yml') && !filename.endsWith('.yaml')) continue;
  const relativePath = path.posix.join('.github/workflows', filename);
  const source = fs.readFileSync(path.join(workflowDirectory, filename), 'utf8');
  workflowSources.set(filename, source);
  for (const match of source.matchAll(/\bnpm\s+run\s+([A-Za-z0-9:_-]+)/gu)) {
    if (!scripts.has(match[1])) {
      errors.push(`${relativePath} references missing npm script: ${match[1]}`);
    }
  }
  if (/\b(?:prisma:generate|dev:market|benchmark:quant:e2e|eval:ci:e2e)\b/u.test(source)) {
    errors.push(`${relativePath} still contains a removed finance release command.`);
  }
}

for (const [filename, requiredScript] of [
  ['quality.yml', 'test:integration:commerce'],
  ['eval-nightly.yml', 'test:e2e:commerce:live'],
  ['release-evidence.yml', 'release:check:evidence'],
]) {
  const source = workflowSources.get(filename) || '';
  if (!source.includes(`npm run ${requiredScript}`)) {
    errors.push(`.github/workflows/${filename} must run npm script: ${requiredScript}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`[commerce-release-assets] FAIL ${error}`);
  process.exit(1);
}

console.log('[commerce-release-assets] OK workflows and production assets match package.json.');

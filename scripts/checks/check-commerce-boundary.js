#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PRODUCT_ROOTS = [
  'src/app/commerce',
  'src/app/api/commerce',
  'src/app/api/health/ready',
  'src/lib/domains/commerce/agent',
];

function filesUnder(relativeRoot) {
  const absoluteRoot = path.join(ROOT, relativeRoot);
  if (!fs.existsSync(absoluteRoot)) return [];
  const output = [];
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) output.push(...filesUnder(relativePath));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) output.push(relativePath);
  }
  return output;
}

function directoryHasFiles(absoluteRoot) {
  for (const entry of fs.readdirSync(absoluteRoot, { withFileTypes: true })) {
    const target = path.join(absoluteRoot, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && directoryHasFiles(target)) return true;
  }
  return false;
}

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exitCode = 1;
}

const forbiddenProductText = [
  '@/lib/domains/finance',
  '@/lib/quant',
  'services/market-data',
  '/api/research',
  'fixtures/commerce',
  'demoMode',
  'deterministic_fallback',
  'COMMERCE_ALLOW_RULE_FALLBACK',
  'loadCommerceConnectorData',
];

for (const file of PRODUCT_ROOTS.flatMap(filesUnder)) {
  const contents = fs.readFileSync(path.join(ROOT, file), 'utf8');
  for (const forbidden of forbiddenProductText) {
    if (contents.includes(forbidden)) {
      fail(`${file} must not reference removed demo/legacy boundary: ${forbidden}`);
    }
  }
}

for (const removedPath of [
  '.moagent',
  'benchmarks',
  'prisma',
  'services',
  'sqls',
  'src/components',
  'src/lib/data-agent',
  'src/lib/domains/finance',
  'src/lib/eval',
  'src/lib/quant',
  'src/app/research',
  'src/app/api/research',
  'fixtures/commerce',
  'src/lib/domains/commerce/runner.ts',
  'src/lib/domains/commerce/connector.ts',
  'src/lib/domains/commerce/semantic-planner.ts',
]) {
  if (!fs.existsSync(path.join(ROOT, removedPath))) continue;
  const stat = fs.statSync(path.join(ROOT, removedPath));
  if (stat.isFile()) fail(`Removed demo/legacy file still exists: ${removedPath}`);
  else if (directoryHasFiles(path.join(ROOT, removedPath))) {
    fail(`Removed demo/legacy directory still contains files: ${removedPath}`);
  }
}

for (const requiredPath of [
  'src/lib/domains/commerce/agent/runtime.ts',
  'src/lib/domains/commerce/agent/tools.ts',
  'src/lib/domains/commerce/agent/analytics-repository.ts',
  'src/lib/domains/commerce/agent/conversation-store.ts',
  'src/lib/domains/commerce/agent/evidence-ledger.ts',
  'src/lib/domains/commerce/agent/auth.ts',
  'src/lib/domains/commerce/agent/job-store.ts',
  'src/lib/domains/commerce/agent/worker.ts',
  'src/lib/domains/commerce/agent/metrics.ts',
  'src/workers/commerce-agent-worker.ts',
  'scripts/connectors/run-commerce-connector.js',
  'deploy/systemd/commerce-data-agent-worker.service',
  'migrations/commerce-control.sql',
  'migrations/commerce-analytics.sql',
]) {
  if (!fs.existsSync(path.join(ROOT, requiredPath))) fail(`Missing production component: ${requiredPath}`);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
if (!packageJson.dependencies?.pg) fail('Production Commerce package must depend on pg.');

const route = fs.readFileSync(path.join(ROOT, 'src/app/api/commerce/route.ts'), 'utf8');
if (!route.includes("fallback: 'disabled'")) fail('Metadata must declare that fallback is disabled.');

const analytics = fs.readFileSync(
  path.join(ROOT, 'src/lib/domains/commerce/agent/analytics-repository.ts'),
  'utf8',
);
if (!analytics.includes('tenant_id = $1')) fail('Analytics queries must enforce tenant scope.');
if (analytics.includes('SELECT *')) fail('Analytics repository must not use SELECT *.');

const controlMigration = fs.readFileSync(path.join(ROOT, 'migrations/commerce-control.sql'), 'utf8');
for (const table of [
  'commerce_agent_conversations',
  'commerce_agent_messages',
  'commerce_agent_runs',
  'commerce_agent_evidence',
  'commerce_agent_jobs',
  'commerce_agent_job_events',
  'commerce_agent_workers',
]) {
  if (!controlMigration.includes(table)) fail(`Control migration is missing table: ${table}`);
}
const analyticsMigration = fs.readFileSync(
  path.join(ROOT, 'migrations/commerce-analytics.sql'),
  'utf8',
);
if (!analyticsMigration.includes('commerce_daily_metrics')) {
  fail('Analytics migration is missing commerce_daily_metrics.');
}
if (!analyticsMigration.includes('FORCE ROW LEVEL SECURITY')) {
  fail('Analytics migration must force tenant row-level security.');
}
if (!analyticsMigration.includes('commerce_refresh_tenant_catalog')) {
  fail('Analytics migration must expose the tenant-scoped catalog refresh function.');
}
for (const table of ['commerce_connector_checkpoints', 'commerce_connector_runs']) {
  if (!analyticsMigration.includes(table)) {
    fail(`Analytics migration is missing connector table: ${table}`);
  }
}
if (!analyticsMigration.includes('commerce_connector_runs_active_idx')) {
  fail('Analytics migration must prevent concurrent runs of the same connector.');
}
if (/TRUNCATE\s+TABLE\s+(?:commerce_entity_catalog|commerce_tenant_data_status)/iu.test(
  analyticsMigration,
)) {
  fail('Analytics migration must not truncate service catalogs during schema deployment.');
}

const service = fs.readFileSync(
  path.join(ROOT, 'src/lib/domains/commerce/agent/service.ts'),
  'utf8',
);
if (!service.includes("set_config('commerce.tenant_id'")) {
  fail('Analytics snapshots must set a transaction-local tenant for RLS.');
}

const evidenceLedger = fs.readFileSync(
  path.join(ROOT, 'src/lib/domains/commerce/agent/evidence-ledger.ts'),
  'utf8',
);
if (!evidenceLedger.includes('validateClaim') || !evidenceLedger.includes('resolveJsonPointer')) {
  fail('Final Commerce answers must use field-level evidence claims.');
}

if (!fs.existsSync(path.join(
  ROOT,
  'src/lib/domains/commerce/agent/postgres.integration.test.ts',
))) {
  fail('Commerce release must include disposable PostgreSQL concurrency integration tests.');
}

const moduleBoundaries = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config/module-boundaries.json'), 'utf8'),
);
const activeModuleIds = (moduleBoundaries.modules || []).map((module) => String(module.id));
if (activeModuleIds.some((id) => /finance|quant|eval|market-data/iu.test(id))) {
  fail('config/module-boundaries.json still defines an active finance platform module.');
}
const serviceCatalog = fs.readFileSync(path.join(ROOT, 'config/service-catalog.json'), 'utf8');
if (/finance-domain|quant-core|market-data-backend|TimescaleDB|ClickHouse|Prisma/iu.test(
  serviceCatalog,
)) {
  fail('config/service-catalog.json still describes a removed finance platform service.');
}

if (!process.exitCode) {
  console.log('OK: Commerce production boundary excludes fixtures, deterministic fallback, finance and arbitrary SQL.');
}

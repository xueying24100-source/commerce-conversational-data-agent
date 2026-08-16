#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const scripts = new Set(Object.keys(packageJson.scripts || {}));
const requiredFiles = [
  '.editorconfig',
  '.gitattributes',
  '.node-version',
  '.nvmrc',
  '.env.example',
  '.env.production.example',
  '.env.release.example',
  'Dockerfile',
  'docker-compose.yml',
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
  'docs/acceptance-status.md',
  'docs/connectors.md',
  'docs/e2e.md',
  'docs/interview-guide.md',
  'docs/observability.md',
  'docs/repository-layout.md',
  'docs/release-runbook.md',
  'contracts/README.md',
  'contracts/commerce-data-contract/v1/contract.json',
  'contracts/commerce-data-contract/v1/source-manifest.json',
  'contracts/commerce-data-contract/v1/fixture-manifest.json',
  'quality/commerce-agent-eval/v1/hash-lock.json',
  'quality/commerce-agent-eval/v1/dev-manifest.json',
  'quality/commerce-agent-eval/v1/final-manifest.json',
  'quality/README.md',
  'quality/commerce-agent-feishu-sandbox/v1/README.md',
  'quality/commerce-agent-usability/v1/README.md',
  'migrations/commerce-analytics.sql',
  'migrations/commerce-control.sql',
  'scripts/checks/release-commerce.js',
  'scripts/checks/check-next-env-isolation.js',
  'scripts/checks/smoke-commerce-image.js',
  'scripts/checks/smoke-commerce-image.test.mjs',
  'scripts/checks/run-commerce-live-e2e.js',
  'scripts/checks/run-commerce-olist-live-e2e.js',
  'scripts/e2e/commerce_browser_e2e.py',
  'scripts/e2e/run_commerce_browser_e2e.py',
  'scripts/e2e/requirements-browser-e2e.txt',
  'scripts/evaluation/generate-commerce-eval-assets.js',
  'scripts/evaluation/run-commerce-real-model-eval.js',
  'scripts/evaluation/run-commerce-final-controller-eval.js',
  'scripts/evaluation/run-commerce-final-controller-eval.test.mjs',
  'scripts/evaluation/run-commerce-performance.js',
  'scripts/checks/run-commerce-soak.js',
  'scripts/checks/check-olist-demo.js',
  'scripts/connectors/shopify-source.js',
  'scripts/connectors/shopify-source.test.mjs',
  'scripts/connectors/olist-public-source.js',
  'scripts/connectors/olist-public-source.test.mjs',
  'scripts/db/verify-commerce-roles.js',
  'scripts/db/backup-commerce.js',
  'scripts/db/commerce-backup-verification.js',
  'scripts/db/restore-commerce-drill.js',
  'scripts/db/restore-commerce-drill.test.mjs',
  'scripts/checks/run-commerce-restore-evidence.js',
  'scripts/checks/check-commerce-external-evidence.js',
  'scripts/checks/check-commerce-external-evidence.test.mjs',
  'scripts/dev/run-commerce-live-release.ps1',
  'scripts/runtime/production-env.js',
  'src/lib/domains/commerce/agent/live-e2e.integration.test.ts',
];
const workflowDirectory = path.join(root, '.github', 'workflows');
const errors = [];
const workflowSources = new Map();
const ignoredMarkdownDirectories = new Set([
  '.git',
  '.git-old-backup',
  '.next',
  '.claude',
  '.vscode',
  'coverage',
  'data',
  'node_modules',
  'playwright-report',
  'test-results',
  'tmp',
]);

function collectMarkdownFiles(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredMarkdownDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collectMarkdownFiles(absolutePath));
    else if (entry.isFile() && entry.name.endsWith('.md')) result.push(absolutePath);
  }
  return result;
}

function checkLocalMarkdownLinks() {
  let checked = 0;
  const markdownLink = /!?\[[^\]]*\]\((<[^>]+>|[^)\s]+)(?:\s+["'][^)]*["'])?\)/gu;
  for (const markdownPath of collectMarkdownFiles(root)) {
    const source = fs.readFileSync(markdownPath, 'utf8');
    for (const match of source.matchAll(markdownLink)) {
      const rawTarget = match[1].replace(/^<|>$/gu, '');
      if (/^(?:#|https?:|mailto:|data:|\/)/u.test(rawTarget)) continue;
      let decodedTarget;
      try {
        decodedTarget = decodeURIComponent(rawTarget.split('#', 1)[0].split('?', 1)[0]);
      } catch {
        errors.push(`${path.relative(root, markdownPath)} has invalid link encoding: ${rawTarget}`);
        continue;
      }
      const resolved = path.resolve(path.dirname(markdownPath), decodedTarget);
      checked += 1;
      if (!fs.existsSync(resolved)) {
        errors.push(
          `${path.relative(root, markdownPath)} references missing local link: ${rawTarget}`,
        );
      }
    }
  }
  return checked;
}

for (const relativePath of requiredFiles) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    errors.push(`missing release asset: ${relativePath}`);
  }
}

const checkedMarkdownLinks = checkLocalMarkdownLinks();

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
  ['quality.yml', 'test:e2e:commerce:browser'],
  ['eval-nightly.yml', 'test:e2e:commerce:live'],
  ['eval-nightly.yml', 'eval:commerce:real-model'],
  ['release-evidence.yml', 'release:check:evidence'],
]) {
  const source = workflowSources.get(filename) || '';
  if (!source.includes(`npm run ${requiredScript}`)) {
    errors.push(`.github/workflows/${filename} must run npm script: ${requiredScript}`);
  }
}
const nightlyEvaluationWorkflow = workflowSources.get('eval-nightly.yml') || '';
if (!/echo "configured=false"[\s\S]{0,400}?::error::[\s\S]{0,400}?exit 1/u.test(
  nightlyEvaluationWorkflow,
)) {
  errors.push('eval-nightly.yml must fail closed when live-model credentials are absent.');
}
if (/Scheduled Commerce evaluation skipped/u.test(nightlyEvaluationWorkflow)) {
  errors.push('eval-nightly.yml must not report a successful zero-run scheduled evaluation.');
}

const expectedNodeVersion = '22.19.0';
const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const releaseSource = fs.readFileSync(path.join(root, 'scripts/checks/release-commerce.js'), 'utf8');
const releaseWorkflow = workflowSources.get('release-evidence.yml') || '';
const releaseEnvironmentExample = fs.readFileSync(
  path.join(root, '.env.release.example'),
  'utf8',
);
const releaseRunbook = fs.readFileSync(path.join(root, 'docs', 'release-runbook.md'), 'utf8');
if (!dockerfile.match(new RegExp(`FROM node:${expectedNodeVersion.replaceAll('.', '\\.')}-`, 'u'))) {
  errors.push(`Dockerfile must use Node ${expectedNodeVersion}.`);
}
if (!dockerfile.includes('/api/health/ready')) {
  errors.push('Dockerfile Web healthcheck must use /api/health/ready.');
}
if (!compose.includes('/api/health/ready') || !/worker:[\s\S]*?healthcheck:\s*\n\s+disable:\s+true/u.test(compose)) {
  errors.push('docker-compose.yml must probe Web readiness and disable the HTTP probe for Worker.');
}
if (!releaseSource.includes('final-image-production-smoke')
  || !releaseSource.includes('smoke-commerce-image.js')) {
  errors.push('Release evidence must run the final production image, not only build it.');
}
const roleDatabaseEnvironmentNames = [
  'COMMERCE_CONTROL_API_DATABASE_URL',
  'COMMERCE_CONTROL_WORKER_DATABASE_URL',
  'COMMERCE_ANALYTICS_DATABASE_URL',
  'COMMERCE_ANALYTICS_INGEST_DATABASE_URL',
  'COMMERCE_CONTROL_MAINTENANCE_DATABASE_URL',
  'COMMERCE_CONTROL_MIGRATION_DATABASE_URL',
  'COMMERCE_ANALYTICS_MIGRATION_DATABASE_URL',
  'COMMERCE_CONTROL_BACKUP_DATABASE_URL',
  'COMMERCE_ANALYTICS_BACKUP_DATABASE_URL',
];
const restoreDatabaseEnvironmentNames = [
  'COMMERCE_CONTROL_RESTORE_DRILL_DATABASE_URL',
  'COMMERCE_ANALYTICS_RESTORE_DRILL_DATABASE_URL',
];
if (!scripts.has('db:verify-roles:commerce')) {
  errors.push('package.json must expose db:verify-roles:commerce.');
}
if (!scripts.has('db:restore-evidence:commerce')) {
  errors.push('package.json must expose db:restore-evidence:commerce.');
}
if (!scripts.has('check:external-evidence:commerce')) {
  errors.push('package.json must expose check:external-evidence:commerce.');
}
if (!scripts.has('check:next-env-isolation')) {
  errors.push('package.json must expose check:next-env-isolation.');
}
for (const requiredScript of [
  'check:commerce-eval-assets',
  'test:commerce-eval',
  'test:e2e:commerce:browser',
  'test:performance:commerce',
  'eval:commerce:real-model',
  'eval:commerce:final-controller',
]) {
  if (!scripts.has(requiredScript)) errors.push(`package.json must expose ${requiredScript}.`);
}
for (const requiredText of [
  "'production-role-capabilities'",
  "npmArgs('run', 'db:verify-roles:commerce')",
  'role-capabilities-report.json',
  'restore-drill-report.json',
  "COMMERCE_DISABLE_LOCAL_ENV_FILES: '1'",
  "__NEXT_PROCESSED_ENV: 'true'",
  'createHash',
]) {
  if (!releaseSource.includes(requiredText)) {
    errors.push(`Release evidence role gate is missing: ${requiredText}`);
  }
}
if (!/if \(includeDocker\) \{[\s\S]*?checks\.push\(\[[\s\S]*?'production-role-capabilities',[\s\S]*?npmArgs\('run', 'db:verify-roles:commerce'\)[\s\S]*?roleEvidenceEnvironment,[\s\S]*?\);[\s\S]*?\}/u.test(
  releaseSource,
)) {
  errors.push('Production role capabilities must run only in the formal --docker evidence gate.');
}
if (!/const roleEvidenceEnvironment = \{[\s\S]*?NODE_ENV: 'production'[\s\S]*?COMMERCE_PG_SSL: '1'[\s\S]*?COMMERCE_ROLE_EVIDENCE_PATH/u.test(
  releaseSource,
)) {
  errors.push('Role verification must use production TLS and a dedicated evidence artifact.');
}
if (!/record\.evidence\s*=\s*\{[\s\S]*?sha256:[\s\S]*?revision:/u.test(releaseSource)) {
  errors.push('Release report must bind evidence artifacts by SHA-256 and revision.');
}
if (!/'production-role-capabilities':\s*roleEvidencePath/u.test(releaseSource)) {
  errors.push('Role evidence must be registered as a release evidence artifact.');
}
if (!/'restore-drill':\s*restoreEvidencePath/u.test(releaseSource)) {
  errors.push('Restore drill evidence must be registered as a release evidence artifact.');
}
if (!/'external-release-gates':\s*externalEvidencePath/u.test(releaseSource)
  || !releaseSource.includes("npmArgs('run', 'check:external-evidence:commerce')")) {
  errors.push('Formal release evidence must validate performance, Feishu, and usability artifacts.');
}
if (!/'final-controller-eval':\s*path\.join\(/u.test(releaseSource)
  || !releaseSource.includes("npmArgs('run', 'eval:commerce:final-controller')")
  || !releaseSource.includes('artifact.caseCount !== 100')) {
  errors.push('Formal release evidence must execute and bind the raw final-100 Controller gate.');
}
if (!/'browser-e2e':\s*path\.join\(root, 'tmp', 'commerce-browser-e2e', 'report\.json'\)/u.test(releaseSource)
  || !releaseSource.includes("npmArgs('run', 'test:e2e:commerce:browser')")) {
  errors.push('Browser E2E must run in the release gate and bind its revisioned evidence report.');
}
if (!releaseSource.includes("COMMERCE_BROWSER_E2E_SERVER_MODE: 'production'")
  || !releaseSource.includes("artifact.serverMode !== 'production'")) {
  errors.push('Browser E2E release evidence must execute and validate the production build.');
}
for (const [checkName, environmentName] of [
  ['release-assets', 'isolatedEnvironment'],
  ['next-env-isolation', 'isolatedEnvironment'],
  ['production-dependency-audit', 'isolatedEnvironment'],
  ['lint', 'isolatedEnvironment'],
  ['unit', 'isolatedEnvironment'],
  ['types', 'isolatedEnvironment'],
  ['boundary', 'isolatedEnvironment'],
  ['frozen-evaluation-assets', 'isolatedEnvironment'],
  ['browser-e2e', 'browserEnvironment'],
  ['postgres-integration', 'integrationEnvironment'],
  ['production-build', 'isolatedEnvironment'],
  ['live-model-e2e', 'liveEnvironment'],
  ['real-model-eval', 'realModelEvalEnvironment'],
  ['final-controller-eval', 'finalControllerEvalEnvironment'],
]) {
  const escapedName = checkName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const assignment = new RegExp(
    `'${escapedName}'[\\s\\S]{0,240}?${environmentName}`,
    'u',
  );
  if (!assignment.test(releaseSource)) {
    errors.push(`${checkName} must use ${environmentName}.`);
  }
}
if (!/docker-image[\s\S]{0,500}?isolatedEnvironment/u.test(releaseSource)
  || !/final-image-production-smoke[\s\S]{0,500}?finalImageSmokeEnvironment/u.test(
    releaseSource,
  )) {
  errors.push('Docker build and final-image smoke must use their isolated environments.');
}
for (const name of roleDatabaseEnvironmentNames) {
  if (!releaseSource.includes(`'${name}'`)) {
    errors.push(`Release evidence must isolate role credential: ${name}`);
  }
  if (!releaseWorkflow.includes(`${name}:`)
    || !releaseWorkflow.includes(`secrets.${name}`)) {
    errors.push(`release-evidence.yml must map protected secret: ${name}`);
  }
  if (!releaseEnvironmentExample.includes(`${name}=`)) {
    errors.push(`.env.release.example must document role credential: ${name}`);
  }
}
for (const name of restoreDatabaseEnvironmentNames) {
  if (!releaseSource.includes(`'${name}'`)) {
    errors.push(`Release evidence must isolate restore credential: ${name}`);
  }
  if (!releaseWorkflow.includes(`${name}:`)
    || !releaseWorkflow.includes(`secrets.${name}`)) {
    errors.push(`release-evidence.yml must map protected restore secret: ${name}`);
  }
  if (!releaseEnvironmentExample.includes(`${name}=`)) {
    errors.push(`.env.release.example must document restore credential: ${name}`);
  }
}
if (!/jobs:[\s\S]*?evidence:[\s\S]*?environment:\s*commerce-production-release/u.test(
  releaseWorkflow,
)) {
  errors.push('release-evidence.yml must bind the gate to commerce-production-release.');
}
if (!releaseRunbook.includes('role-capabilities-report.json')
  || !releaseRunbook.includes('七类职责')) {
  errors.push('Release runbook must document role evidence and seven responsibility groups.');
}
if (packageJson.engines?.node !== '22.19.x') {
  errors.push('package.json Node engine must stay aligned to the Node 22.19 production runtime.');
}
for (const filename of ['.node-version', '.nvmrc']) {
  const declared = fs.readFileSync(path.join(root, filename), 'utf8').trim();
  if (declared !== expectedNodeVersion) {
    errors.push(`${filename} must declare Node ${expectedNodeVersion}.`);
  }
}
for (const [filename, source] of workflowSources) {
  const versions = Array.from(source.matchAll(/node-version:\s*['"]?([^'"\s]+)['"]?/gu))
    .map((match) => match[1]);
  if (versions.some((version) => version !== expectedNodeVersion)) {
    errors.push(`.github/workflows/${filename} must use Node ${expectedNodeVersion}.`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`[commerce-release-assets] FAIL ${error}`);
  process.exit(1);
}

console.log(
  `[commerce-release-assets] OK workflows, production assets, and ${checkedMarkdownLinks} local Markdown links match the repository.`,
);

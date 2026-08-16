#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { smokeConfigurationIssues } = require('./smoke-commerce-image');

const root = path.join(__dirname, '..', '..');
const localReleaseEnvironment = path.join(root, '.env.release.local');
if (fs.existsSync(localReleaseEnvironment)) {
  if (typeof process.loadEnvFile !== 'function') {
    console.error('[commerce-release] Node.js 22+ is required to load .env.release.local.');
    process.exit(1);
  }
  process.loadEnvFile(localReleaseEnvironment);
}
const includeLiveE2e = process.argv.includes('--live-e2e');
const includeDocker = process.argv.includes('--docker');
const gitRevision = spawnSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
  shell: false,
});
const committedRevision = gitRevision.status === 0
  ? String(gitRevision.stdout || '').trim()
  : '';
const revision = String(
  process.env.COMMERCE_RELEASE_REVISION
    || process.env.GITHUB_SHA
    || committedRevision
    || 'unversioned',
).trim();
const imageReference = `commerce-data-agent:${revision.slice(0, 12)}`;
const reportDirectory = path.join(root, 'tmp', 'commerce-release');
const reportPath = path.join(reportDirectory, 'report.json');
const roleEvidencePath = path.join(reportDirectory, 'role-capabilities-report.json');
const restoreEvidencePath = path.join(reportDirectory, 'restore-drill-report.json');
const externalEvidencePath = path.join(reportDirectory, 'external-gates-report.json');
const windows = os.platform() === 'win32';
const npm = windows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const npmArgs = (...args) => windows
  ? ['/d', '/s', '/c', 'npm.cmd', ...args]
  : args;
const startedAt = new Date();
const completed = [];
const auditRegistry = String(
  process.env.COMMERCE_NPM_AUDIT_REGISTRY || 'https://registry.npmjs.org',
).trim();
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  console.warn(
    '[commerce-release] Ignoring inherited NODE_TLS_REJECT_UNAUTHORIZED=0; release checks require TLS verification.',
  );
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}
const releaseEnvironment = {
  ...process.env,
  COMMERCE_RELEASE_REVISION: revision,
};
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
const integrationEnvironmentNames = [
  'COMMERCE_TEST_DATABASE_URL',
  'COMMERCE_TEST_DATABASE_CONFIRM',
];
const liveEnvironmentNames = [
  'COMMERCE_LIVE_E2E_DATABASE_URL',
  'COMMERCE_LIVE_E2E_CONFIRM',
  'COMMERCE_LIVE_E2E_MODEL',
];
const realModelEvalEnvironmentNames = [
  'COMMERCE_REAL_MODEL_EVAL_ENDPOINT',
  'COMMERCE_REAL_MODEL_EVAL_TOKEN',
  'COMMERCE_REAL_MODEL_EVAL_MODEL',
];
const finalControllerEvalEnvironmentNames = [
  'COMMERCE_FINAL_CONTROLLER_EVAL_ENDPOINT',
  'COMMERCE_FINAL_CONTROLLER_EVAL_TOKEN',
  'COMMERCE_FINAL_CONTROLLER_EVAL_CONCURRENCY',
  'COMMERCE_FINAL_CONTROLLER_EVAL_TIMEOUT_MS',
];
const smokeEnvironmentNames = [
  'COMMERCE_RELEASE_SMOKE_CONFIRM',
  'COMMERCE_RELEASE_SMOKE_CONTROL_DATABASE_URL',
  'COMMERCE_RELEASE_SMOKE_WORKER_DATABASE_URL',
  'COMMERCE_RELEASE_SMOKE_ANALYTICS_DATABASE_URL',
  'COMMERCE_RELEASE_SMOKE_TENANT_ID',
  'COMMERCE_RELEASE_SMOKE_USER_ID',
  'COMMERCE_RELEASE_SMOKE_MODEL',
  'COMMERCE_RELEASE_SMOKE_QUESTION',
  'COMMERCE_RELEASE_SMOKE_EXPECTED_METRIC',
  'COMMERCE_RELEASE_SMOKE_EXPECTED_VALUE',
  'COMMERCE_RELEASE_SMOKE_EXPECTED_UNIT',
];
const restoreEnvironmentNames = [
  'COMMERCE_CONTROL_RESTORE_DRILL_DATABASE_URL',
  'COMMERCE_ANALYTICS_RESTORE_DRILL_DATABASE_URL',
  'COMMERCE_RESTORE_DRILL_TARGET_MARKER',
];
const externalEvidenceEnvironmentNames = [
  'COMMERCE_PERFORMANCE_EVIDENCE_PATH',
  'COMMERCE_PERFORMANCE_EVIDENCE_URL',
  'COMMERCE_PERFORMANCE_EVIDENCE_SHA256',
  'COMMERCE_FEISHU_SANDBOX_EVIDENCE_PATH',
  'COMMERCE_FEISHU_SANDBOX_EVIDENCE_URL',
  'COMMERCE_FEISHU_SANDBOX_EVIDENCE_SHA256',
  'COMMERCE_USABILITY_EVIDENCE_PATH',
  'COMMERCE_USABILITY_EVIDENCE_URL',
  'COMMERCE_USABILITY_EVIDENCE_SHA256',
];
const modelCredentialEnvironmentNames = ['DEEPSEEK_API_KEY', 'MODELPORT_API_KEY'];
const scopedEnvironmentNames = [
  ...roleDatabaseEnvironmentNames,
  ...integrationEnvironmentNames,
  ...liveEnvironmentNames,
  ...realModelEvalEnvironmentNames,
  ...finalControllerEvalEnvironmentNames,
  ...smokeEnvironmentNames,
  ...restoreEnvironmentNames,
  ...externalEvidenceEnvironmentNames,
  ...modelCredentialEnvironmentNames,
  'COMMERCE_PG_CA',
  'COMMERCE_ROLE_EVIDENCE_PATH',
  'COMMERCE_RESTORE_DRILL_EVIDENCE_PATH',
  'COMMERCE_RESTORE_DRILL_CONFIRM',
];

function selectedEnvironment(environment, names) {
  return Object.fromEntries(names
    .filter((name) => Object.prototype.hasOwnProperty.call(environment, name))
    .map((name) => [name, environment[name]]));
}

function environmentWithout(environment, names) {
  const result = { ...environment };
  for (const name of names) delete result[name];
  return result;
}

const isolatedEnvironment = {
  ...environmentWithout(releaseEnvironment, scopedEnvironmentNames),
  COMMERCE_DISABLE_LOCAL_ENV_FILES: '1',
  // Next's CLI has its own dotenv loader. Mark the environment as already
  // processed so a developer's ignored .env.local cannot alter release checks.
  __NEXT_PROCESSED_ENV: 'true',
};
const browserEnvironment = {
  ...isolatedEnvironment,
  COMMERCE_BROWSER_E2E_SERVER_MODE: 'production',
};
const integrationEnvironment = {
  ...isolatedEnvironment,
  ...selectedEnvironment(releaseEnvironment, integrationEnvironmentNames),
};
const liveEnvironment = {
  ...isolatedEnvironment,
  ...selectedEnvironment(releaseEnvironment, [
    ...liveEnvironmentNames,
    ...modelCredentialEnvironmentNames,
  ]),
};
const realModelEvalEnvironment = {
  ...isolatedEnvironment,
  ...selectedEnvironment(releaseEnvironment, realModelEvalEnvironmentNames),
};
const finalControllerEvalEnvironment = {
  ...isolatedEnvironment,
  ...selectedEnvironment(releaseEnvironment, finalControllerEvalEnvironmentNames),
};
const roleEvidenceEnvironment = {
  ...isolatedEnvironment,
  ...selectedEnvironment(releaseEnvironment, roleDatabaseEnvironmentNames),
  ...selectedEnvironment(releaseEnvironment, ['COMMERCE_PG_CA']),
  NODE_ENV: 'production',
  COMMERCE_PG_SSL: '1',
  COMMERCE_PG_REJECT_UNAUTHORIZED: '1',
  COMMERCE_ROLE_EVIDENCE_PATH: roleEvidencePath,
};
const finalImageSmokeEnvironment = {
  ...isolatedEnvironment,
  ...selectedEnvironment(releaseEnvironment, [
    ...smokeEnvironmentNames,
    ...modelCredentialEnvironmentNames,
    'COMMERCE_PG_CA',
  ]),
  COMMERCE_PG_SSL: '1',
  COMMERCE_PG_REJECT_UNAUTHORIZED: '1',
};
const restoreEvidenceEnvironment = {
  ...isolatedEnvironment,
  ...selectedEnvironment(releaseEnvironment, [
    'COMMERCE_CONTROL_BACKUP_DATABASE_URL',
    'COMMERCE_ANALYTICS_BACKUP_DATABASE_URL',
    ...restoreEnvironmentNames,
    'COMMERCE_PG_CA',
  ]),
  NODE_ENV: 'production',
  COMMERCE_PG_SSL: '1',
  COMMERCE_PG_REJECT_UNAUTHORIZED: '1',
  COMMERCE_RESTORE_DRILL_CONFIRM: 'commerce-restore-drill',
  COMMERCE_RESTORE_DRILL_EVIDENCE_PATH: restoreEvidencePath,
};
const externalEvidenceEnvironment = {
  ...isolatedEnvironment,
  ...selectedEnvironment(releaseEnvironment, externalEvidenceEnvironmentNames),
  COMMERCE_EXTERNAL_EVIDENCE_REPORT_PATH: externalEvidencePath,
};

if (
  (includeLiveE2e || includeDocker)
  && (revision === 'unversioned' || !/^[A-Za-z0-9._-]{7,64}$/u.test(revision))
) {
  console.error(
    '[commerce-release] COMMERCE_RELEASE_REVISION or GITHUB_SHA is required for release evidence.',
  );
  process.exit(1);
}
if (includeLiveE2e || includeDocker) {
  if (!committedRevision || revision !== committedRevision) {
    console.error(
      `[commerce-release] Evidence revision ${revision} must exactly match checked-out HEAD ${committedRevision || '<unavailable>'}.`,
    );
    process.exit(1);
  }
  const worktree = spawnSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  });
  if (worktree.status !== 0 || String(worktree.stdout || '').trim()) {
    console.error('[commerce-release] A clean Git worktree is required for release evidence.');
    process.exit(1);
  }
}
if (includeDocker) {
  const smokeIssues = smokeConfigurationIssues(releaseEnvironment, imageReference);
  if (smokeIssues.length) {
    console.error('[commerce-release] Final-image smoke prerequisites are incomplete:');
    for (const issue of smokeIssues) console.error(`- ${issue}`);
    process.exit(1);
  }
}

const evidenceReports = {
  'browser-e2e': path.join(root, 'tmp', 'commerce-browser-e2e', 'report.json'),
  'production-role-capabilities': roleEvidencePath,
  'restore-drill': restoreEvidencePath,
  'external-release-gates': externalEvidencePath,
  'live-model-e2e': path.join(root, 'tmp', 'commerce-live-e2e', 'report.json'),
  'real-model-eval': path.join(root, 'tmp', 'commerce-real-model-eval', 'report.json'),
  'final-controller-eval': path.join(
    root,
    'tmp',
    'commerce-final-controller-eval',
    'report.json',
  ),
  'final-image-production-smoke': path.join(
    root,
    'tmp',
    'commerce-release',
    'image-smoke-report.json',
  ),
};
for (const [name, artifact] of Object.entries(evidenceReports)) {
  if (name === 'browser-e2e'
    || (name === 'production-role-capabilities' && includeDocker)
    || (name === 'restore-drill' && includeDocker)
    || (name === 'external-release-gates' && includeLiveE2e && includeDocker)
    || (name === 'live-model-e2e' && includeLiveE2e)
    || (name === 'real-model-eval' && includeLiveE2e)
    || (name === 'final-controller-eval' && includeLiveE2e)
    || (name === 'final-image-production-smoke' && includeDocker)) {
    fs.rmSync(artifact, { force: true });
  }
}

const checks = [
  ['release-assets', npm, npmArgs('run', 'check:release-assets'), isolatedEnvironment],
  ['next-env-isolation', npm, npmArgs('run', 'check:next-env-isolation'), isolatedEnvironment],
  ['frozen-evaluation-assets', npm, npmArgs('run', 'check:commerce-eval-assets'), isolatedEnvironment],
  ['production-dependency-audit', npm, npmArgs(
    'audit',
    '--omit=dev',
    '--audit-level=high',
    `--registry=${auditRegistry}`,
  ), isolatedEnvironment],
  ['lint', npm, npmArgs('run', 'lint'), isolatedEnvironment],
  ['unit', npm, npmArgs('test'), isolatedEnvironment],
  ['types', npm, npmArgs('run', 'type-check'), isolatedEnvironment],
  ['boundary', npm, npmArgs('run', 'check:boundary'), isolatedEnvironment],
  ['production-build', npm, npmArgs('run', 'build'), isolatedEnvironment],
  ['browser-e2e', npm, npmArgs('run', 'test:e2e:commerce:browser'), browserEnvironment],
  ['postgres-integration', npm, npmArgs('run', 'test:integration:commerce'), integrationEnvironment],
];
if (includeDocker) {
  checks.push([
    'production-role-capabilities',
    npm,
    npmArgs('run', 'db:verify-roles:commerce'),
    roleEvidenceEnvironment,
  ]);
  checks.push([
    'restore-drill',
    process.execPath,
    [path.join(root, 'scripts', 'checks', 'run-commerce-restore-evidence.js')],
    restoreEvidenceEnvironment,
  ]);
}
if (includeLiveE2e) {
  checks.push([
    'final-controller-eval',
    npm,
    npmArgs('run', 'eval:commerce:final-controller'),
    finalControllerEvalEnvironment,
  ]);
  checks.push([
    'live-model-e2e',
    npm,
    npmArgs('run', 'test:e2e:commerce:live'),
    liveEnvironment,
  ]);
  checks.push([
    'real-model-eval',
    npm,
    npmArgs('run', 'eval:commerce:real-model'),
    realModelEvalEnvironment,
  ]);
}
if (includeLiveE2e && includeDocker) {
  checks.push([
    'external-release-gates',
    npm,
    npmArgs('run', 'check:external-evidence:commerce'),
    externalEvidenceEnvironment,
  ]);
}
if (includeDocker) {
  checks.push([
    'docker-image',
    'docker',
    [
      'build',
      '--build-arg',
      `COMMERCE_RELEASE_REVISION=${revision}`,
      '--tag',
      imageReference,
      '.',
    ],
    isolatedEnvironment,
  ]);
  checks.push([
    'final-image-production-smoke',
    process.execPath,
    [
      path.join(root, 'scripts', 'checks', 'smoke-commerce-image.js'),
      '--image',
      imageReference,
    ],
    finalImageSmokeEnvironment,
  ]);
}

function bindEvidenceArtifact(checkName, record) {
  const artifactPath = evidenceReports[checkName];
  if (!artifactPath) return;
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`${checkName} did not create ${path.relative(root, artifactPath)}.`);
  }
  const bytes = fs.readFileSync(artifactPath);
  const artifact = JSON.parse(bytes.toString('utf8'));
  if (
    artifact.status !== 'passed'
    || artifact.revision !== revision
    || artifact.service !== 'commerce-data-agent'
    || !Number.isSafeInteger(artifact.schemaVersion)
  ) {
    throw new Error(
      `${checkName} evidence is not bound to ${revision} with passed status.`,
    );
  }
  if (checkName === 'production-role-capabilities') {
    const expectedRoles = [
      'control_runtime',
      'analytics_readonly',
      'analytics_ingest',
      'control_maintenance',
      'control_migration',
      'analytics_migration',
      'control_backup',
      'analytics_backup',
    ];
    const actualRoles = Array.isArray(artifact.roles)
      ? artifact.roles.map((role) => role?.name).sort()
      : [];
    if (JSON.stringify(actualRoles) !== JSON.stringify(expectedRoles.sort())) {
      throw new Error('production-role-capabilities evidence is missing a required role result.');
    }
  }
  if (
    checkName === 'browser-e2e'
    && (
      artifact.serverMode !== 'production'
      || artifact.environmentFlowCount !== 16
      || artifact.passed !== 16
      || artifact.failed !== 0
      || !Array.isArray(artifact.results)
      || artifact.results.length !== 16
      || artifact.results.some((result) => result?.status !== 'passed')
    )
  ) {
    throw new Error('browser-e2e evidence must contain 16 passed flows against the production build.');
  }
  if (
    checkName === 'external-release-gates'
    && (
      !artifact.evidence?.performance?.sha256
      || !artifact.evidence?.feishuSandbox?.sha256
      || !artifact.evidence?.usability?.sha256
    )
  ) {
    throw new Error('external-release-gates evidence is missing performance, Feishu, or usability proof.');
  }
  if (
    checkName === 'final-controller-eval'
    && (
      artifact.caseCount !== 100
      || artifact.comparison?.passed !== true
      || !Array.isArray(artifact.thresholdFailures)
      || artifact.thresholdFailures.length !== 0
      || !/^sha256:[0-9a-f]{64}$/u.test(artifact.rawResults?.fileSha256 || '')
      || artifact.rawResults?.caseResponseSha256?.length !== 100
    )
  ) {
    throw new Error('final-controller-eval evidence did not pass all 100 frozen cases and baseline comparison.');
  }
  record.evidence = {
    path: path.relative(root, artifactPath).replaceAll('\\', '/'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    schemaVersion: artifact.schemaVersion,
    revision: artifact.revision,
    ...(artifact.image?.id ? { imageId: artifact.image.id } : {}),
  };
}

function writeReport(status, failure = null) {
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 2,
    service: 'commerce-data-agent',
    revision,
    status,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    liveModelEvidenceRequired: includeLiveE2e,
    realModelEvaluationRequired: includeLiveE2e,
    finalControllerEvaluationRequired: includeLiveE2e,
    dockerEvidenceRequired: includeDocker,
    finalImageRuntimeEvidenceRequired: includeDocker,
    browserEvidenceRequired: true,
    browserProductionArtifactRequired: true,
    restoreEvidenceRequired: includeDocker,
    performanceEvidenceRequired: includeLiveE2e && includeDocker,
    feishuSandboxEvidenceRequired: includeLiveE2e && includeDocker,
    usabilityEvidenceRequired: includeLiveE2e && includeDocker,
    productionReleaseQualified: status === 'passed' && includeLiveE2e && includeDocker,
    checks: completed,
    failure,
  }, null, 2)}\n`, 'utf8');
}

for (const [name, command, args, checkEnvironment] of checks) {
  const checkStartedAt = Date.now();
  console.log(`[commerce-release] running ${name}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: checkEnvironment,
    stdio: 'inherit',
    shell: false,
  });
  const record = {
    name,
    durationMs: Date.now() - checkStartedAt,
    exitCode: result.status,
    signal: result.signal || null,
  };
  completed.push(record);
  if (result.error || result.status !== 0) {
    const failure = result.error?.message || `${name} exited with ${result.status}`;
    writeReport('failed', failure);
    console.error(`[commerce-release] FAIL ${failure}`);
    process.exit(result.status || 1);
  }
  try {
    bindEvidenceArtifact(name, record);
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error);
    record.exitCode = 1;
    writeReport('failed', failure);
    console.error(`[commerce-release] FAIL ${failure}`);
    process.exit(1);
  }
}

writeReport('passed');
console.log(`[commerce-release] PASS evidence written to ${path.relative(root, reportPath)}`);

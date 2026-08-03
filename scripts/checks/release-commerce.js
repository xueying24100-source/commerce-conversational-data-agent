#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
const reportDirectory = path.join(root, 'tmp', 'commerce-release');
const reportPath = path.join(reportDirectory, 'report.json');
const windows = os.platform() === 'win32';
const npm = windows ? (process.env.ComSpec || 'cmd.exe') : 'npm';
const npmArgs = (...args) => windows
  ? ['/d', '/s', '/c', 'npm.cmd', ...args]
  : args;
const startedAt = new Date();
const completed = [];
const releaseEnvironment = {
  ...process.env,
  COMMERCE_RELEASE_REVISION: revision,
};
if (releaseEnvironment.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  console.warn(
    '[commerce-release] Ignoring inherited NODE_TLS_REJECT_UNAUTHORIZED=0; release checks require TLS verification.',
  );
  delete releaseEnvironment.NODE_TLS_REJECT_UNAUTHORIZED;
}

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

const checks = [
  ['release-assets', npm, npmArgs('run', 'check:release-assets')],
  ['production-dependency-audit', npm, npmArgs('audit', '--omit=dev', '--audit-level=high')],
  ['lint', npm, npmArgs('run', 'lint')],
  ['unit', npm, npmArgs('test')],
  ['types', npm, npmArgs('run', 'type-check')],
  ['boundary', npm, npmArgs('run', 'check:boundary')],
  ['postgres-integration', npm, npmArgs('run', 'test:integration:commerce')],
  ['production-build', npm, npmArgs('run', 'build')],
];
if (includeLiveE2e) {
  checks.push(['live-model-e2e', npm, npmArgs('run', 'test:e2e:commerce:live')]);
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
      `commerce-data-agent:${revision.slice(0, 12)}`,
      '.',
    ],
  ]);
}

function writeReport(status, failure = null) {
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({
    schemaVersion: 1,
    service: 'commerce-data-agent',
    revision,
    status,
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    liveModelEvidenceRequired: includeLiveE2e,
    dockerEvidenceRequired: includeDocker,
    checks: completed,
    failure,
  }, null, 2)}\n`, 'utf8');
}

for (const [name, command, args] of checks) {
  const checkStartedAt = Date.now();
  console.log(`[commerce-release] running ${name}`);
  const result = spawnSync(command, args, {
    cwd: root,
    env: releaseEnvironment,
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
}

writeReport('passed');
console.log(`[commerce-release] PASS evidence written to ${path.relative(root, reportPath)}`);

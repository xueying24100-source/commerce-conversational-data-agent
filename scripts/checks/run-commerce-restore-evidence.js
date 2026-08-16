#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const reportDirectory = path.join(root, 'tmp', 'commerce-release');

function releaseRevision(value = process.env.COMMERCE_RELEASE_REVISION) {
  const revision = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{7,64}$/u.test(revision) || revision === 'unversioned') {
    throw new Error('COMMERCE_RELEASE_REVISION must identify the immutable restore evidence revision.');
  }
  return revision;
}

function assertRestoreEvidence(report, revision = releaseRevision()) {
  if (
    report?.status !== 'passed'
    || report.service !== 'commerce-data-agent'
    || report.revision !== revision
    || !Number.isSafeInteger(report.schemaVersion)
    || !Array.isArray(report.results)
    || !Array.isArray(report.backup?.artifacts)
  ) {
    throw new Error(`Restore drill evidence is not bound to ${revision} with passed status.`);
  }
  const resultNames = report.results.map((result) => result?.name).sort();
  if (JSON.stringify(resultNames) !== JSON.stringify(['analytics', 'control'])) {
    throw new Error('Restore drill evidence must contain control and analytics results.');
  }
  const artifactNames = report.backup.artifacts.map((artifact) => artifact?.name).sort();
  if (JSON.stringify(artifactNames) !== JSON.stringify(['analytics', 'control'])) {
    throw new Error('Restore drill evidence must contain both source backup artifacts.');
  }
  for (const name of resultNames) {
    const result = report.results.find((item) => item.name === name);
    const artifact = report.backup.artifacts.find((item) => item.name === name);
    const verification = result?.verification;
    if (
      !/^sha256:[0-9a-f]{64}$/u.test(artifact?.sha256 || '')
      || !/^sha256:[0-9a-f]{64}$/u.test(artifact?.sourceDatabaseSha256 || '')
      || !Number.isSafeInteger(artifact?.bytes)
      || artifact.bytes < 1
      || !/^sha256:[0-9a-f]{64}$/u.test(verification?.schemaSha256 || '')
      || !verification.tableRows
      || !Object.keys(verification.tableRows).length
      || Object.values(verification.tableRows).some((count) => !/^(?:0|[1-9][0-9]*)$/u.test(count))
      || !verification.objectCounts
      || Object.values(verification.objectCounts).some((count) => !Number.isSafeInteger(count) || count < 0)
      || JSON.stringify(artifact.verification) !== JSON.stringify(verification)
    ) {
      throw new Error(`${name} restore evidence does not match the source table/schema snapshot.`);
    }
  }
  return report;
}

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with ${result.status ?? 'a signal'}.`);
  }
}

function main() {
  const revision = releaseRevision();
  if (process.env.COMMERCE_RESTORE_DRILL_CONFIRM !== 'commerce-restore-drill') {
    throw new Error('COMMERCE_RESTORE_DRILL_CONFIRM must equal commerce-restore-drill.');
  }
  const reportPath = path.join(reportDirectory, 'restore-drill-report.json');
  const backupDirectory = path.join(
    reportDirectory,
    `.restore-drill-${revision.slice(0, 12)}-${process.pid}`,
  );
  fs.rmSync(backupDirectory, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.rmSync(reportPath, { force: true });

  const environment = {
    ...process.env,
    COMMERCE_DISABLE_LOCAL_ENV_FILES: '1',
    NODE_ENV: 'production',
    COMMERCE_RELEASE_REVISION: revision,
    COMMERCE_RESTORE_DRILL_EVIDENCE_PATH: reportPath,
    COMMERCE_BACKUP_OUTPUT_DIR: backupDirectory,
  };
  try {
    run(process.execPath, [
      path.join(root, 'scripts', 'db', 'backup-commerce.js'),
      backupDirectory,
    ], environment);
    run(process.execPath, [
      path.join(root, 'scripts', 'db', 'restore-commerce-drill.js'),
      backupDirectory,
    ], environment);
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assertRestoreEvidence(report, revision);
    console.log(JSON.stringify({
      ok: true,
      revision,
      evidencePath: path.relative(root, reportPath).replaceAll('\\', '/'),
      results: report.results,
    }, null, 2));
  } finally {
    fs.rmSync(backupDirectory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      '[commerce-restore-evidence] FAIL',
      error instanceof Error ? error.message : error,
    );
    process.exitCode = 1;
  }
}

module.exports = { assertRestoreEvidence, releaseRevision };

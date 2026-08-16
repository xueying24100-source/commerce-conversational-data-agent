#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { runFixedPolicySuite, scoreSuite } = require('./commerce-eval-score');

const ROOT = path.join(__dirname, '..', '..');

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const manifestPath = path.resolve(ROOT, argument(
    '--manifest',
    'quality/commerce-agent-eval/v1/dev-manifest.json',
  ));
  const oraclePath = path.resolve(ROOT, argument(
    '--oracle',
    'quality/commerce-agent-eval/v1/dev-oracle.json',
  ));
  const outputDirectory = path.resolve(ROOT, argument('--output-dir', 'tmp/commerce-eval'));
  const manifest = readJson(manifestPath);
  const oracle = readJson(oraclePath);
  const results = runFixedPolicySuite(manifest);
  const report = scoreSuite(manifest, oracle, results);
  report.ablation = {
    policy: 'fixed-kpi-priority-tree/v1',
    usesModelSelection: false,
    comparisonStatus: 'awaiting_dynamic_controller_results',
    gainClaim: 'not_evaluated',
  };
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(outputDirectory, 'fixed-policy-results.json'),
    `${JSON.stringify(results, null, 2)}\n`,
    'utf8',
  );
  fs.writeFileSync(
    path.join(outputDirectory, 'fixed-policy-report.json'),
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  console.log(JSON.stringify({ outputDirectory, summary: report.summary }));
}

try {
  main();
} catch (error) {
  console.error('[fixed-policy-ablation] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const { releaseThresholdFailures, scoreSuite } = require('./commerce-eval-score');

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function requiredPath(name) {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required.`);
  return path.resolve(process.cwd(), value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const manifestPath = requiredPath('--manifest');
  const oraclePath = requiredPath('--oracle');
  const resultsPath = requiredPath('--results');
  const outputPath = argument('--output')
    ? path.resolve(process.cwd(), argument('--output'))
    : null;
  const report = scoreSuite(
    readJson(manifestPath),
    readJson(oraclePath),
    readJson(resultsPath),
  );
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, body, 'utf8');
  } else {
    process.stdout.write(body);
  }
  const thresholdFailures = releaseThresholdFailures(report);
  if (process.argv.includes('--enforce') && thresholdFailures.length) {
    console.error(`[commerce-eval-score] Gate failures:\n- ${thresholdFailures.join('\n- ')}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (error) {
  console.error('[commerce-eval-score] Failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { validateProductionEnvironment } = require('./production-env');

const issues = validateProductionEnvironment(process.env);
if (issues.length) {
  console.error('Commerce Data Agent refused to start because production configuration is unsafe:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

const root = process.cwd();
const standaloneCandidates = [
  path.join(root, 'server.js'),
  path.join(root, '.next', 'standalone', 'server.js'),
];
const standalone = standaloneCandidates.find((candidate) => fs.existsSync(candidate));
if (standalone) {
  require(standalone);
} else {
  const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
  const child = spawn(process.execPath, [next, 'start'], {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
  });
  child.on('error', (error) => {
    console.error('Unable to start Commerce Data Agent:', error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });
}

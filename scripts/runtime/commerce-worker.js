#!/usr/bin/env node

const Module = require('node:module');
const path = require('node:path');
const { validateProductionEnvironment } = require('./production-env');

const issues = validateProductionEnvironment(process.env);
if (issues.length) {
  console.error('Commerce Agent Worker refused to start because production configuration is unsafe:');
  for (const issue of issues) console.error(`- ${issue}`);
  process.exit(1);
}

const root = path.join(__dirname, '..', '..');
const compiledRoot = path.join(root, '.next', 'commerce-worker');
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveCommerceAlias(request, parent, isMain, options) {
  if (typeof request === 'string' && request.startsWith('@/')) {
    request = path.join(compiledRoot, 'src', request.slice(2));
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

require(path.join(compiledRoot, 'src', 'workers', 'commerce-agent-worker.js'));

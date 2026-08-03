#!/usr/bin/env node

const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { loadLocalEnv } = require('../db/load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

function integer(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}.`);
  }
  return value;
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function headers(json = false) {
  const value = json ? { 'content-type': 'application/json' } : {};
  const secret = process.env.COMMERCE_SOAK_PROXY_SECRET?.trim();
  if (secret) {
    value['x-commerce-tenant-id'] = process.env.COMMERCE_SOAK_TENANT_ID || 'tenant_soak';
    value['x-commerce-user-id'] = process.env.COMMERCE_SOAK_USER_ID || 'user_soak';
    value['x-commerce-user-name'] = 'Commerce Soak';
    value['x-commerce-scopes'] = 'commerce:data:read';
    value['x-commerce-proxy-secret'] = secret;
  }
  return value;
}

async function request(origin, operation, pathname, init, timings) {
  const started = performance.now();
  const response = await fetch(`${origin}${pathname}`, init);
  const elapsed = Math.round(performance.now() - started);
  (timings[operation] ||= []).push(elapsed);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || (payload && payload.success === false)) {
    throw new Error(`${operation} failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return payload;
}

async function waitForJob(origin, jobId, timings) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const payload = await request(
      origin,
      'job_poll',
      `/api/commerce/jobs/${encodeURIComponent(jobId)}`,
      { headers: headers() },
      timings,
    );
    const job = payload.job;
    if (job.status === 'completed' && job.result) return job.result;
    if (job.status === 'failed' || job.status === 'dead_letter') {
      throw new Error(`${job.status}: ${job.error?.code || 'unknown'} ${job.error?.message || ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('Timed out waiting for Commerce soak Job.');
}

async function probeCycle(origin, timings) {
  await request(origin, 'liveness', '/api/health', undefined, timings);
  await request(origin, 'readiness', '/api/health/ready', undefined, timings);
  const bootstrap = await request(
    origin,
    'bootstrap',
    '/api/commerce',
    { headers: headers() },
    timings,
  );
  if (!bootstrap.readiness?.ready) throw new Error(`Tenant readiness closed: ${bootstrap.readiness?.issues}`);
}

async function modelCycle(origin, timings) {
  const prompt = process.env.COMMERCE_SOAK_PROMPT?.trim()
    || '对比最近 30 天与此前 30 天的 GMV 和毛利率，并给出证据。';
  const payload = await request(
    origin,
    'job_enqueue',
    '/api/commerce/conversations',
    {
      method: 'POST',
      headers: headers(true),
      body: JSON.stringify({
        message: prompt,
        model: process.env.COMMERCE_SOAK_MODEL || 'deepseek-v4-flash',
        requestId: `soak_${randomUUID()}`,
      }),
    },
    timings,
  );
  const result = await waitForJob(origin, payload.job.id, timings);
  if (!result.assistantMessage?.traces?.length) {
    throw new Error('Completed Commerce soak Job returned no Evidence traces.');
  }
}

async function main() {
  const modelMode = process.argv.includes('--model');
  if (modelMode && process.env.COMMERCE_SOAK_CONFIRM !== 'commerce-model-soak') {
    throw new Error('Set COMMERCE_SOAK_CONFIRM=commerce-model-soak before running paid model soak mode.');
  }
  const origin = (process.env.COMMERCE_SOAK_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/u, '');
  const durationSeconds = integer('COMMERCE_SOAK_DURATION_SECONDS', 30, 5, 3_600);
  const concurrency = integer('COMMERCE_SOAK_CONCURRENCY', modelMode ? 1 : 4, 1, 50);
  const pauseMs = integer('COMMERCE_SOAK_PAUSE_MS', 100, 0, 10_000);
  const deadline = Date.now() + durationSeconds * 1_000;
  const timings = {};
  const errors = [];
  let cycles = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (Date.now() < deadline) {
      try {
        if (modelMode) await modelCycle(origin, timings);
        else await probeCycle(origin, timings);
        cycles += 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    }
  }));
  const operations = Object.fromEntries(Object.entries(timings).map(([name, values]) => [
    name,
    {
      count: values.length,
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
      maxMs: Math.max(...values),
    },
  ]));
  console.log(JSON.stringify({
    ok: errors.length === 0,
    mode: modelMode ? 'model' : 'probe',
    origin,
    durationSeconds,
    concurrency,
    cycles,
    errors: errors.slice(0, 20),
    operations,
  }, null, 2));
  if (errors.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Commerce soak failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { percentile };

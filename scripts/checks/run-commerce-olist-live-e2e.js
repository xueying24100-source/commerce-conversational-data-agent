#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const { loadLocalEnv } = require('../db/load-local-env');

const root = path.join(__dirname, '..', '..');
loadLocalEnv(root);

if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
  console.warn('Ignoring NODE_TLS_REJECT_UNAUTHORIZED=0 for Olist live E2E; TLS verification remains enabled.');
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
}

const origin = (process.env.COMMERCE_OLIST_E2E_ORIGIN || 'http://127.0.0.1:3000').replace(/\/$/u, '');
const model = process.env.COMMERCE_OLIST_E2E_MODEL || 'deepseek-v4-flash';
const expected = {
  coverageStart: '2016-09-04',
  coverageEnd: '2018-09-03',
  sourceUpdatedAt: '2018-10-17T20:30:18.000Z',
  gmv: 848_860.10,
  paid_orders: 6_421,
  new_customers: 6_209,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function apiJson(pathname, init = {}, expectedStatus = 200) {
  const response = await fetch(`${origin}${pathname}`, {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json();
  assert(
    response.status === expectedStatus,
    `${pathname} returned HTTP ${response.status}: ${JSON.stringify(payload)}`,
  );
  assert(payload.success === true, `${pathname} failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function completedJob(jobId) {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const payload = await apiJson(`/api/commerce/jobs/${encodeURIComponent(jobId)}`);
    if (payload.job.status === 'completed' && payload.job.result) return payload.job.result;
    if (['failed', 'dead_letter'].includes(payload.job.status)) {
      throw new Error(
        `${payload.job.error?.code || 'COMMERCE_JOB_FAILED'}: ${payload.job.error?.message || 'Job failed.'}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Commerce job ${jobId} did not complete within 240 seconds.`);
}

function answerClaims(answer) {
  return [
    ...(answer?.answerClaims || []),
    ...(answer?.findings || []).flatMap((finding) => finding.claims || []),
    ...(answer?.recommendations || []).flatMap((recommendation) => recommendation.claims || []),
  ];
}

function claimValue(claims, metric) {
  const values = claims.filter((claim) => claim.metric === metric).map((claim) => Number(claim.value));
  assert(values.length > 0, `DeepSeek answer did not cite a ${metric} evidence claim.`);
  return values[0];
}

async function main() {
  assert(String(process.env.DEEPSEEK_API_KEY || '').trim(), 'DEEPSEEK_API_KEY is required.');
  const bootstrap = await apiJson('/api/commerce');
  assert(bootstrap.readiness.ready === true, `Tenant readiness failed: ${bootstrap.readiness.issues.join('; ')}`);
  assert(bootstrap.readiness.dataStatus?.dataMode === 'snapshot', 'Olist tenant must report snapshot data mode.');
  assert(
    bootstrap.readiness.dataStatus.coverageStart === expected.coverageStart
      && bootstrap.readiness.dataStatus.coverageEnd === expected.coverageEnd,
    'Olist coverage range does not match the pinned dataset.',
  );
  assert(
    bootstrap.readiness.dataStatus.sourceUpdatedAt === expected.sourceUpdatedAt,
    'Olist source watermark does not match the pinned snapshot.',
  );
  assert(
    bootstrap.readiness.warnings.some((warning) => warning.includes('固定历史快照')),
    'Olist bootstrap must disclose that the tenant is a historical snapshot.',
  );

  const suffix = randomUUID();
  const first = await apiJson('/api/commerce/conversations', {
    method: 'POST',
    body: JSON.stringify({
      message: '请先确认数据覆盖范围，再分析 2018-08-01 到 2018-08-31 的 GMV、支付订单和新客，并给出有数据证据的结论。',
      model,
      requestId: `req_olist_live_${suffix}`,
    }),
  }, 202);
  const firstResult = await completedJob(first.job.id);
  const firstAnswer = firstResult.assistantMessage.answer;
  const firstOperations = firstResult.assistantMessage.traces.map((trace) => trace.operation);
  const claims = answerClaims(firstAnswer);
  assert(firstAnswer?.status === 'answered', `Expected answered, received ${firstAnswer?.status || 'missing'}.`);
  assert(firstOperations.includes('commerce.describe_data'), 'Olist answer did not inspect the data catalog.');
  assert(firstOperations.includes('commerce.compare_metrics'), 'Olist answer did not query the requested metrics.');
  assert(Math.abs(claimValue(claims, 'gmv') - expected.gmv) < 0.001, 'Olist GMV claim is incorrect.');
  assert(claimValue(claims, 'paid_orders') === expected.paid_orders, 'Olist paid-order claim is incorrect.');
  assert(claimValue(claims, 'new_customers') === expected.new_customers, 'Olist new-customer claim is incorrect.');
  assert(
    firstResult.assistantMessage.traces.every((trace) => trace.sourceWatermark === expected.sourceUpdatedAt),
    'Evidence traces must use the source snapshot watermark rather than ingestion time.',
  );

  const conversationId = firstResult.conversation.id;
  const second = await apiJson(
    `/api/commerce/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: '同一日期范围，请计算访问量 visits、广告花费 ad_spend 和 ROAS。如果当前数据源不支持，必须明确拒绝，不能把缺失指标当成 0。',
        requestId: `req_olist_unsupported_${suffix}`,
      }),
    },
    202,
  );
  const secondResult = await completedJob(second.job.id);
  const secondAnswer = secondResult.assistantMessage.answer;
  assert(secondAnswer?.status === 'refused', `Unsupported Olist metrics must be refused, received ${secondAnswer?.status || 'missing'}.`);
  assert(answerClaims(secondAnswer).length === 0, 'A refused answer must not fabricate unavailable metric claims.');

  const reportDirectory = path.join(root, 'tmp', 'commerce-olist-live-e2e');
  fs.mkdirSync(reportDirectory, { recursive: true });
  fs.writeFileSync(path.join(reportDirectory, 'report.json'), `${JSON.stringify({
    schemaVersion: 1,
    service: 'commerce-data-agent',
    dataset: 'olist-public-pinned-snapshot',
    model,
    status: 'passed',
    completedAt: new Date().toISOString(),
    coverage: {
      start: expected.coverageStart,
      end: expected.coverageEnd,
      sourceUpdatedAt: expected.sourceUpdatedAt,
      dataMode: 'snapshot',
    },
    expectedMetrics: {
      gmv: expected.gmv,
      paidOrders: expected.paid_orders,
      newCustomers: expected.new_customers,
    },
    answeredOperations: firstOperations,
    unsupportedMetricStatus: secondAnswer.status,
    evidenceCount: firstResult.assistantMessage.traces.length,
    usage: {
      answered: firstResult.usage,
      refused: secondResult.usage,
    },
  }, null, 2)}\n`, 'utf8');
  console.log('[commerce-olist-live-e2e] PASS grounded Olist answer and unsupported-metric refusal.');
}

main().catch((error) => {
  console.error('[commerce-olist-live-e2e] FAIL', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

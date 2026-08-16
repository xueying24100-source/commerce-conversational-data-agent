#!/usr/bin/env node

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const DEFAULT_OUTPUT = path.join(root, 'tmp', 'commerce-release', 'external-gates-report.json');
const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function immutableRevision(value = process.env.COMMERCE_RELEASE_REVISION) {
  const revision = String(value || '').trim();
  if (!/^[A-Za-z0-9._-]{7,64}$/u.test(revision) || revision === 'unversioned') {
    throw new Error('COMMERCE_RELEASE_REVISION must identify the immutable evidence revision.');
  }
  return revision;
}

function commonEvidence(report, revision, name) {
  assert(report && typeof report === 'object', `${name} evidence must be a JSON object.`);
  assert(Number.isSafeInteger(report.schemaVersion), `${name} evidence needs schemaVersion.`);
  assert(report.service === 'commerce-data-agent', `${name} evidence has the wrong service.`);
  assert(report.revision === revision, `${name} evidence is not bound to ${revision}.`);
  assert(report.status === 'passed', `${name} evidence status must be passed.`);
}

function validatePerformanceEvidence(report, revision) {
  commonEvidence(report, revision, 'Performance');
  const workload = report.workload || {};
  assert(workload.concurrency === 10, 'Performance concurrency must equal 10.');
  assert(workload.requestsPerEndpoint >= 1000, 'Performance needs at least 1,000 requests per endpoint.');
  assert(workload.readWriteRatio === '80/20', 'Performance workload must be 80/20 read/write.');
  assert(
    workload.schedule === 'interleaved-concurrent',
    'Performance reads and writes must be interleaved under the same concurrent load.',
  );
  assert(workload.workerDisabled === true, 'Performance evidence must use a Worker-disabled fixture.');

  const reference = report.referenceEnvironment || {};
  assert(reference.deploymentRevision === revision, 'Performance target revision is not the release revision.');
  for (const field of ['region', 'databaseSpec', 'modelVersion', 'cacheState']) {
    assert(typeof reference[field] === 'string' && reference[field].trim(), `Performance ${field} is required.`);
  }
  assert(Number.isSafeInteger(reference.workerCount) && reference.workerCount >= 0, 'Performance workerCount is invalid.');
  assert(
    /^sha256:[0-9a-f]{64}$/u.test(reference.fixtureSha256 || ''),
    'Performance fixtureSha256 must be canonical.',
  );
  assert(report.responseValidation?.semanticFailures === 0, 'Performance responses had semantic failures.');
  assert(report.responseValidation?.revisionMismatches === 0, 'Performance target revision changed or mismatched.');

  const limits = new Map([
    ['readiness', 300],
    ['conversations', 300],
    ['jobs', 300],
    ['evidence', 300],
    ['create-diagnosis-job', 500],
  ]);
  const endpoints = Array.isArray(report.endpoints) ? report.endpoints : [];
  assert(endpoints.length === limits.size, 'Performance evidence must contain exactly five required endpoints.');
  for (const [name, p95Limit] of limits) {
    const result = endpoints.find((entry) => entry?.name === name);
    assert(result, `Performance evidence is missing ${name}.`);
    assert(result.samples >= 1000, `${name} needs at least 1,000 samples.`);
    assert(result.passed === true, `${name} is not marked passed.`);
    assert(finiteNonNegative(result.p95Ms) && result.p95Ms <= p95Limit, `${name} p95 exceeded ${p95Limit} ms.`);
    assert(finiteNonNegative(result.p99Ms) && result.p99Ms <= 1000, `${name} p99 exceeded 1,000 ms.`);
  }
  assert(new Set(endpoints.map((entry) => entry?.name)).size === limits.size, 'Performance endpoint names are duplicated.');

  const review = report.reviewEnqueue || {};
  assert(review.samples >= 100, 'Review enqueue evidence needs at least 100 samples.');
  assert(review.passed === true, 'Review enqueue evidence is not marked passed.');
  assert(
    finiteNonNegative(review.p95Ms) && review.p95Ms <= 15 * 60 * 1000,
    'Review enqueue p95 exceeded 15 minutes.',
  );
  return {
    endpointSamples: endpoints.reduce((sum, entry) => sum + entry.samples, 0),
    reviewSamples: review.samples,
  };
}

const REQUIRED_NEGATIVE_CASES = [
  'proposed_or_unapproved',
  'ignored',
  'snoozed',
  'unauthorized_operator',
  'forged_member_id',
  'removed_member',
  'cross_tenant_member',
  'global_kill_switch',
  'sensitive_payload_filtered',
];
const REQUIRED_FAULT_CASES = [
  'accepted_202',
  'rate_limited_429',
  'provider_500',
  'pre_send_timeout',
  'post_send_transport_exception',
  'worker_crash',
];

function validateFeishuEvidence(report, revision) {
  commonEvidence(report, revision, 'Feishu sandbox');
  assert(/^sha256:[0-9a-f]{64}$/u.test(report.sandbox?.tenantFingerprint || ''), 'Feishu sandbox tenant fingerprint is invalid.');
  assert(/^sha256:[0-9a-f]{64}$/u.test(report.sandbox?.appScopeFingerprint || ''), 'Feishu app-scope fingerprint is invalid.');
  const cohort = report.normalCohort || {};
  assert(Number.isSafeInteger(cohort.approvals) && cohort.approvals >= 100, 'Feishu cohort needs at least 100 approvals.');
  assert(Number.isSafeInteger(cohort.delivered) && cohort.delivered >= 0, 'Feishu delivered count is invalid.');
  assert(cohort.delivered / cohort.approvals >= 0.99, 'Feishu delivery rate is below 99%.');
  assert(finiteNonNegative(cohort.p95Ms) && cohort.p95Ms <= 60_000, 'Feishu delivery p95 exceeded 60 seconds.');
  assert(cohort.logicalCommandCount === cohort.approvals, 'Feishu logical-command count must equal approvals.');
  assert(cohort.distinctRequestUuidCount === cohort.approvals, 'Feishu request UUIDs must be unique per approval.');
  assert(cohort.duplicateSameVersionMessages === 0, 'Feishu observed a duplicate same-version message.');
  const messageDigests = Array.isArray(cohort.providerMessageIdDigests)
    ? cohort.providerMessageIdDigests
    : [];
  assert(messageDigests.length === cohort.delivered, 'Feishu report must hash every delivered provider message ID.');
  assert(messageDigests.every((value) => /^sha256:[0-9a-f]{64}$/u.test(value)), 'Feishu provider message digest is invalid.');
  assert(new Set(messageDigests).size === messageDigests.length, 'Feishu provider message IDs are not distinct.');

  const replay = report.approvalReplay || {};
  assert(
    replay.submissions >= 10
      && replay.approvalEvents === 1
      && replay.logicalCommands === 1
      && replay.requestUuids === 1
      && replay.sameVersionProviderMessages <= 1
      && replay.passed === true,
    'Feishu approval replay did not prove logical idempotency.',
  );
  const negatives = new Map((report.negativeCases || []).map((entry) => [entry?.name, entry]));
  for (const name of REQUIRED_NEGATIVE_CASES) {
    const entry = negatives.get(name);
    assert(entry?.passed === true && entry.externalMessages === 0, `Feishu negative case ${name} failed.`);
  }
  const faults = new Map((report.faultCases || []).map((entry) => [entry?.name, entry]));
  for (const name of REQUIRED_FAULT_CASES) {
    const entry = faults.get(name);
    assert(entry?.passed === true && entry.blindRetries === 0, `Feishu fault case ${name} failed.`);
  }
  assert(
    faults.get('post_send_transport_exception')?.actualState === 'delivery_unknown',
    'A post-send transport exception must end in delivery_unknown.',
  );
  return { approvals: cohort.approvals, delivered: cohort.delivered, p95Ms: cohort.p95Ms };
}

function validateUsabilityEvidence(report, revision) {
  commonEvidence(report, revision, 'Usability');
  assert(/^sha256:[0-9a-f]{64}$/u.test(report.fixtureSha256 || ''), 'Usability fixtureSha256 is invalid.');
  const participants = Array.isArray(report.participants) ? report.participants : [];
  assert(participants.length >= 5, 'Usability evidence needs at least five participants.');
  const pseudonyms = new Set();
  let successful = 0;
  for (const participant of participants) {
    assert(/^[A-Za-z0-9_-]{3,40}$/u.test(participant?.pseudonym || ''), 'Usability participant pseudonym is invalid.');
    assert(!pseudonyms.has(participant.pseudonym), 'Usability participant pseudonyms must be unique.');
    pseudonyms.add(participant.pseudonym);
    assert(
      participant.eligibility?.notDeveloper === true
        && participant.eligibility?.commerceOperationsExperience === true
        && participant.eligibility?.unfamiliarWithProduct === true,
      `Usability participant ${participant.pseudonym} is ineligible.`,
    );
    assert(participant.assistanceGiven === false, `Usability participant ${participant.pseudonym} received assistance.`);
    const started = Date.parse(participant.startedAt);
    const completed = Date.parse(participant.completedAt);
    assert(Number.isFinite(started) && Number.isFinite(completed) && completed >= started, 'Usability timestamps are invalid.');
    const durationMs = completed - started;
    assert(participant.durationMs === durationMs, 'Usability duration does not match its timestamps.');
    const stepsComplete = participant.steps?.diagnosis === true
      && participant.steps?.evidence === true
      && participant.steps?.actionConfirmed === true;
    const computedSuccess = stepsComplete && durationMs <= 180_000;
    assert(participant.success === computedSuccess, `Usability success is inconsistent for ${participant.pseudonym}.`);
    if (computedSuccess) successful += 1;
  }
  assert(successful >= 4, 'Fewer than four usability participants completed the task in three minutes.');
  assert(report.summary?.eligible === participants.length, 'Usability eligible denominator is inconsistent.');
  assert(report.summary?.successful === successful, 'Usability success numerator is inconsistent.');
  const reviewers = report.attestation?.reviewers;
  assert(Array.isArray(reviewers) && new Set(reviewers).size >= 2, 'Usability report needs two independent reviewer attestations.');
  assert(Number.isFinite(Date.parse(report.attestation?.signedAt)), 'Usability attestation signedAt is invalid.');
  return { participants: participants.length, successful };
}

function assertNoSensitiveMaterial(report, name) {
  const serialized = JSON.stringify(report);
  assert(!/postgres(?:ql)?:\/\//iu.test(serialized), `${name} evidence contains a database URL.`);
  assert(!/(?:password|app_secret|access_token|authorization)["']?\s*:/iu.test(serialized), `${name} evidence contains secret material.`);
}

async function fetchBytes(url, label) {
  const parsed = new URL(url);
  assert(parsed.protocol === 'https:', `${label} evidence URL must use HTTPS.`);
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
  assert(response.ok, `${label} evidence download returned HTTP ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert(bytes.length > 0 && bytes.length <= MAX_EVIDENCE_BYTES, `${label} evidence size is invalid.`);
  return bytes;
}

async function loadEvidence({ label, pathValue, urlValue, expectedSha256 }) {
  let bytes;
  let source;
  if (String(pathValue || '').trim()) {
    const resolved = path.resolve(String(pathValue).trim());
    bytes = fs.readFileSync(resolved);
    source = { kind: 'file', location: path.relative(root, resolved).replaceAll('\\', '/') };
  } else {
    const url = String(urlValue || '').trim();
    assert(url, `${label} evidence path or URL is required.`);
    assert(/^[0-9a-f]{64}$/u.test(String(expectedSha256 || '')), `${label} evidence URL requires an expected SHA-256.`);
    bytes = await fetchBytes(url, label);
    source = { kind: 'https', location: new URL(url).origin };
  }
  assert(bytes.length > 0 && bytes.length <= MAX_EVIDENCE_BYTES, `${label} evidence size is invalid.`);
  const digest = sha256(bytes);
  if (String(expectedSha256 || '').trim()) {
    assert(digest === String(expectedSha256).trim(), `${label} evidence SHA-256 mismatch.`);
  }
  let report;
  try {
    report = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} evidence is not valid UTF-8 JSON.`);
  }
  return { report, digest, bytes: bytes.length, source };
}

async function main() {
  const revision = immutableRevision();
  const specifications = [
    {
      key: 'performance', label: 'Performance', pathValue: process.env.COMMERCE_PERFORMANCE_EVIDENCE_PATH,
      urlValue: process.env.COMMERCE_PERFORMANCE_EVIDENCE_URL,
      expectedSha256: process.env.COMMERCE_PERFORMANCE_EVIDENCE_SHA256,
      validate: validatePerformanceEvidence,
    },
    {
      key: 'feishuSandbox', label: 'Feishu sandbox', pathValue: process.env.COMMERCE_FEISHU_SANDBOX_EVIDENCE_PATH,
      urlValue: process.env.COMMERCE_FEISHU_SANDBOX_EVIDENCE_URL,
      expectedSha256: process.env.COMMERCE_FEISHU_SANDBOX_EVIDENCE_SHA256,
      validate: validateFeishuEvidence,
    },
    {
      key: 'usability', label: 'Usability', pathValue: process.env.COMMERCE_USABILITY_EVIDENCE_PATH,
      urlValue: process.env.COMMERCE_USABILITY_EVIDENCE_URL,
      expectedSha256: process.env.COMMERCE_USABILITY_EVIDENCE_SHA256,
      validate: validateUsabilityEvidence,
    },
  ];
  const evidence = {};
  for (const specification of specifications) {
    const loaded = await loadEvidence(specification);
    assertNoSensitiveMaterial(loaded.report, specification.label);
    const summary = specification.validate(loaded.report, revision);
    evidence[specification.key] = {
      sha256: loaded.digest,
      bytes: loaded.bytes,
      source: loaded.source,
      schemaVersion: loaded.report.schemaVersion,
      summary,
    };
  }
  const report = {
    schemaVersion: 1,
    service: 'commerce-data-agent',
    revision,
    status: 'passed',
    generatedAt: new Date().toISOString(),
    evidence,
  };
  const output = path.resolve(process.env.COMMERCE_EXTERNAL_EVIDENCE_REPORT_PATH || DEFAULT_OUTPUT);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  console.log(`[commerce-external-evidence] PASS ${path.relative(root, output)}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[commerce-external-evidence] FAIL ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

module.exports = {
  immutableRevision,
  loadEvidence,
  validateFeishuEvidence,
  validatePerformanceEvidence,
  validateUsabilityEvidence,
};

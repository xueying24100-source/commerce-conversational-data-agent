import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  validateFeishuEvidence,
  validatePerformanceEvidence,
  validateUsabilityEvidence,
} = require('./check-commerce-external-evidence.js');

const revision = 'abcdef1234567';
const digest = `sha256:${'a'.repeat(64)}`;

function common() {
  return { schemaVersion: 1, service: 'commerce-data-agent', revision, status: 'passed' };
}

function performanceEvidence() {
  return {
    ...common(),
    workload: {
      concurrency: 10,
      requestsPerEndpoint: 1000,
      readWriteRatio: '80/20',
      schedule: 'interleaved-concurrent',
      workerDisabled: true,
    },
    referenceEnvironment: {
      deploymentRevision: revision,
      region: 'test-region',
      workerCount: 0,
      databaseSpec: 'postgres-test',
      modelVersion: 'deepseek:test',
      fixtureSha256: digest,
      cacheState: 'warm',
    },
    responseValidation: { semanticFailures: 0, revisionMismatches: 0 },
    endpoints: [
      ['readiness', 250],
      ['conversations', 250],
      ['jobs', 250],
      ['evidence', 250],
      ['create-diagnosis-job', 450],
    ].map(([name, p95Ms]) => ({ name, samples: 1000, p95Ms, p99Ms: 800, passed: true })),
    reviewEnqueue: { samples: 100, p95Ms: 14 * 60 * 1000, passed: true },
  };
}

function feishuEvidence() {
  return {
    ...common(),
    sandbox: { tenantFingerprint: digest, appScopeFingerprint: digest },
    normalCohort: {
      approvals: 100,
      delivered: 99,
      p95Ms: 59_000,
      logicalCommandCount: 100,
      distinctRequestUuidCount: 100,
      duplicateSameVersionMessages: 0,
      providerMessageIdDigests: Array.from(
        { length: 99 },
        (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`,
      ),
    },
    approvalReplay: {
      submissions: 10,
      approvalEvents: 1,
      logicalCommands: 1,
      requestUuids: 1,
      sameVersionProviderMessages: 1,
      passed: true,
    },
    negativeCases: [
      'proposed_or_unapproved',
      'ignored',
      'snoozed',
      'unauthorized_operator',
      'forged_member_id',
      'removed_member',
      'cross_tenant_member',
      'global_kill_switch',
      'sensitive_payload_filtered',
    ].map((name) => ({ name, externalMessages: 0, passed: true })),
    faultCases: [
      'accepted_202',
      'rate_limited_429',
      'provider_500',
      'pre_send_timeout',
      'post_send_transport_exception',
      'worker_crash',
    ].map((name) => ({
      name,
      actualState: name === 'post_send_transport_exception' ? 'delivery_unknown' : 'verified',
      blindRetries: 0,
      passed: true,
    })),
  };
}

function usabilityEvidence() {
  const participants = Array.from({ length: 5 }, (_, index) => ({
    pseudonym: `operator_${index}`,
    eligibility: {
      notDeveloper: true,
      commerceOperationsExperience: true,
      unfamiliarWithProduct: true,
    },
    assistanceGiven: false,
    startedAt: '2026-08-16T00:00:00.000Z',
    completedAt: index < 4 ? '2026-08-16T00:02:00.000Z' : '2026-08-16T00:04:00.000Z',
    durationMs: index < 4 ? 120_000 : 240_000,
    steps: {
      diagnosis: index < 4,
      evidence: index < 4,
      actionConfirmed: index < 4,
    },
    success: index < 4,
  }));
  return {
    ...common(),
    fixtureSha256: digest,
    participants,
    summary: { eligible: 5, successful: 4 },
    attestation: { reviewers: ['reviewer_a', 'reviewer_b'], signedAt: '2026-08-16T01:00:00.000Z' },
  };
}

describe('Commerce external release evidence', () => {
  it('accepts only interleaved revision-bound performance evidence', () => {
    expect(validatePerformanceEvidence(performanceEvidence(), revision)).toEqual({
      endpointSamples: 5000,
      reviewSamples: 100,
    });
    const sequential = performanceEvidence();
    sequential.workload.schedule = 'sequential';
    expect(() => validatePerformanceEvidence(sequential, revision)).toThrow('interleaved');
  });

  it('requires Feishu provider IDs, negative cases and delivery_unknown handling', () => {
    expect(validateFeishuEvidence(feishuEvidence(), revision)).toMatchObject({ approvals: 100, delivered: 99 });
    const unsafe = feishuEvidence();
    unsafe.faultCases.find((entry) => entry.name === 'post_send_transport_exception').actualState = 'retryable';
    expect(() => validateFeishuEvidence(unsafe, revision)).toThrow('delivery_unknown');
  });

  it('recomputes the five-person usability outcome from timestamps and steps', () => {
    expect(validateUsabilityEvidence(usabilityEvidence(), revision)).toEqual({ participants: 5, successful: 4 });
    const assisted = usabilityEvidence();
    assisted.participants[0].assistanceGiven = true;
    expect(() => validateUsabilityEvidence(assisted, revision)).toThrow('received assistance');
  });
});

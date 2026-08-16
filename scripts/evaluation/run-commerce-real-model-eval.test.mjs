import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  ADAPTIVE_SCENARIO_QUOTAS,
  SCENARIO_QUOTAS,
  adaptiveScenarioKind,
  selectLayeredScenarios,
  summarizeRuns,
  validateRunEnvelope,
} = require('./run-commerce-real-model-eval.js');

const manifest = JSON.parse(fs.readFileSync(
  path.join(process.cwd(), 'quality', 'commerce-agent-eval', 'v1', 'final-manifest.json'),
  'utf8',
));

describe('Commerce 120-run real-model harness', () => {
  it('selects the frozen 24-scenario layered quotas', () => {
    const scenarios = selectLayeredScenarios(manifest);
    const counts = scenarios.reduce((result, scenario) => ({
      ...result,
      [scenario.category]: (result[scenario.category] || 0) + 1,
    }), {});
    expect(scenarios).toHaveLength(24);
    expect(new Set(scenarios.map((scenario) => scenario.caseId)).size).toBe(24);
    expect(counts).toEqual(SCENARIO_QUOTAS);
    const adaptiveKinds = scenarios
      .filter((scenario) => scenario.category === 'adaptive_diagnosis')
      .reduce((result, scenario) => ({
        ...result,
        [adaptiveScenarioKind(scenario)]: (result[adaptiveScenarioKind(scenario)] || 0) + 1,
      }), {});
    expect(adaptiveKinds).toEqual(ADAPTIVE_SCENARIO_QUOTAS);
  });

  it('rejects result envelopes without auditable model metadata', () => {
    expect(() => validateRunEnvelope({ caseId: 'case', repeat: 1, result: { caseId: 'case' } }, {
      caseId: 'case', repeat: 1,
    })).toThrow(/metadata/u);
  });

  it('binds the envelope to revision, model, frozen hashes, parameters and real usage', () => {
    const expected = {
      caseId: 'case',
      repeat: 1,
      revision: 'a'.repeat(40),
      model: 'deepseek-v4-flash',
      manifestSha256: `sha256:${'1'.repeat(64)}`,
      oracleSha256: `sha256:${'2'.repeat(64)}`,
      promptSha256: `sha256:${'3'.repeat(64)}`,
      fixtureSha256: `sha256:${'4'.repeat(64)}`,
      requestSha256: `sha256:${'5'.repeat(64)}`,
      parameters: { temperature: 0 },
    };
    const envelope = {
      caseId: 'case',
      repeat: 1,
      revision: expected.revision,
      model: expected.model,
      result: { caseId: 'case' },
      metadata: {
        revision: expected.revision,
        model: expected.model,
        manifestSha256: expected.manifestSha256,
        oracleSha256: expected.oracleSha256,
        promptSha256: expected.promptSha256,
        fixtureSha256: expected.fixtureSha256,
        requestSha256: expected.requestSha256,
        parameters: expected.parameters,
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        costUsd: 0.01,
        latencyMs: 250,
        tools: [],
      },
    };
    expect(() => validateRunEnvelope(envelope, expected)).not.toThrow();

    expect(() => validateRunEnvelope({ ...envelope, revision: 'wrong' }, expected)).toThrow(/revision\/model/u);
    expect(() => validateRunEnvelope({
      ...envelope,
      metadata: { ...envelope.metadata, promptSha256: `sha256:${'9'.repeat(64)}` },
    }, expected)).toThrow(/promptSha256/u);
    expect(() => validateRunEnvelope({
      ...envelope,
      metadata: { ...envelope.metadata, totalTokens: 121 },
    }, expected)).toThrow(/totalTokens/u);
    expect(() => validateRunEnvelope({
      ...envelope,
      metadata: { ...envelope.metadata, inputTokens: 0, totalTokens: 20 },
    }, expected)).toThrow(/inputTokens/u);
    expect(() => validateRunEnvelope({
      ...envelope,
      result: { caseId: 'case', tools: ['scan_weekly_commerce_kpis'] },
    }, expected)).toThrow(/tools do not match/u);
  });

  it('enforces 110 of 120 and four of five per non-safety scenario', () => {
    const scenarios = selectLayeredScenarios(manifest);
    const runs = scenarios.flatMap((scenario, scenarioIndex) => Array.from({ length: 5 }, (_, index) => ({
      caseId: scenario.caseId,
      completeTask: !(scenario.category !== 'safety_refusal' && scenarioIndex < 10 && index === 4),
      assertionFailures: [],
      metadata: { latencyMs: 30_000 },
      clientRoundTripMs: 30_100,
    })));
    const summary = summarizeRuns(runs, scenarios);
    expect(summary.completeRuns).toBeGreaterThanOrEqual(110);
    expect(summary.passed).toBe(true);

    runs.find((run) => run.caseId === scenarios[0].caseId && run.completeTask).completeTask = false;
    expect(summarizeRuns(runs, scenarios).passed).toBe(false);
  });

  it('requires all five safety runs to complete instead of diluting them in 110 of 120', () => {
    const scenarios = selectLayeredScenarios(manifest);
    const runs = scenarios.flatMap((scenario) => Array.from({ length: 5 }, (_, index) => ({
      caseId: scenario.caseId,
      completeTask: !(scenario.category === 'safety_refusal' && index === 0),
      assertionFailures: [],
      metadata: { latencyMs: 30_000 },
      clientRoundTripMs: 30_100,
    })));
    expect(runs.filter((run) => run.completeTask)).toHaveLength(116);
    expect(summarizeRuns(runs, scenarios).passed).toBe(false);
  });

  it('enforces diagnosis p95 <= 60 seconds and at least 98% within 90 seconds', () => {
    const scenarios = selectLayeredScenarios(manifest);
    const runs = scenarios.flatMap((scenario) => Array.from({ length: 5 }, () => ({
      caseId: scenario.caseId,
      completeTask: true,
      assertionFailures: [],
      metadata: { latencyMs: 30_000 },
      clientRoundTripMs: 30_100,
    })));
    expect(summarizeRuns(runs, scenarios).latency).toMatchObject({
      samples: 120,
      within90Seconds: 120,
      passed: true,
    });
    for (let index = 0; index < 7; index += 1) runs[index].clientRoundTripMs = 61_000;
    expect(summarizeRuns(runs, scenarios).latency.passed).toBe(false);
    for (let index = 0; index < 7; index += 1) runs[index].clientRoundTripMs = 30_100;
    for (let index = 0; index < 3; index += 1) runs[index].clientRoundTripMs = 91_000;
    expect(summarizeRuns(runs, scenarios).latency.passed).toBe(false);
  });
});

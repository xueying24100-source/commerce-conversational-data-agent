import { describe, expect, it, vi } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import type { PostgresCommerceJobStore } from './job-store';
import type { CommerceAgentRunResponse } from './types';
import {
  PostgresCommerceWeeklyDiagnosisScheduler,
  eligibleCommerceWeeklyDiagnosisWindows,
} from './weekly-diagnosis-scheduler';

function result(rows: Record<string, unknown>[] = []): CommerceQueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length };
}

function completedWeeklyResult(): CommerceAgentRunResponse {
  const createdAt = '2026-08-18T00:05:00.000Z';
  return {
    conversation: {
      id: 'conv_weekly_result_1234',
      title: '周诊断',
      model: 'model-test',
      createdAt,
      updatedAt: createdAt,
    },
    userMessage: {
      id: 'msg_weekly_question_1234',
      role: 'user',
      content: '诊断上一完整周。',
      answer: null,
      runId: 'run_weekly_result_1234',
      runStatus: 'completed',
      reportAvailable: false,
      traces: [],
      createdAt,
    },
    assistantMessage: {
      id: 'msg_weekly_result_1234',
      role: 'assistant',
      content: '诊断完成。',
      answer: null,
      runId: 'run_weekly_result_1234',
      runStatus: 'completed',
      reportAvailable: true,
      traces: [],
      createdAt,
    },
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  };
}

class ScriptedDatabase implements CommerceDatabase {
  constructor(private readonly execute: (
    text: string,
    values: readonly unknown[],
  ) => CommerceQueryResult<Record<string, unknown>>) {}
  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    if (text.includes("set_config('commerce.")) return Promise.resolve(result() as CommerceQueryResult<Row>);
    return Promise.resolve(this.execute(text, values) as CommerceQueryResult<Row>);
  }
  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> { return work(this); }
  async ping(): Promise<void> {}
}

class RegistryAnalyticsDatabase implements CommerceDatabase {
  readonly tenantScopes: string[] = [];
  private tenantId: string | null = null;

  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    if (text.includes("set_config('commerce.tenant_id'")) {
      this.tenantId = String(values[0]);
      this.tenantScopes.push(this.tenantId);
      return Promise.resolve(result() as CommerceQueryResult<Row>);
    }
    expect(this.tenantId).not.toBeNull();
    expect(values).toEqual([this.tenantId]);
    return Promise.resolve(result([{
      business_timezone: 'Asia/Shanghai',
      published_coverage_end: '1900-01-01',
      connector_id: `${this.tenantId}-orders`,
      source_coverage_end: '1900-01-01',
    }]) as CommerceQueryResult<Row>);
  }

  async transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> {
    this.tenantId = null;
    return work(this);
  }

  async ping(): Promise<void> {}
}

describe('weekly diagnosis scheduling policy', () => {
  it('enumerates multiple tenants from Control and scopes one Analytics transaction per tenant', async () => {
    let usedControlRegistry = false;
    const control = new ScriptedDatabase((text) => {
      if (text.includes('scheduler_tenant_registry')) {
        usedControlRegistry = true;
        return result([{ tenant_id: 'tenant-a' }, { tenant_id: 'tenant-b' }]);
      }
      if (text.includes('FROM commerce_weekly_diagnosis_runs')) return result();
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const analytics = new RegistryAnalyticsDatabase();

    await expect(new PostgresCommerceWeeklyDiagnosisScheduler(control, analytics).runDue({
      model: 'model-test',
      policyVersion: 'policy-v1',
      now: new Date('2026-08-17T20:00:00.000Z'),
    })).resolves.toEqual({ queued: 0, backlog: 0 });
    expect(usedControlRegistry).toBe(true);
    expect(analytics.tenantScopes).toEqual(['tenant-a', 'tenant-b']);
  });

  it('waits for both the 26-hour tolerance and inclusive coverage date, then bounds recovery to two weeks', () => {
    const beforeTolerance = eligibleCommerceWeeklyDiagnosisWindows({
      tenantId: 'tenant-a',
      now: new Date('2026-08-10T17:59:59.000Z'),
      timezone: 'Asia/Shanghai',
      coverageEnd: '2026-08-09',
    });
    expect(beforeTolerance.runnable.some((window) => window.weekStart === '2026-08-03')).toBe(false);

    const recovered = eligibleCommerceWeeklyDiagnosisWindows({
      tenantId: 'tenant-a',
      now: new Date('2026-08-17T20:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      coverageEnd: '2026-08-16',
      recoveryLimit: 2,
    });
    expect(recovered.runnable).toHaveLength(2);
    expect(recovered.runnable.map((window) => window.weekStart)).toEqual([
      '2026-08-03',
      '2026-08-10',
    ]);
    expect(recovered.skippedBacklog.length).toBeGreaterThan(0);
    expect(recovered.runnable.every((window) => window.canonicalSha256.startsWith('sha256:'))).toBe(true);
  });

  it('does not consider a policy version when replaying the canonical complete week', async () => {
    let persisted: Record<string, unknown> | null = null;
    let inserts = 0;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('AND is_current') && text.includes('LIMIT 1')) {
        return result(persisted ? [persisted] : []);
      }
      if (text.includes('INSERT INTO commerce_weekly_diagnosis_runs')) {
        inserts += 1;
        persisted = {
          id: values[0], revision: 1, canonical_sha256: values[7],
          policy_version: values[6], status: values[8], supersedes_run_id: null,
          created_at: '2026-08-17T20:00:00.000Z',
        };
        return result([persisted]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const scheduler = new PostgresCommerceWeeklyDiagnosisScheduler(database);
    const window = eligibleCommerceWeeklyDiagnosisWindows({
      tenantId: 'tenant-a',
      now: new Date('2026-08-17T20:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      coverageEnd: '2026-08-16',
      recoveryLimit: 1,
    }).runnable[0]!;
    const first = await scheduler.ensureCanonical({
      tenantId: 'tenant-a', userId: 'system-weekly', timezone: 'Asia/Shanghai',
      window, policyVersion: 'policy-v1',
    });
    const replay = await scheduler.ensureCanonical({
      tenantId: 'tenant-a', userId: 'system-weekly', timezone: 'Asia/Shanghai',
      window, policyVersion: 'policy-v2',
    });
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.run.id).toBe(first.run.id);
    expect(inserts).toBe(1);
  });

  it('atomically binds one durable create-conversation Job to a canonical week and replays it', async () => {
    let persisted: Record<string, unknown> | null = null;
    const enqueueWithClient = vi.fn(async (
      _client: CommerceSqlClient,
      _input: Parameters<PostgresCommerceJobStore['enqueueWithClient']>[1],
    ) => ({
      id: 'job_weekly_1234567890', kind: 'create_conversation' as const,
      conversationId: null, requestId: 'weekly-request', model: 'model-test',
      message: 'weekly diagnosis', requiredRevision: 'test-revision', executedByWorkerId: null,
      status: 'queued' as const, attemptCount: 0, maxAttempts: 3,
      availableAt: '2026-08-17T20:00:00.000Z', createdAt: '2026-08-17T20:00:00.000Z',
      startedAt: null, completedAt: null, result: null, error: null,
    }));
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_weekly_diagnosis_runs') && text.includes('FOR UPDATE')) {
        return result(persisted ? [persisted] : []);
      }
      if (text.includes('INSERT INTO commerce_weekly_diagnosis_runs')) {
        persisted = {
          id: values[0], week_start: values[3], week_end: values[4], revision: 1,
          canonical_sha256: values[7], policy_version: values[6], status: 'waiting',
          is_current: true, supersedes_run_id: null, agent_job_id: null,
          created_at: '2026-08-17T20:00:00.000Z',
        };
        return result([persisted]);
      }
      if (text.includes("SET status = 'queued', agent_job_id")) {
        persisted = { ...persisted!, status: 'queued', agent_job_id: values[1] };
        return result([persisted]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const scheduler = new PostgresCommerceWeeklyDiagnosisScheduler(
      database,
      null,
      { enqueueWithClient },
    );
    const window = eligibleCommerceWeeklyDiagnosisWindows({
      tenantId: 'tenant-a',
      now: new Date('2026-08-17T20:00:00.000Z'),
      timezone: 'Asia/Shanghai',
      coverageEnd: '2026-08-16',
      recoveryLimit: 1,
    }).runnable[0]!;
    const first = await scheduler.enqueueCanonical({
      tenantId: 'tenant-a', timezone: 'Asia/Shanghai', window,
      policyVersion: 'policy-v1', model: 'model-test',
    });
    const replay = await scheduler.enqueueCanonical({
      tenantId: 'tenant-a', timezone: 'Asia/Shanghai', window,
      policyVersion: 'policy-v2', model: 'model-test',
    });
    expect(first).toMatchObject({ created: true, jobCreated: true });
    expect(replay).toMatchObject({ created: false, jobCreated: false });
    expect(replay.run.id).toBe(first.run.id);
    expect(enqueueWithClient).toHaveBeenCalledTimes(1);
    expect(enqueueWithClient.mock.calls[0]?.[1]).toMatchObject({
      kind: 'create_conversation',
      model: 'model-test',
      identity: { userId: 'system:weekly-diagnosis' },
    });
    expect(enqueueWithClient.mock.calls[0]?.[1].message).toContain(window.weekStart);
    expect(enqueueWithClient.mock.calls[0]?.[1].message).toContain('至 2026-08-16');
  });

  it('recovers a failed physical Job without creating a duplicate canonical logical run', async () => {
    const persisted = {
      id: 'weekly_diagnosis_1234567890123456',
      week_start: '2026-08-10', week_end: '2026-08-17', revision: 1,
      canonical_sha256: `sha256:${'a'.repeat(64)}`, policy_version: 'policy-v1',
      status: 'failed', is_current: true, supersedes_run_id: null,
      agent_job_id: 'job_weekly_failed_1234', created_at: '2026-08-17T20:00:00.000Z',
    };
    const enqueueWithClient = vi.fn(async (
      _client: CommerceSqlClient,
      _input: Parameters<PostgresCommerceJobStore['enqueueWithClient']>[1],
    ) => ({
      id: 'job_weekly_recovery_1234', kind: 'create_conversation' as const,
      conversationId: null, requestId: 'weekly-recovery', model: 'model-test',
      message: 'weekly diagnosis', requiredRevision: 'new-revision', executedByWorkerId: null,
      status: 'queued' as const, attemptCount: 0, maxAttempts: 3,
      availableAt: '2026-08-18T00:00:00.000Z', createdAt: '2026-08-18T00:00:00.000Z',
      startedAt: null, completedAt: null, result: null, error: null,
    }));
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_weekly_diagnosis_runs') && text.includes('FOR UPDATE')) {
        return result([persisted]);
      }
      if (text.includes("SET status = 'queued', agent_job_id")) {
        return result([{
          ...persisted, status: 'queued', agent_job_id: values[1],
        }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const scheduler = new PostgresCommerceWeeklyDiagnosisScheduler(
      database,
      null,
      { enqueueWithClient },
    );
    const recovered = await scheduler.enqueueCanonical({
      tenantId: 'tenant-a', timezone: 'Asia/Shanghai',
      window: {
        weekStart: '2026-08-10', weekEnd: '2026-08-17',
        eligibleAt: '2026-08-18T18:00:00.000Z',
        canonicalSha256: persisted.canonical_sha256,
      },
      policyVersion: 'policy-v2', model: 'model-test', recoverFailed: true,
    });
    expect(recovered).toMatchObject({
      created: false, jobCreated: true,
      run: { id: persisted.id, revision: 1, status: 'queued', agentJobId: 'job_weekly_recovery_1234' },
    });
    expect(enqueueWithClient).toHaveBeenCalledTimes(1);
    expect(enqueueWithClient.mock.calls[0]?.[1].requestId).toMatch(/^weekly-recovery:/u);
  });

  it('creates an auditable correction revision that supersedes but does not overwrite the current run', async () => {
    const current = {
      id: 'weekly_diagnosis_revision_1',
      tenant_id: 'tenant-a', user_id: 'system:weekly-diagnosis',
      week_start: '2026-08-10', week_end: '2026-08-17', revision: 1,
      canonical_sha256: `sha256:${'b'.repeat(64)}`, policy_version: 'policy-v1',
      status: 'completed', is_current: true, supersedes_run_id: null,
      agent_job_id: 'job_weekly_revision_1', created_at: '2026-08-17T20:00:00.000Z',
    };
    let superseded = false;
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('pg_advisory_xact_lock')) return result([{}]);
      if (text.includes('FROM commerce_weekly_diagnosis_runs') && text.includes('FOR UPDATE')) {
        return result([current]);
      }
      if (text.includes('SET is_current = FALSE')) {
        expect(values).toEqual([current.id]);
        expect(text).toContain("THEN 'superseded'");
        superseded = true;
        return result([{ id: current.id }]);
      }
      if (text.includes('UPDATE commerce_agent_jobs')) {
        expect(values.slice(0, 3)).toEqual([
          current.agent_job_id, current.tenant_id, current.user_id,
        ]);
        return result();
      }
      if (text.includes('INSERT INTO commerce_weekly_diagnosis_runs')) {
        expect(superseded).toBe(true);
        expect(values[2]).toBe(current.user_id);
        expect(values[6]).toBe(2);
        expect(values[9]).toBe(current.id);
        return result([{
          ...current,
          id: values[0], revision: 2, policy_version: values[7], status: 'waiting',
          is_current: true, supersedes_run_id: current.id, agent_job_id: null,
          created_at: '2026-08-18T00:00:00.000Z',
        }]);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const corrected = await new PostgresCommerceWeeklyDiagnosisScheduler(database)
      .supersedeForCorrection({
        tenantId: 'tenant-a', userId: 'operator-a', timezone: 'Asia/Shanghai',
        window: {
          weekStart: '2026-08-10', weekEnd: '2026-08-17',
          eligibleAt: '2026-08-18T18:00:00.000Z',
          canonicalSha256: current.canonical_sha256,
        },
        policyVersion: 'policy-v2',
      });
    expect(corrected).toMatchObject({
      revision: 2,
      supersedesRunId: current.id,
      policyVersion: 'policy-v2',
      status: 'waiting',
    });
  });
});

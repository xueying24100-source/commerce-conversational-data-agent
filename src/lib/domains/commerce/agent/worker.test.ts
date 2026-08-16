import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  renew: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
  retryOrDeadLetter: vi.fn(),
  heartbeatWorker: vi.fn(),
  stopWorker: vi.fn(),
  reviewClaim: vi.fn(),
  reviewFinalize: vi.fn(),
  reviewFailed: vi.fn(),
  weeklyClaim: vi.fn(),
  weeklyComplete: vi.fn(),
  weeklyFailed: vi.fn(),
  weeklyRunDue: vi.fn(),
  reminderRunDue: vi.fn(),
  reviewInvalidate: vi.fn(),
  reviewSchedule: vi.fn(),
  reviewQueueReady: vi.fn(),
  createConversationAndRun: vi.fn(),
  runTurn: vi.fn(),
  feishuClaim: vi.fn(),
  feishuSend: vi.fn(),
  feishuComplete: vi.fn(),
  globalKillSwitch: false,
  notificationsEnabled: false,
  retrySignal: { retryable: false, retryAfterMs: null } as {
    retryable: boolean;
    retryAfterMs: number | null;
  },
  diagnosticPolicyEnabled: true,
  anomalyDetectionEnabled: true,
  order: [] as string[],
}));

vi.mock('./config', () => ({
  configuredCommerceModels: () => ['deepseek-v4-flash'],
  getCommerceAgentRuntimeConfig: () => ({
    globalKillSwitch: mocks.globalKillSwitch,
    jobLeaseMs: 150_000,
    jobRetryBaseMs: 2_000,
    jobRetryMaxMs: 60_000,
    jobMaxAttempts: 3,
    maxQueuedJobsPerUser: 2,
    automaticReviewEnabled: true,
    weeklyDiagnosisEnabled: true,
    diagnosticPolicyEnabled: mocks.diagnosticPolicyEnabled,
    anomalyDetectionEnabled: mocks.anomalyDetectionEnabled,
    notificationsEnabled: mocks.notificationsEnabled,
    feishuAppId: mocks.notificationsEnabled ? 'app-id' : null,
    feishuAppSecret: mocks.notificationsEnabled ? 'app-secret' : null,
    feishuBaseUrl: 'https://open.feishu.cn',
    workerStaleMs: 3_000,
    jobPollMs: 1,
  }),
}));

vi.mock('./action-reminder-scheduler', () => ({
  getCommerceActionReminderScheduler: () => ({
    runDue: mocks.reminderRunDue,
  }),
}));

vi.mock('./jobs', () => ({
  getCommerceJobStore: () => ({
    claim: mocks.claim,
    renew: mocks.renew,
    complete: mocks.complete,
    fail: mocks.fail,
    retryOrDeadLetter: mocks.retryOrDeadLetter,
    heartbeatWorker: mocks.heartbeatWorker,
    stopWorker: mocks.stopWorker,
  }),
}));

vi.mock('./feishu-outbox', () => ({
  FeishuNotificationClient: class {
    send = mocks.feishuSend;
  },
  getCommerceFeishuOutboxStore: () => ({
    claim: mocks.feishuClaim,
    completeDelivery: mocks.feishuComplete,
  }),
}));

vi.mock('./review-scheduler', () => ({
  getCommerceReviewScheduler: () => ({
    claimJob: mocks.reviewClaim,
    finalizeJob: mocks.reviewFinalize,
    markJobFailed: mocks.reviewFailed,
    invalidateStale: mocks.reviewInvalidate,
    scheduleCompleted: mocks.reviewSchedule,
    queueReadyFromCurrentWatermarks: mocks.reviewQueueReady,
  }),
}));

vi.mock('./weekly-diagnosis-scheduler', () => ({
  getCommerceWeeklyDiagnosisScheduler: () => ({
    claimJob: mocks.weeklyClaim,
    completeJob: mocks.weeklyComplete,
    markJobFailed: mocks.weeklyFailed,
    runDue: mocks.weeklyRunDue,
  }),
}));

vi.mock('./service', () => ({
  getCommerceAgentService: () => ({
    createConversationAndRun: mocks.createConversationAndRun,
    runTurn: mocks.runTurn,
  }),
}));

vi.mock('./job-retry', () => ({
  commerceJobRetryDelay: () => 1_000,
  commerceJobRetrySignal: () => mocks.retrySignal,
}));

vi.mock('./telemetry', () => ({
  logCommerceEvent: vi.fn(),
  logCommerceFailure: vi.fn(),
}));

import {
  processNextCommerceAgentJob,
  processNextCommerceFeishuNotification,
  runCommerceAgentWorker,
  runCommerceSchedulers,
} from './worker';

const identity = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  displayName: 'Operator A',
  authMode: 'trusted_proxy' as const,
  scopes: ['commerce:read'],
};

const claimedJob = {
  id: 'job_review_1234567890',
  kind: 'conversation_turn' as const,
  conversationId: 'conv_1234567890123456',
  requestId: 'auto-review:request',
  model: 'model-test',
  message: '复盘指定窗口。',
  requiredRevision: 'test-revision',
  executedByWorkerId: 'worker-a',
  status: 'running' as const,
  attemptCount: 1,
  maxAttempts: 3,
  availableAt: '2026-03-16T04:05:00.000Z',
  createdAt: '2026-03-16T04:05:00.000Z',
  startedAt: '2026-03-16T04:05:00.000Z',
  completedAt: null,
  result: null,
  error: null,
  identity,
  leaseOwner: 'worker-a',
};

const runResult = {
  conversation: {
    id: claimedJob.conversationId,
    title: 'Review',
    model: 'model-test',
    createdAt: '2026-03-01T00:00:00.000Z',
    updatedAt: '2026-03-16T04:06:00.000Z',
  },
  userMessage: {
    id: 'msg_review_user_123456', role: 'user' as const, content: claimedJob.message,
    answer: null, runId: 'run_review_1234567890', runStatus: 'completed' as const,
    reportAvailable: false, traces: [], createdAt: '2026-03-16T04:05:00.000Z',
  },
  assistantMessage: {
    id: 'msg_review_answer_123456', role: 'assistant' as const, content: '复盘结果。',
    answer: {
      status: 'answered' as const, answer: '复盘结果。', answerClaims: [],
      findings: [], recommendations: [], followUps: [],
    },
    runId: 'run_review_1234567890', runStatus: 'completed' as const,
    reportAvailable: false, traces: [], createdAt: '2026-03-16T04:06:00.000Z',
  },
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
};

describe('Commerce Worker durable scheduler orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.globalKillSwitch = false;
    mocks.notificationsEnabled = false;
    mocks.retrySignal = { retryable: false, retryAfterMs: null };
    mocks.diagnosticPolicyEnabled = true;
    mocks.anomalyDetectionEnabled = true;
    mocks.order.length = 0;
    mocks.claim.mockResolvedValue(claimedJob);
    mocks.renew.mockResolvedValue(true);
    mocks.complete.mockResolvedValue(undefined);
    mocks.fail.mockResolvedValue(undefined);
    mocks.retryOrDeadLetter.mockResolvedValue('requeued');
    mocks.heartbeatWorker.mockResolvedValue(undefined);
    mocks.stopWorker.mockResolvedValue(undefined);
    mocks.reviewClaim.mockResolvedValue({ kind: 'not_review' });
    mocks.reviewFinalize.mockResolvedValue('completed');
    mocks.weeklyClaim.mockResolvedValue({ kind: 'not_weekly_diagnosis' });
    mocks.weeklyComplete.mockResolvedValue('completed');
    mocks.reviewFailed.mockResolvedValue(undefined);
    mocks.weeklyFailed.mockResolvedValue(undefined);
    mocks.reminderRunDue.mockResolvedValue(0);
    mocks.reviewInvalidate.mockResolvedValue(0);
    mocks.reviewSchedule.mockResolvedValue(0);
    mocks.reviewQueueReady.mockResolvedValue(0);
    mocks.weeklyRunDue.mockResolvedValue({ queued: 0, backlog: 0 });
    mocks.createConversationAndRun.mockResolvedValue(runResult);
    mocks.runTurn.mockResolvedValue(runResult);
    mocks.feishuClaim.mockResolvedValue(null);
    mocks.feishuSend.mockResolvedValue({ status: 'delivered', providerMessageId: 'om_123' });
    mocks.feishuComplete.mockResolvedValue(undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('does not claim a Job while the global kill switch is enabled', async () => {
    mocks.globalKillSwitch = true;

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(false);

    expect(mocks.claim).not.toHaveBeenCalled();
  });

  it('returns idle when no durable Job is available', async () => {
    mocks.claim.mockResolvedValueOnce(null);

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(false);

    expect(mocks.runTurn).not.toHaveBeenCalled();
  });

  it('completes a normal conversation turn after service execution', async () => {
    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(true);

    expect(mocks.runTurn).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: claimedJob.conversationId,
      requestId: claimedJob.requestId,
      retryFailed: false,
      signal: expect.any(AbortSignal),
    }));
    expect(mocks.complete).toHaveBeenCalledWith(claimedJob, runResult);
  });

  it('uses the create-conversation service path and marks retries explicitly', async () => {
    const createJob = {
      ...claimedJob,
      kind: 'create_conversation' as const,
      conversationId: null,
      attemptCount: 2,
    };
    mocks.claim.mockResolvedValueOnce(createJob);

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(true);

    expect(mocks.createConversationAndRun).toHaveBeenCalledWith(expect.objectContaining({
      requestId: createJob.requestId,
      retryFailed: true,
      signal: expect.any(AbortSignal),
    }));
    expect(mocks.runTurn).not.toHaveBeenCalled();
  });

  it('does not run model-enqueuing schedulers while the global kill switch is enabled', async () => {
    mocks.globalKillSwitch = true;

    await expect(runCommerceSchedulers()).resolves.toBeUndefined();

    expect(mocks.reminderRunDue).toHaveBeenCalledWith({ limit: 100 });
    expect(mocks.reviewInvalidate).not.toHaveBeenCalled();
    expect(mocks.reviewSchedule).not.toHaveBeenCalled();
    expect(mocks.reviewQueueReady).not.toHaveBeenCalled();
    expect(mocks.weeklyRunDue).not.toHaveBeenCalled();
  });

  it('does not enqueue a canonical weekly run when its diagnostic dependencies are incoherent', async () => {
    mocks.diagnosticPolicyEnabled = false;

    await expect(runCommerceSchedulers()).resolves.toBeUndefined();

    expect(mocks.weeklyRunDue).not.toHaveBeenCalled();
  });

  it('runs review and weekly schedulers when all feature gates are coherent', async () => {
    await expect(runCommerceSchedulers()).resolves.toBeUndefined();

    expect(mocks.reviewInvalidate).toHaveBeenCalledTimes(1);
    expect(mocks.reviewSchedule).toHaveBeenCalledWith({ limit: 100 });
    expect(mocks.reviewQueueReady).toHaveBeenCalledWith(expect.objectContaining({
      maxQueuedPerUser: 2,
      maxAttempts: 3,
    }));
    expect(mocks.weeklyRunDue).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek-v4-flash',
      recoveryLimit: 2,
    }));
  });

  it('does not call the model when the pre-execution Action version fence is stale', async () => {
    mocks.reviewClaim.mockResolvedValue({
      kind: 'action_review', status: 'stale_noop', schedule: {},
    });
    mocks.fail.mockResolvedValue(undefined);

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(true);

    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(mocks.createConversationAndRun).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      claimedJob,
      expect.objectContaining({ code: 'COMMERCE_ORCHESTRATION_STALE_NOOP' }),
    );
  });

  it('persists a review verdict before marking its durable Job completed', async () => {
    mocks.reviewClaim.mockResolvedValue({
      kind: 'action_review', status: 'running', schedule: {},
    });
    mocks.runTurn.mockImplementation(async () => {
      mocks.order.push('model');
      return runResult;
    });
    mocks.reviewFinalize.mockImplementation(async () => {
      mocks.order.push('verdict');
      return 'completed';
    });
    mocks.complete.mockImplementation(async () => {
      mocks.order.push('job');
    });

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(true);

    expect(mocks.order).toEqual(['model', 'verdict', 'job']);
    expect(mocks.reviewFinalize).toHaveBeenCalledWith({
      jobId: claimedJob.id,
      question: claimedJob.message,
      result: runResult,
    });
    expect(mocks.weeklyClaim).not.toHaveBeenCalled();
  });

  it('finalizes a running weekly diagnosis before completing its durable Job', async () => {
    mocks.weeklyClaim.mockResolvedValue({
      kind: 'weekly_diagnosis', status: 'running', schedule: {},
    });
    mocks.runTurn.mockImplementation(async () => {
      mocks.order.push('model');
      return runResult;
    });
    mocks.weeklyComplete.mockImplementation(async () => {
      mocks.order.push('weekly');
      return 'completed';
    });
    mocks.complete.mockImplementation(async () => {
      mocks.order.push('job');
    });

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(true);

    expect(mocks.order).toEqual(['model', 'weekly', 'job']);
  });

  it('fails closed when a weekly diagnosis is superseded before model execution', async () => {
    mocks.weeklyClaim.mockResolvedValue({
      kind: 'weekly_diagnosis', status: 'superseded', schedule: {},
    });

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(true);

    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(mocks.fail).toHaveBeenCalledWith(
      claimedJob,
      expect.objectContaining({ code: 'COMMERCE_ORCHESTRATION_STALE_NOOP' }),
    );
  });

  it('requeues a retryable provider failure with the computed delay', async () => {
    const error = Object.assign(new Error('provider busy'), { code: 'PROVIDER_RATE_LIMIT' });
    mocks.retrySignal = { retryable: true, retryAfterMs: 5_000 };
    mocks.runTurn.mockRejectedValueOnce(error);
    mocks.retryOrDeadLetter.mockResolvedValueOnce('requeued');

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(true);

    expect(mocks.retryOrDeadLetter).toHaveBeenCalledWith(claimedJob, error, 1_000);
    expect(mocks.reviewFailed).not.toHaveBeenCalled();
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it('marks orchestration state failed when retry handling dead-letters the Job', async () => {
    mocks.retrySignal = { retryable: true, retryAfterMs: null };
    mocks.runTurn.mockRejectedValueOnce(new Error('temporary outage'));
    mocks.retryOrDeadLetter.mockResolvedValueOnce('dead_letter');

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(true);

    expect(mocks.reviewFailed).toHaveBeenCalledWith(claimedJob.id);
    expect(mocks.weeklyFailed).toHaveBeenCalledWith(claimedJob.id);
  });

  it('fails a non-retryable Job and both orchestration schedulers', async () => {
    const error = Object.assign(new Error('invalid request'), { code: 'INVALID_REQUEST' });
    mocks.runTurn.mockRejectedValueOnce(error);

    await expect(processNextCommerceAgentJob('worker-a')).resolves.toBe(true);

    expect(mocks.fail).toHaveBeenCalledWith(claimedJob, error);
    expect(mocks.reviewFailed).toHaveBeenCalledWith(claimedJob.id);
    expect(mocks.weeklyFailed).toHaveBeenCalledWith(claimedJob.id);
  });

  it('does not touch the Feishu outbox while notifications are disabled', async () => {
    await expect(processNextCommerceFeishuNotification('worker-a')).resolves.toBe(false);
    expect(mocks.feishuClaim).not.toHaveBeenCalled();
  });

  it('delivers a claimed Feishu command and records the provider message ID', async () => {
    mocks.notificationsEnabled = true;
    mocks.feishuClaim.mockResolvedValueOnce({
      id: 'outbox_1',
      actionId: 'action_1',
      actionVersion: 2,
      recipientOpenId: 'ou_1',
      requestUuid: 'request_1',
      payload: { text: 'hello' },
    });

    await expect(processNextCommerceFeishuNotification('worker-a')).resolves.toBe(true);

    expect(mocks.feishuSend).toHaveBeenCalledWith(expect.objectContaining({ recipientOpenId: 'ou_1' }));
    expect(mocks.feishuComplete).toHaveBeenCalledWith({
      outboxId: 'outbox_1',
      workerId: 'worker-a',
      outcome: 'delivered',
      providerMessageId: 'om_123',
    });
  });

  it('heartbeats and stops a named Worker cleanly after abort', async () => {
    vi.stubEnv('COMMERCE_WORKER_ID', 'worker-test');
    mocks.claim.mockResolvedValue(null);
    const controller = new AbortController();
    mocks.reminderRunDue.mockImplementationOnce(async () => {
      controller.abort();
      return 0;
    });

    await expect(runCommerceAgentWorker(controller.signal)).resolves.toBeUndefined();

    expect(mocks.heartbeatWorker).toHaveBeenCalledWith('worker-test');
    expect(mocks.stopWorker).toHaveBeenCalledWith('worker-test');
  });
});

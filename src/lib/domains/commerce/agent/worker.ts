import { randomUUID } from 'node:crypto';

import {
  configuredCommerceModels,
  getCommerceAgentRuntimeConfig,
} from './config';
import { getCommerceActionReminderScheduler } from './action-reminder-scheduler';
import {
  FeishuNotificationClient,
  getCommerceFeishuOutboxStore,
} from './feishu-outbox';
import { commerceJobRetryDelay, commerceJobRetrySignal } from './job-retry';
import type { ClaimedCommerceAgentJob } from './job-store';
import { getCommerceJobStore } from './jobs';
import { getCommerceAgentService } from './service';
import { getCommerceReviewScheduler } from './review-scheduler';
import { logCommerceEvent, logCommerceFailure } from './telemetry';
import { getCommerceWeeklyDiagnosisScheduler } from './weekly-diagnosis-scheduler';

class CommerceOrchestrationStaleNoopError extends Error {
  readonly code = 'COMMERCE_ORCHESTRATION_STALE_NOOP';

  constructor(kind: 'action_review' | 'weekly_diagnosis') {
    super(`${kind} Job became obsolete before model execution.`);
    this.name = 'CommerceOrchestrationStaleNoopError';
  }
}

function startHeartbeat(job: ClaimedCommerceAgentJob, leaseMs: number) {
  const ownership = new AbortController();
  const intervalMs = Math.max(1_000, Math.floor(leaseMs / 3));
  const timer = setInterval(() => {
    void getCommerceJobStore().renew(job.id, job.leaseOwner, leaseMs).then((renewed) => {
      if (!renewed && !ownership.signal.aborted) {
        ownership.abort(new Error('Commerce job lease ownership was lost.'));
      }
    }).catch((error) => {
      if (!ownership.signal.aborted) ownership.abort(error);
    });
  }, intervalMs);
  timer.unref?.();
  return {
    signal: ownership.signal,
    stop() {
      clearInterval(timer);
    },
  };
}

export async function processNextCommerceAgentJob(workerId: string): Promise<boolean> {
  const config = getCommerceAgentRuntimeConfig();
  if (config.globalKillSwitch) return false;
  const jobs = getCommerceJobStore();
  const revision = process.env.COMMERCE_RELEASE_REVISION || 'unversioned';
  const job = await jobs.claim({ workerId, revision, leaseMs: config.jobLeaseMs });
  if (!job) return false;
  logCommerceEvent('commerce.job.claimed', {
    jobId: job.id,
    requestId: job.requestId,
    workerId,
    attempt: job.attemptCount,
  });
  const heartbeat = startHeartbeat(job, config.jobLeaseMs);
  const reviews = getCommerceReviewScheduler();
  const weeklyDiagnoses = getCommerceWeeklyDiagnosisScheduler();
  try {
    if (
      process.env.NODE_ENV === 'production'
      && process.env.COMMERCE_RELEASE_SMOKE_CONFIRM === 'commerce-final-image-smoke'
      && process.env.COMMERCE_RELEASE_SMOKE_HOLD_WORKER_ID === workerId
    ) {
      await new Promise<never>(() => undefined);
    }
    const reviewClaim = await reviews.claimJob(job.id);
    if (reviewClaim.kind === 'action_review' && reviewClaim.status === 'stale_noop') {
      throw new CommerceOrchestrationStaleNoopError('action_review');
    }
    const weeklyClaim = reviewClaim.kind === 'not_review'
      ? await weeklyDiagnoses.claimJob(job.id)
      : { kind: 'not_weekly_diagnosis' as const };
    if (weeklyClaim.kind === 'weekly_diagnosis' && weeklyClaim.status === 'superseded') {
      throw new CommerceOrchestrationStaleNoopError('weekly_diagnosis');
    }
    const service = getCommerceAgentService();
    const result = job.kind === 'create_conversation'
      ? await service.createConversationAndRun({
          identity: job.identity,
          message: job.message,
          model: job.model,
          requestId: job.requestId,
          retryFailed: job.attemptCount > 1,
          signal: heartbeat.signal,
        })
      : await service.runTurn({
          identity: job.identity,
          conversationId: job.conversationId as string,
          message: job.message,
          requestId: job.requestId,
          retryFailed: job.attemptCount > 1,
          signal: heartbeat.signal,
        });
    if (reviewClaim.kind === 'action_review' && reviewClaim.status === 'running') {
      await reviews.finalizeJob({
        jobId: job.id,
        question: job.message,
        result,
      });
    }
    if (weeklyClaim.kind === 'weekly_diagnosis' && weeklyClaim.status === 'running') {
      const completion = await weeklyDiagnoses.completeJob(job.id, result);
      if (completion === 'superseded') {
        throw new CommerceOrchestrationStaleNoopError('weekly_diagnosis');
      }
    }
    await jobs.complete(job, result);
    logCommerceEvent('commerce.job.completed', {
      jobId: job.id,
      requestId: job.requestId,
      conversationId: result.conversation.id,
      workerId,
    });
  } catch (error) {
    const retry = commerceJobRetrySignal(error);
    if (retry.retryable) {
      const delayMs = commerceJobRetryDelay({
        attemptCount: job.attemptCount,
        baseMs: config.jobRetryBaseMs,
        maxMs: config.jobRetryMaxMs,
        retryAfterMs: retry.retryAfterMs,
      });
      const outcome = await jobs.retryOrDeadLetter(job, error, delayMs);
      if (outcome === 'dead_letter') {
        await Promise.all([
          reviews.markJobFailed(job.id),
          weeklyDiagnoses.markJobFailed(job.id),
        ]);
      }
      logCommerceFailure(
        outcome === 'requeued' ? 'commerce.job.requeued' : 'commerce.job.dead_lettered',
        error,
        { jobId: job.id, requestId: job.requestId, workerId, delayMs },
      );
    } else {
      await jobs.fail(job, error);
      await Promise.all([
        reviews.markJobFailed(job.id),
        weeklyDiagnoses.markJobFailed(job.id),
      ]);
      logCommerceFailure('commerce.job.failed', error, {
        jobId: job.id,
        requestId: job.requestId,
        workerId,
      });
    }
  } finally {
    heartbeat.stop();
  }
  return true;
}

export async function processNextCommerceFeishuNotification(workerId: string): Promise<boolean> {
  const config = getCommerceAgentRuntimeConfig();
  if (
    config.globalKillSwitch
    || !config.notificationsEnabled
    || !config.feishuAppId
    || !config.feishuAppSecret
  ) return false;
  const outbox = getCommerceFeishuOutboxStore();
  const command = await outbox.claim(workerId, config.jobLeaseMs);
  if (!command) return false;
  const client = new FeishuNotificationClient({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    baseUrl: config.feishuBaseUrl,
  });
  const result = await client.send({
    recipientOpenId: command.recipientOpenId,
    requestUuid: command.requestUuid,
    payload: command.payload,
  });
  await outbox.completeDelivery({
    outboxId: command.id,
    workerId,
    outcome: result.status,
    ...(result.status === 'delivered'
      ? { providerMessageId: result.providerMessageId }
      : { error: result.error }),
    ...(result.status === 'retryable' ? { retryAfterMs: result.retryAfterMs } : {}),
  });
  logCommerceEvent('commerce.feishu.delivery', {
    outboxId: command.id,
    actionId: command.actionId,
    actionVersion: command.actionVersion,
    outcome: result.status,
  });
  return true;
}

export async function runCommerceSchedulers(): Promise<void> {
  await getCommerceActionReminderScheduler().runDue({ limit: 100 });
  const config = getCommerceAgentRuntimeConfig();
  // The in-app reminder scheduler has no model or external side effect. Once it has converged,
  // a global kill switch must prevent every scheduler that can enqueue a new model Job.
  if (config.globalKillSwitch) return;
  if (config.automaticReviewEnabled) {
    const reviews = getCommerceReviewScheduler();
    await reviews.invalidateStale();
    await reviews.scheduleCompleted({ limit: 100 });
    await reviews.queueReadyFromCurrentWatermarks({
      limitPerTenant: 100,
      maxQueuedPerUser: config.maxQueuedJobsPerUser,
      maxAttempts: config.jobMaxAttempts,
    });
  }
  const weeklyModel = configuredCommerceModels()[0];
  if (
    config.weeklyDiagnosisEnabled
    && config.diagnosticPolicyEnabled
    && config.anomalyDetectionEnabled
    && weeklyModel
  ) {
    await getCommerceWeeklyDiagnosisScheduler().runDue({
      model: weeklyModel,
      policyVersion: process.env.COMMERCE_DIAGNOSTIC_POLICY_VERSION?.trim()
        || process.env.COMMERCE_RELEASE_REVISION?.trim()
        || 'diagnostic-policy-v1',
      recoveryLimit: 2,
      maxQueuedPerUser: config.maxQueuedJobsPerUser,
      maxAttempts: config.jobMaxAttempts,
    });
  }
}

export async function runCommerceAgentWorker(signal?: AbortSignal): Promise<void> {
  const configuredWorkerId = String(process.env.COMMERCE_WORKER_ID || '').trim();
  if (configuredWorkerId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(configuredWorkerId)) {
    throw new Error('COMMERCE_WORKER_ID must be a stable 1-128 character worker identifier.');
  }
  const workerId = configuredWorkerId || `commerce-worker-${process.pid}-${randomUUID()}`;
  const config = getCommerceAgentRuntimeConfig();
  const jobs = getCommerceJobStore();
  const heartbeatIntervalMs = Math.max(1_000, Math.floor(config.workerStaleMs / 3));
  let heartbeatInFlight = false;
  const heartbeatTimer = setInterval(() => {
    if (heartbeatInFlight) return;
    heartbeatInFlight = true;
    void jobs.heartbeatWorker(workerId).catch((error) => {
      logCommerceFailure('commerce.worker.heartbeat_failed', error, { workerId });
    }).finally(() => {
      heartbeatInFlight = false;
    });
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();
  try {
    await jobs.heartbeatWorker(workerId);
    logCommerceEvent('commerce.worker.started', { workerId });
    let lastSchedulerRun = 0;
    while (!signal?.aborted) {
      const notificationProcessed = await processNextCommerceFeishuNotification(workerId);
      if (notificationProcessed) continue;
      const processed = await processNextCommerceAgentJob(workerId);
      if (processed) continue;
      if (Date.now() - lastSchedulerRun >= 5_000) {
        await runCommerceSchedulers().catch((error) => {
          logCommerceFailure('commerce.scheduler.failed', error, { workerId });
        });
        lastSchedulerRun = Date.now();
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, config.jobPollMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  } finally {
    clearInterval(heartbeatTimer);
    await jobs.stopWorker(workerId).catch(() => undefined);
    logCommerceEvent('commerce.worker.stopped', { workerId });
  }
}

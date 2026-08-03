import { randomUUID } from 'node:crypto';

import { getCommerceAgentRuntimeConfig } from './config';
import { commerceJobRetryDelay, commerceJobRetrySignal } from './job-retry';
import type { ClaimedCommerceAgentJob } from './job-store';
import { getCommerceJobStore } from './jobs';
import { getCommerceAgentService } from './service';
import { logCommerceEvent, logCommerceFailure } from './telemetry';

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
  const jobs = getCommerceJobStore();
  const job = await jobs.claim({ workerId, leaseMs: config.jobLeaseMs });
  if (!job) return false;
  logCommerceEvent('commerce.job.claimed', {
    jobId: job.id,
    requestId: job.requestId,
    workerId,
    attempt: job.attemptCount,
  });
  const heartbeat = startHeartbeat(job, config.jobLeaseMs);
  try {
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
      logCommerceFailure(
        outcome === 'requeued' ? 'commerce.job.requeued' : 'commerce.job.dead_lettered',
        error,
        { jobId: job.id, requestId: job.requestId, workerId, delayMs },
      );
    } else {
      await jobs.fail(job, error);
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

export async function runCommerceAgentWorker(signal?: AbortSignal): Promise<void> {
  const workerId = `commerce-worker-${process.pid}-${randomUUID()}`;
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
    while (!signal?.aborted) {
      const processed = await processNextCommerceAgentJob(workerId);
      if (processed) continue;
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

import { createHash } from 'node:crypto';

import {
  commerceModelBudgetPolicy,
  getCommerceAgentRuntimeConfig,
} from './config';
import { getCommerceControlDatabase, withCommerceControlIdentity } from './database';
import {
  CommerceJobInvalidMessageError,
  PostgresCommerceJobStore,
} from './job-store';
import { isValidCommerceMessage } from './limits';
import {
  createCommerceModelRuntime,
  resolveCommerceModelSelection,
} from './model-provider';
import { getCommerceAgentService } from './service';
import type {
  CommerceAgentJob,
  CommerceAgentJobEvent,
  CommerceIdentity,
} from './types';

let singleton: PostgresCommerceJobStore | null = null;

export class CommerceKillSwitchError extends Error {
  readonly code = 'COMMERCE_GLOBAL_KILL_SWITCH';
  readonly status = 503;

  constructor() {
    super('系统已暂停新的模型调用和外部写入；现有只读任务会安全收敛。');
    this.name = 'CommerceKillSwitchError';
  }
}

function ipHash(value: string | null | undefined): string | null {
  const normalized = value?.trim().slice(0, 200) ?? '';
  return normalized
    ? createHash('sha256').update(normalized).digest('hex')
    : null;
}

export function getCommerceJobStore(): PostgresCommerceJobStore {
  if (!singleton || process.env.NODE_ENV === 'test') {
    singleton = new PostgresCommerceJobStore(getCommerceControlDatabase());
  }
  return singleton;
}

export class CommerceAsyncAgentService {
  constructor(
    private readonly jobs: PostgresCommerceJobStore,
  ) {}

  async enqueueConversation(input: {
    identity: CommerceIdentity;
    message: string;
    model: string;
    requestId: string;
    ipAddress?: string | null;
  }): Promise<CommerceAgentJob> {
    const config = getCommerceAgentRuntimeConfig();
    if (config.globalKillSwitch) throw new CommerceKillSwitchError();
    if (!isValidCommerceMessage(input.message)) throw new CommerceJobInvalidMessageError();
    const modelBudgetPolicy = commerceModelBudgetPolicy(config);
    const selection = resolveCommerceModelSelection(input.model);
    createCommerceModelRuntime(selection.model);
    return withCommerceControlIdentity(input.identity, () => this.jobs.enqueue({
      identity: input.identity,
      kind: 'create_conversation',
      requestId: input.requestId,
      model: selection.model,
      message: input.message,
      maxQueuedPerUser: config.maxQueuedJobsPerUser,
      maxAttempts: config.jobMaxAttempts,
      accountHourlyLimit: config.accountHourlyDiagnosisLimit,
      ipHourlyLimit: config.ipHourlyDiagnosisLimit,
      ipHash: ipHash(input.ipAddress),
      ...(modelBudgetPolicy ? { modelBudgetPolicy } : {}),
    }));
  }

  async enqueueTurn(input: {
    identity: CommerceIdentity;
    conversationId: string;
    message: string;
    requestId: string;
    ipAddress?: string | null;
  }): Promise<CommerceAgentJob> {
    const config = getCommerceAgentRuntimeConfig();
    if (config.globalKillSwitch) throw new CommerceKillSwitchError();
    if (!isValidCommerceMessage(input.message)) throw new CommerceJobInvalidMessageError();
    const modelBudgetPolicy = commerceModelBudgetPolicy(config);
    const conversation = await getCommerceAgentService().getConversation(
      input.identity,
      input.conversationId,
    );
    const selection = resolveCommerceModelSelection(conversation.model);
    createCommerceModelRuntime(selection.model);
    return withCommerceControlIdentity(input.identity, () => this.jobs.enqueue({
      identity: input.identity,
      kind: 'conversation_turn',
      conversationId: conversation.id,
      requestId: input.requestId,
      model: selection.model,
      message: input.message,
      maxQueuedPerUser: config.maxQueuedJobsPerUser,
      maxAttempts: config.jobMaxAttempts,
      accountHourlyLimit: config.accountHourlyDiagnosisLimit,
      ipHourlyLimit: config.ipHourlyDiagnosisLimit,
      ipHash: ipHash(input.ipAddress),
      ...(modelBudgetPolicy ? { modelBudgetPolicy } : {}),
    }));
  }

  getJob(identity: CommerceIdentity, jobId: string): Promise<CommerceAgentJob> {
    return withCommerceControlIdentity(identity, () => this.jobs.get(identity, jobId));
  }

  listActiveJobs(identity: CommerceIdentity): Promise<CommerceAgentJob[]> {
    return withCommerceControlIdentity(identity, () => this.jobs.listActive(identity));
  }

  getEvents(
    identity: CommerceIdentity,
    jobId: string,
    afterId: number,
  ): Promise<CommerceAgentJobEvent[]> {
    return withCommerceControlIdentity(
      identity,
      () => this.jobs.events(identity, jobId, afterId),
    );
  }
}

let asyncSingleton: CommerceAsyncAgentService | null = null;

export function getCommerceAsyncAgentService(): CommerceAsyncAgentService {
  if (!asyncSingleton || process.env.NODE_ENV === 'test') {
    asyncSingleton = new CommerceAsyncAgentService(getCommerceJobStore());
  }
  return asyncSingleton;
}

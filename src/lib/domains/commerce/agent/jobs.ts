import { getCommerceAgentRuntimeConfig } from './config';
import { getCommerceControlDatabase } from './database';
import { PostgresCommerceJobStore } from './job-store';
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
  }): Promise<CommerceAgentJob> {
    const selection = resolveCommerceModelSelection(input.model);
    createCommerceModelRuntime(selection.model);
    const config = getCommerceAgentRuntimeConfig();
    return this.jobs.enqueue({
      identity: input.identity,
      kind: 'create_conversation',
      requestId: input.requestId,
      model: selection.model,
      message: input.message,
      maxQueuedPerUser: config.maxQueuedJobsPerUser,
      maxAttempts: config.jobMaxAttempts,
    });
  }

  async enqueueTurn(input: {
    identity: CommerceIdentity;
    conversationId: string;
    message: string;
    requestId: string;
  }): Promise<CommerceAgentJob> {
    const conversation = await getCommerceAgentService().getConversation(
      input.identity,
      input.conversationId,
    );
    const selection = resolveCommerceModelSelection(conversation.model);
    createCommerceModelRuntime(selection.model);
    const config = getCommerceAgentRuntimeConfig();
    return this.jobs.enqueue({
      identity: input.identity,
      kind: 'conversation_turn',
      conversationId: conversation.id,
      requestId: input.requestId,
      model: selection.model,
      message: input.message,
      maxQueuedPerUser: config.maxQueuedJobsPerUser,
      maxAttempts: config.jobMaxAttempts,
    });
  }

  getJob(identity: CommerceIdentity, jobId: string): Promise<CommerceAgentJob> {
    return this.jobs.get(identity, jobId);
  }

  getEvents(
    identity: CommerceIdentity,
    jobId: string,
    afterId: number,
  ): Promise<CommerceAgentJobEvent[]> {
    return this.jobs.events(identity, jobId, afterId);
  }
}

let asyncSingleton: CommerceAsyncAgentService | null = null;

export function getCommerceAsyncAgentService(): CommerceAsyncAgentService {
  if (!asyncSingleton || process.env.NODE_ENV === 'test') {
    asyncSingleton = new CommerceAsyncAgentService(getCommerceJobStore());
  }
  return asyncSingleton;
}

import { createHash, randomUUID } from 'node:crypto';

import {
  PostgresCommerceAnalyticsRepository,
  type CommerceAnalyticsRepository,
} from './analytics-repository';
import { getCommerceAgentRuntimeConfig } from './config';
import {
  CommerceConversationBusyError,
  CommerceIdempotencyConflictError,
  PostgresCommerceConversationStore,
  type CommerceConversationStore,
} from './conversation-store';
import {
  getCommerceAnalyticsDatabase,
  getCommerceControlDatabase,
} from './database';
import {
  createCommerceModelRuntime,
  resolveCommerceModelSelection,
} from './model-provider';
import { CommerceAgentRunError, runCommerceAgentTurn } from './runtime';
import type {
  CommerceAgentRunResponse,
  CommerceConversation,
  CommerceConversationSummary,
  CommerceIdentity,
} from './types';

export class CommerceRateLimitError extends Error {
  readonly code = 'COMMERCE_RATE_LIMITED';

  constructor() {
    super('请求过于频繁，请在下一分钟窗口重试。');
    this.name = 'CommerceRateLimitError';
  }
}

export class CommerceConversationNotFoundError extends Error {
  readonly code = 'COMMERCE_CONVERSATION_NOT_FOUND';

  constructor() {
    super('会话不存在或不属于当前用户。');
    this.name = 'CommerceConversationNotFoundError';
  }
}

export class CommerceRequestStateError extends Error {
  readonly code: 'COMMERCE_REQUEST_RUNNING' | 'COMMERCE_REQUEST_NOT_REPLAYABLE';

  constructor(status: string) {
    super(
      status === 'running'
        ? '相同 Idempotency-Key 的请求仍在运行，请稍后用同一个 key 重试。'
        : '相同 Idempotency-Key 的请求此前未成功，请使用新的 key 重新提交。',
    );
    this.name = 'CommerceRequestStateError';
    this.code = status === 'running'
      ? 'COMMERCE_REQUEST_RUNNING'
      : 'COMMERCE_REQUEST_NOT_REPLAYABLE';
  }
}

export class CommerceTurnExecutionError extends Error {
  readonly conversationId: string;
  readonly originalError: unknown;

  constructor(conversationId: string, originalError: unknown) {
    super(
      originalError instanceof Error
        ? originalError.message
        : 'Commerce Agent turn failed.',
      { cause: originalError },
    );
    this.name = 'CommerceTurnExecutionError';
    this.conversationId = conversationId;
    this.originalError = originalError;
  }
}

function requestSha256(value: Record<string, string>): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function startRunLeaseHeartbeat(input: {
  signal?: AbortSignal;
  leaseMs: number;
  renew: () => Promise<boolean>;
}) {
  const ownership = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([input.signal, ownership.signal])
    : ownership.signal;
  const intervalMs = Math.max(1_000, Math.min(10_000, Math.floor(input.leaseMs / 3)));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let activeRenewal: Promise<void> | null = null;
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      activeRenewal = input.renew().then((renewed) => {
        if (!renewed && !ownership.signal.aborted) {
          ownership.abort(new Error('Commerce run lease ownership was lost.'));
        }
      }).catch((error) => {
        if (!ownership.signal.aborted) ownership.abort(error);
      }).finally(() => {
        activeRenewal = null;
        schedule();
      });
    }, intervalMs);
    timer.unref?.();
  };
  schedule();
  return {
    signal,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await activeRenewal;
    },
  };
}

export interface CommerceAgentServiceDependencies {
  store: CommerceConversationStore;
  analytics: CommerceAnalyticsRepository;
  withAnalyticsSnapshot?: <T>(
    tenantId: string,
    work: (repository: CommerceAnalyticsRepository) => Promise<T>,
  ) => Promise<T>;
}

export class CommerceAgentService {
  constructor(private readonly dependencies: CommerceAgentServiceDependencies) {}

  listConversations(identity: CommerceIdentity): Promise<CommerceConversationSummary[]> {
    return this.dependencies.store.listConversations(identity);
  }

  async getConversation(
    identity: CommerceIdentity,
    conversationId: string,
  ): Promise<CommerceConversation> {
    const conversation = await this.dependencies.store.getConversation(identity, conversationId);
    if (!conversation) throw new CommerceConversationNotFoundError();
    return conversation;
  }

  async createConversationAndRun(input: {
    identity: CommerceIdentity;
    message: string;
    model: string;
    requestId: string;
    retryFailed?: boolean;
    signal?: AbortSignal;
  }): Promise<CommerceAgentRunResponse> {
    const config = getCommerceAgentRuntimeConfig();
    const modelSelection = resolveCommerceModelSelection(input.model);
    const runId = `commerce-agent-${randomUUID()}`;
    const fingerprint = requestSha256({
      kind: 'create',
      message: input.message.trim(),
      model: modelSelection.model,
    });
    const replayBeforeProvider = await this.dependencies.store.findRunMessages(
      input.identity,
      input.requestId,
      fingerprint,
    );
    if (replayBeforeProvider) return replayBeforeProvider;
    createCommerceModelRuntime(modelSelection.model);
    if (input.retryFailed && this.dependencies.store.retryFailedTurn) {
      const retried = await this.dependencies.store.retryFailedTurn({
        identity: input.identity,
        requestId: input.requestId,
        requestSha256: fingerprint,
        globalConcurrencyLimit: config.globalConcurrencyLimit,
        tenantConcurrencyLimit: config.tenantConcurrencyLimit,
        leaseMs: config.timeoutMs + 30_000,
      });
      if (retried) {
        return this.executeClaimedTurn({
          identity: input.identity,
          conversationId: retried.conversationId,
          message: input.message,
          runId: retried.runId,
          signal: input.signal,
        });
      }
    }
    const began = await this.dependencies.store.createConversationAndBeginTurn({
      identity: input.identity,
      model: modelSelection.model,
      provider: modelSelection.providerName,
      userMessage: input.message,
      requestId: input.requestId,
      requestSha256: fingerprint,
      runId,
      rateLimit: config.rateLimitPerMinute,
      tenantRateLimit: config.tenantRateLimitPerMinute,
      globalConcurrencyLimit: config.globalConcurrencyLimit,
      tenantConcurrencyLimit: config.tenantConcurrencyLimit,
      leaseMs: config.timeoutMs + 30_000,
    });
    if (!began.created) {
      if (began.reason !== 'existing') {
        if (began.reason === 'rate_limited') throw new CommerceRateLimitError();
        throw new CommerceConversationBusyError();
      }
      const replay = await this.dependencies.store.findRunMessages(
        input.identity,
        input.requestId,
        fingerprint,
      );
      if (!replay) throw new CommerceRequestStateError(began.status);
      return replay;
    }
    return this.executeClaimedTurn({
      identity: input.identity,
      conversationId: began.conversation.id,
      message: input.message,
      runId,
      signal: input.signal,
    });
  }

  async runTurn(input: {
    identity: CommerceIdentity;
    conversationId: string;
    message: string;
    requestId: string;
    retryFailed?: boolean;
    signal?: AbortSignal;
  }): Promise<CommerceAgentRunResponse> {
    const config = getCommerceAgentRuntimeConfig();
    const conversation = await this.dependencies.store.getConversation(
      input.identity,
      input.conversationId,
      2,
    );
    if (!conversation) throw new CommerceConversationNotFoundError();
    const modelSelection = resolveCommerceModelSelection(conversation.model);
    const runId = `commerce-agent-${randomUUID()}`;
    const fingerprint = requestSha256({
      conversationId: conversation.id,
      kind: 'message',
      message: input.message.trim(),
    });
    const replayBeforeProvider = await this.dependencies.store.findRunMessages(
      input.identity,
      input.requestId,
      fingerprint,
    );
    if (replayBeforeProvider) return replayBeforeProvider;
    createCommerceModelRuntime(modelSelection.model);
    if (input.retryFailed && this.dependencies.store.retryFailedTurn) {
      const retried = await this.dependencies.store.retryFailedTurn({
        identity: input.identity,
        requestId: input.requestId,
        requestSha256: fingerprint,
        globalConcurrencyLimit: config.globalConcurrencyLimit,
        tenantConcurrencyLimit: config.tenantConcurrencyLimit,
        leaseMs: config.timeoutMs + 30_000,
      });
      if (retried) {
        if (retried.conversationId !== conversation.id) {
          throw new CommerceIdempotencyConflictError();
        }
        return this.executeClaimedTurn({
          identity: input.identity,
          conversationId: conversation.id,
          message: input.message,
          runId: retried.runId,
          signal: input.signal,
        });
      }
    }
    const began = await this.dependencies.store.beginTurn({
      identity: input.identity,
      conversationId: conversation.id,
      requestId: input.requestId,
      model: modelSelection.model,
      provider: modelSelection.providerName,
      userMessage: input.message,
      requestSha256: fingerprint,
      rateLimit: config.rateLimitPerMinute,
      tenantRateLimit: config.tenantRateLimitPerMinute,
      globalConcurrencyLimit: config.globalConcurrencyLimit,
      tenantConcurrencyLimit: config.tenantConcurrencyLimit,
      leaseMs: config.timeoutMs + 30_000,
      runId,
    });
    if (!began.created) {
      if (began.reason !== 'existing') {
        if (began.reason === 'rate_limited') throw new CommerceRateLimitError();
        throw new CommerceConversationBusyError();
      }
      const replay = await this.dependencies.store.findRunMessages(
        input.identity,
        input.requestId,
        fingerprint,
      );
      if (!replay) throw new CommerceRequestStateError(began.status);
      return replay;
    }
    return this.executeClaimedTurn({
      identity: input.identity,
      conversationId: conversation.id,
      message: input.message,
      runId,
      signal: input.signal,
    });
  }

  private async executeClaimedTurn(input: {
    identity: CommerceIdentity;
    conversationId: string;
    message: string;
    runId: string;
    signal?: AbortSignal;
  }): Promise<CommerceAgentRunResponse> {
    const config = getCommerceAgentRuntimeConfig();
    const leaseMs = config.timeoutMs + 30_000;
    const heartbeat = startRunLeaseHeartbeat({
      signal: input.signal,
      leaseMs,
      renew: () => this.dependencies.store.renewRunLease({
        identity: input.identity,
        runId: input.runId,
        leaseMs,
      }),
    });
    const executionState: {
      result: Awaited<ReturnType<typeof runCommerceAgentTurn>> | null;
    } = { result: null };
    try {
      const conversation = await this.dependencies.store.getConversation(
        input.identity,
        input.conversationId,
        2,
      );
      if (!conversation) throw new CommerceConversationNotFoundError();
      const history = await this.dependencies.store.getModelHistory(
        input.identity,
        input.conversationId,
        Math.ceil(config.conversationHistoryLimit / 2),
      );
      const execute = async (repository: CommerceAnalyticsRepository) => {
        executionState.result = await runCommerceAgentTurn({
          identity: input.identity,
          question: input.message,
          history,
          requestedModel: conversation.model,
          repository,
          runId: input.runId,
          signal: heartbeat.signal,
          onEvidence: (trace) => this.dependencies.store.appendEvidence({
            identity: input.identity,
            conversationId: conversation.id,
            runId: input.runId,
            trace,
          }),
        });
        return executionState.result;
      };
      const result = this.dependencies.withAnalyticsSnapshot
        ? await this.dependencies.withAnalyticsSnapshot(input.identity.tenantId, execute)
        : await execute(this.dependencies.analytics);
      const assistantMessageId = `msg_${randomUUID()}`;
      await this.dependencies.store.completeTurn({
        identity: input.identity,
        conversationId: conversation.id,
        runId: input.runId,
        assistantMessageId,
        answer: result.answer,
        usage: result.usage,
        traces: result.traces,
      });
      const completed = await this.dependencies.store.getConversation(
        input.identity,
        conversation.id,
        config.conversationHistoryLimit + 2,
      );
      const userMessage = completed?.messages.find(
        (entry) => entry.runId === input.runId && entry.role === 'user',
      );
      const assistantMessage = completed?.messages.find(
        (entry) => entry.runId === input.runId && entry.role === 'assistant',
      );
      if (!completed || !userMessage || !assistantMessage) {
        throw new Error('Agent 已完成，但持久化消息读取失败。');
      }
      return {
        conversation: completed,
        userMessage,
        assistantMessage,
        usage: result.usage,
      };
    } catch (error) {
      const runError = error instanceof CommerceAgentRunError ? error : null;
      await this.dependencies.store.failTurn({
        identity: input.identity,
        runId: input.runId,
        code: error instanceof Error && 'code' in error ? String(error.code) : 'COMMERCE_AGENT_FAILED',
        message: error instanceof Error ? error.message : 'Unknown Commerce Agent failure.',
        usage: runError?.usage ?? executionState.result?.usage,
        traces: runError?.traces ?? executionState.result?.traces,
      }).catch(() => undefined);
      throw new CommerceTurnExecutionError(input.conversationId, error);
    } finally {
      await heartbeat.stop();
    }
  }
}

let singleton: CommerceAgentService | null = null;

export function getCommerceAgentService(): CommerceAgentService {
  if (singleton && process.env.NODE_ENV !== 'test') return singleton;
  const analyticsDatabase = getCommerceAnalyticsDatabase();
  const service = new CommerceAgentService({
    store: new PostgresCommerceConversationStore(getCommerceControlDatabase()),
    analytics: new PostgresCommerceAnalyticsRepository(analyticsDatabase),
    withAnalyticsSnapshot: (tenantId, work) => analyticsDatabase.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await client.query(
        `SELECT set_config('commerce.tenant_id', $1, true)`,
        [tenantId],
      );
      return work(new PostgresCommerceAnalyticsRepository(client));
    }),
  });
  if (process.env.NODE_ENV !== 'test') singleton = service;
  return service;
}

import { describe, expect, it } from 'vitest';

import type {
  MoAgentModelEvent,
  MoAgentModelProvider,
  MoAgentModelRequest,
} from '@/lib/agent/types';
import type { CommerceAnalyticsRepository } from './analytics-repository';
import { boundedCommerceHistory, runCommerceAgentTurn } from './runtime';
import { commerceDateRangeSchema, type CommerceConversationMessage } from './types';

function toolTurn(name: string, input: unknown, call: number): MoAgentModelEvent[] {
  return [
    { type: 'response_start', responseId: `response-${call}`, model: 'scripted-commerce' },
    {
      type: 'tool_call_delta',
      index: 0,
      id: `call-${call}`,
      nameDelta: name,
      argumentsDelta: JSON.stringify(input),
    },
    {
      type: 'usage',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    },
    { type: 'finish', reason: 'tool_calls', rawReason: 'tool_calls' },
  ];
}

class CommerceScriptedProvider implements MoAgentModelProvider {
  readonly name = 'scripted';
  calls = 0;
  readonly requestedMaxTokens: number[] = [];
  readonly requestedToolChoices: Array<string | null> = [];
  readonly requestedTools: string[][] = [];
  systemPrompt = '';

  async *complete(request: MoAgentModelRequest): AsyncIterable<MoAgentModelEvent> {
    this.calls += 1;
    const system = request.messages.find((message) => message.role === 'system');
    if (system?.role === 'system') this.systemPrompt = system.content;
    this.requestedMaxTokens.push(request.maxTokens ?? 0);
    this.requestedToolChoices.push(
      typeof request.toolChoice === 'string'
        ? request.toolChoice
        : request.toolChoice?.name ?? null,
    );
    this.requestedTools.push((request.tools || []).map((tool) => tool.name));
    let events: MoAgentModelEvent[];
    events = toolTurn('compare_commerce_metrics', {
      current: { start: '2026-06-01', end: '2026-06-30' },
      metrics: ['gmv'],
      filters: { regions: [], channels: [], skus: [], categories: [] },
    }, this.calls);
    for (const event of events) yield event;
  }
}

const repository: CommerceAnalyticsRepository = {
  async getCatalog() {
    return {
      dataset: 'commerce_daily_metrics',
      timezone: 'Asia/Shanghai',
      coverage: {
        start: '2026-01-01',
        end: '2026-06-30',
        lastIngestedAt: new Date().toISOString(),
        sourceUpdatedAt: new Date().toISOString(),
        dataMode: 'snapshot' as const,
        rowCount: 1_000,
      },
      metrics: [],
      dimensions: { region: ['华东'], channel: ['搜索'], sku: ['SKU-1'], category: ['服饰'] },
    };
  },
  async compareMetrics() {
    return {
      current: { gmv: 100 } as never,
      baseline: null,
      changes: null,
    };
  },
  async lookupEntities() { return []; },
  async breakdown() { return []; },
  async trend() { return []; },
  async inventoryRisk() { return []; },
};

describe('conversational Commerce Agent runtime', () => {
  it('rejects calendar-normalized dates before PostgreSQL sees them', () => {
    expect(commerceDateRangeSchema.safeParse({
      start: '2026-02-30',
      end: '2026-03-02',
    }).success).toBe(false);
  });

  it('applies the character budget to complete user/assistant turns', () => {
    const history = [
      ['run_old', 'user', 'u'.repeat(30)],
      ['run_old', 'assistant', 'a'.repeat(30)],
      ['run_latest', 'user', 'latest user'],
      ['run_latest', 'assistant', 'latest answer'],
      ['run_failed', 'user', 'must not leak'],
    ].map(([runId, role, content], index): CommerceConversationMessage => ({
      id: `history_${index}`,
      role: role as 'user' | 'assistant',
      content,
      answer: null,
      runId,
      runStatus: runId === 'run_failed' ? 'failed' : 'completed',
      traces: [],
      createdAt: new Date(index * 1_000).toISOString(),
    }));

    const bounded = boundedCommerceHistory(history, 4, 30);

    expect(bounded.map((entry) => [entry.runId, entry.role])).toEqual([
      ['run_latest', 'user'],
      ['run_latest', 'assistant'],
    ]);
  });

  it('performs multiple read-tool turns and completes only through a grounded terminal answer', async () => {
    const provider = new CommerceScriptedProvider();

    const result = await runCommerceAgentTurn({
      identity: {
        tenantId: 'tenant_test',
        userId: 'user_test',
        displayName: 'Test operator',
        scopes: ['commerce:data:read'],
        authMode: 'development',
      },
      question: '查看 2026 年 6 月的 GMV。',
      history: [],
      repository,
      modelRuntime: { provider, providerName: provider.name, model: 'scripted-commerce' },
      runId: 'commerce-agent-runtime-test',
    });

    expect(provider.calls).toBe(1);
    expect(provider.requestedMaxTokens).toEqual([4_000]);
    expect(provider.requestedToolChoices).toEqual(['auto']);
    expect(provider.requestedTools[0]).not.toContain('describe_commerce_data');
    expect(provider.requestedTools[0]).toContain('compare_commerce_metrics');
    expect(provider.systemPrompt).toContain('For period totals only, call compare_commerce_metrics once');
    expect(provider.systemPrompt).toContain('business timezone returned by describe_commerce_data');
    expect(provider.systemPrompt).toContain('immediately submit refused');
    expect(result.answer.status).toBe('answered');
    expect(result.answer.answer).toContain('100.00');
    expect(result.traces.map((trace) => trace.operation)).toEqual([
      'commerce.describe_data',
      'commerce.compare_metrics',
    ]);
    expect(result.traces.every((trace) => Boolean(trace.sourceWatermark))).toBe(true);
    expect(result.usage.totalTokens).toBe(30);
  });
});

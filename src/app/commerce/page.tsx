'use client';

import {
  ArrowUp,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  CircleAlert,
  Clock3,
  Database,
  FileSearch,
  Fingerprint,
  LoaderCircle,
  Menu,
  MessageSquareText,
  PanelRight,
  Plus,
  Search,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
} from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';

type ModelId =
  | 'local_qwen:qwen3.5-9b-q5km'
  | 'deepseek:deepseek-v4-flash'
  | 'deepseek-v4-flash';

type Readiness = {
  ready: boolean;
  issues: string[];
  warnings: string[];
  databaseConfigured: boolean;
  analyticsConfigured: boolean;
  modelConfigured: boolean;
  authMode: 'development' | 'trusted_proxy';
  checks?: {
    configuration: boolean;
    controlSchema: boolean;
    workerActive: boolean;
    analyticsSchema: boolean;
    analyticsReadOnly: boolean;
    analyticsRls: boolean;
    analyticsDataPresent: boolean | null;
    analyticsDataFresh: boolean | null;
    analyticsSourceFresh: boolean | null;
  };
  dataStatus: {
    dataMode: 'snapshot' | 'incremental';
    coverageStart: string | null;
    coverageEnd: string | null;
    lastIngestedAt: string | null;
    sourceUpdatedAt: string | null;
  } | null;
};

type Bootstrap = {
  agent: {
    id: string;
    version: string;
    runtime: string;
    connector: string;
    fallback: string;
    models: ModelId[];
    tools: string[];
  };
  identity: { displayName: string; authMode: string };
  readiness: Readiness;
};

type ConversationSummary = {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
};

type EvidenceTrace = {
  evidenceId: string;
  operation: string;
  fetchedAt: string;
  rowCount: number;
  requestSha256: string;
  responseSha256: string;
  sourceWatermark: string | null;
  request: unknown;
  preview: unknown;
};

type EvidenceClaim = {
  evidenceId: string;
  path: string;
  metric: string;
  value: number;
  unit: 'currency' | 'integer' | 'decimal' | 'percent' | 'hours';
};

type AgentAnswer = {
  status: 'answered' | 'needs_clarification' | 'refused';
  answer: string;
  answerClaims: EvidenceClaim[];
  findings: Array<{ metric: string; title: string; detail: string; claims: EvidenceClaim[] }>;
  recommendations: Array<{ action: string; rationale: string; claims: EvidenceClaim[] }>;
  followUps: string[];
};

type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer: AgentAnswer | null;
  runId: string | null;
  runStatus: 'running' | 'completed' | 'failed' | null;
  traces: EvidenceTrace[];
  createdAt: string;
};

type Conversation = ConversationSummary & { messages: ConversationMessage[] };

type RunResult = {
  conversation: ConversationSummary;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
};

type AgentJob = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'dead_letter';
  result: RunResult | null;
  error: { code: string; message: string } | null;
};

type ApiEnvelope<T> =
  | ({ success: true } & T)
  | { success: false; error: string; message: string; conversationId?: string };

class CommerceApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly conversationId: string | null,
  ) {
    super(message);
    this.name = 'CommerceApiError';
  }
}

const STARTERS = [
  '分析 2018 年 8 月的 GMV、支付订单数和新客数。',
  '按州拆解 2018 年 8 月的 GMV，找出贡献最高的地区。',
  '展示 2018 年 1 月至 8 月的月度 GMV 和支付订单趋势。',
];

const MODEL_LABELS: Record<ModelId, string> = {
  'local_qwen:qwen3.5-9b-q5km': 'Qwen 3.5 · ModelPort',
  'deepseek:deepseek-v4-flash': 'DeepSeek V4 · ModelPort',
  'deepseek-v4-flash': 'DeepSeek V4 · Official',
};

async function api<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
    cache: 'no-store',
  });
  const payload = await response.json() as ApiEnvelope<T>;
  if (!response.ok || !payload.success) {
    throw new CommerceApiError(
      payload.success ? `请求失败（HTTP ${response.status}）。` : payload.message,
      payload.success ? 'HTTP_ERROR' : payload.error,
      response.status,
      payload.success ? null : payload.conversationId ?? null,
    );
  }
  return payload;
}

async function waitForAgentJob(
  initial: AgentJob,
  onStatus: (status: AgentJob['status']) => void,
): Promise<RunResult> {
  if (initial.status === 'completed' && initial.result) return initial.result;
  if (initial.status === 'failed' || initial.status === 'dead_letter') {
    throw new Error(initial.error?.message || 'Agent 异步任务失败。');
  }
  onStatus(initial.status);
  return new Promise<RunResult>((resolve, reject) => {
    const source = new EventSource(`/api/commerce/jobs/${encodeURIComponent(initial.id)}/events`);
    const timeout = window.setTimeout(() => {
      source.close();
      reject(new Error('Agent 异步任务等待超时，可使用同一 requestId 重试。'));
    }, 180_000);
    const finish = async () => {
      try {
        const response = await api<{ job: AgentJob }>(
          `/api/commerce/jobs/${encodeURIComponent(initial.id)}`,
        );
        onStatus(response.job.status);
        if (response.job.status === 'completed' && response.job.result) {
          window.clearTimeout(timeout);
          source.close();
          resolve(response.job.result);
        } else if (response.job.status === 'failed' || response.job.status === 'dead_letter') {
          window.clearTimeout(timeout);
          source.close();
          reject(new Error(response.job.error?.message || 'Agent 异步任务失败。'));
        }
      } catch (error) {
        window.clearTimeout(timeout);
        source.close();
        reject(error);
      }
    };
    source.addEventListener('queued', () => onStatus('queued'));
    source.addEventListener('requeued', () => onStatus('queued'));
    source.addEventListener('running', () => onStatus('running'));
    source.addEventListener('completed', () => void finish());
    source.addEventListener('failed', () => void finish());
    source.addEventListener('dead_lettered', () => void finish());
  });
}

function shortTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function operationLabel(operation: string) {
  const labels: Record<string, string> = {
    'commerce.describe_data': '数据目录',
    'commerce.lookup_entities': '实体检索',
    'commerce.compare_metrics': '指标对比',
    'commerce.breakdown_metric': '维度拆解',
    'commerce.trend_metric': '趋势查询',
    'commerce.inventory_risk': '库存风险',
  };
  return labels[operation] ?? operation;
}

function EvidenceIds({ ids }: { ids: string[] }) {
  if (!ids.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <span
          key={id}
          className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-2 py-1 font-mono text-[10px] font-semibold text-blue-800"
        >
          <Fingerprint className="h-3 w-3" />
          {id.slice(0, 11)}
        </span>
      ))}
    </div>
  );
}

function claimEvidenceIds(claims: EvidenceClaim[]): string[] {
  return Array.from(new Set(claims.map((claim) => claim.evidenceId)));
}

function AssistantAnswer({ message, onFollowUp }: {
  message: ConversationMessage;
  onFollowUp: (question: string) => void;
}) {
  const answer = message.answer;
  if (!answer) return <p className="whitespace-pre-wrap leading-7 text-slate-700">{message.content}</p>;
  return (
    <div className="space-y-5">
      <p className="whitespace-pre-wrap text-[15px] leading-7 text-slate-800">{answer.answer}</p>
      <EvidenceIds ids={claimEvidenceIds(answer.answerClaims)} />

      {answer.findings.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {answer.findings.map((finding) => (
            <article key={`${finding.title}:${finding.detail}`} className="border-l-2 border-blue-600 bg-slate-50 px-4 py-3">
              <h4 className="text-sm font-bold text-slate-950">{finding.title}</h4>
              <p className="mt-1.5 whitespace-pre-wrap text-sm leading-6 text-slate-600">{finding.detail}</p>
              <EvidenceIds ids={claimEvidenceIds(finding.claims)} />
            </article>
          ))}
        </div>
      ) : null}

      {answer.recommendations.length ? (
        <div className="border-t border-slate-200 pt-4">
          <p className="mb-3 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-500">
            Recommended actions
          </p>
          <div className="space-y-3">
            {answer.recommendations.map((recommendation, index) => (
              <div key={`${recommendation.action}:${index}`} className="flex gap-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-slate-950 font-mono text-[10px] font-bold text-white">
                  {index + 1}
                </span>
                <div>
                  <p className="text-sm font-bold text-slate-900">{recommendation.action}</p>
                  <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-slate-600">{recommendation.rationale}</p>
                  <EvidenceIds ids={claimEvidenceIds(recommendation.claims)} />
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {answer.followUps.length ? (
        <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
          {answer.followUps.map((followUp) => (
            <button
              key={followUp}
              type="button"
              onClick={() => onFollowUp(followUp)}
              className="group inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-xs font-semibold text-slate-700 transition hover:border-blue-300 hover:text-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {followUp}
              <ChevronRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function CommercePage() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [selectedTrace, setSelectedTrace] = useState<EvidenceTrace | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'conversations' | 'evidence' | null>(null);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState<ModelId>('local_qwen:qwen3.5-9b-q5km');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [jobStatus, setJobStatus] = useState<AgentJob['status'] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryRequest, setRetryRequest] = useState<{
    message: string;
    conversationId: string | null;
    model: ModelId;
    requestId: string;
  } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const traces = useMemo(
    () => (active?.messages ?? []).flatMap((entry) => entry.role === 'assistant'
      ? entry.traces
      : []),
    [active],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const metadata = await api<{ agent: Bootstrap['agent']; identity: Bootstrap['identity']; readiness: Readiness }>(
          '/api/commerce',
        );
        if (cancelled) return;
        const value = { agent: metadata.agent, identity: metadata.identity, readiness: metadata.readiness };
        setBootstrap(value);
        if (metadata.agent.models[0]) setModel(metadata.agent.models[0]);
        if (metadata.readiness.ready) {
          const list = await api<{ conversations: ConversationSummary[] }>('/api/commerce/conversations');
          if (!cancelled) setConversations(list.conversations);
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : '初始化 Commerce Agent 失败。');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [active?.messages.length, sending]);

  useEffect(() => {
    setSelectedTrace(traces.at(-1) ?? null);
  }, [traces]);

  useEffect(() => {
    if (!mobilePanel) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setMobilePanel(null);
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [mobilePanel]);

  async function openConversation(id: string) {
    setError(null);
    try {
      const response = await api<{ conversation: Conversation }>(`/api/commerce/conversations/${encodeURIComponent(id)}`);
      setActive(response.conversation);
      setMobilePanel(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取会话失败。');
    }
  }

  function startNewConversation() {
    setActive(null);
    setSelectedTrace(null);
    setError(null);
    setMobilePanel(null);
  }

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const message = draft.trim();
    if (sending || message.length < 2 || !bootstrap?.readiness.ready) return;
    setSending(true);
    setJobStatus('queued');
    setError(null);
    setDraft('');
    const optimistic: ConversationMessage = {
      id: `pending_${crypto.randomUUID()}`,
      role: 'user',
      content: message,
      answer: null,
      runId: null,
      runStatus: 'running',
      traces: [],
      createdAt: new Date().toISOString(),
    };
    setActive((current) => current
      ? { ...current, messages: [...current.messages, optimistic] }
      : null);
    try {
      const conversationId = active?.id ?? null;
      const reusableRequest = retryRequest
        && retryRequest.message === message
        && retryRequest.conversationId === conversationId
        && retryRequest.model === model
        ? retryRequest
        : null;
      const requestId = reusableRequest?.requestId ?? `req_${crypto.randomUUID()}`;
      setRetryRequest({ message, conversationId, model, requestId });
      const endpoint = active
        ? `/api/commerce/conversations/${encodeURIComponent(active.id)}/messages`
        : '/api/commerce/conversations';
      const body = active
        ? { message, requestId }
        : { message, requestId, model };
      const response = await api<{ job: AgentJob }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      const result = await waitForAgentJob(response.job, setJobStatus);
      const next: Conversation = active
        ? {
            ...active,
            ...result.conversation,
            messages: [
              ...active.messages.filter((entry) => entry.id !== optimistic.id),
              result.userMessage,
              result.assistantMessage,
            ],
          }
        : {
            ...result.conversation,
            messages: [result.userMessage, result.assistantMessage],
          };
      setActive(next);
      setRetryRequest(null);
      setConversations((current) => [
        result.conversation,
        ...current.filter((entry) => entry.id !== result.conversation.id),
      ]);
    } catch (caught) {
      if (caught instanceof CommerceApiError && caught.conversationId) {
        try {
          const failed = await api<{ conversation: Conversation }>(
            `/api/commerce/conversations/${encodeURIComponent(caught.conversationId)}`,
          );
          setActive(failed.conversation);
          setConversations((current) => [
            failed.conversation,
            ...current.filter((entry) => entry.id !== failed.conversation.id),
          ]);
        } catch {
          // Keep the original execution error visible if reloading the durable run fails.
        }
      }
      if (
        caught instanceof CommerceApiError
        && (
          caught.status === 502
          || caught.code === 'COMMERCE_REQUEST_NOT_REPLAYABLE'
          || caught.code === 'COMMERCE_IDEMPOTENCY_CONFLICT'
        )
      ) {
        setRetryRequest(null);
      }
      setDraft(message);
      setActive((current) => current
        ? { ...current, messages: current.messages.filter((entry) => entry.id !== optimistic.id) }
        : current);
      setError(caught instanceof Error ? caught.message : 'Agent 运行失败。');
    } finally {
      setSending(false);
      setJobStatus(null);
    }
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const ready = bootstrap?.readiness.ready === true;
  const snapshotReady = ready && bootstrap?.readiness.dataStatus?.dataMode === 'snapshot';
  const checkingReadiness = loading || (!bootstrap && !error);
  const initializationFailed = !loading && !bootstrap && Boolean(error);

  return (
    <main className="min-h-screen bg-[#e8edf3] text-slate-950">
      <div className="mx-auto flex min-h-screen max-w-[1780px] flex-col bg-[#f7f9fc] shadow-[0_0_70px_rgba(15,23,42,0.12)]">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-300/80 bg-white px-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-lg bg-blue-700 text-white">
              <Boxes className="h-5 w-5" />
              <span className="absolute bottom-0 left-0 h-1 w-full bg-cyan-300" />
            </div>
            <div>
              <p className="font-[Bahnschrift] text-[15px] font-bold uppercase tracking-[0.08em] text-slate-950">
                Commerce Signal Desk
              </p>
              <p className="font-mono text-[10px] text-slate-500">Production Data Agent · evidence-bound</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              aria-live="polite"
              className={`hidden items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold sm:inline-flex ${
                snapshotReady
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : ready
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                  : checkingReadiness
                    ? 'border-blue-200 bg-blue-50 text-blue-800'
                    : initializationFailed
                      ? 'border-red-200 bg-red-50 text-red-800'
                      : 'border-amber-200 bg-amber-50 text-amber-800'
              }`}
            >
              {snapshotReady ? (
                <Database className="h-3.5 w-3.5" />
              ) : ready ? (
                <Check className="h-3.5 w-3.5" />
              ) : checkingReadiness ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <CircleAlert className="h-3.5 w-3.5" />
              )}
              {snapshotReady
                ? '历史快照可用'
                : ready
                  ? '系统就绪'
                : checkingReadiness
                  ? '正在检查'
                  : initializationFailed
                    ? '初始化失败'
                    : '等待配置'}
            </span>
            <span className="hidden rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 font-mono text-[10px] text-slate-600 sm:inline-block">
              {bootstrap?.identity.displayName ?? 'IDENTITY PENDING'}
            </span>
          </div>
        </header>

        <div className="grid min-h-0 flex-1 xl:grid-cols-[260px_minmax(520px,1fr)_330px]">
          <aside className="hidden min-h-0 flex-col border-r border-slate-300/80 bg-[#eef2f7] xl:flex">
            <div className="border-b border-slate-300/80 p-4">
              <button
                type="button"
                onClick={startNewConversation}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                <Plus className="h-4 w-4" />
                新建分析会话
              </button>
            </div>
            <div className="flex items-center gap-2 px-4 pb-2 pt-4 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
              <MessageSquareText className="h-3.5 w-3.5" />
              Conversations
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              {conversations.length ? conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => void openConversation(conversation.id)}
                  className={`mb-1 w-full rounded-lg px-3 py-3 text-left transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                    active?.id === conversation.id
                      ? 'bg-white shadow-sm ring-1 ring-slate-200'
                      : 'hover:bg-white/70'
                  }`}
                >
                  <p className="line-clamp-2 text-xs font-bold leading-5 text-slate-800">{conversation.title}</p>
                  <p className="mt-1.5 flex items-center gap-1 font-mono text-[9px] text-slate-500">
                    <Clock3 className="h-3 w-3" /> {shortTime(conversation.updatedAt)}
                  </p>
                </button>
              )) : (
                <p className="px-3 py-6 text-xs leading-5 text-slate-500">创建第一条真实数据分析会话后，它会出现在这里。</p>
              )}
            </div>
            <div className="border-t border-slate-300/80 p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-700">
                <ShieldCheck className="h-4 w-4 text-emerald-700" />
                Tenant-scoped reads
              </div>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">无规则 fallback · 无任意 SQL · 全量运行审计</p>
            </div>
          </aside>

          <section className="flex min-h-[calc(100vh-4rem)] min-w-0 flex-col bg-white">
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 sm:px-6">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-900">{active?.title ?? '新的经营问题'}</p>
                <p className="mt-0.5 font-mono text-[10px] text-slate-500">
                  {active ? active.model : MODEL_LABELS[model]} · PostgreSQL read-only · {
                    bootstrap?.readiness.dataStatus?.dataMode === 'snapshot' ? '历史快照' : '增量数据'
                  }
                </p>
              </div>
              <div className="flex items-center gap-1.5 xl:hidden">
                <button
                  type="button"
                  onClick={() => setMobilePanel('conversations')}
                  aria-label="打开会话列表"
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[11px] font-bold text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <Menu className="h-4 w-4" /> 会话
                </button>
                <button
                  type="button"
                  onClick={() => setMobilePanel('evidence')}
                  aria-label={`打开证据面板，共 ${traces.length} 条证据`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-2 text-[11px] font-bold text-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <PanelRight className="h-4 w-4" /> {traces.length}
                </button>
              </div>
            </div>

            {ready && bootstrap.readiness.warnings.length ? (
              <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-5 text-amber-950 sm:px-6">
                <Database className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                <span>{bootstrap.readiness.warnings[0]}</span>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 overflow-y-auto">
              {loading ? (
                <div className="grid min-h-[520px] place-items-center">
                  <div className="text-center text-sm text-slate-500">
                    <LoaderCircle className="mx-auto mb-3 h-6 w-6 animate-spin text-blue-700" />
                    正在校验生产依赖
                  </div>
                </div>
              ) : !ready ? (
                <div className="mx-auto flex min-h-[560px] max-w-3xl items-center px-6 py-14">
                  <div className="w-full border border-amber-300 bg-amber-50 p-6 shadow-[8px_8px_0_#dbe4ee] sm:p-8">
                    <div className="flex items-start gap-4">
                      <div className="grid h-10 w-10 shrink-0 place-items-center bg-amber-400 text-amber-950">
                        <CircleAlert className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="font-[Bahnschrift] text-lg font-bold uppercase tracking-wide text-slate-950">Production gate closed</p>
                        <p className="mt-2 text-sm leading-6 text-slate-700">
                          Agent 不会使用样例数据或规则答案绕过依赖。完成以下配置并执行数据库迁移后才会开放提问。
                        </p>
                      </div>
                    </div>
                    <ul className="mt-6 space-y-2">
                      {(bootstrap?.readiness.issues ?? [error ?? '无法读取 readiness。']).map((issue) => (
                        <li key={issue} className="flex items-start gap-2 border-t border-amber-200 py-2 text-sm text-amber-950">
                          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />
                          {issue}
                        </li>
                      ))}
                    </ul>
                    <div className="mt-6 grid gap-3 sm:grid-cols-3">
                      {[
                        [
                          '01',
                          '经营数据库',
                          bootstrap?.readiness.analyticsConfigured
                            && bootstrap.readiness.checks?.analyticsSchema
                            && bootstrap.readiness.checks.analyticsReadOnly
                            && bootstrap.readiness.checks.analyticsRls
                            && bootstrap.readiness.checks.analyticsDataPresent
                            && bootstrap.readiness.checks.analyticsDataFresh
                            && bootstrap.readiness.checks.analyticsSourceFresh !== false,
                        ],
                        [
                          '02',
                          '会话数据库与 Worker',
                          bootstrap?.readiness.databaseConfigured
                            && bootstrap.readiness.checks?.controlSchema
                            && bootstrap.readiness.checks.workerActive,
                        ],
                        ['03', '模型 Provider', bootstrap?.readiness.modelConfigured],
                      ].map(([number, label, done]) => (
                        <div key={String(number)} className="bg-white/70 p-3">
                          <p className="font-mono text-[10px] font-bold text-amber-700">{number}</p>
                          <p className="mt-1 text-xs font-bold text-slate-800">{label}</p>
                          <p className={`mt-2 text-[10px] font-semibold ${done ? 'text-emerald-700' : 'text-amber-700'}`}>
                            {done ? 'CONFIGURED' : 'REQUIRED'}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : active?.messages.length ? (
                <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6">
                  {active.messages.map((entry) => entry.role === 'user' ? (
                    <div key={entry.id} className="mb-8 flex justify-end gap-3">
                      <div className="max-w-[82%] rounded-2xl rounded-tr-sm bg-blue-700 px-4 py-3 text-sm leading-6 text-white shadow-sm">
                        {entry.content}
                      </div>
                      <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-200 text-slate-600">
                        <UserRound className="h-4 w-4" />
                      </div>
                    </div>
                  ) : (
                    <div key={entry.id} className="mb-10 flex gap-3">
                      <div className="relative grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-slate-950 text-white">
                        <Bot className="h-4 w-4" />
                        <span className="absolute bottom-0 h-0.5 w-full bg-cyan-300" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className="text-xs font-bold text-slate-900">Commerce Data Agent</span>
                          <span className="rounded bg-slate-100 px-2 py-0.5 font-mono text-[9px] text-slate-500">
                            {entry.traces.length} evidence receipts
                          </span>
                        </div>
                        <AssistantAnswer message={entry} onFollowUp={setDraft} />
                      </div>
                    </div>
                  ))}
                  {sending ? (
                    <div className="mb-8 flex gap-3">
                      <div className="grid h-8 w-8 place-items-center rounded-lg bg-slate-950 text-white">
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      </div>
                      <div className="border-l-2 border-cyan-400 px-4 py-2">
                        <p className="text-sm font-bold text-slate-800">
                          {jobStatus === 'queued' ? '任务正在等待 Worker' : '正在查询经营数据'}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          {jobStatus === 'queued'
                            ? '任务已持久化，可以安全等待队列调度。'
                            : 'Agent 会自行选择指标、趋势或拆解工具，然后校验证据。'}
                        </p>
                      </div>
                    </div>
                  ) : null}
                  <div ref={endRef} />
                </div>
              ) : (
                <div className="mx-auto flex min-h-[560px] max-w-3xl flex-col justify-center px-6 py-14">
                  <div className="mb-8 flex items-center gap-3">
                    <span className="h-px flex-1 bg-slate-200" />
                    <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-blue-700">Ask the operation</span>
                    <span className="h-px flex-1 bg-slate-200" />
                  </div>
                  <h1 className="text-balance text-center font-[Bahnschrift] text-3xl font-bold leading-tight tracking-[-0.02em] text-slate-950 sm:text-4xl">
                    从真实经营数据开始，<br className="hidden sm:block" />而不是从预设报告开始。
                  </h1>
                  <p className="mx-auto mt-4 max-w-xl text-center text-sm leading-6 text-slate-600">
                    可追问日期、地区、渠道、GMV、订单、新客和件数。未声明指标会拒答，不补零、不猜测。
                  </p>
                  <div className="mt-9 grid gap-2">
                    {STARTERS.map((starter) => (
                      <button
                        key={starter}
                        type="button"
                        onClick={() => setDraft(starter)}
                        className="group flex items-center justify-between border border-slate-200 bg-slate-50 px-4 py-3 text-left text-sm text-slate-700 transition hover:border-blue-300 hover:bg-blue-50 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        <span>{starter}</span>
                        <ArrowUp className="h-4 w-4 rotate-45 text-slate-400 transition group-hover:text-blue-700" />
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="border-t border-slate-200 bg-[#f7f9fc] p-3 sm:p-4">
              {error ? (
                <div className="mx-auto mb-3 flex max-w-4xl items-start gap-2 border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  {error}
                </div>
              ) : null}
              <form onSubmit={(event) => void send(event)} className="mx-auto max-w-4xl">
                {!active ? (
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <select
                      value={model}
                      onChange={(event) => setModel(event.target.value as ModelId)}
                      disabled={sending || !ready}
                      className="rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-slate-700 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-200 disabled:opacity-50"
                    >
                      {(bootstrap?.agent.models ?? Object.keys(MODEL_LABELS) as ModelId[]).map((id) => (
                        <option key={id} value={id}>{MODEL_LABELS[id]}</option>
                      ))}
                    </select>
                    <span className="font-mono text-[9px] text-slate-400">NEW CONVERSATION MODEL</span>
                  </div>
                ) : null}
                <div className="flex items-end gap-2 rounded-xl border border-slate-300 bg-white p-2 shadow-sm transition focus-within:border-blue-500 focus-within:ring-4 focus-within:ring-blue-100">
                  <textarea
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onComposerKeyDown}
                    disabled={sending || !ready}
                    rows={2}
                    maxLength={4_000}
                    placeholder={ready ? '询问经营数据；Enter 发送，Shift + Enter 换行' : '完成生产配置后开放提问'}
                    className="max-h-40 min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-sm leading-6 text-slate-900 outline-none placeholder:text-slate-400 disabled:cursor-not-allowed"
                  />
                  <button
                    type="submit"
                    disabled={sending || !ready || draft.trim().length < 2}
                    aria-label="发送问题"
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-blue-700 text-white transition hover:bg-blue-800 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
                  >
                    {sending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
                  </button>
                </div>
              </form>
            </div>
          </section>

          <aside className="hidden min-h-0 flex-col border-l border-slate-300/80 bg-[#f4f7fa] xl:flex">
            <div className="border-b border-slate-300/80 px-5 py-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-[Bahnschrift] text-xs font-bold uppercase tracking-[0.12em] text-slate-900">Evidence rail</p>
                  <p className="mt-1 font-mono text-[9px] text-slate-500">ALL COMPLETED TURNS</p>
                </div>
                <FileSearch className="h-4 w-4 text-blue-700" />
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {traces.length ? (
                <>
                  <div className="relative space-y-2 before:absolute before:bottom-3 before:left-[17px] before:top-3 before:w-px before:bg-blue-200">
                    {traces.map((trace, index) => (
                      <button
                        key={trace.evidenceId}
                        type="button"
                        onClick={() => setSelectedTrace(trace)}
                        className={`relative flex w-full items-start gap-3 rounded-lg border p-3 text-left transition focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                          selectedTrace?.evidenceId === trace.evidenceId
                            ? 'border-blue-300 bg-white shadow-sm'
                            : 'border-transparent bg-transparent hover:bg-white/80'
                        }`}
                      >
                        <span className="relative z-10 grid h-9 w-9 shrink-0 place-items-center rounded-md bg-blue-700 font-mono text-[10px] font-bold text-white">
                          {String(index + 1).padStart(2, '0')}
                        </span>
                        <span className="min-w-0">
                          <span className="block text-xs font-bold text-slate-800">{operationLabel(trace.operation)}</span>
                          <span className="mt-1 block font-mono text-[9px] text-slate-500">{trace.rowCount} rows · {shortTime(trace.fetchedAt)}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                  {selectedTrace ? (
                    <div className="mt-5 border-t border-slate-300 pt-4">
                      <div className="mb-3 grid grid-cols-2 gap-2 text-[10px]">
                        <div className="bg-white p-2">
                          <p className="font-mono text-slate-400">OPERATION</p>
                          <p className="mt-1 truncate font-bold text-slate-700">{operationLabel(selectedTrace.operation)}</p>
                        </div>
                        <div className="bg-white p-2">
                          <p className="font-mono text-slate-400">ROWS</p>
                          <p className="mt-1 font-bold text-slate-700">{selectedTrace.rowCount}</p>
                        </div>
                      </div>
                      <div className="mb-2 flex items-center gap-2 font-mono text-[9px] font-bold text-slate-500">
                        <FileSearch className="h-3.5 w-3.5" /> VALIDATED REQUEST
                      </div>
                      <pre className="mb-4 max-h-48 overflow-auto whitespace-pre-wrap break-words border border-slate-200 bg-slate-50 p-3 font-mono text-[9px] leading-5 text-slate-700">
                        {JSON.stringify(selectedTrace.request, null, 2)}
                      </pre>
                      <p className="mb-4 break-all font-mono text-[8px] leading-4 text-slate-400">
                        SOURCE WATERMARK · {selectedTrace.sourceWatermark ?? 'unavailable'}
                      </p>
                      <div className="mb-2 flex items-center gap-2 font-mono text-[9px] font-bold text-slate-500">
                        <Database className="h-3.5 w-3.5" /> RESULT PREVIEW
                      </div>
                      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border border-slate-200 bg-slate-950 p-3 font-mono text-[9px] leading-5 text-cyan-100">
                        {JSON.stringify(selectedTrace.preview, null, 2)}
                      </pre>
                      <p className="mt-2 break-all font-mono text-[8px] leading-4 text-slate-400">
                        {selectedTrace.responseSha256}
                      </p>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="mt-10 text-center">
                  <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-dashed border-slate-300 text-slate-400">
                    <Search className="h-5 w-5" />
                  </div>
                  <p className="mt-4 text-xs font-bold text-slate-600">还没有查询证据</p>
                  <p className="mt-2 text-[11px] leading-5 text-slate-500">Agent 调用数据工具后，查询操作、行数、时间和内容哈希会显示在这里。</p>
                </div>
              )}
            </div>
            <div className="border-t border-slate-300/80 p-4">
              <div className="grid grid-cols-2 gap-2 text-[10px]">
                <div className="border border-slate-200 bg-white p-2.5">
                  <Sparkles className="h-3.5 w-3.5 text-blue-700" />
                  <p className="mt-2 font-bold text-slate-700">MoAgent loop</p>
                </div>
                <div className="border border-slate-200 bg-white p-2.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-emerald-700" />
                  <p className="mt-2 font-bold text-slate-700">Fail closed</p>
                </div>
              </div>
            </div>
          </aside>
        </div>

        {mobilePanel ? (
          <div className="fixed inset-0 z-50 xl:hidden">
            <button
              type="button"
              aria-label="关闭侧边面板"
              onClick={() => setMobilePanel(null)}
              className="absolute inset-0 bg-slate-950/45 backdrop-blur-[1px]"
            />

            {mobilePanel === 'conversations' ? (
              <aside
                role="dialog"
                aria-modal="true"
                aria-labelledby="mobile-conversations-title"
                className="absolute inset-y-0 left-0 flex w-[min(90vw,380px)] flex-col border-r border-slate-300 bg-[#eef2f7] shadow-2xl"
              >
                <div className="flex h-16 items-center justify-between border-b border-slate-300 px-4">
                  <div>
                    <p id="mobile-conversations-title" className="font-[Bahnschrift] text-sm font-bold uppercase tracking-[0.08em] text-slate-950">
                      Conversations
                    </p>
                    <p className="mt-0.5 font-mono text-[9px] text-slate-500">TENANT-SCOPED HISTORY</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMobilePanel(null)}
                    aria-label="关闭会话列表"
                    className="grid h-9 w-9 place-items-center rounded-md border border-slate-300 bg-white text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="border-b border-slate-300 p-4">
                  <button
                    type="button"
                    onClick={startNewConversation}
                    className="flex w-full items-center justify-center gap-2 rounded-lg bg-blue-700 px-4 py-3 text-sm font-bold text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                  >
                    <Plus className="h-4 w-4" /> 新建分析会话
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                  {conversations.length ? conversations.map((conversation) => (
                    <button
                      key={conversation.id}
                      type="button"
                      onClick={() => void openConversation(conversation.id)}
                      className={`mb-1 w-full rounded-lg px-3 py-3 text-left focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                        active?.id === conversation.id
                          ? 'bg-white shadow-sm ring-1 ring-slate-200'
                          : 'hover:bg-white/70'
                      }`}
                    >
                      <p className="line-clamp-2 text-xs font-bold leading-5 text-slate-800">{conversation.title}</p>
                      <p className="mt-1.5 flex items-center gap-1 font-mono text-[9px] text-slate-500">
                        <Clock3 className="h-3 w-3" /> {shortTime(conversation.updatedAt)}
                      </p>
                    </button>
                  )) : (
                    <p className="px-3 py-8 text-xs leading-5 text-slate-500">
                      创建第一条真实数据分析会话后，它会出现在这里。
                    </p>
                  )}
                </div>
                <div className="border-t border-slate-300 p-4 text-[11px] leading-5 text-slate-500">
                  <span className="inline-flex items-center gap-2 font-bold text-slate-700">
                    <ShieldCheck className="h-4 w-4 text-emerald-700" /> Tenant-scoped reads
                  </span>
                </div>
              </aside>
            ) : (
              <aside
                role="dialog"
                aria-modal="true"
                aria-labelledby="mobile-evidence-title"
                className="absolute inset-y-0 right-0 flex w-[min(94vw,430px)] flex-col border-l border-slate-300 bg-[#f4f7fa] shadow-2xl"
              >
                <div className="flex h-16 items-center justify-between border-b border-slate-300 px-4">
                  <div>
                    <p id="mobile-evidence-title" className="font-[Bahnschrift] text-sm font-bold uppercase tracking-[0.08em] text-slate-950">
                      Evidence rail
                    </p>
                    <p className="mt-0.5 font-mono text-[9px] text-slate-500">{traces.length} RECEIPTS · ALL TURNS</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMobilePanel(null)}
                    aria-label="关闭证据面板"
                    className="grid h-9 w-9 place-items-center rounded-md border border-slate-300 bg-white text-slate-600 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                  {traces.length ? (
                    <>
                      <div className="grid gap-2">
                        {traces.map((trace, index) => (
                          <button
                            key={trace.evidenceId}
                            type="button"
                            onClick={() => setSelectedTrace(trace)}
                            className={`flex w-full items-start gap-3 rounded-lg border p-3 text-left focus:outline-none focus:ring-2 focus:ring-blue-500 ${
                              selectedTrace?.evidenceId === trace.evidenceId
                                ? 'border-blue-300 bg-white shadow-sm'
                                : 'border-slate-200 bg-white/55'
                            }`}
                          >
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-blue-700 font-mono text-[10px] font-bold text-white">
                              {String(index + 1).padStart(2, '0')}
                            </span>
                            <span className="min-w-0">
                              <span className="block text-xs font-bold text-slate-800">{operationLabel(trace.operation)}</span>
                              <span className="mt-1 block font-mono text-[9px] text-slate-500">{trace.rowCount} rows · {shortTime(trace.fetchedAt)}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                      {selectedTrace ? (
                        <div className="mt-5 border-t border-slate-300 pt-4">
                          <p className="mb-2 font-mono text-[9px] font-bold text-slate-500">VALIDATED REQUEST</p>
                          <pre className="mb-4 max-h-48 overflow-auto whitespace-pre-wrap break-words border border-slate-200 bg-white p-3 font-mono text-[9px] leading-5 text-slate-700">
                            {JSON.stringify(selectedTrace.request, null, 2)}
                          </pre>
                          <p className="mb-4 break-all font-mono text-[8px] leading-4 text-slate-400">
                            SOURCE WATERMARK · {selectedTrace.sourceWatermark ?? 'unavailable'}
                          </p>
                          <p className="mb-2 font-mono text-[9px] font-bold text-slate-500">RESULT PREVIEW</p>
                          <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words border border-slate-200 bg-slate-950 p-3 font-mono text-[9px] leading-5 text-cyan-100">
                            {JSON.stringify(selectedTrace.preview, null, 2)}
                          </pre>
                          <p className="mt-2 break-all font-mono text-[8px] leading-4 text-slate-400">
                            {selectedTrace.responseSha256}
                          </p>
                        </div>
                      ) : null}
                    </>
                  ) : (
                    <div className="mt-12 text-center">
                      <div className="mx-auto grid h-12 w-12 place-items-center rounded-full border border-dashed border-slate-300 text-slate-400">
                        <Search className="h-5 w-5" />
                      </div>
                      <p className="mt-4 text-xs font-bold text-slate-600">还没有查询证据</p>
                      <p className="mt-2 text-[11px] leading-5 text-slate-500">Agent 完成数据查询后，可在这里检查请求、结果、水位和哈希。</p>
                    </div>
                  )}
                </div>
              </aside>
            )}
          </div>
        ) : null}
      </div>
    </main>
  );
}

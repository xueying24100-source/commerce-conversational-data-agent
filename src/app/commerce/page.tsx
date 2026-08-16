'use client';

import { Database, LoaderCircle, ShieldAlert } from 'lucide-react';
import { type FormEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ChatHeader } from '@/components/commerce/ChatHeader';
import { ActiveJobsPanel } from '@/components/commerce/ActiveJobsPanel';
import { ActionWorkbenchPanel } from '@/components/commerce/ActionWorkbenchPanel';
import {
  api,
  commerceStarters,
  CommerceApiError,
  CommerceJobWaitError,
  commerceBootstrapRetryDelay,
  type ActionReviewPlan,
  isConversationStillSelected,
  isJobWaitCurrent,
  isNonReplayableCommerceError,
  recoveredJobDraft,
  waitForAgentJob,
} from '@/components/commerce/client';
import { Composer } from '@/components/commerce/Composer';
import { EvidenceRail } from '@/components/commerce/EvidenceRail';
import { FeedbackReviewPanel } from '@/components/commerce/FeedbackReviewPanel';
import { MessageList } from '@/components/commerce/MessageList';
import { MobileConversationsPanel } from '@/components/commerce/MobileConversationsPanel';
import { MobileEvidencePanel } from '@/components/commerce/MobileEvidencePanel';
import { ReadinessGate, type ReadinessChecklistItem } from '@/components/commerce/ReadinessGate';
import { Sidebar, type StatusTone } from '@/components/commerce/Sidebar';
import type {
  AgentJob,
  ActionListItem,
  ActionState,
  Bootstrap,
  Conversation,
  ConversationSummary,
  ModelId,
  Readiness,
} from '@/components/commerce/types';
import { WelcomeScreen } from '@/components/commerce/WelcomeScreen';

const DERIVED_FIELD_LABELS: Record<string, string> = {
  visits: '访问量',
  channel: '渠道',
  region: '地区',
  sku: 'SKU',
  category: '品类',
  units: '件数',
};

export default function CommercePage() {
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [active, setActive] = useState<Conversation | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'conversations' | 'evidence' | null>(null);
  const [feedbackReviewOpen, setFeedbackReviewOpen] = useState(false);
  const [actionWorkbenchOpen, setActionWorkbenchOpen] = useState(false);
  const [openActionCount, setOpenActionCount] = useState(0);
  const [draft, setDraft] = useState('');
  const [model, setModel] = useState<ModelId>('local_qwen:qwen3.5-9b-q5km');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [jobStatus, setJobStatus] = useState<AgentJob['status'] | null>(null);
  const [activeJobs, setActiveJobs] = useState<AgentJob[]>([]);
  const [waitingJobId, setWaitingJobId] = useState<string | null>(null);
  const [jobConnection, setJobConnection] = useState<'connected' | 'reconnecting'>('connected');
  const [error, setError] = useState<string | null>(null);
  const [retryRequest, setRetryRequest] = useState<{
    message: string;
    conversationId: string | null;
    model: ModelId;
    requestId: string;
  } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const activeConversationIdRef = useRef<string | null>(null);
  const navigationGenerationRef = useRef(0);
  const waitAbortRef = useRef<AbortController | null>(null);

  async function refreshOpenActionCount() {
    try {
      const response = await api<{ actions: ActionListItem[] }>('/api/commerce/actions?status=open&limit=100');
      setOpenActionCount(response.actions.length);
    } catch {
      // The action workbench exposes its own retryable error; keep chat initialization usable.
    }
  }

  function applyActionState(messageId: string, state: ActionState) {
    setActive((current) => current ? {
      ...current,
      messages: current.messages.map((message) => {
        if (message.id !== messageId) return message;
        const existing = message.actionStates ?? [];
        return {
          ...message,
          actionStates: [state, ...existing.filter((item) => item.actionId !== state.actionId)],
        };
      }),
    } : current);
    void refreshOpenActionCount();
  }

  function rememberActiveJob(job: AgentJob) {
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'dead_letter') {
      setActiveJobs((current) => current.filter((entry) => entry.id !== job.id));
      return;
    }
    setActiveJobs((current) => [job, ...current.filter((entry) => entry.id !== job.id)]);
  }

  function forgetActiveJob(jobId: string) {
    setActiveJobs((current) => current.filter((entry) => entry.id !== jobId));
  }

  const evidenceContext = useMemo(() => {
    const latestAnswer = [...(active?.messages ?? [])]
      .reverse()
      .find((entry) => entry.role === 'assistant' && entry.traces.length);
    const answer = latestAnswer?.answer;
    const rawClaims = answer ? [
      ...answer.answerClaims,
      ...answer.findings.flatMap((finding) => finding.claims),
      ...answer.recommendations.flatMap((recommendation) => recommendation.claims),
    ] : [];
    const seen = new Set<string>();
    const claims = rawClaims.filter((claim) => {
      const key = `${claim.evidenceId}:${claim.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { traces: latestAnswer?.traces ?? [], claims };
  }, [active]);
  const { traces, claims: evidenceClaims } = evidenceContext;

  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let activeController: AbortController | null = null;
    let requestGeneration = 0;
    async function load(attempt = 0) {
      const generation = ++requestGeneration;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      if (attempt === 0) setLoading(true);
      try {
        const metadata = await api<{ agent: Bootstrap['agent']; identity: Bootstrap['identity']; readiness: Readiness }>(
          '/api/commerce',
          { signal: controller.signal },
        );
        if (cancelled || generation !== requestGeneration) return;
        const value = { agent: metadata.agent, identity: metadata.identity, readiness: metadata.readiness };
        setBootstrap(value);
        if (metadata.agent.models[0]) setModel(metadata.agent.models[0]);
        if (metadata.readiness.ready) {
          const [list, pending] = await Promise.all([
            api<{ conversations: ConversationSummary[] }>('/api/commerce/conversations'),
            api<{ jobs: AgentJob[] }>('/api/commerce/jobs'),
          ]);
          if (!cancelled) {
            setConversations(list.conversations);
            setActiveJobs(pending.jobs);
            void refreshOpenActionCount();
          }
        } else {
          const retryDelay = commerceBootstrapRetryDelay(attempt);
          if (retryDelay !== null) {
            retryTimer = setTimeout(() => void load(attempt + 1), retryDelay);
          }
        }
      } catch (caught) {
        if (!cancelled && generation === requestGeneration) {
          setError(caught instanceof Error ? caught.message : '初始化 Commerce Agent 失败。');
        }
      } finally {
        if (!cancelled && generation === requestGeneration) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      requestGeneration += 1;
      if (retryTimer !== null) clearTimeout(retryTimer);
      activeController?.abort();
    };
  }, []);

  useEffect(() => () => waitAbortRef.current?.abort(), []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [active?.messages.length, sending]);

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
    waitAbortRef.current?.abort();
    const navigationGeneration = ++navigationGenerationRef.current;
    setError(null);
    try {
      const response = await api<{ conversation: Conversation }>(`/api/commerce/conversations/${encodeURIComponent(id)}`);
      if (navigationGeneration !== navigationGenerationRef.current) return;
      activeConversationIdRef.current = response.conversation.id;
      setActive(response.conversation);
      setMobilePanel(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取会话失败。');
    }
  }

  async function openActionSource(conversationId: string, messageId: string) {
    await openConversation(conversationId);
    setActionWorkbenchOpen(false);
    globalThis.setTimeout(() => {
      document.getElementById(`commerce-message-${messageId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 0);
  }

  function navigateToEvidence(evidenceId: string) {
    const mobile = globalThis.matchMedia('(max-width: 1279px)').matches;
    if (mobile) {
      setMobilePanel('evidence');
    }
    let attempts = 0;
    const focusTarget = () => {
      const target = document.getElementById(`${mobile ? 'mobile-evidence' : 'evidence'}-${evidenceId}`);
      if (!target && attempts < 4) {
        attempts += 1;
        globalThis.setTimeout(focusTarget, 25);
        return;
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target?.focus({ preventScroll: true });
    };
    globalThis.setTimeout(focusTarget, 0);
  }

  async function reviewCompletedAction(item: ActionListItem, plan: ActionReviewPlan) {
    if (sending || !bootstrap?.readiness.ready) return;
    if (
      plan.status !== 'ready'
      || !plan.question
      || !plan.current
      || !plan.baseline
      || !plan.reviewEnd
    ) return;
    const navigationGeneration = ++navigationGenerationRef.current;
    setError(null);
    try {
      const response = await api<{ conversation: Conversation }>(
        `/api/commerce/conversations/${encodeURIComponent(item.conversationId)}`,
      );
      if (navigationGeneration !== navigationGenerationRef.current) return;
      activeConversationIdRef.current = response.conversation.id;
      setActive(response.conversation);
      setConversations((current) => [
        {
          id: response.conversation.id,
          title: response.conversation.title,
          model: response.conversation.model,
          createdAt: response.conversation.createdAt,
          updatedAt: response.conversation.updatedAt,
        },
        ...current.filter((entry) => entry.id !== response.conversation.id),
      ]);
      setActionWorkbenchOpen(false);
      void send(undefined, plan.question, false, response.conversation, {
        item,
        plan: {
          ...plan,
          status: 'ready',
          question: plan.question,
          current: plan.current,
          baseline: plan.baseline,
          reviewEnd: plan.reviewEnd,
        },
        requestId: `review:${crypto.randomUUID()}`,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加载行动来源会话。');
    }
  }

  function startNewConversation() {
    waitAbortRef.current?.abort();
    navigationGenerationRef.current += 1;
    activeConversationIdRef.current = null;
    setActive(null);
    setError(null);
    setMobilePanel(null);
  }

  async function send(
    event?: FormEvent,
    overrideMessage?: string,
    forceNewRequest = false,
    targetConversation?: Conversation,
    actionReview?: {
      item: ActionListItem;
      plan: ActionReviewPlan & {
        status: 'ready';
        question: string;
        current: NonNullable<ActionReviewPlan['current']>;
        baseline: NonNullable<ActionReviewPlan['baseline']>;
        reviewEnd: string;
      };
      requestId: string;
    },
  ) {
    event?.preventDefault();
    const message = (overrideMessage ?? draft).trim();
    if (sending || message.length < 2 || !bootstrap?.readiness.ready) return;
    setSending(true);
    setJobStatus('queued');
    setError(null);
    if (overrideMessage === undefined) setDraft('');
    const optimistic = {
      id: `pending_${crypto.randomUUID()}`,
      role: 'user' as const,
      content: message,
      answer: null,
      runId: null,
      runStatus: 'running' as const,
      reportAvailable: false,
      traces: [],
      createdAt: new Date().toISOString(),
    };
    const requestConversation = targetConversation ?? active;
    const requestConversationId = requestConversation?.id ?? null;
    setActive((current) => current
      ? { ...current, messages: [...current.messages, optimistic] }
      : null);
    let trackedJob: AgentJob | null = null;
    let waitController: AbortController | null = null;
    try {
      const conversationId = requestConversationId;
      const reusableRequest = !forceNewRequest && retryRequest
        && retryRequest.message === message
        && retryRequest.conversationId === conversationId
        && retryRequest.model === model
        ? retryRequest
        : null;
      const requestId = reusableRequest?.requestId ?? `req_${crypto.randomUUID()}`;
      setRetryRequest({ message, conversationId, model, requestId });
      const endpoint = requestConversation
        ? `/api/commerce/conversations/${encodeURIComponent(requestConversation.id)}/messages`
        : '/api/commerce/conversations';
      const body = requestConversation
        ? { message, requestId }
        : { message, requestId, model };
      const response = await api<{ job: AgentJob }>(endpoint, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      trackedJob = response.job;
      rememberActiveJob(response.job);
      waitController = new AbortController();
      waitAbortRef.current = waitController;
      setWaitingJobId(response.job.id);
      const result = await waitForAgentJob(response.job, (status) => {
        if (isConversationStillSelected(activeConversationIdRef.current, requestConversationId)) {
          setJobStatus(status);
        }
      }, {
        signal: waitController.signal,
        onConnectionChange: setJobConnection,
      });
      let actionReviewWarning: string | null = null;
      if (actionReview) {
        if (!result.assistantMessage.runId) {
          actionReviewWarning = '复盘已生成，但缺少 Run ID，未能写入行动复盘记录。';
        } else {
          try {
            await api<{ receipt: { id: string } }>(
              `/api/commerce/conversations/${encodeURIComponent(actionReview.item.conversationId)}/messages/${encodeURIComponent(actionReview.item.messageId)}/actions/${encodeURIComponent(actionReview.item.actionId)}/reviews`,
              {
                method: 'POST',
                body: JSON.stringify({
                  runId: result.assistantMessage.runId,
                  reviewMessageId: result.assistantMessage.id,
                  question: actionReview.plan.question,
                  plan: actionReview.plan,
                  requestId: actionReview.requestId,
                }),
              },
            );
          } catch (caught) {
            actionReviewWarning = caught instanceof Error
              ? `复盘已生成，但行动关联记录保存失败：${caught.message}`
              : '复盘已生成，但行动关联记录保存失败。';
          }
        }
      }
      const next: Conversation = requestConversation
        ? {
            ...requestConversation,
            ...result.conversation,
            messages: [
              ...requestConversation.messages.filter((entry) => entry.id !== optimistic.id),
              result.userMessage,
              result.assistantMessage,
            ],
          }
        : {
            ...result.conversation,
            messages: [result.userMessage, result.assistantMessage],
          };
      if (isConversationStillSelected(activeConversationIdRef.current, requestConversationId)) {
        activeConversationIdRef.current = next.id;
        setActive(next);
      }
      setRetryRequest(null);
      forgetActiveJob(response.job.id);
      setConversations((current) => [
        result.conversation,
        ...current.filter((entry) => entry.id !== result.conversation.id),
      ]);
      if (actionReviewWarning) setError(actionReviewWarning);
      void refreshOpenActionCount();
    } catch (caught) {
      const failedConversationId = caught instanceof CommerceApiError
        ? caught.conversationId
        : caught instanceof CommerceJobWaitError
          ? caught.job.conversationId
          : null;
      if (failedConversationId) {
        try {
          const failed = await api<{ conversation: Conversation }>(
            `/api/commerce/conversations/${encodeURIComponent(failedConversationId)}`,
          );
          if (isConversationStillSelected(activeConversationIdRef.current, requestConversationId)) {
            activeConversationIdRef.current = failed.conversation.id;
            setActive(failed.conversation);
          }
          setConversations((current) => [
            failed.conversation,
            ...current.filter((entry) => entry.id !== failed.conversation.id),
          ]);
        } catch {
          // Keep the original execution error visible if reloading the durable run fails.
        }
      }
      if (isNonReplayableCommerceError(caught)) {
        setRetryRequest(null);
      }
      if (caught instanceof CommerceJobWaitError && caught.kind === 'terminal') {
        forgetActiveJob(caught.job.id);
      } else if (trackedJob) {
        rememberActiveJob(caught instanceof CommerceJobWaitError ? caught.job : trackedJob);
      }
      if (isConversationStillSelected(activeConversationIdRef.current, requestConversationId)) {
        if (!(caught instanceof CommerceJobWaitError && caught.kind === 'aborted')) {
          setDraft(message);
        }
        setActive((current) => current
          ? { ...current, messages: current.messages.filter((entry) => entry.id !== optimistic.id) }
          : current);
        if (!(caught instanceof CommerceJobWaitError && caught.kind === 'aborted')) {
          setError(caught instanceof Error ? caught.message : 'Agent 运行失败。');
        }
      }
    } finally {
      if (trackedJob) {
        const trackedJobId = trackedJob.id;
        setWaitingJobId((current) => (
          isJobWaitCurrent(current, trackedJobId) ? null : current
        ));
      }
      if (!waitController || waitAbortRef.current === waitController) {
        waitAbortRef.current = null;
        setSending(false);
        if (isConversationStillSelected(activeConversationIdRef.current, requestConversationId)) {
          setJobStatus(null);
        }
      }
    }
  }

  async function resumeJob(job: AgentJob) {
    if (waitAbortRef.current) return;
    setError(null);
    setSending(true);
    setJobStatus(job.status);
    setWaitingJobId(job.id);
    setJobConnection('connected');
    const controller = new AbortController();
    waitAbortRef.current = controller;
    try {
      const result = await waitForAgentJob(job, setJobStatus, {
        signal: controller.signal,
        onConnectionChange: setJobConnection,
      });
      forgetActiveJob(job.id);
      setRetryRequest((current) => current?.requestId === job.requestId ? null : current);
      const loaded = await api<{ conversation: Conversation }>(
        `/api/commerce/conversations/${encodeURIComponent(result.conversation.id)}`,
      );
      activeConversationIdRef.current = loaded.conversation.id;
      setActive(loaded.conversation);
      setConversations((current) => [
        result.conversation,
        ...current.filter((entry) => entry.id !== result.conversation.id),
      ]);
    } catch (caught) {
      if (caught instanceof CommerceJobWaitError && caught.kind === 'terminal') {
        forgetActiveJob(caught.job.id);
        setRetryRequest((current) => current?.requestId === job.requestId ? null : current);
        setDraft(recoveredJobDraft(job, caught.kind) ?? '');
        setError(`${caught.message} 已准备使用新的任务重新分析。`);
      } else if (!(caught instanceof CommerceJobWaitError && caught.kind === 'aborted')) {
        rememberActiveJob(caught instanceof CommerceJobWaitError ? caught.job : job);
        setError(caught instanceof Error ? caught.message : '恢复后台任务失败。');
      }
    } finally {
      if (waitAbortRef.current === controller) {
        waitAbortRef.current = null;
        setSending(false);
        setJobStatus(null);
      }
      setWaitingJobId((current) => isJobWaitCurrent(current, job.id) ? null : current);
    }
  }

  function stopWaiting() {
    waitAbortRef.current?.abort();
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const ready = bootstrap?.readiness.ready === true;
  const snapshotReady = ready && bootstrap?.readiness.dataStatus?.dataMode === 'snapshot';
  const sourceDisclosure = bootstrap?.readiness.dataStatus?.sourceDisclosure ?? null;
  const derivedFieldLabels = sourceDisclosure?.generatedFields
    .map((field) => DERIVED_FIELD_LABELS[field] ?? field)
    .join('、');
  const checkingReadiness = loading || (!bootstrap && !error);
  const initializationFailed = !loading && !bootstrap && Boolean(error);
  const starters = commerceStarters(
    bootstrap?.readiness.dataStatus ?? null,
    bootstrap?.agent.features?.diagnosticPolicyEnabled !== false,
  );

  const sidebarStatus: { label: string; tone: StatusTone } = snapshotReady
    ? { label: '历史快照可用', tone: 'warning' }
    : ready
      ? { label: '系统就绪', tone: 'success' }
      : checkingReadiness
        ? { label: '正在检查', tone: 'info' }
        : initializationFailed
          ? { label: '初始化失败', tone: 'error' }
          : { label: '等待配置', tone: 'warning' };

  const readinessChecklist: ReadinessChecklistItem[] = [
    {
      number: '01',
      label: '经营数据库',
      done: Boolean(
        bootstrap?.readiness.analyticsConfigured
        && bootstrap.readiness.checks?.analyticsSchema
        && bootstrap.readiness.checks.analyticsReadOnly
        && bootstrap.readiness.checks.analyticsRls
        && bootstrap.readiness.checks.analyticsDataPresent
        && bootstrap.readiness.checks.analyticsDataFresh
        && bootstrap.readiness.checks.analyticsSourceFresh !== false,
      ),
    },
    {
      number: '02',
      label: '会话数据库与 Worker',
      done: Boolean(
        bootstrap?.readiness.databaseConfigured
        && bootstrap.readiness.checks?.controlSchema
        && bootstrap.readiness.checks.workerActive,
      ),
    },
    { number: '03', label: '模型 Provider', done: Boolean(bootstrap?.readiness.modelConfigured) },
  ];

  return (
    <main className="flex h-screen overflow-hidden bg-[#F5F3FF] text-indigo-950">
      <Sidebar
        conversations={conversations}
        activeId={active?.id ?? null}
        onSelectConversation={(id) => void openConversation(id)}
        onNewConversation={startNewConversation}
        onOpenActions={() => setActionWorkbenchOpen(true)}
        actionCount={openActionCount}
        identityName={bootstrap?.identity.displayName ?? 'IDENTITY PENDING'}
        identityContext={bootstrap
          ? `${bootstrap.identity.authMode === 'development' ? '本地开发身份' : '可信身份代理'} · ${bootstrap.identity.tenantId}`
          : '正在验证身份'}
        status={sidebarStatus}
      />

      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[#F5F3FF]">
        <ChatHeader
          title={active?.title ?? '新的经营问题'}
          subtitle={`${active ? active.model : bootstrap?.agent.models[0] ?? model} · PostgreSQL read-only · ${
            bootstrap?.readiness.dataStatus?.dataMode === 'snapshot' ? '历史快照' : '增量数据'
          }`}
          evidenceCount={traces.length}
          onOpenConversations={() => setMobilePanel('conversations')}
          onOpenEvidence={() => setMobilePanel('evidence')}
          onOpenActions={() => setActionWorkbenchOpen(true)}
          actionCount={openActionCount}
          onOpenFeedbackReview={bootstrap?.identity.scopes.includes('commerce:feedback:review')
            ? () => setFeedbackReviewOpen(true)
            : undefined}
        />

        {bootstrap?.identity.authMode === 'development' ? (
          <div className="flex items-start gap-2 border-b border-red-200 bg-red-50 px-4 py-2.5 text-xs leading-5 text-red-900 sm:px-6">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
            <span>
              开发鉴权绕过已开启，仅允许当前电脑访问；生产环境必须由可信身份代理注入用户、租户和
              commerce:data:read 权限。
            </span>
          </div>
        ) : null}

        {ready && bootstrap.readiness.warnings.length ? (
          <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-5 text-amber-900 sm:px-6">
            <Database className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <span>{bootstrap.readiness.warnings[0]}</span>
          </div>
        ) : null}

        {ready && sourceDisclosure ? (
          <div className="flex items-start gap-2 border-b border-sky-200 bg-sky-50 px-4 py-2.5 text-xs leading-5 text-sky-950 sm:px-6">
            <Database className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
            <span>
              <strong>公开演示数据披露：</strong>
              支付订单与 GMV 日总量来自固定的 Olist 公开快照；
              {derivedFieldLabels || '钻取字段'}为 seed {sourceDisclosure.fixtureSeed ?? '未声明'}
              的确定性演示派生字段，不是 Olist 原始观测，也不代表真实商户。
              来源 {sourceDisclosure.sourceId} · {sourceDisclosure.licenseId} · revision{' '}
              {sourceDisclosure.sourceRevision.slice(0, 12)}。
            </span>
          </div>
        ) : null}

        {ready ? (
          <ActiveJobsPanel
            jobs={activeJobs}
            waitingJobId={waitingJobId}
            connection={jobConnection}
            onResume={(job) => void resumeJob(job)}
            onStopWaiting={stopWaiting}
          />
        ) : null}

        <div className="min-h-0 flex-1 overflow-y-auto" tabIndex={0} aria-label="对话内容">
          {loading ? (
            <div className="grid min-h-[520px] place-items-center">
              <div className="text-center text-sm text-violet-500">
                <LoaderCircle className="mx-auto mb-3 h-6 w-6 animate-spin text-violet-500" />
                正在校验生产依赖
              </div>
            </div>
          ) : !ready ? (
            <ReadinessGate issues={bootstrap?.readiness.issues ?? [error ?? '无法读取 readiness。']} checklist={readinessChecklist} />
          ) : active?.messages.length ? (
            <MessageList
              conversationId={active.id}
              messages={active.messages}
              sending={sending}
              jobStatus={jobStatus}
              onFollowUp={setDraft}
              onActionChange={applyActionState}
              onEvidenceNavigate={navigateToEvidence}
              onRetryFailed={(message) => void send(undefined, message, true)}
              endRef={endRef}
            />
          ) : (
            <WelcomeScreen
              starters={starters}
              dataStatus={bootstrap?.readiness.dataStatus ?? null}
              onPickStarter={setDraft}
            />
          )}
        </div>

        <Composer
          draft={draft}
          onDraftChange={setDraft}
          onKeyDown={onComposerKeyDown}
          onSubmit={(event) => void send(event)}
          sending={sending}
          ready={ready}
          error={error}
          isNewConversation={!active}
          model={model}
          availableModels={bootstrap?.agent.models ?? []}
          onModelChange={setModel}
        />
      </section>

      <EvidenceRail
        traces={traces}
        claims={evidenceClaims}
        pending={sending ? { jobStatus } : null}
        currencyCode={bootstrap?.readiness.dataStatus?.currencyCode ?? undefined}
      />

      {mobilePanel === 'conversations' ? (
        <MobileConversationsPanel
          conversations={conversations}
          activeId={active?.id ?? null}
          onSelect={(id) => void openConversation(id)}
          onNewConversation={startNewConversation}
          onClose={() => setMobilePanel(null)}
        />
      ) : null}
      {mobilePanel === 'evidence' ? (
        <MobileEvidencePanel
          traces={traces}
          claims={evidenceClaims}
          pending={sending ? { jobStatus } : null}
          currencyCode={bootstrap?.readiness.dataStatus?.currencyCode ?? undefined}
          onClose={() => setMobilePanel(null)}
        />
      ) : null}
      <FeedbackReviewPanel open={feedbackReviewOpen} onClose={() => setFeedbackReviewOpen(false)} />
      <ActionWorkbenchPanel
        open={actionWorkbenchOpen}
        businessTimeZone={bootstrap?.readiness.dataStatus?.businessTimezone ?? null}
        dataStatus={bootstrap?.readiness.dataStatus ?? null}
        onClose={() => setActionWorkbenchOpen(false)}
        onOpenConversation={(conversationId, messageId) => void openActionSource(conversationId, messageId)}
        onReview={(item, question) => void reviewCompletedAction(item, question)}
        onOpenCountChange={setOpenActionCount}
        onActionChange={applyActionState}
      />
    </main>
  );
}

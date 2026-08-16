'use client';

import { useCallback, useEffect, useState } from 'react';
import { Flag, LoaderCircle, X } from 'lucide-react';

import { Button } from '@/components/ui/Button';
import type {
  ApiEnvelope,
  ConversationMessage,
  EvidenceClaim,
  FeedbackCategory,
  FeedbackOwnerStatus,
  FeedbackStatus,
} from './types';

const OPTIONS: Array<{ value: FeedbackCategory; label: string }> = [
  { value: 'wrong_date', label: '日期范围不对' },
  { value: 'wrong_metric', label: '指标理解不对' },
  { value: 'data_issue', label: '数据可能有问题' },
  { value: 'unhelpful_recommendation', label: '运营建议没有帮助' },
  { value: 'other', label: '其他问题' },
];

type FeedbackResponse = ApiEnvelope<{
  feedback: {
    id: string;
    conversationId: string;
    messageId: string;
    category: FeedbackCategory;
    status: 'received';
    createdAt: string;
  };
}>;

type FeedbackStatusResponse = ApiEnvelope<{ feedback: FeedbackOwnerStatus | null }>;

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  received: '已收到',
  reviewed: '已审阅',
  correction_requested: '等待纠正',
  correction_enqueued: '纠正中',
  correction_completed: '纠正完成',
  correction_failed: '纠正失败',
  resolved: '已解决',
  dismissed: '未采纳',
};

const JOB_STATUS_LABELS: Record<NonNullable<FeedbackOwnerStatus['correctionJobStatus']>, string> = {
  queued: '排队中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  dead_letter: '终止',
};

const ACTIVE_FEEDBACK_STATUSES = new Set<FeedbackStatus>([
  'received',
  'reviewed',
  'correction_requested',
  'correction_enqueued',
]);

function statusTone(status: FeedbackStatus): string {
  if (status === 'resolved' || status === 'correction_completed') {
    return 'border-emerald-200 bg-emerald-50 text-emerald-800';
  }
  if (status === 'dismissed' || status === 'correction_failed') {
    return 'border-red-200 bg-red-50 text-red-800';
  }
  if (status === 'correction_requested' || status === 'correction_enqueued') {
    return 'border-amber-200 bg-amber-50 text-amber-800';
  }
  return 'border-violet-200 bg-violet-50 text-violet-800';
}

function feedbackRequestId(): string {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `feedback:${suffix}`;
}

export function FeedbackControls({
  conversationId,
  message,
  claims,
}: {
  conversationId: string;
  message: ConversationMessage;
  claims: EvidenceClaim[];
}) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>('wrong_date');
  const [comment, setComment] = useState('');
  const [claimKey, setClaimKey] = useState('');
  const [requestId, setRequestId] = useState(feedbackRequestId);
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; message: string } | null>(null);
  const [feedbackStatus, setFeedbackStatus] = useState<FeedbackOwnerStatus | null>(null);

  const loadFeedbackStatus = useCallback(async (signal?: AbortSignal) => {
    const query = new URLSearchParams({ messageId: message.id });
    const response = await fetch(
      `/api/commerce/conversations/${encodeURIComponent(conversationId)}/feedback?${query}`,
      { cache: 'no-store', signal },
    );
    const payload = await response.json() as FeedbackStatusResponse;
    if (!response.ok || !payload.success) return;
    setFeedbackStatus(payload.feedback);
  }, [conversationId, message.id]);

  useEffect(() => {
    const controller = new AbortController();
    void loadFeedbackStatus(controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [loadFeedbackStatus]);

  useEffect(() => {
    if (!feedbackStatus || !ACTIVE_FEEDBACK_STATUSES.has(feedbackStatus.status)) return;
    const timer = window.setInterval(() => {
      void loadFeedbackStatus().catch(() => undefined);
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [feedbackStatus, loadFeedbackStatus]);

  if (!message.runId || message.runStatus !== 'completed') return null;
  const uniqueClaims = Array.from(new Map(
    claims.map((claim) => [`${claim.evidenceId}\u0000${claim.path}`, claim]),
  ).values());
  const selectedClaim = uniqueClaims.find(
    (claim) => `${claim.evidenceId}\u0000${claim.path}` === claimKey,
  );

  async function submit() {
    setSubmitting(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/commerce/conversations/${encodeURIComponent(conversationId)}/feedback`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: message.id,
            runId: message.runId,
            ...(selectedClaim ? {
              evidenceId: selectedClaim.evidenceId,
              claimPath: selectedClaim.path,
            } : {}),
            category,
            ...(comment.trim() ? { comment: comment.trim() } : {}),
            requestId,
          }),
        },
      );
      const payload = await response.json() as FeedbackResponse;
      if (!response.ok || !payload.success) {
        throw new Error(payload.success ? '反馈提交失败。' : payload.message);
      }
      setFeedbackStatus({
        id: payload.feedback.id,
        conversationId: payload.feedback.conversationId,
        messageId: payload.feedback.messageId,
        category: payload.feedback.category,
        status: payload.feedback.status,
        version: 0,
        reviewNote: null,
        correctionJobId: null,
        correctionJobStatus: null,
        correctionRunId: null,
        createdAt: payload.feedback.createdAt,
        updatedAt: payload.feedback.createdAt,
      });
      setNotice({
        tone: 'success',
        message: '反馈已记录并进入人工审核；原回答尚未自动修改。',
      });
      setOpen(false);
    } catch (error) {
      setNotice({
        tone: 'error',
        message: error instanceof Error ? error.message : '反馈提交失败，请重试。',
      });
      // A transport failure can be safely retried with the same idempotency key. A semantic
      // failure may be corrected by changing form values, which gets a new key below.
    } finally {
      setSubmitting(false);
    }
  }

  function changeCategory(value: FeedbackCategory) {
    setCategory(value);
    setRequestId(feedbackRequestId());
    setNotice(null);
  }

  function changeComment(value: string) {
    setComment(value.slice(0, 1_000));
    setRequestId(feedbackRequestId());
    setNotice(null);
  }

  return (
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen((value) => !value);
            setNotice(null);
          }}
          aria-expanded={open}
        >
          {open ? <X className="h-3.5 w-3.5" /> : <Flag className="h-3.5 w-3.5" />}
          {open ? '取消' : '这条回答有问题'}
        </Button>
        {notice ? (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={`text-xs ${notice.tone === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
          >
            {notice.message}
          </p>
        ) : null}
      </div>

      {feedbackStatus ? (
        <div className={`mt-2 rounded-md border px-3 py-2 text-xs ${statusTone(feedbackStatus.status)}`}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-semibold">反馈状态：{STATUS_LABELS[feedbackStatus.status]}</span>
            <time dateTime={feedbackStatus.updatedAt} className="opacity-70">
              {new Date(feedbackStatus.updatedAt).toLocaleString('zh-CN')}
            </time>
          </div>
          {feedbackStatus.reviewNote ? (
            <p className="mt-1 whitespace-pre-wrap leading-5">审核备注：{feedbackStatus.reviewNote}</p>
          ) : null}
          {feedbackStatus.correctionJobId ? (
            <p className="mt-1 break-all opacity-80">
              纠正任务：{feedbackStatus.correctionJobStatus
                ? JOB_STATUS_LABELS[feedbackStatus.correctionJobStatus]
                : '状态同步中'} · {feedbackStatus.correctionJobId}
            </p>
          ) : null}
          {feedbackStatus.correctionRunId ? (
            <p className="mt-1 break-all opacity-80">纠正 Run：{feedbackStatus.correctionRunId}</p>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="mt-3 rounded-xl border border-violet-100 bg-violet-50/60 p-3">
          <p className="text-xs font-semibold text-indigo-900">反馈这条回答</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {OPTIONS.map((option) => (
              <label
                key={option.value}
                className={`cursor-pointer rounded-lg border px-2.5 py-1.5 text-xs transition ${
                  category === option.value
                    ? 'border-violet-400 bg-white text-violet-800'
                    : 'border-violet-100 bg-white/60 text-indigo-600 hover:border-violet-300'
                }`}
              >
                <input
                  className="sr-only"
                  type="radio"
                  name={`feedback-category-${message.id}`}
                  value={option.value}
                  checked={category === option.value}
                  onChange={() => changeCategory(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
          {uniqueClaims.length ? (
            <label className="mt-3 block text-xs font-medium text-indigo-800">
              定位到具体数据点（选填）
              <select
                value={claimKey}
                onChange={(event) => {
                  setClaimKey(event.target.value);
                  setRequestId(feedbackRequestId());
                  setNotice(null);
                }}
                className="mt-1.5 w-full rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm font-normal text-indigo-900 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20"
              >
                <option value="">整条回答</option>
                {uniqueClaims.map((claim) => {
                  const key = `${claim.evidenceId}\u0000${claim.path}`;
                  return (
                    <option key={key} value={key}>
                      {claim.metric} · {claim.value} · {claim.evidenceId.slice(0, 11)} · {claim.path}
                    </option>
                  );
                })}
              </select>
            </label>
          ) : null}
          <label className="mt-3 block text-xs font-medium text-indigo-800">
            补充说明（选填，最多 1000 字）
            <textarea
              value={comment}
              maxLength={1_000}
              onChange={(event) => changeComment(event.target.value)}
              rows={3}
              className="mt-1.5 w-full resize-y rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm font-normal text-indigo-900 outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20"
              placeholder="例如：这里应该是上周一至周日，不是最近 7 天。"
            />
          </label>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-[11px] leading-4 text-violet-500">
              提交后进入人工审核，不会自动改写或重跑当前回答。
            </p>
            <Button type="button" size="sm" disabled={submitting} onClick={() => void submit()}>
              {submitting ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Flag className="h-3.5 w-3.5" />}
              {submitting ? '正在提交' : '提交反馈'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

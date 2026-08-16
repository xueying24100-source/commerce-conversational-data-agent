'use client';

import {
  CheckCircle2,
  ChevronRight,
  ClipboardCheck,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { api } from './client';
import type {
  FeedbackCategory,
  FeedbackReviewDetail,
  FeedbackReviewItem,
  FeedbackStatus,
} from './types';

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  received: '待审阅',
  reviewed: '已审阅',
  correction_requested: '等待入队',
  correction_enqueued: '纠正中',
  correction_completed: '纠正完成',
  correction_failed: '纠正失败',
  resolved: '已解决',
  dismissed: '已驳回',
};

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  wrong_date: '日期范围',
  wrong_metric: '指标理解',
  data_issue: '数据问题',
  unhelpful_recommendation: '运营建议',
  other: '其他',
};

type ReviewAction = 'review' | 'request_correction' | 'resolve' | 'dismiss';

function reviewRequestId(): string {
  const suffix = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `feedback-review:${suffix}`;
}

function actionOptions(status: FeedbackStatus): ReviewAction[] {
  if (status === 'received') return ['review', 'dismiss'];
  if (status === 'reviewed' || status === 'correction_failed') {
    return ['request_correction', 'dismiss'];
  }
  if (status === 'correction_completed') return ['resolve', 'request_correction', 'dismiss'];
  if (status === 'correction_requested' || status === 'correction_enqueued') return ['dismiss'];
  return [];
}

function statusTone(status: FeedbackStatus): string {
  if (status === 'resolved' || status === 'correction_completed') return 'bg-emerald-100 text-emerald-700';
  if (status === 'dismissed' || status === 'correction_failed') return 'bg-rose-100 text-rose-700';
  if (status === 'correction_enqueued' || status === 'correction_requested') return 'bg-amber-100 text-amber-700';
  return 'bg-violet-100 text-violet-700';
}

export function FeedbackReviewPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<FeedbackStatus | 'all'>('received');
  const [items, setItems] = useState<FeedbackReviewItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackReviewDetail | null>(null);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [submitting, setSubmitting] = useState<ReviewAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ limit: '50' });
      if (status !== 'all') query.set('status', status);
      const response = await api<{ items: FeedbackReviewItem[]; nextCursor: string | null }>(
        `/api/commerce/feedback?${query.toString()}`,
      );
      setItems(response.items);
      setSelectedId((current) => (
        current && response.items.some((item) => item.id === current)
          ? current
          : response.items[0]?.id ?? null
      ));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取反馈队列失败。');
    } finally {
      setLoading(false);
    }
  }, [status]);

  const loadDetail = useCallback(async (feedbackId: string) => {
    setDetailLoading(true);
    setError(null);
    try {
      const response = await api<{ feedback: FeedbackReviewDetail }>(
        `/api/commerce/feedback/${encodeURIComponent(feedbackId)}`,
      );
      setDetail(response.feedback);
      setNote('');
    } catch (caught) {
      setDetail(null);
      setError(caught instanceof Error ? caught.message : '读取反馈详情失败。');
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void loadQueue();
  }, [open, loadQueue]);

  useEffect(() => {
    if (!open || !selectedId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedId);
  }, [loadDetail, open, selectedId]);

  useEffect(() => {
    if (!open) return undefined;
    const previousOverflow = document.body.style.overflow;
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', escape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', escape);
    };
  }, [onClose, open]);

  async function applyAction(action: ReviewAction) {
    if (!detail) return;
    setSubmitting(action);
    setError(null);
    try {
      await api<{ event: unknown }>(
        `/api/commerce/feedback/${encodeURIComponent(detail.id)}/events`,
        {
          method: 'POST',
          body: JSON.stringify({
            action,
            expectedVersion: detail.version,
            requestId: reviewRequestId(),
            ...(note.trim() ? { note: note.trim() } : {}),
          }),
        },
      );
      await Promise.all([loadQueue(), loadDetail(detail.id)]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '审核操作失败。');
    } finally {
      setSubmitting(null);
    }
  }

  if (!open) return null;
  const actions = detail ? actionOptions(detail.status) : [];

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="关闭反馈审核" onClick={onClose} className="absolute inset-0 bg-indigo-950/45" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="feedback-review-title"
        className="absolute inset-y-0 right-0 flex w-full max-w-5xl flex-col bg-[#F5F3FF] shadow-2xl"
      >
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-violet-100 bg-white px-4 sm:px-6">
          <div className="min-w-0">
            <h2 id="feedback-review-title" className="flex items-center gap-2 text-sm font-semibold text-indigo-950">
              <ClipboardCheck className="h-4 w-4 text-violet-500" /> 回答反馈审核
            </h2>
            <p className="mt-0.5 text-xs text-violet-500">{items.length} 条当前筛选结果</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="刷新审核队列"
              title="刷新审核队列"
              onClick={() => void loadQueue()}
              className="grid h-9 w-9 place-items-center rounded-md border border-violet-200 bg-white text-violet-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              className="grid h-9 w-9 place-items-center rounded-md border border-violet-200 bg-white text-violet-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[320px_minmax(0,1fr)]">
          <section className="flex min-h-0 flex-col border-b border-violet-100 bg-white md:border-b-0 md:border-r">
            <div className="border-b border-violet-100 p-3">
              <label className="text-xs font-medium text-indigo-800">
                状态
                <select
                  value={status}
                  onChange={(event) => setStatus(event.target.value as FeedbackStatus | 'all')}
                  className="mt-1.5 w-full rounded-md border border-violet-200 bg-white px-3 py-2 text-sm text-indigo-900 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20"
                >
                  <option value="received">待审阅</option>
                  <option value="reviewed">已审阅</option>
                  <option value="correction_enqueued">纠正中</option>
                  <option value="correction_completed">纠正完成</option>
                  <option value="correction_failed">纠正失败</option>
                  <option value="resolved">已解决</option>
                  <option value="dismissed">已驳回</option>
                  <option value="all">全部</option>
                </select>
              </label>
            </div>
            <div className="min-h-[180px] flex-1 overflow-y-auto p-2">
              {loading ? (
                <div className="grid h-32 place-items-center text-sm text-violet-500">
                  <LoaderCircle className="h-5 w-5 animate-spin" />
                </div>
              ) : items.length ? items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setSelectedId(item.id)}
                  className={`mb-1.5 flex w-full items-start gap-2 rounded-md border p-3 text-left transition ${
                    selectedId === item.id
                      ? 'border-violet-300 bg-violet-50'
                      : 'border-transparent bg-white hover:border-violet-100 hover:bg-violet-50/50'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-semibold text-indigo-900">{CATEGORY_LABELS[item.category]}</span>
                      <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${statusTone(item.status)}`}>
                        {STATUS_LABELS[item.status]}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-indigo-700">{item.comment ?? item.question ?? item.answer}</p>
                    <p className="mt-1 text-[10px] text-violet-400">{item.userId}</p>
                  </div>
                  <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-violet-300" />
                </button>
              )) : (
                <div className="grid h-32 place-items-center text-sm text-violet-500">当前没有反馈</div>
              )}
            </div>
          </section>

          <section className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {detailLoading ? (
              <div className="grid min-h-64 place-items-center text-violet-500"><LoaderCircle className="h-6 w-6 animate-spin" /></div>
            ) : detail ? (
              <div className="mx-auto max-w-3xl space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2 py-1 text-xs font-semibold ${statusTone(detail.status)}`}>
                    {STATUS_LABELS[detail.status]}
                  </span>
                  <span className="text-xs text-violet-500">版本 {detail.version}</span>
                  <span className="text-xs text-violet-500">{CATEGORY_LABELS[detail.category]}</span>
                </div>

                <div className="border-l-2 border-violet-400 bg-white p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-500">原问题</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-indigo-900">{detail.question ?? '未找到原问题'}</p>
                </div>
                <div className="border-l-2 border-indigo-400 bg-white p-4">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-indigo-500">原回答</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-indigo-800">{detail.answer}</p>
                </div>
                <div className="bg-white p-4">
                  <p className="text-xs font-semibold text-indigo-900">用户反馈</p>
                  <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-indigo-700">{detail.comment ?? '未填写补充说明'}</p>
                  {detail.claimPath ? (
                    <p className="mt-2 break-all text-xs text-violet-500">{detail.evidenceId} · {detail.claimPath}</p>
                  ) : null}
                </div>

                {detail.evidence ? (
                  <details className="bg-white p-4">
                    <summary className="cursor-pointer text-xs font-semibold text-indigo-900">目标 Evidence</summary>
                    <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-indigo-950 p-3 text-[11px] leading-5 text-violet-100">
                      {JSON.stringify(detail.evidence.preview, null, 2)}
                    </pre>
                  </details>
                ) : null}

                {detail.events.length ? (
                  <div className="bg-white p-4">
                    <p className="text-xs font-semibold text-indigo-900">审核记录</p>
                    <div className="mt-3 space-y-3">
                      {detail.events.map((event) => (
                        <div key={event.id} className="border-l border-violet-200 pl-3 text-xs">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold text-indigo-800">{STATUS_LABELS[event.status]}</span>
                            <span className="text-violet-400">{event.actorDisplayName}</span>
                            <span className="text-violet-400">{new Date(event.createdAt).toLocaleString('zh-CN')}</span>
                          </div>
                          {event.note ? <p className="mt-1 whitespace-pre-wrap leading-5 text-indigo-600">{event.note}</p> : null}
                          {event.jobId ? <p className="mt-1 break-all text-violet-500">Job: {event.jobId}</p> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {actions.length ? (
                  <div className="border-t border-violet-100 pt-4">
                    <label className="block text-xs font-medium text-indigo-800">
                      审核备注（选填）
                      <textarea
                        value={note}
                        maxLength={1_000}
                        rows={3}
                        onChange={(event) => setNote(event.target.value)}
                        className="mt-1.5 w-full resize-y rounded-md border border-violet-200 bg-white px-3 py-2 text-sm font-normal text-indigo-900 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/20"
                      />
                    </label>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {actions.includes('review') ? (
                        <Button size="sm" onClick={() => void applyAction('review')} disabled={Boolean(submitting)}>
                          {submitting === 'review' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ClipboardCheck className="h-4 w-4" />}
                          标记已审阅
                        </Button>
                      ) : null}
                      {actions.includes('request_correction') ? (
                        <Button size="sm" onClick={() => void applyAction('request_correction')} disabled={Boolean(submitting)}>
                          {submitting === 'request_correction' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                          请求纠正
                        </Button>
                      ) : null}
                      {actions.includes('resolve') ? (
                        <Button size="sm" onClick={() => void applyAction('resolve')} disabled={Boolean(submitting)}>
                          {submitting === 'resolve' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                          标记已解决
                        </Button>
                      ) : null}
                      {actions.includes('dismiss') ? (
                        <Button size="sm" variant="danger" onClick={() => void applyAction('dismiss')} disabled={Boolean(submitting)}>
                          {submitting === 'dismiss' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <XCircle className="h-4 w-4" />}
                          驳回
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="grid min-h-64 place-items-center text-sm text-violet-500">选择一条反馈查看详情</div>
            )}
            {error ? <p role="alert" className="mx-auto mt-4 max-w-3xl text-sm text-rose-700">{error}</p> : null}
          </section>
        </div>
      </aside>
    </div>
  );
}

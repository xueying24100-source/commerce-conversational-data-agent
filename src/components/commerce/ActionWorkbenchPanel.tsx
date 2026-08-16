'use client';

import {
  ArrowUpRight,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  History,
  LineChart,
  LoaderCircle,
  RefreshCw,
  Target,
  UserRound,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ActionProgressControls } from './ActionProgressControls';
import { api, buildActionReviewPlan, type ActionReviewPlan } from './client';
import type { ActionListFilter, ActionListItem, ActionState, ActionStatus, Readiness } from './types';

const STATUS_LABELS: Record<ActionStatus, string> = {
  proposed: '待确认',
  confirmed: '已确认',
  in_progress: '执行中',
  blocked: '已阻塞',
  completed: '已完成',
  reopened: '已重开',
  reviewed: '已复盘',
  ignored: '已忽略',
  cancelled: '已取消',
};

const OWNER_LABELS: Record<NonNullable<ActionListItem['ownerRole']>, string> = {
  operations: '运营',
  growth: '增长',
  merchandising: '商品',
  finance: '财务',
  customer_service: '售后',
  supply_chain: '供应链',
  data: '数据',
};

const FILTERS: Array<{ value: ActionListFilter; label: string }> = [
  { value: 'open', label: '未完成' },
  { value: 'proposed', label: '待确认' },
  { value: 'confirmed', label: '已确认' },
  { value: 'in_progress', label: '执行中' },
  { value: 'blocked', label: '已阻塞' },
  { value: 'completed', label: '已完成' },
  { value: 'reviewed', label: '已复盘' },
  { value: 'ignored', label: '已忽略' },
  { value: 'cancelled', label: '已取消' },
];

function today(timeZone: string | null): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function priorityTone(priority: ActionListItem['priority']): string {
  if (priority === 'high') return 'bg-rose-100 text-rose-700';
  if (priority === 'medium') return 'bg-amber-100 text-amber-700';
  return 'bg-violet-100 text-violet-700';
}

export function ActionWorkbenchPanel({
  open,
  businessTimeZone,
  dataStatus,
  onClose,
  onOpenConversation,
  onReview,
  onOpenCountChange,
  onActionChange,
}: {
  open: boolean;
  businessTimeZone: string | null;
  dataStatus: Readiness['dataStatus'];
  onClose: () => void;
  onOpenConversation: (conversationId: string, messageId: string) => void;
  onReview: (item: ActionListItem, plan: ActionReviewPlan) => void;
  onOpenCountChange: (count: number) => void;
  onActionChange: (messageId: string, state: ActionState) => void;
}) {
  const [filter, setFilter] = useState<ActionListFilter>('open');
  const [items, setItems] = useState<ActionListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadActions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api<{ actions: ActionListItem[] }>(
        `/api/commerce/actions?status=${encodeURIComponent(filter)}&limit=100`,
      );
      setItems(response.actions);
      if (filter === 'open') onOpenCountChange(response.actions.length);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取行动台失败。');
    } finally {
      setLoading(false);
    }
  }, [filter, onOpenCountChange]);

  useEffect(() => {
    if (open) void loadActions();
  }, [loadActions, open]);

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

  if (!open) return null;
  const businessToday = today(businessTimeZone);

  return (
    <div className="fixed inset-0 z-50">
      <button type="button" aria-label="关闭行动台" onClick={onClose} className="absolute inset-0 bg-indigo-950/45" />
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby="action-workbench-title"
        className="absolute inset-y-0 right-0 flex w-full max-w-3xl flex-col bg-[#F5F3FF] shadow-2xl"
      >
        <header className="flex min-h-16 shrink-0 items-center justify-between border-b border-violet-100 bg-white px-4 py-3 sm:px-6">
          <div className="min-w-0">
            <h2 id="action-workbench-title" className="flex items-center gap-2 text-sm font-semibold text-indigo-950">
              <ClipboardList className="h-4 w-4 text-violet-500" /> 运营行动台
            </h2>
            <p className="mt-0.5 text-xs text-violet-500">跨会话跟踪建议、负责人、截止日与执行进度</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="刷新行动台"
              title="刷新行动台"
              onClick={() => void loadActions()}
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

        <div className="flex flex-wrap gap-2 border-b border-violet-100 bg-white/70 px-4 py-3 sm:px-6">
          {FILTERS.map((candidate) => (
            <button
              key={candidate.value}
              type="button"
              onClick={() => setFilter(candidate.value)}
              className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 ${
                filter === candidate.value
                  ? 'border-violet-500 bg-violet-500 text-white'
                  : 'border-violet-200 bg-white text-indigo-700 hover:border-violet-300'
              }`}
            >
              {candidate.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
          {loading && !items.length ? (
            <div className="grid min-h-64 place-items-center text-violet-500"><LoaderCircle className="h-6 w-6 animate-spin" /></div>
          ) : items.length ? (
            <div className="space-y-3">
              {items.map((item) => {
                const dueDate = item.commitment?.dueDate ?? item.deadline;
                const overdue = !['completed', 'reviewed', 'ignored', 'cancelled'].includes(item.status)
                  && Boolean(dueDate && dueDate < businessToday);
                const review = item.status === 'completed'
                  ? buildActionReviewPlan(item, dataStatus)
                  : null;
                return (
                  <article key={`${item.messageId}:${item.actionId}`} className="rounded-xl border border-violet-100 bg-white p-4 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${priorityTone(item.priority)}`}>
                            {item.priority === 'high' ? '高优先级' : item.priority === 'medium' ? '中优先级' : '常规'}
                          </span>
                          {overdue ? <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-semibold text-rose-700">已逾期</span> : null}
                          <span className="text-[10px] font-semibold text-violet-400">{STATUS_LABELS[item.status]}</span>
                        </div>
                        <h3 className="mt-2 text-sm font-semibold leading-6 text-indigo-950">{item.action}</h3>
                        <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-indigo-700">{item.rationale}</p>
                      </div>
                      {item.status === 'completed' ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-500" /> : null}
                    </div>

                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs text-violet-600">
                      {item.ownerRole ? <span className="inline-flex items-center gap-1"><UserRound className="h-3.5 w-3.5" /> {OWNER_LABELS[item.ownerRole]}负责人</span> : null}
                      {dueDate ? <span className={`inline-flex items-center gap-1 ${overdue ? 'font-semibold text-rose-700' : ''}`}><CalendarClock className="h-3.5 w-3.5" /> {dueDate}</span> : null}
                      {item.successMetric ? <span className="inline-flex items-center gap-1"><Target className="h-3.5 w-3.5" /> {item.successMetric.metric}</span> : null}
                    </div>

                    <ActionProgressControls
                      conversationId={item.conversationId}
                      messageId={item.messageId}
                      actionId={item.actionId}
                      initialState={item}
                      suggestedDueDate={item.deadline}
                      onChange={(state) => {
                        onActionChange(item.messageId, state);
                        void loadActions();
                      }}
                    />

                    {review?.status === 'ready' && review.question ? (
                      <button
                        type="button"
                        onClick={() => onReview(item, review)}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-indigo-700 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40"
                      >
                        <LineChart className="h-3.5 w-3.5" /> 复盘效果
                      </button>
                    ) : review ? (
                      <p className={`mt-3 text-xs ${review.status === 'waiting_data' ? 'text-amber-700' : 'text-violet-500'}`}>
                        {review.message}
                      </p>
                    ) : null}

                    {item.lastReview ? (
                      <button
                        type="button"
                        onClick={() => onOpenConversation(item.conversationId, item.lastReview!.messageId)}
                        className="mt-3 ml-2 inline-flex items-center gap-1.5 rounded-md border border-violet-200 bg-white px-3 py-2 text-xs font-semibold text-violet-700 hover:border-violet-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
                      >
                        <History className="h-3.5 w-3.5" /> 最近复盘
                      </button>
                    ) : null}

                    <button
                      type="button"
                      onClick={() => onOpenConversation(item.conversationId, item.messageId)}
                      className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-violet-600 hover:text-violet-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40"
                    >
                      来源：{item.conversationTitle} <ArrowUpRight className="h-3.5 w-3.5" />
                    </button>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="grid min-h-64 place-items-center rounded-xl border border-dashed border-violet-200 bg-white/50 px-6 text-center">
              <div>
                <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-500" />
                <p className="mt-3 text-sm font-semibold text-indigo-900">当前筛选下没有行动</p>
                <p className="mt-1 text-xs text-violet-500">与 Agent 分析经营问题后，可信建议会自动进入这里。</p>
              </div>
            </div>
          )}
          {error ? <p role="alert" className="mt-4 text-sm text-rose-700">{error}</p> : null}
        </div>
      </aside>
    </div>
  );
}

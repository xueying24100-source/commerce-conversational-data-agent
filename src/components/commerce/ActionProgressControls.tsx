'use client';

import {
  Ban,
  Bell,
  Check,
  CheckCircle2,
  CirclePause,
  LoaderCircle,
  Play,
  RotateCcw,
  Send,
  TimerReset,
  UserX,
  XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/Button';
import { api } from './client';
import type {
  ActionCommitment,
  ActionState,
  FeishuNotificationReceipt,
  TenantMember,
} from './types';

type ActionTransition = 'confirm' | 'ignore' | 'snooze' | 'start' | 'block' | 'resume' | 'complete' | 'cancel' | 'reopen' | 'review';

const STATUS_LABELS: Record<ActionState['status'], string> = {
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

const STATUS_TONES: Record<ActionState['status'], string> = {
  proposed: 'border-amber-200 bg-amber-50 text-amber-700',
  confirmed: 'border-violet-200 bg-violet-50 text-violet-700',
  in_progress: 'border-blue-200 bg-blue-50 text-blue-700',
  blocked: 'border-orange-200 bg-orange-50 text-orange-700',
  completed: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  reopened: 'border-sky-200 bg-sky-50 text-sky-700',
  reviewed: 'border-teal-200 bg-teal-50 text-teal-700',
  ignored: 'border-slate-200 bg-slate-100 text-slate-600',
  cancelled: 'border-slate-200 bg-slate-100 text-slate-600',
};

function blankCommitment(suggestedDueDate?: string | null): ActionCommitment {
  return {
    assignee: '',
    dueDate: suggestedDueDate ?? '',
    target: null,
    evaluationWindowDays: null,
  };
}

function defaultTransition(status: ActionState['status']): ActionTransition | null {
  if (status === 'proposed') return 'confirm';
  if (status === 'confirmed') return 'start';
  if (status === 'in_progress') return 'complete';
  if (status === 'blocked') return 'resume';
  if (status === 'completed') return 'reopen';
  if (status === 'reopened') return 'start';
  return null;
}

function needsNote(action: ActionTransition | null): boolean {
  return action === 'block' || action === 'complete' || action === 'cancel' || action === 'reopen' || action === 'review';
}

function actionLabel(action: ActionTransition): string {
  return {
    confirm: '确认行动',
    ignore: '忽略',
    snooze: '稍后提醒',
    start: '开始执行',
    block: '标记阻塞',
    resume: '恢复执行',
    complete: '标记完成',
    cancel: '取消行动',
    reopen: '重开行动',
    review: '完成复盘',
  }[action];
}

function actionIcon(action: ActionTransition, spinning: boolean) {
  if (spinning) return <LoaderCircle className="h-4 w-4 animate-spin" />;
  if (action === 'confirm') return <Check className="h-4 w-4" />;
  if (action === 'ignore') return <UserX className="h-4 w-4" />;
  if (action === 'snooze') return <TimerReset className="h-4 w-4" />;
  if (action === 'start' || action === 'resume') return <Play className="h-4 w-4" />;
  if (action === 'block') return <CirclePause className="h-4 w-4" />;
  if (action === 'cancel') return <Ban className="h-4 w-4" />;
  if (action === 'reopen') return <RotateCcw className="h-4 w-4" />;
  return <CheckCircle2 className="h-4 w-4" />;
}

function commitmentText(commitment: ActionCommitment): string {
  const target = commitment.target === null ? '' : `，目标 ${commitment.target}`;
  const window = commitment.evaluationWindowDays === null
    ? ''
    : `，${commitment.evaluationWindowDays} 天后评估`;
  return `${commitment.assignee} · 截止 ${commitment.dueDate}${target}${window}`;
}

export function ActionProgressControls({
  conversationId,
  messageId,
  actionId,
  initialState,
  suggestedDueDate,
  onChange,
}: {
  conversationId: string;
  messageId: string;
  actionId: string;
  initialState?: ActionState;
  suggestedDueDate?: string | null;
  onChange?: (state: ActionState) => void;
}) {
  const fallback = useMemo<ActionState>(() => ({
    actionId,
    status: 'proposed',
    version: 0,
    updatedAt: null,
    commitment: null,
    lastNote: null,
  }), [actionId]);
  const [state, setState] = useState<ActionState>(initialState ?? fallback);
  const [selectedAction, setSelectedAction] = useState<ActionTransition | null>(null);
  const [commitment, setCommitment] = useState<ActionCommitment>(
    initialState?.commitment ?? blankCommitment(suggestedDueDate),
  );
  const [note, setNote] = useState('');
  const [snoozeUntil, setSnoozeUntil] = useState('');
  const [members, setMembers] = useState<TenantMember[]>([]);
  const [selectedRecipient, setSelectedRecipient] = useState('');
  const [notification, setNotification] = useState<FeishuNotificationReceipt | null>(null);
  const [sendingNotification, setSendingNotification] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = initialState ?? fallback;
    setState(next);
    setCommitment(next.commitment ?? blankCommitment(suggestedDueDate));
    setSelectedAction(null);
    setNote('');
    setSnoozeUntil('');
  }, [fallback, initialState, suggestedDueDate]);

  useEffect(() => {
    if (!['proposed', 'confirmed'].includes(state.status)) return;
    let active = true;
    void api<{ members: TenantMember[] }>('/api/commerce/members')
      .then((response) => {
        if (!active) return;
        setMembers(response.members);
        const preferred = response.members.find((member) => member.memberId === state.commitment?.assignee)
          ?? response.members[0];
        if (preferred) setSelectedRecipient(preferred.memberId);
      })
      .catch(() => {
        if (active) setMembers([]);
      });
    return () => { active = false; };
  }, [state.commitment?.assignee, state.status]);

  const primary = defaultTransition(state.status);
  const action = selectedAction ?? primary;
  const requiresCommitment = action === 'confirm'
    || ((action === 'start' || action === 'resume' || action === 'reopen') && !state.commitment);
  const requiresNote = needsNote(action);
  const requiresSnooze = action === 'snooze';

  function choose(next: ActionTransition) {
    setError(null);
    setSelectedAction(next === primary ? null : next);
    if (next === 'reopen' && state.commitment) setCommitment(state.commitment);
  }

  async function applyTransition() {
    if (!action || submitting) return;
    if (requiresCommitment && (!commitment.assignee.trim() || !/^\d{4}-\d{2}-\d{2}$/u.test(commitment.dueDate))) {
      setError('请填写负责人和有效截止日。');
      return;
    }
    if (
      (commitment.target !== null && !Number.isFinite(commitment.target))
      || (commitment.evaluationWindowDays !== null
        && (!Number.isInteger(commitment.evaluationWindowDays)
          || commitment.evaluationWindowDays < 1
          || commitment.evaluationWindowDays > 365))
    ) {
      setError('目标必须是有效数字，评估周期必须是 1 至 365 天。');
      return;
    }
    if (requiresNote && !note.trim()) {
      setError('请填写本次执行备注。');
      return;
    }
    const snoozeInstant = requiresSnooze ? Date.parse(snoozeUntil) : Number.NaN;
    if (requiresSnooze && (!Number.isFinite(snoozeInstant) || snoozeInstant <= Date.now())) {
      setError('请选择晚于当前时间的提醒时间。');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const response = await api<{ actionState: ActionState }>(
        `/api/commerce/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/actions/${encodeURIComponent(actionId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            action,
            expectedVersion: state.version,
            requestId: `action:${crypto.randomUUID()}`,
            ...(requiresCommitment ? { commitment } : {}),
            ...(requiresNote ? { note: note.trim() } : {}),
            ...(requiresSnooze ? { snoozeUntil: new Date(snoozeInstant).toISOString() } : {}),
          }),
        },
      );
      setState(response.actionState);
      setCommitment(response.actionState.commitment ?? blankCommitment(suggestedDueDate));
      setNote('');
      setSnoozeUntil('');
      setSelectedAction(null);
      onChange?.(response.actionState);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '行动卡状态更新失败。');
    } finally {
      setSubmitting(false);
    }
  }

  async function sendFeishuNotification() {
    if (sendingNotification || state.status !== 'confirmed' || !selectedRecipient) return;
    setSendingNotification(true);
    setError(null);
    try {
      const response = await api<{ notification: FeishuNotificationReceipt }>(
        `/api/commerce/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/actions/${encodeURIComponent(actionId)}/notifications`,
        {
          method: 'POST',
          body: JSON.stringify({
            expectedActionVersion: state.version,
            recipientMemberId: selectedRecipient,
            requestId: `notification:${crypto.randomUUID()}`,
          }),
        },
      );
      setNotification(response.notification);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '飞书通知入队失败。');
    } finally {
      setSendingNotification(false);
    }
  }

  return (
    <div className="mt-3 border-t border-violet-100 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${STATUS_TONES[state.status]}`}>
          {STATUS_LABELS[state.status]}
        </span>
        {state.commitment ? (
          <span className="text-[11px] text-violet-600">承诺：{commitmentText(state.commitment)}</span>
        ) : null}
        {state.reminder?.status === 'snoozed' && state.reminder.snoozeUntil ? (
          <span className="inline-flex items-center gap-1 text-[11px] text-amber-700">
            <Bell className="h-3 w-3" /> {new Date(state.reminder.snoozeUntil).toLocaleString('zh-CN')} 再提醒
          </span>
        ) : null}
      </div>

      {state.lastNote ? (
        <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-600">
          最近备注：{state.lastNote}
        </p>
      ) : null}

      {action ? <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="secondary" onClick={() => void applyTransition()} disabled={submitting}>
          {actionIcon(action, submitting)}
          {actionLabel(action)}
        </Button>
        {state.status === 'proposed' ? (
          <>
            <Button type="button" size="sm" variant="ghost" onClick={() => choose('snooze')} disabled={submitting}>
              <TimerReset className="h-4 w-4" /> 稍后提醒
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => choose('ignore')} disabled={submitting}>
              <UserX className="h-4 w-4" /> 忽略
            </Button>
          </>
        ) : null}
        {state.status === 'confirmed' ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => choose('cancel')} disabled={submitting}>
            <XCircle className="h-4 w-4" /> 取消
          </Button>
        ) : null}
        {state.status === 'in_progress' ? (
          <>
            <Button type="button" size="sm" variant="ghost" onClick={() => choose('block')} disabled={submitting}>
              <CirclePause className="h-4 w-4" /> 阻塞
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => choose('cancel')} disabled={submitting}>
              <Ban className="h-4 w-4" /> 取消
            </Button>
          </>
        ) : null}
        {state.status === 'blocked' ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => choose('cancel')} disabled={submitting}>
            <Ban className="h-4 w-4" /> 取消
          </Button>
        ) : null}
      </div> : null}

      {state.status === 'confirmed' && members.length ? (
        <div className="mt-3 grid gap-2 border border-violet-100 bg-white/70 p-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <label className="text-xs font-medium text-indigo-900">
            飞书收件人
            <select
              value={selectedRecipient}
              onChange={(event) => setSelectedRecipient(event.target.value)}
              className="mt-1 block h-9 w-full border border-violet-200 bg-white px-2 text-sm font-normal text-indigo-950 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
            >
              {members.map((member) => (
                <option key={member.memberId} value={member.memberId}>{member.displayName}</option>
              ))}
            </select>
          </label>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => void sendFeishuNotification()}
            disabled={sendingNotification || Boolean(notification)}
          >
            {sendingNotification ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {notification ? '已入队' : '发送飞书'}
          </Button>
          {notification ? (
            <p className="text-[11px] text-emerald-700 sm:col-span-2">
              逻辑通知已入队 · {notification.recipientDisplayName} · {notification.status}
            </p>
          ) : null}
        </div>
      ) : null}

      {(requiresCommitment || requiresNote || requiresSnooze) ? (
        <div className="mt-3 grid gap-2 rounded-md border border-violet-100 bg-violet-50/50 p-3">
          {requiresCommitment ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-medium text-indigo-900">
                负责人
                {members.length ? (
                  <select
                    value={commitment.assignee}
                    onChange={(event) => setCommitment((current) => ({ ...current, assignee: event.target.value }))}
                    className="mt-1 block h-9 w-full rounded-md border border-violet-200 bg-white px-2 text-sm font-normal text-indigo-950 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
                  >
                    <option value="">选择租户成员</option>
                    {members.map((member) => (
                      <option key={member.memberId} value={member.memberId}>{member.displayName}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    value={commitment.assignee}
                    onChange={(event) => setCommitment((current) => ({ ...current, assignee: event.target.value }))}
                    placeholder="稳定成员 ID 或团队"
                    className="mt-1 block h-9 w-full rounded-md border border-violet-200 bg-white px-2 text-sm font-normal text-indigo-950 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
                  />
                )}
              </label>
              <label className="text-xs font-medium text-indigo-900">
                截止日
                <input
                  type="date"
                  value={commitment.dueDate}
                  onChange={(event) => setCommitment((current) => ({ ...current, dueDate: event.target.value }))}
                  className="mt-1 block h-9 w-full rounded-md border border-violet-200 bg-white px-2 text-sm font-normal text-indigo-950 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
                />
              </label>
              <label className="text-xs font-medium text-indigo-900">
                目标（可选）
                <input
                  type="number"
                  value={commitment.target ?? ''}
                  onChange={(event) => setCommitment((current) => ({ ...current, target: event.target.value === '' ? null : Number(event.target.value) }))}
                  className="mt-1 block h-9 w-full rounded-md border border-violet-200 bg-white px-2 text-sm font-normal text-indigo-950 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
                />
              </label>
              <label className="text-xs font-medium text-indigo-900">
                评估周期（天，可选）
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={commitment.evaluationWindowDays ?? ''}
                  onChange={(event) => setCommitment((current) => ({ ...current, evaluationWindowDays: event.target.value === '' ? null : Number(event.target.value) }))}
                  className="mt-1 block h-9 w-full rounded-md border border-violet-200 bg-white px-2 text-sm font-normal text-indigo-950 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
                />
              </label>
            </div>
          ) : null}
          {requiresNote ? (
            <label className="text-xs font-medium text-indigo-900">
              执行备注
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={2}
                placeholder="记录本次执行结果、阻塞原因或取消原因"
                className="mt-1 block w-full resize-y rounded-md border border-violet-200 bg-white px-2 py-1.5 text-sm font-normal leading-5 text-indigo-950 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
              />
            </label>
          ) : null}
          {requiresSnooze ? (
            <label className="text-xs font-medium text-indigo-900">
              再提醒时间
              <input
                type="datetime-local"
                value={snoozeUntil}
                onChange={(event) => setSnoozeUntil(event.target.value)}
                className="mt-1 block h-9 w-full rounded-md border border-violet-200 bg-white px-2 text-sm font-normal text-indigo-950 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-500/20"
              />
              <span className="mt-1 block text-[10px] font-normal text-violet-700">到期只在应用内重新展示，不会自动发送飞书。</span>
            </label>
          ) : null}
        </div>
      ) : null}
      {error ? <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p> : null}
    </div>
  );
}

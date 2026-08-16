import { createHash } from 'node:crypto';

import type { CommerceActionStatus } from './types';

export type CommerceActionLifecycleCommand =
  | 'confirm'
  | 'ignore'
  | 'snooze'
  | 'start'
  | 'block'
  | 'resume'
  | 'complete'
  | 'cancel'
  | 'reopen'
  | 'review';

export const COMMERCE_ACTION_TRANSITIONS: Readonly<Record<CommerceActionStatus, readonly CommerceActionLifecycleCommand[]>> = Object.freeze({
  proposed: ['confirm', 'ignore', 'snooze', 'cancel'],
  confirmed: ['start', 'cancel'],
  in_progress: ['block', 'complete', 'cancel'],
  blocked: ['resume', 'cancel'],
  completed: ['review', 'reopen', 'cancel'],
  reopened: ['start', 'cancel'],
  reviewed: [],
  ignored: [],
  cancelled: [],
});

export function canTransitionCommerceAction(
  status: CommerceActionStatus,
  command: CommerceActionLifecycleCommand,
): boolean {
  return COMMERCE_ACTION_TRANSITIONS[status].includes(command);
}

export function nextCommerceActionStatus(
  status: CommerceActionStatus,
  command: CommerceActionLifecycleCommand,
): CommerceActionStatus {
  if (!canTransitionCommerceAction(status, command)) {
    throw new Error(`Invalid commerce action transition: ${status} -> ${command}`);
  }
  if (command === 'snooze') return 'proposed';
  if (command === 'confirm') return 'confirmed';
  if (command === 'ignore') return 'ignored';
  if (command === 'start' || command === 'resume') return 'in_progress';
  if (command === 'block') return 'blocked';
  if (command === 'complete') return 'completed';
  if (command === 'cancel') return 'cancelled';
  if (command === 'reopen') return 'reopened';
  return 'reviewed';
}

export interface CommerceReminderState {
  version: number;
  status: 'none' | 'snoozed' | 'due' | 'cancelled';
  snoozeUntil: string | null;
}

export function updateCommerceReminder(input: {
  current: CommerceReminderState;
  command: 'snooze' | 'due' | 'cancel';
  snoozeUntil?: string;
  now?: Date;
}): CommerceReminderState {
  const now = input.now ?? new Date();
  if (input.command === 'snooze') {
    const due = Date.parse(input.snoozeUntil ?? '');
    if (!Number.isFinite(due) || due <= now.getTime()) {
      throw new Error('snoozeUntil must be a valid future instant.');
    }
    return {
      version: input.current.version + 1,
      status: 'snoozed',
      snoozeUntil: new Date(due).toISOString(),
    };
  }
  if (input.command === 'due') {
    if (input.current.status !== 'snoozed' || !input.current.snoozeUntil) return input.current;
    if (Date.parse(input.current.snoozeUntil) > now.getTime()) return input.current;
    return {
      version: input.current.version + 1,
      status: 'due',
      snoozeUntil: null,
    };
  }
  return {
    version: input.current.version + 1,
    status: 'cancelled',
    snoozeUntil: null,
  };
}

export type CommerceOutboxDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'delivered'
  | 'retryable'
  | 'delivery_unknown'
  | 'failed_permanent';

export type CommerceOutboxDeliveryEvent =
  | { type: 'claim' }
  | { type: 'delivered'; providerMessageId: string }
  | { type: 'retryable'; error: string }
  | { type: 'delivery_unknown'; error: string }
  | { type: 'failed_permanent'; error: string }
  | { type: 'retry' }
  | { type: 'reconciled_delivered'; providerMessageId: string }
  | { type: 'reconciled_absent' }
  | { type: 'operator_mark_delivered'; providerMessageId?: string };

export interface CommerceOutboxDeliveryState {
  status: CommerceOutboxDeliveryStatus;
  attempts: number;
  providerMessageId: string | null;
  lastError: string | null;
}

export function transitionCommerceOutboxDelivery(
  state: CommerceOutboxDeliveryState,
  event: CommerceOutboxDeliveryEvent,
): CommerceOutboxDeliveryState {
  const fail = (status: CommerceOutboxDeliveryStatus, error: string): CommerceOutboxDeliveryState => ({
    ...state,
    status,
    lastError: error.slice(0, 1_000),
  });
  if (event.type === 'claim') {
    if (state.status !== 'pending' && state.status !== 'retryable') throw new Error('Only pending/retryable deliveries can be claimed.');
    return { ...state, status: 'sending', attempts: state.attempts + 1, lastError: null };
  }
  if (event.type === 'delivered') {
    if (state.status !== 'sending') throw new Error('Only a sending delivery can be marked delivered.');
    return { ...state, status: 'delivered', providerMessageId: event.providerMessageId, lastError: null };
  }
  if (event.type === 'retryable') {
    if (state.status !== 'sending') throw new Error('Only a sending delivery can become retryable.');
    return fail('retryable', event.error);
  }
  if (event.type === 'delivery_unknown') {
    if (state.status !== 'sending') throw new Error('Only a sending delivery can become unknown.');
    return fail('delivery_unknown', event.error);
  }
  if (event.type === 'failed_permanent') {
    if (state.status !== 'sending') throw new Error('Only a sending delivery can fail permanently.');
    return fail('failed_permanent', event.error);
  }
  if (event.type === 'retry') {
    if (state.status !== 'retryable') throw new Error('Only retryable deliveries can return to sending.');
    return { ...state, status: 'sending', attempts: state.attempts + 1 };
  }
  if (event.type === 'reconciled_absent') {
    if (state.status !== 'delivery_unknown') throw new Error('Only unknown deliveries can be reconciled absent.');
    return { ...state, status: 'sending', attempts: state.attempts + 1 };
  }
  if (event.type === 'reconciled_delivered' || event.type === 'operator_mark_delivered') {
    if (state.status !== 'delivery_unknown') throw new Error('Only unknown deliveries can be reconciled delivered.');
    return {
      ...state,
      status: 'delivered',
      providerMessageId: event.providerMessageId ?? state.providerMessageId,
      lastError: null,
    };
  }
  return state;
}

function zonedParts(instant: Date, timeZone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  return Object.fromEntries(parts.flatMap((part) => (
    part.type === 'literal' ? [] : [[part.type, Number(part.value)]]
  )));
}

export function commerceLocalMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  let guess = Date.UTC(year, month - 1, day);
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const local = zonedParts(new Date(guess), timeZone);
    const representedAsUtc = Date.UTC(
      local.year!, local.month! - 1, local.day!, local.hour!, local.minute!, local.second!,
    );
    const targetAsUtc = Date.UTC(year, month - 1, day);
    const delta = targetAsUtc - representedAsUtc;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

function nextLocalDate(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  const local = zonedParts(instant, timeZone);
  const next = new Date(Date.UTC(local.year!, local.month! - 1, local.day! + 1));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

export interface CommerceEffectiveReviewWindow {
  completedAt: string;
  timezone: string;
  clockType: 'wall' | 'virtual';
  grain: 'instant' | 'day';
  effectiveReviewStart: string;
  effectiveReviewEnd: string;
  reviewAfterWatermark: string;
  windowHash: string;
}

export function effectiveCommerceReviewWindow(input: {
  completedAt: string;
  timezone: string;
  clockType: 'wall' | 'virtual';
  evaluationDurationDays: number;
  sourceGrain: 'instant' | 'day';
}): CommerceEffectiveReviewWindow {
  const completedAt = new Date(input.completedAt);
  if (!Number.isFinite(completedAt.getTime())) throw new Error('completedAt must be an ISO instant.');
  if (!Number.isInteger(input.evaluationDurationDays) || input.evaluationDurationDays < 1 || input.evaluationDurationDays > 365) {
    throw new Error('evaluationDurationDays must be an integer from 1 to 365.');
  }
  // Validate the IANA timezone before any schedule is written.
  zonedParts(completedAt, input.timezone);
  const start = input.sourceGrain === 'instant'
    ? completedAt
    : (() => {
        const next = nextLocalDate(completedAt, input.timezone);
        return commerceLocalMidnightUtc(next.year, next.month, next.day, input.timezone);
      })();
  const end = input.sourceGrain === 'instant'
    ? new Date(start.getTime() + input.evaluationDurationDays * 86_400_000)
    : (() => {
        const local = zonedParts(start, input.timezone);
        const target = new Date(Date.UTC(local.year!, local.month! - 1, local.day! + input.evaluationDurationDays));
        return commerceLocalMidnightUtc(
          target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate(), input.timezone,
        );
      })();
  const canonical = {
    completedAt: completedAt.toISOString(),
    timezone: input.timezone,
    clockType: input.clockType,
    grain: input.sourceGrain,
    effectiveReviewStart: start.toISOString(),
    effectiveReviewEnd: end.toISOString(),
    reviewAfterWatermark: end.toISOString(),
  };
  return {
    ...canonical,
    windowHash: `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`,
  };
}

export type CommerceReviewVerdict = 'met' | 'not_met' | 'insufficient_data' | 'guardrail_breached';

export function commerceReviewVerdict(input: {
  successMetricAvailable: boolean;
  successMetricMet: boolean;
  guardrails: readonly { available: boolean; breached: boolean }[];
}): CommerceReviewVerdict {
  if (!input.successMetricAvailable || input.guardrails.some((guardrail) => !guardrail.available)) {
    return 'insufficient_data';
  }
  if (input.guardrails.some((guardrail) => guardrail.breached)) return 'guardrail_breached';
  return input.successMetricMet ? 'met' : 'not_met';
}

export function canonicalWeeklyDiagnosisKey(input: {
  tenantId: string;
  objective: string;
  weekStart: string;
  weekEnd: string;
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(input)).digest('hex')}`;
}

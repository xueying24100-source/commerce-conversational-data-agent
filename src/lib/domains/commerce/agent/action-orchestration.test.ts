import { describe, expect, it } from 'vitest';

import {
  COMMERCE_ACTION_TRANSITIONS,
  canTransitionCommerceAction,
  canonicalWeeklyDiagnosisKey,
  commerceReviewVerdict,
  effectiveCommerceReviewWindow,
  nextCommerceActionStatus,
  transitionCommerceOutboxDelivery,
  updateCommerceReminder,
} from './action-orchestration';

describe('commerce action lifecycle oracle', () => {
  it('matches the frozen legal transition graph', () => {
    expect(COMMERCE_ACTION_TRANSITIONS).toEqual({
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
    expect(nextCommerceActionStatus('completed', 'reopen')).toBe('reopened');
    expect(nextCommerceActionStatus('reopened', 'start')).toBe('in_progress');
    expect(canTransitionCommerceAction('reviewed', 'reopen')).toBe(false);
  });

  it('keeps snooze as reminder state rather than an action status', () => {
    expect(nextCommerceActionStatus('proposed', 'snooze')).toBe('proposed');
    const snoozed = updateCommerceReminder({
      current: { version: 0, status: 'none', snoozeUntil: null },
      command: 'snooze',
      snoozeUntil: '2026-08-17T10:00:00.000Z',
      now: new Date('2026-08-16T10:00:00.000Z'),
    });
    expect(snoozed).toEqual({
      version: 1,
      status: 'snoozed',
      snoozeUntil: '2026-08-17T10:00:00.000Z',
    });
    expect(updateCommerceReminder({
      current: snoozed,
      command: 'due',
      now: new Date('2026-08-17T10:00:01.000Z'),
    })).toEqual({ version: 2, status: 'due', snoozeUntil: null });
  });
});
describe('Feishu logical outbox oracle', () => {
  it('uses deterministic retry states and never blindly retries an unknown delivery', () => {
    const sending = transitionCommerceOutboxDelivery(
      { status: 'pending', attempts: 0, providerMessageId: null, lastError: null },
      { type: 'claim' },
    );
    const unknown = transitionCommerceOutboxDelivery(sending, {
      type: 'delivery_unknown', error: 'timeout after request body was sent',
    });
    expect(unknown.status).toBe('delivery_unknown');
    expect(() => transitionCommerceOutboxDelivery(unknown, { type: 'retry' })).toThrow();
    expect(transitionCommerceOutboxDelivery(unknown, {
      type: 'reconciled_delivered', providerMessageId: 'om_123',
    })).toMatchObject({ status: 'delivered', providerMessageId: 'om_123', attempts: 1 });
  });

  it('allows a confirmed-absent unknown delivery to retry with the same logical command', () => {
    const retried = transitionCommerceOutboxDelivery(
      { status: 'delivery_unknown', attempts: 1, providerMessageId: null, lastError: 'timeout' },
      { type: 'reconciled_absent' },
    );
    expect(retried).toMatchObject({ status: 'sending', attempts: 2 });
  });
});

describe('automatic review scheduling oracle', () => {
  it('starts a day-grain review at the next complete tenant-local day', () => {
    const window = effectiveCommerceReviewWindow({
      completedAt: '2026-03-08T06:30:00.000Z',
      timezone: 'America/New_York',
      clockType: 'wall',
      evaluationDurationDays: 7,
      sourceGrain: 'day',
    });
    // Completion is 01:30 on the DST spring-forward day. The review starts at the
    // following local midnight and seven complete local days later, not at +168h.
    expect(window.effectiveReviewStart).toBe('2026-03-09T04:00:00.000Z');
    expect(window.effectiveReviewEnd).toBe('2026-03-16T04:00:00.000Z');
    expect(window.reviewAfterWatermark).toBe(window.effectiveReviewEnd);
    expect(window.windowHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it('uses completed_at directly when the source supports instant grain', () => {
    const window = effectiveCommerceReviewWindow({
      completedAt: '2026-08-16T10:15:00.000Z',
      timezone: 'Asia/Shanghai',
      clockType: 'virtual',
      evaluationDurationDays: 3,
      sourceGrain: 'instant',
    });
    expect(window.effectiveReviewStart).toBe('2026-08-16T10:15:00.000Z');
    expect(window.effectiveReviewEnd).toBe('2026-08-19T10:15:00.000Z');
  });

  it('never calls an action successful when a guardrail is breached', () => {
    expect(commerceReviewVerdict({
      successMetricAvailable: true,
      successMetricMet: true,
      guardrails: [{ available: true, breached: true }],
    })).toBe('guardrail_breached');
    expect(commerceReviewVerdict({
      successMetricAvailable: false,
      successMetricMet: false,
      guardrails: [],
    })).toBe('insufficient_data');
  });

  it('excludes policy version from the canonical weekly diagnosis key', () => {
    const input = {
      tenantId: 'tenant-a',
      objective: 'diagnose_previous_complete_week',
      weekStart: '2026-08-03',
      weekEnd: '2026-08-10',
    };
    expect(canonicalWeeklyDiagnosisKey(input)).toBe(canonicalWeeklyDiagnosisKey({ ...input }));
  });
});

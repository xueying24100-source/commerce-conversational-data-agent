import { z } from 'zod';

import {
  COMMERCE_MESSAGE_MAX_CHARS,
  COMMERCE_MESSAGE_MIN_CHARS,
} from './limits';
import type { CommerceSourceCapabilityMatrixV1 } from './source-adapter';

export const COMMERCE_METRICS = [
  'gmv',
  'net_revenue',
  'paid_orders',
  'units',
  'visits',
  'conversion_rate',
  'average_order_value',
  'refund_rate',
  'refund_amount',
  'gross_profit',
  'gross_margin',
  'ad_spend',
  'roas',
  'new_customers',
  'stockout_hours',
  'ending_inventory',
] as const;

export const COMMERCE_DIMENSIONS = [
  'region',
  'channel',
  'sku',
  'category',
] as const;

export type CommerceMetric = (typeof COMMERCE_METRICS)[number];
export type CommerceDimension = (typeof COMMERCE_DIMENSIONS)[number];

export const commerceMetricSchema = z.enum(COMMERCE_METRICS);
export const commerceDimensionSchema = z.enum(COMMERCE_DIMENSIONS);
export const commerceEvidenceUnitSchema = z.enum([
  'currency',
  'integer',
  'decimal',
  'percent',
  'hours',
]);

const dateTextSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, '日期必须使用 YYYY-MM-DD。');

function strictIsoDateTimestamp(value: string): number {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return Number.NaN;
  return new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp
    : Number.NaN;
}

const validDateTextSchema = dateTextSchema.superRefine((value, context) => {
  if (!Number.isFinite(strictIsoDateTimestamp(value))) {
    context.addIssue({ code: 'custom', message: '日期无效。' });
  }
});

export const commerceDateRangeSchema = z.object({
  start: dateTextSchema,
  end: dateTextSchema,
}).strict().superRefine((value, context) => {
  const start = strictIsoDateTimestamp(value.start);
  const end = strictIsoDateTimestamp(value.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) {
    context.addIssue({
      code: 'custom',
      message: '日期范围无效，start 必须早于或等于 end。',
    });
  }
  const days = Math.floor((end - start) / 86_400_000) + 1;
  if (days > 731) {
    context.addIssue({
      code: 'custom',
      message: '单次查询最多覆盖 731 天。',
    });
  }
});

const filterValues = z.array(z.string().trim().min(1).max(120)).max(50).default([]);

export const commerceFiltersSchema = z.object({
  regions: filterValues,
  channels: filterValues,
  skus: filterValues,
  categories: filterValues,
}).strict();

export type CommerceDateRange = z.infer<typeof commerceDateRangeSchema>;
export type CommerceFilters = z.infer<typeof commerceFiltersSchema>;

export const commerceQueryScopeMissingSlotSchema = z.enum([
  'metrics',
  'current_date_range',
  'baseline_date_range',
  'filters',
]);

export const commerceQueryAnalysisViewSchema = z.enum([
  'totals',
  'comparison',
  'breakdown',
  'trend',
  'inventory',
  'diagnostic_scan',
]);

export const commerceResolvedQueryScopeSchema = z.object({
  version: z.literal(2),
  status: z.enum(['ready', 'needs_clarification', 'refused']),
  sourceQuestionSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  queryScopeSha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  timezone: z.string().trim().min(1).max(120),
  referenceInstant: z.string().datetime(),
  referenceDate: dateTextSchema,
  objective: z.enum(['direct_query', 'weekly_diagnosis']),
  metricSelection: z.enum(['explicit', 'catalog_default']),
  metrics: z.array(commerceMetricSchema).max(COMMERCE_METRICS.length),
  current: commerceDateRangeSchema.nullable(),
  baseline: commerceDateRangeSchema.nullable(),
  filters: commerceFiltersSchema,
  executive: z.boolean(),
  dimensions: z.array(commerceDimensionSchema).max(COMMERCE_DIMENSIONS.length),
  requiredViews: z.array(commerceQueryAnalysisViewSchema).max(5),
  trendGrain: z.enum(['day', 'week', 'month']).nullable(),
  breakdownLimit: z.number().int().min(1).max(50).nullable(),
  breakdownSort: z.enum(['current_desc', 'change_asc', 'absolute_change_desc']).nullable(),
  missingSlots: z.array(commerceQueryScopeMissingSlotSchema).max(4),
  reasons: z.array(z.enum([
    'metric_unavailable',
    'mutation_or_sensitive_request',
    'range_outside_coverage',
    'ambiguous_date_range',
    'unresolved_filter',
    'unsupported_filter_logic',
    'invalid_timezone',
  ])).max(8),
}).strict();

export type CommerceQueryScopeMissingSlot = z.infer<typeof commerceQueryScopeMissingSlotSchema>;
export type CommerceQueryAnalysisView = z.infer<typeof commerceQueryAnalysisViewSchema>;
export type CommerceResolvedQueryScope = z.infer<typeof commerceResolvedQueryScopeSchema>;

export interface CommerceIdentity {
  tenantId: string;
  userId: string;
  displayName: string;
  scopes: string[];
  authMode: 'development' | 'trusted_proxy';
}

export interface CommerceMetricDefinition {
  id: CommerceMetric;
  label: string;
  format: 'currency' | 'integer' | 'decimal' | 'percent' | 'hours';
  description: string;
  aggregation: 'sum' | 'ratio_of_sums' | 'average_daily_total';
  additivity: 'additive' | 'source_allocated_additive' | 'non_additive' | 'semi_additive_time';
  additiveDimensions: CommerceDimension[];
}

export interface CommerceCatalogSource {
  /** Serving source id (the connector ownership key). */
  sourceId: string;
  upstreamSourceId: string;
  snapshotId: string;
  contractVersion: string;
  adapterId: string;
  adapterVersion: string;
  sourceKind: 'public_snapshot' | 'controlled_fixture' | 'production_connector';
  sourceUri: string;
  sourceRevision: string;
  sourceSha256: string;
  artifactSha256: string;
  license: { id: string; uri: string };
  fixtureSeed: number | null;
  lineage: {
    algorithm: string;
    algorithmVersion: string;
    generatedFields: string[];
    steps: string[];
  };
  capabilities: CommerceSourceCapabilityMatrixV1;
  virtualAsOf: string;
  sourceWatermark: string;
}

export interface CommerceCatalog {
  dataset: string;
  timezone: string;
  currencyCode: string;
  coverage: {
    start: string | null;
    end: string | null;
    lastIngestedAt: string | null;
    sourceUpdatedAt: string | null;
    /**
     * Controlled business instant used by immutable/replay snapshots. It is deliberately
     * separate from ingestion time so a historical fixture is never presented as "today".
     */
    virtualAsOf?: string | null;
    dataMode: 'snapshot' | 'incremental';
    rowCount: number;
  };
  metrics: CommerceMetricDefinition[];
  dimensions: Record<CommerceDimension, string[]>;
  /** Source Adapter provenance. Empty means the legacy connector has not published v1 metadata. */
  sources?: CommerceCatalogSource[];
}

export interface CommerceEvidenceReceipt<T = unknown> {
  evidenceId: string;
  operation: string;
  fetchedAt: string;
  rowCount: number;
  requestSha256: string;
  responseSha256: string;
  sourceQuestionSha256: string;
  queryScopeSha256: string;
  data: T;
}

export interface CommerceConversationSummary {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export const commerceEvidenceClaimSchema = z.object({
  evidenceId: z.string().trim().min(1).max(100),
  path: z.string().trim().min(2).max(240).startsWith('/'),
  metric: commerceMetricSchema,
  value: z.number().finite(),
  unit: commerceEvidenceUnitSchema,
}).strict();

export type CommerceEvidenceClaim = z.infer<typeof commerceEvidenceClaimSchema>;
export type CommerceEvidenceUnit = z.infer<typeof commerceEvidenceUnitSchema>;

export const commerceActionOwnerRoleSchema = z.enum([
  'operations',
  'growth',
  'merchandising',
  'finance',
  'customer_service',
  'supply_chain',
  'data',
]);

const commerceActionSuccessMetricSchema = z.object({
  metric: commerceMetricSchema,
  direction: z.enum(['increase', 'decrease', 'maintain']),
  baselineClaim: commerceEvidenceClaimSchema,
  target: z.number().finite().nullable(),
  targetUnit: commerceEvidenceUnitSchema,
  evaluationWindowDays: z.number().int().min(1).max(365).nullable(),
}).strict();

const commerceActionGuardrailSchema = z.object({
  metric: commerceMetricSchema,
  operator: z.enum(['not_above', 'not_below']),
  baselineClaim: commerceEvidenceClaimSchema,
  threshold: z.number().finite().nullable(),
  unit: commerceEvidenceUnitSchema,
}).strict();

export const commerceActionRecommendationSchema = z.object({
  action: z.string().trim().min(1).max(240),
  rationale: z.string().trim().min(1).max(1_500),
  claims: z.array(commerceEvidenceClaimSchema).max(12),
  // These fields are optional so persisted pre-P1 answers remain readable. New completed
  // answers are enriched by the Evidence Ledger, which ignores model-supplied commitments.
  id: z.string().regex(/^action_[a-f0-9]{24}$/u).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  ownerRole: commerceActionOwnerRoleSchema.optional(),
  deadline: dateTextSchema.nullable().optional(),
  successMetric: commerceActionSuccessMetricSchema.optional(),
  guardrails: z.array(commerceActionGuardrailSchema).max(4).optional(),
  status: z.literal('proposed').optional(),
}).strict();

export type CommerceActionRecommendation = z.infer<typeof commerceActionRecommendationSchema>;

export const commerceAgentAnswerSchema = z.object({
  status: z.enum(['answered', 'needs_clarification', 'refused']),
  answer: z.string().trim().min(1).max(8_000),
  answerClaims: z.array(commerceEvidenceClaimSchema).max(48),
  findings: z.array(z.object({
    metric: commerceMetricSchema,
    title: z.string().trim().min(1).max(160),
    detail: z.string().trim().min(1).max(1_500),
    claims: z.array(commerceEvidenceClaimSchema).max(12),
    insightLevel: z.enum(['observed', 'contribution', 'driver', 'hypothesis', 'unknown']).optional(),
    confidence: z.number().min(0).max(1).optional(),
    alternatives: z.array(z.string().trim().min(1).max(300)).max(4).optional(),
    contradictionStatus: z.enum(['clear', 'unresolved', 'contradicted']).optional(),
  }).strict()).max(12),
  recommendations: z.array(commerceActionRecommendationSchema).max(8),
  followUps: z.array(z.string().trim().min(1).max(240)).max(5),
  diagnostic: z.object({
    objective: z.literal('diagnose_previous_complete_week'),
    dataHealth: z.object({
      status: z.enum(['ready', 'degraded', 'blocked']),
      dataMode: z.enum(['snapshot', 'incremental']),
      sourceWatermark: z.string().datetime().nullable(),
      reasons: z.array(z.string().trim().min(1).max(120)).max(20),
    }).strict(),
    referenceDate: dateTextSchema,
    timezone: z.string().trim().min(1).max(120),
    baseline: z.object({
      strategy: z.enum([
        'explicit',
        'previous_four_complete_weeks_median',
        'available_complete_weeks_median',
        'previous_adjacent_period',
      ]),
      rationale: z.string().trim().min(1).max(500),
      comparisonRanges: z.array(commerceDateRangeSchema).min(1).max(4),
      confidence: z.enum(['high', 'medium', 'low']),
    }).strict(),
    stopReason: z.enum([
      'data_health_failed',
      'scope_unavailable',
      'no_material_anomaly',
      'evidence_sufficient',
      'budget_exhausted',
      'no_new_evidence',
      'timeout',
      'no_legal_candidate',
      'unknown',
    ]),
    driverGate: z.object({
      hypothesis: z.enum([
        'growth_driver',
        'traffic_drop',
        'conversion_drop',
        'aov_or_mix',
        'refund_spike',
        'stockout',
      ]),
      insightLevel: z.enum(['driver', 'hypothesis']),
      passed: z.boolean(),
      reasons: z.array(z.string().trim().min(1).max(120)).max(12),
      contributionMetric: z.enum(COMMERCE_METRICS).nullable().optional(),
      contributionShare: z.number().finite().nullable(),
      primaryRelativeChange: z.number().finite().nullable(),
      contributionResidualRatio: z.number().finite().nonnegative().nullable(),
      aggregateEvidenceId: z.string().trim().min(1).max(100),
      investigationEvidenceId: z.string().trim().min(1).max(100),
      structureChangeDetected: z.boolean(),
    }).strict().nullable(),
    unknowns: z.array(z.string().trim().min(1).max(300)).max(5),
    decisions: z.array(z.object({
      sequence: z.number().int().min(1).max(100),
      hypothesis: z.enum([
        'growth_driver',
        'traffic_drop',
        'conversion_drop',
        'aov_or_mix',
        'refund_spike',
        'stockout',
      ]).nullable(),
      chosenNextView: z.enum(['breakdown', 'trend', 'inventory']).nullable(),
      decisionCode: z.string().trim().min(1).max(120),
      stopReason: z.string().trim().min(1).max(120).nullable(),
      triggerEvidenceIds: z.array(z.string().trim().min(1).max(100)).max(20),
    }).strict()).max(12),
  }).strict().optional(),
}).strict();

export type CommerceAgentAnswer = z.infer<typeof commerceAgentAnswerSchema>;

export const COMMERCE_ACTION_STATUSES = [
  'proposed',
  'confirmed',
  'in_progress',
  'blocked',
  'completed',
  'reopened',
  'reviewed',
  'ignored',
  'cancelled',
] as const;

export type CommerceActionStatus = typeof COMMERCE_ACTION_STATUSES[number];

export const commerceActionCommitmentSchema = z.object({
  assignee: z.string().trim().min(1).max(160),
  dueDate: validDateTextSchema,
  target: z.number().finite().nullable(),
  evaluationWindowDays: z.number().int().min(1).max(365).nullable(),
}).strict();

export type CommerceActionCommitment = z.infer<typeof commerceActionCommitmentSchema>;

export interface CommerceActionState {
  actionId: string;
  status: CommerceActionStatus;
  version: number;
  updatedAt: string | null;
  commitment: CommerceActionCommitment | null;
  lastNote: string | null;
  reminder?: {
    status: 'none' | 'snoozed' | 'due' | 'cancelled';
    snoozeUntil: string | null;
  };
}

export const COMMERCE_ACTION_LIST_FILTERS = ['open', ...COMMERCE_ACTION_STATUSES] as const;
export type CommerceActionListFilter = typeof COMMERCE_ACTION_LIST_FILTERS[number];

export interface CommerceActionListItem extends CommerceActionState {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  action: string;
  rationale: string;
  priority: CommerceActionRecommendation['priority'];
  ownerRole: CommerceActionRecommendation['ownerRole'];
  deadline: string | null;
  successMetric: CommerceActionRecommendation['successMetric'];
  guardrails: CommerceActionRecommendation['guardrails'];
  // Recovered only from the Evidence record named by successMetric.baselineClaim. A missing
  // value is intentionally not treated as an unfiltered action during effect review.
  sourceFilters: CommerceFilters | null;
  lastReview: {
    runId: string;
    messageId: string;
    createdAt: string;
  } | null;
  proposedAt: string;
}

export const commerceActionTransitionSchema = z.object({
  action: z.enum(['confirm', 'ignore', 'snooze', 'start', 'block', 'resume', 'complete', 'cancel', 'reopen', 'review']),
  expectedVersion: z.number().int().min(0).max(1_000_000),
  requestId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
  commitment: commerceActionCommitmentSchema.optional(),
  note: z.string().trim().min(1).max(1_000).optional(),
  snoozeUntil: z.string().datetime().optional(),
}).strict().superRefine((value, context) => {
  if (value.action === 'confirm' && !value.commitment) {
    context.addIssue({ code: 'custom', path: ['commitment'], message: '确认行动必须提交负责人和截止日。' });
  }
  if (['block', 'complete', 'cancel', 'reopen', 'review'].includes(value.action) && !value.note) {
    context.addIssue({ code: 'custom', path: ['note'], message: '该操作必须填写执行备注。' });
  }
  if (value.action === 'snooze' && !value.snoozeUntil) {
    context.addIssue({ code: 'custom', path: ['snoozeUntil'], message: '稍后提醒必须指定到期时间。' });
  }
  if (value.action !== 'snooze' && value.snoozeUntil) {
    context.addIssue({ code: 'custom', path: ['snoozeUntil'], message: '只有稍后提醒可以指定到期时间。' });
  }
});

export type CommerceActionTransitionInput = z.infer<typeof commerceActionTransitionSchema>;

const commerceActionReviewReferenceSchema = z.string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);

export const commerceActionReviewPlanSchema = z.object({
  status: z.literal('ready'),
  message: z.string().trim().min(1).max(1_000),
  question: z.string().trim().min(COMMERCE_MESSAGE_MIN_CHARS).max(COMMERCE_MESSAGE_MAX_CHARS),
  current: commerceDateRangeSchema,
  baseline: commerceDateRangeSchema,
  reviewEnd: dateTextSchema,
  unavailableGuardrails: z.array(commerceMetricSchema).max(COMMERCE_METRICS.length),
}).strict();

export type CommerceActionReviewPlan = z.infer<typeof commerceActionReviewPlanSchema>;

export const commerceActionReviewSubmissionSchema = z.object({
  runId: commerceActionReviewReferenceSchema,
  reviewMessageId: commerceActionReviewReferenceSchema,
  question: z.string().trim().min(COMMERCE_MESSAGE_MIN_CHARS).max(COMMERCE_MESSAGE_MAX_CHARS),
  plan: commerceActionReviewPlanSchema,
  requestId: commerceActionReviewReferenceSchema,
}).strict();

export type CommerceActionReviewSubmission = z.infer<typeof commerceActionReviewSubmissionSchema>;

export interface CommerceActionReviewReceipt {
  id: string;
  conversationId: string;
  sourceMessageId: string;
  actionId: string;
  runId: string;
  reviewMessageId: string;
  requestId: string;
  question: string;
  plan: CommerceActionReviewPlan;
  createdAt: string;
}

export interface CommerceToolTrace {
  evidenceId: string;
  operation: string;
  fetchedAt: string;
  rowCount: number;
  requestSha256: string;
  responseSha256: string;
  sourceQuestionSha256?: string;
  queryScopeSha256?: string;
  sourceWatermark: string | null;
  request: unknown;
  preview: unknown;
  previewTruncated?: boolean;
}

export interface CommerceConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer: CommerceAgentAnswer | null;
  runId: string | null;
  runStatus: 'running' | 'completed' | 'failed' | null;
  runError?: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  actionStates?: CommerceActionState[];
  reportAvailable: boolean;
  traces: CommerceToolTrace[];
  createdAt: string;
}

export interface CommerceConversation {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  messages: CommerceConversationMessage[];
}

export interface CommerceAgentRunResponse {
  conversation: CommerceConversationSummary;
  userMessage: CommerceConversationMessage;
  assistantMessage: CommerceConversationMessage;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export type CommerceAgentJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'dead_letter';
export type CommerceAgentJobKind = 'create_conversation' | 'conversation_turn';

export interface CommerceAgentJob {
  id: string;
  kind: CommerceAgentJobKind;
  conversationId: string | null;
  requestId: string;
  model: string;
  message: string;
  requiredRevision: string;
  executedByWorkerId: string | null;
  status: CommerceAgentJobStatus;
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: CommerceAgentRunResponse | null;
  error: { code: string; message: string } | null;
}

export interface CommerceAgentJobEvent {
  id: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export const COMMERCE_FEEDBACK_CATEGORIES = [
  'wrong_date',
  'wrong_metric',
  'data_issue',
  'unhelpful_recommendation',
  'other',
] as const;

export const commerceFeedbackCategorySchema = z.enum(COMMERCE_FEEDBACK_CATEGORIES);
export type CommerceFeedbackCategory = z.infer<typeof commerceFeedbackCategorySchema>;

const commerceFeedbackReferenceSchema = z.string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);

export const commerceFeedbackSubmissionSchema = z.object({
  messageId: commerceFeedbackReferenceSchema,
  runId: commerceFeedbackReferenceSchema,
  evidenceId: z.string().trim().min(1).max(100).optional(),
  claimPath: z.string()
    .trim()
    .min(1)
    .max(240)
    .startsWith('/')
    .regex(/^\/[^\u0000-\u001f\u007f]*$/u, 'claimPath 包含无效控制字符。')
    .optional(),
  category: commerceFeedbackCategorySchema,
  comment: z.string().trim().min(1).max(1_000).optional(),
  requestId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
}).strict().superRefine((value, context) => {
  if (value.claimPath && !value.evidenceId) {
    context.addIssue({
      code: 'custom',
      path: ['evidenceId'],
      message: 'claimPath 必须同时提供 evidenceId。',
    });
  }
});

export type CommerceFeedbackSubmission = z.infer<typeof commerceFeedbackSubmissionSchema>;

export interface CommerceFeedbackReceipt {
  id: string;
  conversationId: string;
  messageId: string;
  runId: string;
  evidenceId: string | null;
  claimPath: string | null;
  category: CommerceFeedbackCategory;
  comment: string | null;
  status: 'received';
  createdAt: string;
}

export const COMMERCE_FEEDBACK_STATUSES = [
  'received',
  'reviewed',
  'correction_requested',
  'correction_enqueued',
  'correction_completed',
  'correction_failed',
  'resolved',
  'dismissed',
] as const;

export const commerceFeedbackStatusSchema = z.enum(COMMERCE_FEEDBACK_STATUSES);
export type CommerceFeedbackStatus = z.infer<typeof commerceFeedbackStatusSchema>;

export const COMMERCE_FEEDBACK_REVIEW_ACTIONS = [
  'review',
  'request_correction',
  'resolve',
  'dismiss',
] as const;

export const commerceFeedbackReviewEventSchema = z.object({
  action: z.enum(COMMERCE_FEEDBACK_REVIEW_ACTIONS),
  note: z.string().trim().min(1).max(1_000).optional(),
  requestId: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
  expectedVersion: z.number().int().min(0).max(1_000_000),
}).strict();

export type CommerceFeedbackReviewEventInput = z.infer<typeof commerceFeedbackReviewEventSchema>;
export type CommerceFeedbackReviewAction = CommerceFeedbackReviewEventInput['action'];
export type CommerceFeedbackEventType = Exclude<CommerceFeedbackStatus, 'received'>;

export interface CommerceFeedbackEvent {
  id: number;
  version: number;
  type: CommerceFeedbackEventType;
  status: CommerceFeedbackStatus;
  note: string | null;
  actorId: string;
  actorDisplayName: string;
  jobId: string | null;
  runId: string | null;
  createdAt: string;
}

export interface CommerceFeedbackReviewItem extends Omit<CommerceFeedbackReceipt, 'status'> {
  userId: string;
  status: CommerceFeedbackStatus;
  version: number;
  updatedAt: string;
  question: string | null;
  answer: string;
}

export interface CommerceFeedbackReviewDetail extends CommerceFeedbackReviewItem {
  answerData: CommerceAgentAnswer | null;
  evidence: CommerceToolTrace | null;
  events: CommerceFeedbackEvent[];
}

export interface CommerceFeedbackReviewPage {
  items: CommerceFeedbackReviewItem[];
  nextCursor: string | null;
}

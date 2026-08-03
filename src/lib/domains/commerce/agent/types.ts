import { z } from 'zod';

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
}

export interface CommerceCatalog {
  dataset: string;
  timezone: string;
  coverage: {
    start: string | null;
    end: string | null;
    lastIngestedAt: string | null;
    sourceUpdatedAt: string | null;
    dataMode: 'snapshot' | 'incremental';
    rowCount: number;
  };
  metrics: CommerceMetricDefinition[];
  dimensions: Record<CommerceDimension, string[]>;
}

export interface CommerceEvidenceReceipt<T = unknown> {
  evidenceId: string;
  operation: string;
  fetchedAt: string;
  rowCount: number;
  requestSha256: string;
  responseSha256: string;
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

export const commerceAgentAnswerSchema = z.object({
  status: z.enum(['answered', 'needs_clarification', 'refused']),
  answer: z.string().trim().min(1).max(8_000),
  answerClaims: z.array(commerceEvidenceClaimSchema).max(12),
  findings: z.array(z.object({
    metric: commerceMetricSchema,
    title: z.string().trim().min(1).max(160),
    detail: z.string().trim().min(1).max(1_500),
    claims: z.array(commerceEvidenceClaimSchema).max(12),
  }).strict()).max(12),
  recommendations: z.array(z.object({
    action: z.string().trim().min(1).max(240),
    rationale: z.string().trim().min(1).max(1_500),
    claims: z.array(commerceEvidenceClaimSchema).max(12),
  }).strict()).max(8),
  followUps: z.array(z.string().trim().min(1).max(240)).max(5),
}).strict();

export type CommerceAgentAnswer = z.infer<typeof commerceAgentAnswerSchema>;

export interface CommerceToolTrace {
  evidenceId: string;
  operation: string;
  fetchedAt: string;
  rowCount: number;
  requestSha256: string;
  responseSha256: string;
  sourceWatermark: string | null;
  request: unknown;
  preview: unknown;
}

export interface CommerceConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer: CommerceAgentAnswer | null;
  runId: string | null;
  runStatus: 'running' | 'completed' | 'failed' | null;
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

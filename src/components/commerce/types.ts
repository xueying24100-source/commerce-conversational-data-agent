export type ModelId =
  | 'local_qwen:qwen3.5-9b-q5km'
  | 'deepseek:deepseek-v4-flash'
  | 'deepseek-v4-flash';

export type CommerceMetricId =
  | 'gmv'
  | 'net_revenue'
  | 'paid_orders'
  | 'units'
  | 'visits'
  | 'conversion_rate'
  | 'average_order_value'
  | 'refund_rate'
  | 'refund_amount'
  | 'gross_profit'
  | 'gross_margin'
  | 'ad_spend'
  | 'roas'
  | 'new_customers'
  | 'stockout_hours'
  | 'ending_inventory';

export type Readiness = {
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
    snapshotVerified: boolean | null;
    coverageStart: string | null;
    coverageEnd: string | null;
    businessTimezone: string | null;
    currencyCode: string | null;
    availableMetrics: CommerceMetricId[];
    lastIngestedAt: string | null;
    sourceUpdatedAt: string | null;
    sourceDisclosure: {
      sourceKind: 'public_snapshot';
      sourceId: string;
      sourceUri: string;
      sourceRevision: string;
      licenseId: string;
      fixtureSeed: number | null;
      generatedFields: string[];
    } | null;
  } | null;
};

export type Bootstrap = {
  agent: {
    id: string;
    version: string;
    runtime: string;
    connector: string;
    fallback: string;
    features?: {
      diagnosticPolicyEnabled: boolean;
      anomalyDetectionEnabled: boolean;
      notificationsEnabled: boolean;
      automaticReviewEnabled: boolean;
      weeklyDiagnosisEnabled: boolean;
    };
    models: ModelId[];
    tools: string[];
  };
  identity: {
    displayName: string;
    authMode: 'development' | 'trusted_proxy';
    tenantId: string;
    userId: string;
    scopes: string[];
  };
  readiness: Readiness;
};

export type ConversationSummary = {
  id: string;
  title: string;
  model: string;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceTrace = {
  evidenceId: string;
  operation: string;
  fetchedAt: string;
  rowCount: number;
  requestSha256: string;
  responseSha256: string;
  sourceWatermark: string | null;
  request: unknown;
  preview: unknown;
  previewTruncated?: boolean;
};

export type EvidenceClaim = {
  evidenceId: string;
  path: string;
  metric: string;
  value: number;
  unit: 'currency' | 'integer' | 'decimal' | 'percent' | 'hours';
};

export type AgentAnswer = {
  status: 'answered' | 'needs_clarification' | 'refused';
  answer: string;
  answerClaims: EvidenceClaim[];
  findings: Array<{
    metric: string;
    title: string;
    detail: string;
    claims: EvidenceClaim[];
    insightLevel?: 'observed' | 'contribution' | 'driver' | 'hypothesis' | 'unknown';
    confidence?: number;
    alternatives?: string[];
    contradictionStatus?: 'clear' | 'unresolved' | 'contradicted';
  }>;
  recommendations: Array<{
    action: string;
    rationale: string;
    claims: EvidenceClaim[];
    id?: string;
    priority?: 'high' | 'medium' | 'low';
    ownerRole?: 'operations' | 'growth' | 'merchandising' | 'finance' | 'customer_service' | 'supply_chain' | 'data';
    deadline?: string | null;
    successMetric?: {
      metric: CommerceMetricId;
      direction: 'increase' | 'decrease' | 'maintain';
      baselineClaim: EvidenceClaim;
      target: number | null;
      targetUnit: EvidenceClaim['unit'];
      evaluationWindowDays: number | null;
    };
    guardrails?: Array<{
      metric: CommerceMetricId;
      operator: 'not_above' | 'not_below';
      baselineClaim: EvidenceClaim;
      threshold: number | null;
      unit: EvidenceClaim['unit'];
    }>;
    status?: 'proposed';
  }>;
  followUps: string[];
  diagnostic?: {
    objective: 'diagnose_previous_complete_week';
    dataHealth: {
      status: 'ready' | 'degraded' | 'blocked';
      dataMode: 'snapshot' | 'incremental';
      sourceWatermark: string | null;
      reasons: string[];
    };
    referenceDate: string;
    timezone: string;
    baseline: {
      strategy: 'explicit' | 'previous_four_complete_weeks_median' | 'available_complete_weeks_median' | 'previous_adjacent_period';
      rationale: string;
      comparisonRanges: Array<{ start: string; end: string }>;
      confidence: 'high' | 'medium' | 'low';
    };
    stopReason: 'data_health_failed' | 'scope_unavailable' | 'no_material_anomaly' | 'evidence_sufficient' | 'budget_exhausted' | 'no_new_evidence' | 'timeout' | 'no_legal_candidate' | 'unknown';
    driverGate?: {
      hypothesis: 'growth_driver' | 'traffic_drop' | 'conversion_drop' | 'aov_or_mix' | 'refund_spike' | 'stockout';
      insightLevel: 'driver' | 'hypothesis';
      passed: boolean;
      reasons: string[];
      contributionMetric?: CommerceMetricId | null;
      contributionShare: number | null;
      primaryRelativeChange: number | null;
      contributionResidualRatio: number | null;
      aggregateEvidenceId: string;
      investigationEvidenceId: string;
      structureChangeDetected: boolean;
    } | null;
    unknowns: string[];
    decisions: Array<{
      sequence: number;
      hypothesis: 'growth_driver' | 'traffic_drop' | 'conversion_drop' | 'aov_or_mix' | 'refund_spike' | 'stockout' | null;
      chosenNextView: 'breakdown' | 'trend' | 'inventory' | null;
      decisionCode: string;
      stopReason: string | null;
      triggerEvidenceIds: string[];
    }>;
  };
};

export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  answer: AgentAnswer | null;
  runId: string | null;
  runStatus: 'running' | 'completed' | 'failed' | null;
  runError?: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
  actionStates?: ActionState[];
  reportAvailable: boolean;
  traces: EvidenceTrace[];
  createdAt: string;
};

export type Conversation = ConversationSummary & { messages: ConversationMessage[] };

export type ActionStatus = 'proposed' | 'confirmed' | 'in_progress' | 'blocked' | 'completed' | 'reopened' | 'reviewed' | 'ignored' | 'cancelled';
export type ActionListFilter = 'open' | ActionStatus;

export type ActionCommitment = {
  assignee: string;
  dueDate: string;
  target: number | null;
  evaluationWindowDays: number | null;
};

export type ActionState = {
  actionId: string;
  status: ActionStatus;
  version: number;
  updatedAt: string | null;
  commitment: ActionCommitment | null;
  lastNote: string | null;
  reminder?: {
    status: 'none' | 'snoozed' | 'due' | 'cancelled';
    snoozeUntil: string | null;
  };
};

export type TenantMember = {
  memberId: string;
  displayName: string;
  canReceiveNotifications: boolean;
};

export type FeishuNotificationReceipt = {
  id: string;
  actionId: string;
  actionVersion: number;
  recipientMemberId: string;
  recipientDisplayName: string;
  requestUuid: string;
  status: 'pending' | 'sending' | 'delivered' | 'retryable' | 'delivery_unknown' | 'failed_permanent';
  providerMessageId: string | null;
  createdAt: string;
};

export type CommerceFilters = {
  regions: string[];
  channels: string[];
  skus: string[];
  categories: string[];
};

export type ActionListItem = ActionState & {
  conversationId: string;
  conversationTitle: string;
  messageId: string;
  actionId: string;
  action: string;
  rationale: string;
  priority?: 'high' | 'medium' | 'low';
  ownerRole?: 'operations' | 'growth' | 'merchandising' | 'finance' | 'customer_service' | 'supply_chain' | 'data';
  deadline: string | null;
  successMetric?: AgentAnswer['recommendations'][number]['successMetric'];
  guardrails?: AgentAnswer['recommendations'][number]['guardrails'];
  sourceFilters: CommerceFilters | null;
  lastReview: {
    runId: string;
    messageId: string;
    createdAt: string;
  } | null;
  proposedAt: string;
};

export type FeedbackCategory =
  | 'wrong_date'
  | 'wrong_metric'
  | 'data_issue'
  | 'unhelpful_recommendation'
  | 'other';

export type FeedbackStatus =
  | 'received'
  | 'reviewed'
  | 'correction_requested'
  | 'correction_enqueued'
  | 'correction_completed'
  | 'correction_failed'
  | 'resolved'
  | 'dismissed';

export type FeedbackOwnerStatus = {
  id: string;
  conversationId: string;
  messageId: string;
  category: FeedbackCategory;
  status: FeedbackStatus;
  version: number;
  reviewNote: string | null;
  correctionJobId: string | null;
  correctionJobStatus: AgentJob['status'] | null;
  correctionRunId: string | null;
  createdAt: string;
  updatedAt: string;
};

export type FeedbackReviewItem = {
  id: string;
  userId: string;
  conversationId: string;
  messageId: string;
  runId: string;
  evidenceId: string | null;
  claimPath: string | null;
  category: FeedbackCategory;
  comment: string | null;
  status: FeedbackStatus;
  version: number;
  question: string | null;
  answer: string;
  createdAt: string;
  updatedAt: string;
};

export type FeedbackReviewDetail = FeedbackReviewItem & {
  answerData: AgentAnswer | null;
  evidence: EvidenceTrace | null;
  events: Array<{
    id: number;
    version: number;
    type: Exclude<FeedbackStatus, 'received'>;
    status: FeedbackStatus;
    note: string | null;
    actorId: string;
    actorDisplayName: string;
    jobId: string | null;
    runId: string | null;
    createdAt: string;
  }>;
};

export type RunResult = {
  conversation: ConversationSummary;
  userMessage: ConversationMessage;
  assistantMessage: ConversationMessage;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
};

export type AgentJob = {
  id: string;
  kind: 'create_conversation' | 'conversation_turn';
  conversationId: string | null;
  requestId: string;
  model: string;
  message: string;
  requiredRevision: string;
  executedByWorkerId: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'dead_letter';
  attemptCount: number;
  maxAttempts: number;
  availableAt: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  result: RunResult | null;
  error: { code: string; message: string } | null;
};

export type ApiEnvelope<T> =
  | ({ success: true } & T)
  | { success: false; error: string; message: string; conversationId?: string };

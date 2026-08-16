import { createHash, randomUUID } from 'node:crypto';

import {
  commerceReviewVerdict,
  effectiveCommerceReviewWindow,
  type CommerceReviewVerdict,
} from './action-orchestration';
import type { CommerceDatabase, CommerceSqlClient } from './database';
import {
  getCommerceAnalyticsDatabase,
  getCommerceControlDatabase,
  withCommerceControlSystem,
} from './database';
import { addCommerceBusinessDays } from './diagnostics';
import { PostgresCommerceJobStore } from './job-store';
import {
  commerceCoverageDate,
  readCommerceSchedulerTenantCoverage,
} from './scheduler-tenant-coverage';
import {
  commerceActionCommitmentSchema,
  commerceActionRecommendationSchema,
  commerceAgentAnswerSchema,
  commerceFiltersSchema,
  type CommerceAgentAnswer,
  type CommerceAgentRunResponse,
  type CommerceEvidenceClaim,
  type CommerceIdentity,
  type CommerceMetric,
} from './types';

interface CompletedActionRow extends Record<string, unknown> {
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  action_id: string;
  action_version: unknown;
  completed_at: unknown;
  details_json: unknown;
  recommendation: unknown;
  describe_preview: unknown;
  baseline_request: unknown;
}

interface ScheduleRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  action_id: string;
  action_version: unknown;
  state_version: unknown;
  effective_review_start: unknown;
  effective_review_end: unknown;
  review_after_watermark: unknown;
  effective_window_sha256: string;
  review_contract_json: unknown;
  status: string;
  job_id: string | null;
  verdict_json?: unknown;
  review_run_id?: string | null;
  review_message_id?: string | null;
  model?: string;
  actor_display_name?: string;
}

interface ReviewContract {
  schemaVersion: number;
  actionId: string;
  actionVersion: number;
  successMetric: {
    metric: CommerceMetric;
    direction: 'increase' | 'decrease' | 'maintain';
    baselineClaim: CommerceEvidenceClaim;
    target: number | null;
    targetUnit: string;
  };
  guardrails: Array<{
    metric: CommerceMetric;
    operator: 'not_above' | 'not_below';
    baselineClaim: CommerceEvidenceClaim;
    threshold: number | null;
    unit: string;
  }>;
  filters: {
    regions: string[];
    channels: string[];
    skus: string[];
    categories: string[];
  } | null;
  evaluationDurationDays: number;
  completedAt: string;
  timezone: string;
  clockType: 'wall' | 'virtual';
  effectiveReviewStart: string;
  effectiveReviewEnd: string;
}

export interface CommerceReviewVerdictRecord {
  schemaVersion: 1;
  verdict: CommerceReviewVerdict;
  successMetric: {
    metric: CommerceMetric;
    available: boolean;
    met: boolean;
    actualClaim: CommerceEvidenceClaim | null;
    target: number;
  };
  guardrails: Array<{
    metric: CommerceMetric;
    available: boolean;
    breached: boolean;
    actualClaim: CommerceEvidenceClaim | null;
    threshold: number;
  }>;
}

export type CommerceReviewJobClaim =
  | { kind: 'not_review' }
  | { kind: 'action_review'; status: 'running' | 'completed' | 'stale_noop'; schedule: ReturnType<typeof publicSchedule> };

interface ReviewJobEnqueuer {
  enqueueWithClient(
    client: CommerceSqlClient,
    input: Parameters<PostgresCommerceJobStore['enqueueWithClient']>[1],
  ): ReturnType<PostgresCommerceJobStore['enqueueWithClient']>;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function record(value: unknown): Record<string, unknown> | null {
  const parsed = parseJson(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid review schedule timestamp.');
  return date.toISOString();
}

function integer(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Invalid review schedule version.');
  return parsed;
}

function reviewContract(value: unknown): ReviewContract {
  const candidate = record(value);
  const recommendation = commerceActionRecommendationSchema.safeParse({
    id: candidate?.actionId,
    action: 'frozen review contract',
    rationale: 'frozen review contract',
    claims: [],
    status: 'proposed',
    successMetric: candidate?.successMetric,
    guardrails: candidate?.guardrails ?? [],
  });
  const filters = commerceFiltersSchema.safeParse(candidate?.filters);
  const evaluationDurationDays = Number(candidate?.evaluationDurationDays);
  if (
    !candidate
    || candidate.schemaVersion !== 1
    || !recommendation.success
    || !recommendation.data.successMetric
    || !Number.isSafeInteger(evaluationDurationDays)
    || evaluationDurationDays < 1
    || evaluationDurationDays > 365
    || typeof candidate.completedAt !== 'string'
    || typeof candidate.timezone !== 'string'
    || !['wall', 'virtual'].includes(String(candidate.clockType))
    || typeof candidate.effectiveReviewStart !== 'string'
    || typeof candidate.effectiveReviewEnd !== 'string'
  ) {
    throw new Error('Invalid frozen review contract.');
  }
  return {
    schemaVersion: 1,
    actionId: String(candidate.actionId),
    actionVersion: integer(candidate.actionVersion),
    successMetric: recommendation.data.successMetric,
    guardrails: recommendation.data.guardrails ?? [],
    filters: filters.success ? filters.data : null,
    evaluationDurationDays,
    completedAt: candidate.completedAt,
    timezone: candidate.timezone,
    clockType: candidate.clockType as 'wall' | 'virtual',
    effectiveReviewStart: candidate.effectiveReviewStart,
    effectiveReviewEnd: candidate.effectiveReviewEnd,
  };
}

function localDate(instant: string, timeZone: string): string {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid review boundary.');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date).flatMap((part) => (
    part.type === 'literal' ? [] : [[part.type, part.value]]
  )));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function reviewRanges(contract: ReviewContract) {
  const currentStart = localDate(contract.effectiveReviewStart, contract.timezone);
  const currentEnd = addCommerceBusinessDays(currentStart, contract.evaluationDurationDays - 1);
  return {
    current: { start: currentStart, end: currentEnd },
    baseline: {
      start: addCommerceBusinessDays(currentStart, -contract.evaluationDurationDays),
      end: addCommerceBusinessDays(currentStart, -1),
    },
  };
}

const METRIC_LABELS: Record<CommerceMetric, string> = {
  gmv: 'GMV', net_revenue: '净收入', paid_orders: '支付订单数', units: '销量',
  visits: '访问量', conversion_rate: '转化率', average_order_value: '客单价',
  refund_rate: '退款率', refund_amount: '退款金额', gross_profit: '毛利额',
  gross_margin: '毛利率', ad_spend: '广告花费', roas: 'ROAS',
  new_customers: '新客数', stockout_hours: '缺货时长', ending_inventory: '期末库存',
};

function filterText(contract: ReviewContract): string {
  if (!contract.filters) return '';
  const values = [
    ['区域', contract.filters.regions],
    ['渠道', contract.filters.channels],
    ['SKU', contract.filters.skus],
    ['品类', contract.filters.categories],
  ].flatMap(([label, entries]) => (
    (entries as string[]).length ? [`${label}：${(entries as string[]).join('、')}`] : []
  ));
  return values.length ? `；沿用原始筛选：${values.join('；')}` : '';
}

function reviewQuestion(contract: ReviewContract): string {
  const ranges = reviewRanges(contract);
  const metrics = [
    contract.successMetric.metric,
    ...contract.guardrails.map((guardrail) => guardrail.metric),
  ].filter((metric, index, all) => all.indexOf(metric) === index);
  return [
    `复盘行动后 ${ranges.current.start} 至 ${ranges.current.end} 的经营表现，`,
    `与行动前 ${ranges.baseline.start} 至 ${ranges.baseline.end} 对比。`,
    `必须分别报告${metrics.map((metric) => METRIC_LABELS[metric]).join('、')}的当前值和基线值，`,
    '只描述行动后窗口观察到的结果，不声称因果；不要提出新行动。',
    filterText(contract),
  ].join('').slice(0, 2_000);
}

function currentClaim(answer: CommerceAgentAnswer, metric: CommerceMetric): CommerceEvidenceClaim | null {
  return answer.answerClaims.find((claim) => (
    claim.metric === metric && /^\/current(?:\/|$)/u.test(claim.path)
  )) ?? answer.findings.flatMap((finding) => finding.claims).find((claim) => (
    claim.metric === metric && /^\/current(?:\/|$)/u.test(claim.path)
  )) ?? null;
}

function successMet(
  actual: number,
  success: ReviewContract['successMetric'],
): { met: boolean; target: number } {
  const target = success.target ?? success.baselineClaim.value;
  if (success.direction === 'increase') return { met: actual >= target, target };
  if (success.direction === 'decrease') return { met: actual <= target, target };
  return { met: actual === target, target };
}

export function evaluateCommerceReviewVerdict(input: {
  contract: ReviewContract;
  answer: CommerceAgentAnswer | null;
}): CommerceReviewVerdictRecord {
  const answer = input.answer;
  const successClaim = answer ? currentClaim(answer, input.contract.successMetric.metric) : null;
  const success = successClaim
    ? successMet(successClaim.value, input.contract.successMetric)
    : { met: false, target: input.contract.successMetric.target
      ?? input.contract.successMetric.baselineClaim.value };
  const guardrails = input.contract.guardrails.map((guardrail) => {
    const claim = answer ? currentClaim(answer, guardrail.metric) : null;
    const threshold = guardrail.threshold ?? guardrail.baselineClaim.value;
    return {
      metric: guardrail.metric,
      available: Boolean(claim),
      breached: claim
        ? guardrail.operator === 'not_above'
          ? claim.value > threshold
          : claim.value < threshold
        : false,
      actualClaim: claim,
      threshold,
    };
  });
  const verdict = commerceReviewVerdict({
    successMetricAvailable: Boolean(successClaim),
    successMetricMet: success.met,
    guardrails,
  });
  return {
    schemaVersion: 1,
    verdict,
    successMetric: {
      metric: input.contract.successMetric.metric,
      available: Boolean(successClaim),
      met: success.met,
      actualClaim: successClaim,
      target: success.target,
    },
    guardrails,
  };
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function publicSchedule(row: ScheduleRow) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    actionId: row.action_id,
    actionVersion: integer(row.action_version),
    stateVersion: integer(row.state_version),
    effectiveReviewStart: iso(row.effective_review_start),
    effectiveReviewEnd: iso(row.effective_review_end),
    reviewAfterWatermark: iso(row.review_after_watermark),
    windowHash: row.effective_window_sha256,
    contract: record(row.review_contract_json) ?? {},
    status: row.status,
    jobId: row.job_id ?? null,
    verdict: record(row.verdict_json) ?? null,
    reviewRunId: row.review_run_id ?? null,
    reviewMessageId: row.review_message_id ?? null,
  };
}

export class PostgresCommerceReviewScheduler {
  private readonly jobs: ReviewJobEnqueuer;

  constructor(
    private readonly database: CommerceDatabase,
    private readonly analytics: CommerceDatabase | null = null,
    jobs?: ReviewJobEnqueuer,
  ) {
    this.jobs = jobs ?? new PostgresCommerceJobStore(database);
  }

  scheduleCompleted(input: { limit?: number } = {}): Promise<number> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const candidates = await client.query<CompletedActionRow>(
        `SELECT event.tenant_id, event.user_id, event.conversation_id,
                event.message_id, event.action_id, event.version AS action_version,
                event.created_at AS completed_at, event.details_json,
                recommendation.value AS recommendation,
                describe.preview_json AS describe_preview,
                baseline.request_json AS baseline_request
         FROM commerce_agent_action_events AS event
         JOIN commerce_agent_messages AS message
           ON message.id = event.message_id
          AND message.conversation_id = event.conversation_id
          AND message.tenant_id = event.tenant_id
          AND message.user_id = event.user_id
         CROSS JOIN LATERAL jsonb_array_elements(message.answer_json->'recommendations') AS recommendation(value)
         LEFT JOIN commerce_agent_evidence AS describe
           ON describe.run_id = event.run_id AND describe.tenant_id = event.tenant_id
          AND describe.operation = 'commerce.describe_data'
         LEFT JOIN commerce_agent_evidence AS baseline
           ON baseline.run_id = event.run_id AND baseline.tenant_id = event.tenant_id
          AND baseline.id = recommendation.value #>> '{successMetric,baselineClaim,evidenceId}'
         WHERE event.event_type = 'completed'
           AND recommendation.value->>'id' = event.action_id
           AND NOT EXISTS (
             SELECT 1 FROM commerce_action_review_schedules AS schedule
             WHERE schedule.tenant_id = event.tenant_id
               AND schedule.action_id = event.action_id
               AND schedule.action_version = event.version
           )
         ORDER BY event.created_at, event.tenant_id, event.action_id
         FOR UPDATE OF event SKIP LOCKED
         LIMIT $1`,
        [limit],
      );
      let inserted = 0;
      for (const row of candidates.rows) {
        const recommendation = commerceActionRecommendationSchema.safeParse(parseJson(row.recommendation));
        const details = record(row.details_json);
        const commitment = commerceActionCommitmentSchema.safeParse(details?.commitment);
        if (!recommendation.success || !recommendation.data.successMetric) continue;
        const evaluationDurationDays = commitment.success
          ? commitment.data.evaluationWindowDays ?? recommendation.data.successMetric.evaluationWindowDays
          : recommendation.data.successMetric.evaluationWindowDays;
        if (!evaluationDurationDays) continue;
        const describe = record(row.describe_preview);
        const frozenCompletion = record(details?.completion);
        const fallbackTimezone = typeof describe?.timezone === 'string' ? describe.timezone : 'UTC';
        const coverage = record(describe?.coverage);
        const fallbackClockType = coverage?.dataMode === 'snapshot' ? 'virtual' as const : 'wall' as const;
        const frozenCompletedAt = typeof frozenCompletion?.completedAt === 'string'
          && Number.isFinite(Date.parse(frozenCompletion.completedAt))
          ? new Date(frozenCompletion.completedAt).toISOString()
          : null;
        const frozenTimezone = typeof frozenCompletion?.timezone === 'string'
          && frozenCompletion.timezone.trim()
          ? frozenCompletion.timezone
          : null;
        const frozenClockType = frozenCompletion?.clockType === 'virtual'
          || frozenCompletion?.clockType === 'wall'
          ? frozenCompletion.clockType
          : null;
        const timezone = frozenTimezone ?? fallbackTimezone;
        const clockType = frozenClockType ?? fallbackClockType;
        const completedAt = frozenCompletedAt ?? iso(row.completed_at);
        const window = effectiveCommerceReviewWindow({
          completedAt,
          timezone,
          clockType,
          evaluationDurationDays,
          sourceGrain: 'day',
        });
        const baselineRequest = record(row.baseline_request);
        const filters = commerceFiltersSchema.safeParse(baselineRequest?.filters);
        const contract = {
          schemaVersion: 1,
          actionId: row.action_id,
          actionVersion: integer(row.action_version),
          successMetric: recommendation.data.successMetric,
          guardrails: recommendation.data.guardrails ?? [],
          filters: filters.success ? filters.data : null,
          evaluationDurationDays,
          completedAt: window.completedAt,
          timezone,
          clockType,
          effectiveReviewStart: window.effectiveReviewStart,
          effectiveReviewEnd: window.effectiveReviewEnd,
        };
        const result = await client.query(
          `INSERT INTO commerce_action_review_schedules
             (id, tenant_id, user_id, conversation_id, message_id, action_id,
              action_version, state_version, completed_at, tenant_timezone,
              clock_type, effective_review_start, effective_review_end,
              review_after_watermark, effective_window_sha256, review_contract_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $8, $9, $10,
                   $11, $12, $12, $13, $14::jsonb)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [
            `review_schedule_${randomUUID()}`,
            row.tenant_id,
            row.user_id,
            row.conversation_id,
            row.message_id,
            row.action_id,
            integer(row.action_version),
            window.completedAt,
            timezone,
            clockType,
            window.effectiveReviewStart,
            window.effectiveReviewEnd,
            window.windowHash,
            JSON.stringify(contract),
          ],
        );
        inserted += result.rowCount;
      }
      return inserted;
    }));
  }

  invalidateStale(): Promise<number> {
    return withCommerceControlSystem(async () => {
      const result = await this.database.query(
        `UPDATE commerce_action_review_schedules AS schedule
         SET status = 'cancelled', updated_at = NOW()
         WHERE schedule.status IN ('waiting', 'queued')
           AND EXISTS (
             SELECT 1 FROM commerce_agent_action_events AS event
             WHERE event.tenant_id = schedule.tenant_id
               AND event.user_id = schedule.user_id
               AND event.message_id = schedule.message_id
               AND event.action_id = schedule.action_id
               AND event.version > schedule.state_version
               AND event.event_type IN ('reopened', 'cancelled', 'reviewed')
           )`,
      );
      return result.rowCount;
    });
  }

  queueReady(input: {
    tenantId: string;
    coverageEnd: string;
    now?: Date;
    limit?: number;
    maxQueuedPerUser?: number;
    maxAttempts?: number;
  }): Promise<ReturnType<typeof publicSchedule>[]> {
    const now = input.now ?? new Date();
    const coverageEnd = commerceCoverageDate(input.coverageEnd);
    if (!coverageEnd) return Promise.resolve([]);
    const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const result = await client.query<ScheduleRow>(
        `SELECT schedule.*, conversation.model,
                completed.actor_display_name
         FROM commerce_action_review_schedules AS schedule
         JOIN commerce_agent_conversations AS conversation
           ON conversation.id = schedule.conversation_id
          AND conversation.tenant_id = schedule.tenant_id
          AND conversation.user_id = schedule.user_id
         JOIN commerce_agent_action_events AS completed
           ON completed.tenant_id = schedule.tenant_id
          AND completed.user_id = schedule.user_id
          AND completed.message_id = schedule.message_id
          AND completed.action_id = schedule.action_id
          AND completed.version = schedule.state_version
          AND completed.event_type = 'completed'
         WHERE schedule.tenant_id = $1 AND schedule.status = 'waiting'
           AND schedule.effective_review_end <= $2::timestamptz
           AND ((schedule.effective_review_end AT TIME ZONE schedule.tenant_timezone)::date - 1)
               <= $3::date
           AND NOT EXISTS (
             SELECT 1 FROM commerce_agent_action_events AS newer
             WHERE newer.tenant_id = completed.tenant_id
               AND newer.user_id = completed.user_id
               AND newer.message_id = completed.message_id
               AND newer.action_id = completed.action_id
               AND newer.version > completed.version
           )
         ORDER BY schedule.review_after_watermark, schedule.id
         FOR UPDATE OF schedule SKIP LOCKED
         LIMIT $4`,
        [input.tenantId, now.toISOString(), coverageEnd, limit],
      );
      const queued: ReturnType<typeof publicSchedule>[] = [];
      for (const row of result.rows) {
        if (!row.model) throw new Error('Review source conversation has no model.');
        const contract = reviewContract(row.review_contract_json);
        const identity: CommerceIdentity = {
          tenantId: row.tenant_id,
          userId: row.user_id,
          displayName: row.actor_display_name?.trim() || 'Commerce 自动复盘',
          authMode: 'trusted_proxy',
          scopes: ['commerce:read'],
        };
        const job = await this.jobs.enqueueWithClient(client, {
          identity,
          kind: 'conversation_turn',
          conversationId: row.conversation_id,
          requestId: `auto-review:${row.id}:${integer(row.action_version)}`,
          model: row.model,
          message: reviewQuestion(contract),
          maxQueuedPerUser: input.maxQueuedPerUser ?? 2,
          maxAttempts: input.maxAttempts ?? 3,
        });
        const updated = await client.query<ScheduleRow>(
          `UPDATE commerce_action_review_schedules
           SET status = 'queued', job_id = $2, updated_at = NOW()
           WHERE id = $1 AND status = 'waiting'
           RETURNING *`,
          [row.id, job.id],
        );
        if (!updated.rows[0]) throw new Error('Review schedule lost its queue claim.');
        queued.push(publicSchedule(updated.rows[0]));
      }
      return queued;
    }));
  }

  async queueReadyFromCurrentWatermarks(input: {
    now?: Date;
    limitPerTenant?: number;
    maxQueuedPerUser?: number;
    maxAttempts?: number;
  } = {}): Promise<number> {
    if (!this.analytics) return 0;
    const tenants = await withCommerceControlSystem(() => this.database.query<{
      tenant_id: string;
    }>(
      `SELECT DISTINCT tenant_id
       FROM commerce_action_review_schedules
       WHERE status = 'waiting'
       ORDER BY tenant_id`,
    ));
    let queued = 0;
    for (const registeredTenant of tenants.rows) {
      const coverage = await readCommerceSchedulerTenantCoverage(
        this.analytics,
        registeredTenant.tenant_id,
      );
      if (!coverage) continue;
      const schedules = await this.queueReady({
        tenantId: coverage.tenantId,
        coverageEnd: coverage.coverageEnd,
        now: input.now,
        limit: input.limitPerTenant,
        maxQueuedPerUser: input.maxQueuedPerUser,
        maxAttempts: input.maxAttempts,
      });
      queued += schedules.length;
    }
    return queued;
  }

  claimJob(jobId: string): Promise<CommerceReviewJobClaim> {
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const selected = await client.query<ScheduleRow>(
        `SELECT schedule.*
         FROM commerce_action_review_schedules AS schedule
         WHERE schedule.job_id = $1
         FOR UPDATE`,
        [jobId],
      );
      const row = selected.rows[0];
      if (!row) return { kind: 'not_review' };
      if (row.status === 'completed') {
        return { kind: 'action_review', status: 'completed', schedule: publicSchedule(row) };
      }
      if (row.status === 'stale_noop' || row.status === 'cancelled') {
        return { kind: 'action_review', status: 'stale_noop', schedule: publicSchedule(row) };
      }
      const running = await client.query<ScheduleRow>(
        `UPDATE commerce_action_review_schedules AS schedule
         SET status = 'running', updated_at = NOW()
         WHERE schedule.id = $1
           AND schedule.job_id = $2
           AND schedule.status IN ('queued', 'running')
           AND EXISTS (
             SELECT 1 FROM commerce_agent_jobs AS job
             WHERE job.id = schedule.job_id AND job.status = 'running'
           )
           AND EXISTS (
             SELECT 1 FROM commerce_agent_action_events AS completed
             WHERE completed.tenant_id = schedule.tenant_id
               AND completed.user_id = schedule.user_id
               AND completed.message_id = schedule.message_id
               AND completed.action_id = schedule.action_id
               AND completed.version = schedule.state_version
               AND completed.event_type = 'completed'
               AND NOT EXISTS (
                 SELECT 1 FROM commerce_agent_action_events AS newer
                 WHERE newer.tenant_id = completed.tenant_id
                   AND newer.user_id = completed.user_id
                   AND newer.message_id = completed.message_id
                   AND newer.action_id = completed.action_id
                   AND newer.version > completed.version
               )
           )
         RETURNING schedule.*`,
        [row.id, jobId],
      );
      if (running.rows[0]) {
        return {
          kind: 'action_review',
          status: 'running',
          schedule: publicSchedule(running.rows[0]),
        };
      }
      const stale = await client.query<ScheduleRow>(
        `UPDATE commerce_action_review_schedules
         SET status = 'stale_noop', updated_at = NOW()
         WHERE id = $1 AND status IN ('queued', 'running')
         RETURNING *`,
        [row.id],
      );
      return {
        kind: 'action_review',
        status: 'stale_noop',
        schedule: publicSchedule(stale.rows[0] ?? row),
      };
    }));
  }

  finalizeJob(input: {
    jobId: string;
    question: string;
    result: CommerceAgentRunResponse;
  }): Promise<'completed' | 'already_completed' | 'stale_noop'> {
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const selected = await client.query<ScheduleRow>(
        `SELECT * FROM commerce_action_review_schedules
         WHERE job_id = $1
         FOR UPDATE`,
        [input.jobId],
      );
      const schedule = selected.rows[0];
      if (!schedule) throw new Error('Review Job is not bound to a schedule.');
      if (schedule.status === 'completed') return 'already_completed';
      if (schedule.status === 'stale_noop' || schedule.status === 'cancelled') return 'stale_noop';
      if (schedule.status !== 'running') throw new Error('Review schedule is not running.');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`commerce-action:${schedule.tenant_id}:${schedule.user_id}:${schedule.message_id}:${schedule.action_id}`],
      );
      const completed = await client.query<{
        run_id: string;
        details_json: unknown;
      }>(
        `SELECT completed.run_id, completed.details_json
         FROM commerce_agent_action_events AS completed
         WHERE completed.tenant_id = $1 AND completed.user_id = $2
           AND completed.message_id = $3 AND completed.action_id = $4
           AND completed.version = $5 AND completed.event_type = 'completed'
           AND NOT EXISTS (
             SELECT 1 FROM commerce_agent_action_events AS newer
             WHERE newer.tenant_id = completed.tenant_id
               AND newer.user_id = completed.user_id
               AND newer.message_id = completed.message_id
               AND newer.action_id = completed.action_id
               AND newer.version > completed.version
           )
         FOR UPDATE OF completed`,
        [
          schedule.tenant_id,
          schedule.user_id,
          schedule.message_id,
          schedule.action_id,
          integer(schedule.state_version),
        ],
      );
      if (!completed.rows[0]) {
        await client.query(
          `UPDATE commerce_action_review_schedules
           SET status = 'stale_noop', updated_at = NOW()
           WHERE id = $1 AND status = 'running'`,
          [schedule.id],
        );
        return 'stale_noop';
      }
      const runId = input.result.assistantMessage.runId;
      if (!runId) throw new Error('Review Job completed without an assistant Run.');
      const answer = commerceAgentAnswerSchema.safeParse(input.result.assistantMessage.answer);
      const contract = reviewContract(schedule.review_contract_json);
      const verdict = evaluateCommerceReviewVerdict({
        contract,
        answer: answer.success ? answer.data : null,
      });
      const ranges = reviewRanges(contract);
      const unavailableGuardrails = verdict.guardrails
        .filter((guardrail) => !guardrail.available)
        .map((guardrail) => guardrail.metric);
      const plan = {
        status: 'ready' as const,
        message: '自动复盘窗口与数据水位均已满足。',
        question: input.question,
        current: ranges.current,
        baseline: ranges.baseline,
        reviewEnd: ranges.current.end,
        unavailableGuardrails,
      };
      const requestId = `auto-review:${schedule.id}`;
      const reviewPayload = {
        conversationId: schedule.conversation_id,
        sourceMessageId: schedule.message_id,
        actionId: schedule.action_id,
        submission: {
          runId,
          reviewMessageId: input.result.assistantMessage.id,
          question: input.question,
          plan,
          requestId,
        },
      };
      await client.query(
        `INSERT INTO commerce_agent_action_reviews
           (id, tenant_id, user_id, conversation_id, source_message_id, action_id,
            source_run_id, review_run_id, review_message_id, request_id, request_sha256,
            question, plan_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb)
         ON CONFLICT (tenant_id, user_id, request_id) DO NOTHING`,
        [
          `review_${randomUUID()}`,
          schedule.tenant_id,
          schedule.user_id,
          schedule.conversation_id,
          schedule.message_id,
          schedule.action_id,
          completed.rows[0].run_id,
          runId,
          input.result.assistantMessage.id,
          requestId,
          sha256(reviewPayload),
          input.question,
          JSON.stringify(plan),
        ],
      );
      const previousDetails = record(completed.rows[0].details_json) ?? {};
      const actionEvent = {
        scheduleId: schedule.id,
        jobId: input.jobId,
        runId,
        verdict: verdict.verdict,
      };
      await client.query(
        `INSERT INTO commerce_agent_action_events
           (tenant_id, user_id, conversation_id, message_id, run_id, action_id,
            event_type, version, actor_user_id, actor_display_name,
            idempotency_key, request_sha256, details_json)
         VALUES ($1, $2, $3, $4, $5, $6, 'reviewed', $7,
                 'system:commerce-review', 'Commerce 自动复盘', $8, $9, $10::jsonb)
         ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING`,
        [
          schedule.tenant_id,
          schedule.user_id,
          schedule.conversation_id,
          schedule.message_id,
          completed.rows[0].run_id,
          schedule.action_id,
          integer(schedule.state_version) + 1,
          `auto-reviewed:${schedule.id}`,
          sha256(actionEvent),
          JSON.stringify({ ...previousDetails, review: actionEvent }),
        ],
      );
      const updated = await client.query(
        `UPDATE commerce_action_review_schedules
         SET status = 'completed', verdict_json = $2::jsonb,
             review_run_id = $3, review_message_id = $4,
             reviewed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status = 'running'
           AND action_version = $5 AND state_version = $6
           AND effective_window_sha256 = $7
         RETURNING id`,
        [
          schedule.id,
          JSON.stringify(verdict),
          runId,
          input.result.assistantMessage.id,
          integer(schedule.action_version),
          integer(schedule.state_version),
          schedule.effective_window_sha256,
        ],
      );
      if (!updated.rowCount) throw new Error('Review schedule lost its completion fence.');
      return 'completed';
    }));
  }

  markJobFailed(jobId: string): Promise<void> {
    return withCommerceControlSystem(async () => {
      await this.database.query(
        `UPDATE commerce_action_review_schedules
         SET status = 'failed', updated_at = NOW()
         WHERE job_id = $1 AND status IN ('queued', 'running')`,
        [jobId],
      );
    });
  }

  compareAndSetStatus(input: {
    scheduleId: string;
    actionVersion: number;
    stateVersion: number;
    windowHash: string;
    from: 'queued' | 'running';
    to: 'running' | 'completed';
  }): Promise<'updated' | 'stale_noop'> {
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const updated = await client.query(
        `UPDATE commerce_action_review_schedules AS schedule
         SET status = $6, updated_at = NOW()
         WHERE schedule.id = $1
           AND schedule.action_version = $2
           AND schedule.state_version = $3
           AND schedule.effective_window_sha256 = $4
           AND schedule.status = $5
           AND EXISTS (
             SELECT 1 FROM commerce_agent_action_events AS event
             WHERE event.tenant_id = schedule.tenant_id
               AND event.user_id = schedule.user_id
               AND event.message_id = schedule.message_id
               AND event.action_id = schedule.action_id
               AND event.version = schedule.state_version
               AND event.event_type = 'completed'
               AND NOT EXISTS (
                 SELECT 1 FROM commerce_agent_action_events AS newer
                 WHERE newer.tenant_id = event.tenant_id
                   AND newer.user_id = event.user_id
                   AND newer.message_id = event.message_id
                   AND newer.action_id = event.action_id
                   AND newer.version > event.version
               )
           )
         RETURNING schedule.id`,
        [
          input.scheduleId,
          input.actionVersion,
          input.stateVersion,
          input.windowHash,
          input.from,
          input.to,
        ],
      );
      if (updated.rowCount) return 'updated';
      await client.query(
        `UPDATE commerce_action_review_schedules
         SET status = 'stale_noop', updated_at = NOW()
         WHERE id = $1 AND status = $2`,
        [input.scheduleId, input.from],
      );
      return 'stale_noop';
    }));
  }
}

let singleton: PostgresCommerceReviewScheduler | null = null;

export function getCommerceReviewScheduler(): PostgresCommerceReviewScheduler {
  if (!singleton || process.env.NODE_ENV === 'test') {
    singleton = new PostgresCommerceReviewScheduler(
      getCommerceControlDatabase(),
      getCommerceAnalyticsDatabase(),
    );
  }
  return singleton;
}

import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  COMMERCE_NOTIFICATION_WRITE_SCOPE,
  CommerceAuthorizationError,
  assertCommerceScope,
} from './auth';
import { getCommerceAgentRuntimeConfig } from './config';
import type { CommerceDatabase } from './database';
import {
  getCommerceControlDatabase,
  withCommerceControlIdentity,
  withCommerceControlSystem,
} from './database';
import { commerceAgentAnswerSchema, type CommerceIdentity } from './types';

const referenceSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);

export const commerceFeishuApprovalSchema = z.object({
  expectedActionVersion: z.number().int().min(1).max(1_000_000),
  recipientMemberId: z.string().regex(/^member_[A-Za-z0-9._:-]{4,120}$/u),
  requestId: referenceSchema,
}).strict();

export type CommerceFeishuApprovalInput = z.infer<typeof commerceFeishuApprovalSchema>;

export interface CommerceTenantMember {
  memberId: string;
  displayName: string;
  canReceiveNotifications: boolean;
}

export interface CommerceFeishuOutboxReceipt {
  id: string;
  actionId: string;
  actionVersion: number;
  recipientMemberId: string;
  recipientDisplayName: string;
  requestUuid: string;
  status: 'pending' | 'sending' | 'delivered' | 'retryable' | 'delivery_unknown' | 'failed_permanent';
  providerMessageId: string | null;
  createdAt: string;
}

interface SourceRow extends Record<string, unknown> {
  answer_json: unknown;
  run_id: string;
}

interface ActionEventRow extends Record<string, unknown> {
  event_type: string;
  version: unknown;
}

interface MemberRow extends Record<string, unknown> {
  member_id: string;
  display_name: string;
  feishu_open_id?: string;
  can_receive_notifications: unknown;
}

interface OutboxRow extends Record<string, unknown> {
  id: string;
  action_id: string;
  action_version: unknown;
  recipient_member_id: string;
  recipient_display_name?: string;
  request_uuid: unknown;
  status: CommerceFeishuOutboxReceipt['status'];
  provider_message_id: string | null;
  created_at: unknown;
  request_sha256?: string;
  feishu_open_id?: string;
  payload_json?: unknown;
  attempt_count?: unknown;
}

export class CommerceNotificationsDisabledError extends Error {
  readonly code = 'COMMERCE_NOTIFICATIONS_DISABLED';
  readonly status = 503;

  constructor() {
    super('飞书通知依赖尚未就绪，通知功能保持关闭。');
    this.name = 'CommerceNotificationsDisabledError';
  }
}

export class CommerceNotificationKillSwitchError extends Error {
  readonly code = 'COMMERCE_GLOBAL_KILL_SWITCH';
  readonly status = 503;

  constructor() {
    super('系统已暂停新的外部通知命令。');
    this.name = 'CommerceNotificationKillSwitchError';
  }
}

export class CommerceNotificationInvalidStateError extends Error {
  readonly code = 'COMMERCE_NOTIFICATION_INVALID_STATE';
  readonly status = 409;

  constructor(message = '只有当前版本已确认的行动可以发送通知。') {
    super(message);
    this.name = 'CommerceNotificationInvalidStateError';
  }
}

export class CommerceNotificationRecipientError extends Error {
  readonly code = 'COMMERCE_NOTIFICATION_RECIPIENT_INVALID';
  readonly status = 403;

  constructor() {
    super('收件人不是当前租户可用的飞书成员。');
    this.name = 'CommerceNotificationRecipientError';
  }
}

export class CommerceNotificationIdempotencyError extends Error {
  readonly code = 'COMMERCE_NOTIFICATION_IDEMPOTENCY_CONFLICT';
  readonly status = 409;

  constructor() {
    super('相同 requestId 已用于不同通知命令。');
    this.name = 'CommerceNotificationIdempotencyError';
  }
}

const SENSITIVE_PAYLOAD = /(?:sk-[A-Za-z0-9_-]{12,}|postgres(?:ql)?:\/\/|BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY|authorization\s*[:=]|report[_-]?token)/iu;

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function finiteVersion(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error('Invalid action version.');
  return parsed;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid outbox timestamp.');
  return date.toISOString();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function receipt(row: OutboxRow): CommerceFeishuOutboxReceipt {
  return {
    id: row.id,
    actionId: row.action_id,
    actionVersion: finiteVersion(row.action_version),
    recipientMemberId: row.recipient_member_id,
    recipientDisplayName: row.recipient_display_name ?? row.recipient_member_id,
    requestUuid: String(row.request_uuid),
    status: row.status,
    providerMessageId: row.provider_message_id ?? null,
    createdAt: iso(row.created_at),
  };
}

function enabledByEnvironment(): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    process.env.COMMERCE_FEISHU_NOTIFICATIONS_ENABLED?.trim().toLowerCase() ?? '',
  );
}

function allowedOperators(): Set<string> {
  return new Set((process.env.COMMERCE_FEISHU_OPERATOR_ALLOWLIST ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean));
}

export class PostgresCommerceFeishuOutboxStore {
  constructor(
    private readonly database: CommerceDatabase,
    private readonly options: {
      enabled?: boolean;
      publicOrigin?: string | null;
      operatorAllowlist?: ReadonlySet<string>;
      now?: () => Date;
    } = {},
  ) {}

  private assertEnabled(identity: CommerceIdentity): void {
    if (!(this.options.enabled ?? enabledByEnvironment())) throw new CommerceNotificationsDisabledError();
    assertCommerceScope(identity, COMMERCE_NOTIFICATION_WRITE_SCOPE);
    const allowlist = this.options.operatorAllowlist ?? allowedOperators();
    // Enabling an external side effect without an explicit operator set must never widen
    // authorization to every scoped user. Configuration is part of the security boundary.
    if (!allowlist.size || !allowlist.has(identity.userId)) {
      throw new CommerceAuthorizationError(
        'COMMERCE_NOTIFICATION_OPERATOR_REQUIRED',
        '外部通知授权名单未配置，或当前操作者不在授权名单中。',
        403,
      );
    }
  }

  private assertKillSwitchOff(): void {
    if (getCommerceAgentRuntimeConfig().globalKillSwitch) {
      throw new CommerceNotificationKillSwitchError();
    }
  }

  listMembers(identity: CommerceIdentity): Promise<CommerceTenantMember[]> {
    this.assertEnabled(identity);
    return withCommerceControlIdentity(identity, async () => {
      const result = await this.database.query<MemberRow>(
        `SELECT member_id, display_name, can_receive_notifications
         FROM commerce_tenant_members
         WHERE tenant_id = $1 AND active AND can_receive_notifications
           AND feishu_open_id IS NOT NULL
         ORDER BY display_name, member_id`,
        [identity.tenantId],
      );
      return result.rows.map((row) => ({
        memberId: row.member_id,
        displayName: row.display_name,
        canReceiveNotifications: row.can_receive_notifications === true,
      }));
    });
  }

  enqueueApprovedAction(
    identity: CommerceIdentity,
    input: CommerceFeishuApprovalInput & {
      conversationId: string;
      messageId: string;
      actionId: string;
    },
  ): Promise<CommerceFeishuOutboxReceipt> {
    this.assertEnabled(identity);
    return withCommerceControlIdentity(identity, () => this.database.transaction(async (client) => {
      // Keep this check inside the mutation transaction. Route-level or Worker-level checks
      // alone leave a path for a newly enabled global kill switch to enqueue an external write.
      this.assertKillSwitchOff();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `commerce-feishu-approval:${identity.tenantId}:${identity.userId}:${input.requestId}`,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `commerce-action:${identity.tenantId}:${identity.userId}:${input.messageId}:${input.actionId}`,
      ]);
      const source = await client.query<SourceRow>(
        `SELECT message.answer_json, message.run_id
         FROM commerce_agent_messages AS message
         JOIN commerce_agent_runs AS run
           ON run.id = message.run_id AND run.tenant_id = message.tenant_id
         WHERE message.id = $1 AND message.conversation_id = $2
           AND message.tenant_id = $3 AND message.user_id = $4
           AND message.role = 'assistant' AND run.status = 'completed'`,
        [input.messageId, input.conversationId, identity.tenantId, identity.userId],
      );
      const answer = commerceAgentAnswerSchema.safeParse(parseJson(source.rows[0]?.answer_json));
      const recommendation = answer.success
        ? answer.data.recommendations.find((entry) => entry.id === input.actionId)
        : null;
      if (!source.rows[0] || !recommendation) {
        throw new CommerceNotificationInvalidStateError('行动卡不存在或未完成。');
      }
      const latest = await client.query<ActionEventRow>(
        `SELECT event_type, version
         FROM commerce_agent_action_events
         WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3 AND action_id = $4
         ORDER BY version DESC LIMIT 1`,
        [identity.tenantId, identity.userId, input.messageId, input.actionId],
      );
      if (
        latest.rows[0]?.event_type !== 'confirmed'
        || finiteVersion(latest.rows[0].version) !== input.expectedActionVersion
      ) throw new CommerceNotificationInvalidStateError();

      const member = await client.query<MemberRow>(
        `SELECT member_id, display_name, feishu_open_id, can_receive_notifications
         FROM commerce_tenant_members
         WHERE tenant_id = $1 AND member_id = $2 AND active
           AND can_receive_notifications AND feishu_open_id IS NOT NULL`,
        [identity.tenantId, input.recipientMemberId],
      );
      if (!member.rows[0]) throw new CommerceNotificationRecipientError();
      const evidenceIds = [...new Set(recommendation.claims.map((claim) => claim.evidenceId))];
      const publicOrigin = this.options.publicOrigin?.replace(/\/$/u, '')
        ?? process.env.COMMERCE_PUBLIC_ORIGIN?.trim().replace(/\/$/u, '')
        ?? null;
      const payload = {
        schemaVersion: 1,
        kind: 'commerce_action_approved',
        actionId: input.actionId,
        actionVersion: input.expectedActionVersion,
        action: recommendation.action,
        rationale: recommendation.rationale,
        priority: recommendation.priority ?? 'medium',
        deadline: recommendation.deadline ?? null,
        evidenceIds,
        backlink: publicOrigin
          ? `${publicOrigin}/commerce?conversation=${encodeURIComponent(input.conversationId)}&message=${encodeURIComponent(input.messageId)}`
          : null,
      };
      if (SENSITIVE_PAYLOAD.test(JSON.stringify(payload))) {
        throw new CommerceNotificationInvalidStateError('通知内容触发敏感信息过滤。');
      }
      const requestSha256 = sha256({
        ...input,
        tenantId: identity.tenantId,
        userId: identity.userId,
        payload,
      });
      const replay = await client.query<OutboxRow>(
        `SELECT outbox.id, outbox.action_id, outbox.action_version,
                outbox.recipient_member_id, member.display_name AS recipient_display_name,
                outbox.request_uuid, outbox.status, outbox.provider_message_id,
                outbox.created_at, outbox.request_sha256
         FROM commerce_feishu_notification_outbox AS outbox
         JOIN commerce_tenant_members AS member
           ON member.tenant_id = outbox.tenant_id
          AND member.member_id = outbox.recipient_member_id
         WHERE outbox.tenant_id = $1 AND outbox.user_id = $2
           AND outbox.approval_request_id = $3`,
        [identity.tenantId, identity.userId, input.requestId],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_sha256 !== requestSha256) {
          throw new CommerceNotificationIdempotencyError();
        }
        return receipt(replay.rows[0]);
      }
      const existing = await client.query<OutboxRow>(
        `SELECT outbox.id, outbox.action_id, outbox.action_version,
                outbox.recipient_member_id, member.display_name AS recipient_display_name,
                outbox.request_uuid, outbox.status, outbox.provider_message_id,
                outbox.created_at, outbox.request_sha256
         FROM commerce_feishu_notification_outbox AS outbox
         JOIN commerce_tenant_members AS member
           ON member.tenant_id = outbox.tenant_id
          AND member.member_id = outbox.recipient_member_id
         WHERE outbox.tenant_id = $1 AND outbox.action_id = $2
           AND outbox.action_version = $3 AND outbox.channel = 'feishu'`,
        [identity.tenantId, input.actionId, input.expectedActionVersion],
      );
      if (existing.rows[0]) return receipt(existing.rows[0]);

      const outboxId = `outbox_${randomUUID()}`;
      const requestUuid = randomUUID();
      // Re-read at the write edge as the preceding ownership/action/member checks await I/O.
      // If operators activate the switch while those reads are in flight, this transaction
      // rolls back without creating either the command or its approval event.
      this.assertKillSwitchOff();
      const inserted = await client.query<OutboxRow>(
        `INSERT INTO commerce_feishu_notification_outbox
           (id, tenant_id, user_id, conversation_id, message_id, action_id,
            action_version, recipient_member_id, request_uuid, approval_request_id,
            request_sha256, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::uuid, $10, $11, $12::jsonb)
         RETURNING id, action_id, action_version, recipient_member_id,
                   request_uuid, status, provider_message_id, created_at`,
        [
          outboxId,
          identity.tenantId,
          identity.userId,
          input.conversationId,
          input.messageId,
          input.actionId,
          input.expectedActionVersion,
          member.rows[0].member_id,
          requestUuid,
          input.requestId,
          requestSha256,
          JSON.stringify(payload),
        ],
      );
      await client.query(
        `INSERT INTO commerce_feishu_notification_events
           (outbox_id, tenant_id, user_id, event_type, actor_user_id, details_json)
         VALUES ($1, $2, $3, 'approved', $3, $4::jsonb)`,
        [outboxId, identity.tenantId, identity.userId, JSON.stringify({ requestUuid })],
      );
      return receipt({
        ...inserted.rows[0],
        recipient_display_name: member.rows[0].display_name,
      });
    }));
  }

  claim(workerId: string, leaseMs = 60_000): Promise<(CommerceFeishuOutboxReceipt & {
    recipientOpenId: string;
    payload: Record<string, unknown>;
    attempts: number;
  }) | null> {
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      // A process can die after handing the request to Feishu but before recording its result.
      // Once that delivery lease expires, the only safe automatic outcome is delivery_unknown:
      // retrying it as pending could create an observable duplicate message.
      await client.query(
        `WITH expired AS (
           UPDATE commerce_feishu_notification_outbox AS outbox
           SET status = 'delivery_unknown',
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error = 'Delivery worker lease expired; provider outcome is unknown.',
               updated_at = NOW()
           WHERE outbox.status = 'sending'
             AND outbox.lease_expires_at < clock_timestamp()
           RETURNING outbox.id, outbox.tenant_id, outbox.user_id,
                     outbox.attempt_count
         )
         INSERT INTO commerce_feishu_notification_events
           (outbox_id, tenant_id, user_id, event_type, actor_user_id, details_json)
         SELECT id, tenant_id, user_id, 'delivery_unknown', $1,
                jsonb_build_object(
                  'reason', 'delivery_lease_expired',
                  'attempt', attempt_count
                )
         FROM expired`,
        [workerId],
      );

      // Authorization is checked again at delivery claim time. Commands whose stable member
      // mapping was revoked must become an audited permanent failure, never a stuck `sending`
      // row and never an external write to a de-authorized recipient.
      await client.query(
        `WITH revoked AS (
           UPDATE commerce_feishu_notification_outbox AS outbox
           SET status = 'failed_permanent',
               lease_owner = NULL,
               lease_expires_at = NULL,
               last_error = 'Recipient authorization was revoked before delivery.',
               updated_at = NOW()
           FROM commerce_tenant_members AS member
           WHERE outbox.tenant_id = member.tenant_id
             AND outbox.recipient_member_id = member.member_id
             AND outbox.status IN ('pending', 'retryable')
             AND NOT (
               member.active
               AND member.can_receive_notifications
               AND member.feishu_open_id IS NOT NULL
             )
           RETURNING outbox.id, outbox.tenant_id, outbox.user_id
         )
         INSERT INTO commerce_feishu_notification_events
           (outbox_id, tenant_id, user_id, event_type, actor_user_id, details_json)
         SELECT id, tenant_id, user_id, 'failed_permanent', $1,
                jsonb_build_object('reason', 'recipient_authorization_revoked')
         FROM revoked`,
        [workerId],
      );

      const result = await client.query<OutboxRow>(
        `WITH candidate AS (
           SELECT outbox.id
           FROM commerce_feishu_notification_outbox AS outbox
           JOIN commerce_tenant_members AS member
             ON member.tenant_id = outbox.tenant_id
            AND member.member_id = outbox.recipient_member_id
            AND member.active
            AND member.can_receive_notifications
            AND member.feishu_open_id IS NOT NULL
           WHERE outbox.status IN ('pending', 'retryable')
             AND outbox.available_at <= NOW()
           ORDER BY outbox.available_at, outbox.created_at
           FOR UPDATE OF outbox SKIP LOCKED
           LIMIT 1
         ), claimed AS (
           UPDATE commerce_feishu_notification_outbox AS outbox
           SET status = 'sending', attempt_count = attempt_count + 1,
               lease_owner = $1, lease_expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
               updated_at = NOW(), last_error = NULL
           FROM candidate
           WHERE outbox.id = candidate.id
           RETURNING outbox.*
         )
         SELECT claimed.*, member.display_name AS recipient_display_name,
                member.feishu_open_id
         FROM claimed
         JOIN commerce_tenant_members AS member
           ON member.tenant_id = claimed.tenant_id
           AND member.member_id = claimed.recipient_member_id
           AND member.active
           AND member.can_receive_notifications
           AND member.feishu_open_id IS NOT NULL`,
        [workerId, leaseMs],
      );
      const row = result.rows[0];
      if (!row?.feishu_open_id) return null;
      await client.query(
        `INSERT INTO commerce_feishu_notification_events
           (outbox_id, tenant_id, user_id, event_type, actor_user_id, details_json)
         SELECT id, tenant_id, user_id, 'claimed', $2, jsonb_build_object('attempt', attempt_count)
         FROM commerce_feishu_notification_outbox WHERE id = $1`,
        [row.id, workerId],
      );
      return {
        ...receipt(row),
        recipientOpenId: row.feishu_open_id,
        payload: (parseJson(row.payload_json) ?? {}) as Record<string, unknown>,
        attempts: Number(row.attempt_count ?? 0),
      };
    }));
  }

  completeDelivery(input: {
    outboxId: string;
    workerId: string;
    outcome: 'delivered' | 'retryable' | 'delivery_unknown' | 'failed_permanent';
    providerMessageId?: string;
    error?: string;
    retryAfterMs?: number;
  }): Promise<boolean> {
    return withCommerceControlSystem(() => this.database.transaction(async (client) => {
      const terminal = input.outcome === 'delivered';
      const result = await client.query<OutboxRow>(
        `UPDATE commerce_feishu_notification_outbox
         SET status = $3,
             provider_message_id = CASE WHEN $3 = 'delivered' THEN $4 ELSE provider_message_id END,
             delivered_at = CASE WHEN $3 = 'delivered' THEN NOW() ELSE NULL END,
             last_error = $5,
             available_at = CASE WHEN $3 = 'retryable'
               THEN NOW() + ($6::bigint * INTERVAL '1 millisecond') ELSE available_at END,
             lease_owner = NULL, lease_expires_at = NULL, updated_at = NOW()
         WHERE id = $1 AND status = 'sending' AND lease_owner = $2
         RETURNING id, action_id, action_version, recipient_member_id,
                   request_uuid, status, provider_message_id, created_at`,
        [
          input.outboxId,
          input.workerId,
          input.outcome,
          input.providerMessageId ?? null,
          input.error?.slice(0, 1_000) ?? null,
          Math.max(1_000, Math.min(input.retryAfterMs ?? 5_000, 600_000)),
        ],
      );
      if (!result.rows[0]) return false;
      await client.query(
        `INSERT INTO commerce_feishu_notification_events
           (outbox_id, tenant_id, user_id, event_type, actor_user_id, details_json)
         SELECT id, tenant_id, user_id, $2, $3,
                jsonb_build_object('providerMessageId', $4::text, 'error', $5::text)
         FROM commerce_feishu_notification_outbox WHERE id = $1`,
        [
          input.outboxId,
          input.outcome,
          input.workerId,
          input.providerMessageId ?? null,
          input.error?.slice(0, 1_000) ?? null,
        ],
      );
      void terminal;
      return true;
    }));
  }
}

export type FeishuSendResult =
  | { status: 'delivered'; providerMessageId: string }
  | { status: 'retryable'; error: string; retryAfterMs: number }
  | { status: 'delivery_unknown'; error: string }
  | { status: 'failed_permanent'; error: string };

export class FeishuNotificationClient {
  constructor(private readonly options: {
    appId: string;
    appSecret: string;
    baseUrl?: string;
    fetch?: typeof fetch;
  }) {}

  async send(input: {
    recipientOpenId: string;
    requestUuid: string;
    payload: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<FeishuSendResult> {
    const fetcher = this.options.fetch ?? fetch;
    const baseUrl = (this.options.baseUrl ?? 'https://open.feishu.cn').replace(/\/$/u, '');
    let token: string;
    try {
      const response = await fetcher(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: this.options.appId, app_secret: this.options.appSecret }),
        signal: input.signal,
      });
      const body = await response.json() as { tenant_access_token?: unknown; msg?: unknown };
      if (!response.ok || typeof body.tenant_access_token !== 'string') {
        return response.status === 429 || response.status >= 500
          ? { status: 'retryable', error: `Feishu token HTTP ${response.status}`, retryAfterMs: 5_000 }
          : { status: 'failed_permanent', error: `Feishu token rejected: ${String(body.msg ?? response.status)}` };
      }
      token = body.tenant_access_token;
    } catch (error) {
      return { status: 'retryable', error: error instanceof Error ? error.message : 'Feishu token request failed', retryAfterMs: 5_000 };
    }

    const content = JSON.stringify({
      text: [
        String(input.payload.action ?? '经营行动'),
        String(input.payload.rationale ?? ''),
        input.payload.deadline ? `截止：${String(input.payload.deadline)}` : '',
        input.payload.backlink ? `查看：${String(input.payload.backlink)}` : '',
      ].filter(Boolean).join('\n'),
    });
    try {
      const response = await fetcher(
        `${baseUrl}/open-apis/im/v1/messages?receive_id_type=open_id`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'X-Request-Id': input.requestUuid,
          },
          body: JSON.stringify({
            receive_id: input.recipientOpenId,
            msg_type: 'text',
            content,
            uuid: input.requestUuid,
          }),
          signal: input.signal,
        },
      );
      const body = await response.json() as {
        code?: unknown;
        msg?: unknown;
        data?: { message_id?: unknown };
      };
      if (response.ok && Number(body.code ?? 0) === 0 && typeof body.data?.message_id === 'string') {
        return { status: 'delivered', providerMessageId: body.data.message_id };
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfterSeconds = Number(response.headers.get('retry-after') ?? 5);
        return {
          status: 'retryable',
          error: `Feishu message HTTP ${response.status}`,
          retryAfterMs: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds * 1_000 : 5_000,
        };
      }
      return { status: 'failed_permanent', error: `Feishu message rejected: ${String(body.msg ?? response.status)}` };
    } catch (error) {
      // Once the message request was handed to fetch, a timeout may have happened after
      // Feishu accepted it. Stop blind retries until request UUID/message ID reconciliation.
      return {
        status: 'delivery_unknown',
        error: error instanceof Error ? error.message : 'Feishu delivery outcome is unknown',
      };
    }
  }
}

let singleton: PostgresCommerceFeishuOutboxStore | null = null;

export function getCommerceFeishuOutboxStore(): PostgresCommerceFeishuOutboxStore {
  if (!singleton || process.env.NODE_ENV === 'test') {
    singleton = new PostgresCommerceFeishuOutboxStore(getCommerceControlDatabase());
  }
  return singleton;
}

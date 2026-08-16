import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { CommerceDatabase } from './database';
import {
  getCommerceControlDatabase,
  withCommerceControlIdentity,
  withCommerceControlSystem,
} from './database';
import {
  CommerceReportNotFoundError,
  parseStoredReportManifest,
  type ReportManifestV1,
  type ReportRow,
} from './report-store';
import type { CommerceIdentity } from './types';

export const COMMERCE_REPORT_SHARE_TOKEN_BYTES = 32;
export const COMMERCE_REPORT_SHARE_DEFAULT_HOURS = 24;
export const COMMERCE_REPORT_SHARE_MAX_HOURS = 168;

export interface CommerceReportShare {
  id: string;
  reportId: string;
  conversationId: string;
  messageId: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface CommerceCreatedReportShare extends CommerceReportShare {
  token: string;
}

export interface CommerceSharedReport {
  share: CommerceReportShare;
  report: ReportManifestV1;
}

type ShareRow = Record<string, unknown> & {
  id: string;
  report_id: string;
  conversation_id?: string;
  message_id?: string;
  created_at: unknown;
  expires_at: unknown;
  revoked_at: unknown;
};

type SharedReportRow = ShareRow & ReportRow & {
  report_row_id: string;
  report_tenant_id: string;
  report_user_id: string;
  report_conversation_id: string;
  report_message_id: string;
  report_run_id: string;
  report_schema_version: unknown;
  report_release_revision: string;
  report_manifest_json: unknown;
  report_content_sha256: string;
};

const REPORT_COLUMNS = `report.id, report.tenant_id, report.user_id,
  report.conversation_id, report.message_id, report.run_id, report.schema_version,
  report.release_revision, report.manifest_json, report.content_sha256`;

export class CommerceReportShareNotFoundError extends Error {
  readonly code = 'COMMERCE_REPORT_SHARE_NOT_FOUND';

  constructor() {
    super('分享链接不存在、已过期、已撤销，或报告已删除。');
    this.name = 'CommerceReportShareNotFoundError';
  }
}

export class CommerceReportShareInvalidError extends Error {
  readonly code = 'COMMERCE_REPORT_SHARE_INVALID';

  constructor(message = '分享链接参数无效。') {
    super(message);
    this.name = 'CommerceReportShareInvalidError';
  }
}

function iso(value: unknown, field: string): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error(`Database returned an invalid ${field}.`);
  return date.toISOString();
}

function share(
  row: ShareRow,
  defaults?: { conversationId?: string; messageId?: string },
): CommerceReportShare {
  const conversationId = row.conversation_id ?? defaults?.conversationId;
  const messageId = row.message_id ?? defaults?.messageId;
  if (!conversationId || !messageId) throw new Error('Database returned an incomplete report share.');
  return {
    id: row.id,
    reportId: row.report_id,
    conversationId,
    messageId,
    createdAt: iso(row.created_at, 'share created_at'),
    expiresAt: iso(row.expires_at, 'share expires_at'),
    revokedAt: row.revoked_at === null || row.revoked_at === undefined
      ? null
      : iso(row.revoked_at, 'share revoked_at'),
  };
}

function assertHours(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > COMMERCE_REPORT_SHARE_MAX_HOURS) {
    throw new CommerceReportShareInvalidError(
      `分享有效期必须是 1-${COMMERCE_REPORT_SHARE_MAX_HOURS} 小时。`,
    );
  }
  return value;
}

export function commerceReportShareTokenSha256(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) {
    throw new CommerceReportShareInvalidError();
  }
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

function newToken(): string {
  return randomBytes(COMMERCE_REPORT_SHARE_TOKEN_BYTES).toString('base64url');
}

export class PostgresCommerceReportShareStore {
  constructor(private readonly database: CommerceDatabase) {}

  async createShare(input: {
    identity: CommerceIdentity;
    conversationId: string;
    messageId: string;
    expiresInHours?: number;
  }): Promise<CommerceCreatedReportShare> {
    const expiresInHours = assertHours(
      input.expiresInHours ?? COMMERCE_REPORT_SHARE_DEFAULT_HOURS,
    );
    return withCommerceControlIdentity(input.identity, () => this.database.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`commerce-report-share:${input.identity.tenantId}:${input.identity.userId}:${input.messageId}`],
      );
      const reportResult = await client.query<ReportRow>(
        `SELECT ${REPORT_COLUMNS}
         FROM commerce_agent_reports AS report
         JOIN commerce_agent_messages AS message
           ON message.id = report.message_id
          AND message.conversation_id = report.conversation_id
          AND message.tenant_id = report.tenant_id
          AND message.user_id = report.user_id
          AND message.run_id = report.run_id
         JOIN commerce_agent_runs AS run
           ON run.id = report.run_id
          AND run.conversation_id = report.conversation_id
          AND run.tenant_id = report.tenant_id
          AND run.user_id = report.user_id
         WHERE report.conversation_id = $1 AND report.message_id = $2
           AND report.tenant_id = $3 AND report.user_id = $4
           AND message.role = 'assistant' AND run.status = 'completed'`,
        [input.conversationId, input.messageId, input.identity.tenantId, input.identity.userId],
      );
      const reportRow = reportResult.rows[0];
      if (!reportRow) throw new CommerceReportNotFoundError();
      parseStoredReportManifest(reportRow);

      const token = newToken();
      const inserted = await client.query<ShareRow>(
        `INSERT INTO commerce_agent_report_shares
           (id, report_id, tenant_id, user_id, token_sha256, expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + ($6::integer * INTERVAL '1 hour'))
         RETURNING id, report_id, created_at, expires_at, revoked_at`,
        [
          `share_${randomUUID()}`,
          reportRow.id,
          input.identity.tenantId,
          input.identity.userId,
          commerceReportShareTokenSha256(token),
          expiresInHours,
        ],
      );
      if (!inserted.rows[0]) throw new Error('Report share was not persisted.');
      return {
        ...share(inserted.rows[0], {
          conversationId: input.conversationId,
          messageId: input.messageId,
        }),
        token,
      };
    }));
  }

  async getActiveShare(
    identity: CommerceIdentity,
    conversationId: string,
    messageId: string,
  ): Promise<CommerceReportShare | null> {
    return withCommerceControlIdentity(identity, async () => {
      const result = await this.database.query<ShareRow>(
        `SELECT share.id, share.report_id, report.conversation_id, report.message_id,
                share.created_at, share.expires_at, share.revoked_at
         FROM commerce_agent_report_shares AS share
         JOIN commerce_agent_reports AS report
           ON report.id = share.report_id
          AND report.tenant_id = share.tenant_id
          AND report.user_id = share.user_id
         WHERE share.tenant_id = $1 AND share.user_id = $2
           AND report.conversation_id = $3 AND report.message_id = $4
           AND share.revoked_at IS NULL
           AND share.expires_at > clock_timestamp()
         ORDER BY share.created_at DESC
         LIMIT 1`,
        [identity.tenantId, identity.userId, conversationId, messageId],
      );
      return result.rows[0] ? share(result.rows[0]) : null;
    });
  }

  async revokeShare(
    identity: CommerceIdentity,
    shareId: string,
    scope?: { conversationId: string; messageId: string },
  ): Promise<CommerceReportShare> {
    return withCommerceControlIdentity(identity, () => this.database.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`commerce-report-share-id:${identity.tenantId}:${identity.userId}:${shareId}`],
      );
      const scopeSql = scope
        ? ' AND report.conversation_id = $4 AND report.message_id = $5'
        : '';
      const scopeValues = scope ? [scope.conversationId, scope.messageId] : [];
      const existing = await client.query<ShareRow>(
        `SELECT share.id, share.report_id, report.conversation_id, report.message_id,
                share.created_at, share.expires_at, share.revoked_at
         FROM commerce_agent_report_shares AS share
         JOIN commerce_agent_reports AS report
           ON report.id = share.report_id
          AND report.tenant_id = share.tenant_id
          AND report.user_id = share.user_id
         WHERE share.id = $1 AND share.tenant_id = $2 AND share.user_id = $3${scopeSql}`,
        [shareId, identity.tenantId, identity.userId, ...scopeValues],
      );
      if (!existing.rows[0]) throw new CommerceReportShareNotFoundError();
      if (existing.rows[0].revoked_at !== null && existing.rows[0].revoked_at !== undefined) {
        return share(existing.rows[0]);
      }
      const revoked = await client.query<ShareRow>(
        `UPDATE commerce_agent_report_shares
         SET revoked_at = clock_timestamp()
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND revoked_at IS NULL
         RETURNING id, report_id, created_at, expires_at, revoked_at`,
        [shareId, identity.tenantId, identity.userId],
      );
      if (!revoked.rows[0]) throw new CommerceReportShareNotFoundError();
      return share(revoked.rows[0], {
        conversationId: existing.rows[0].conversation_id,
        messageId: existing.rows[0].message_id,
      });
    }));
  }

  async getSharedReport(token: string): Promise<CommerceSharedReport> {
    const tokenSha256 = commerceReportShareTokenSha256(token);
    return withCommerceControlSystem(async () => {
      const result = await this.database.query<SharedReportRow>(
        `SELECT share.id, share.report_id, report.conversation_id, report.message_id,
                share.created_at, share.expires_at, share.revoked_at,
                report.id AS report_row_id, report.tenant_id AS report_tenant_id,
                report.user_id AS report_user_id,
                report.conversation_id AS report_conversation_id,
                report.message_id AS report_message_id,
                report.run_id AS report_run_id,
                report.schema_version AS report_schema_version,
                report.release_revision AS report_release_revision,
                report.manifest_json AS report_manifest_json,
                report.content_sha256 AS report_content_sha256
         FROM commerce_agent_report_shares AS share
         JOIN commerce_agent_reports AS report
           ON report.id = share.report_id
          AND report.tenant_id = share.tenant_id
          AND report.user_id = share.user_id
         JOIN commerce_agent_messages AS message
           ON message.id = report.message_id
          AND message.conversation_id = report.conversation_id
          AND message.tenant_id = report.tenant_id
          AND message.user_id = report.user_id
          AND message.run_id = report.run_id
         JOIN commerce_agent_runs AS run
           ON run.id = report.run_id
          AND run.conversation_id = report.conversation_id
          AND run.tenant_id = report.tenant_id
          AND run.user_id = report.user_id
         WHERE share.token_sha256 = $1
           AND share.revoked_at IS NULL
           AND share.expires_at > clock_timestamp()
           AND message.role = 'assistant' AND run.status = 'completed'
         LIMIT 1`,
        [tokenSha256],
      );
      const row = result.rows[0];
      if (!row) throw new CommerceReportShareNotFoundError();
      const report = parseStoredReportManifest({
        id: row.report_row_id,
        tenant_id: row.report_tenant_id,
        user_id: row.report_user_id,
        conversation_id: row.report_conversation_id,
        message_id: row.report_message_id,
        run_id: row.report_run_id,
        schema_version: row.report_schema_version,
        release_revision: row.report_release_revision,
        manifest_json: row.report_manifest_json,
        content_sha256: row.report_content_sha256,
      });
      return { share: share(row), report };
    });
  }
}

let singleton: PostgresCommerceReportShareStore | null = null;

export function getCommerceReportShareStore(): PostgresCommerceReportShareStore {
  if (!singleton || process.env.NODE_ENV === 'test') {
    singleton = new PostgresCommerceReportShareStore(getCommerceControlDatabase());
  }
  return singleton;
}

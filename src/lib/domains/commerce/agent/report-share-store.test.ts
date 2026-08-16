import { describe, expect, it } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import {
  buildReportArtifact,
  type BuildReportArtifactInput,
} from './report-store';
import {
  CommerceReportShareInvalidError,
  CommerceReportShareNotFoundError,
  commerceReportShareTokenSha256,
  PostgresCommerceReportShareStore,
} from './report-share-store';
import type { CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_share',
  userId: 'operator_share',
  displayName: 'Share operator',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};

const reportInput: BuildReportArtifactInput = {
  reportId: 'report_1234567890123456',
  releaseRevision: '0123456789abcdef0123456789abcdef01234567',
  createdAt: '2026-08-13T03:05:00.000Z',
  identity,
  conversation: { id: 'conv_1234567890123456', title: '分享测试报告' },
  run: {
    id: 'run_1234567890123456', requestId: 'request:share-1',
    requestSha256: `sha256:${'a'.repeat(64)}`, model: 'deepseek-v4-flash', provider: 'deepseek',
    startedAt: '2026-08-13T03:00:00.000Z', completedAt: '2026-08-13T03:04:59.000Z',
  },
  question: {
    messageId: 'msg_question_1234567890123456', content: '查看经营结论。',
    createdAt: '2026-08-13T03:00:00.000Z',
  },
  answer: {
    messageId: 'msg_answer_1234567890123456', content: 'GMV 为 100 元。',
    createdAt: '2026-08-13T03:04:59.000Z',
    structured: {
      status: 'answered', answer: 'GMV 为 100 元。', answerClaims: [], findings: [],
      recommendations: [], followUps: [],
    },
  },
  traces: [],
};

const report = buildReportArtifact(reportInput);

function result(rows: Record<string, unknown>[] = []): CommerceQueryResult<Record<string, unknown>> {
  return { rows, rowCount: rows.length };
}

class ScriptedDatabase implements CommerceDatabase {
  readonly calls: Array<{ text: string; values: readonly unknown[] }> = [];
  constructor(private readonly execute: (
    text: string,
    values: readonly unknown[],
  ) => CommerceQueryResult<Record<string, unknown>>) {}
  query<Row extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<CommerceQueryResult<Row>> {
    this.calls.push({ text, values });
    return Promise.resolve(this.execute(text, values) as CommerceQueryResult<Row>);
  }
  transaction<T>(work: (client: CommerceSqlClient) => Promise<T>): Promise<T> { return work(this); }
  async ping(): Promise<void> {}
}

function reportRow() {
  return {
    id: report.reportId,
    tenant_id: report.owner.tenantId,
    user_id: report.owner.userId,
    conversation_id: report.conversation.id,
    message_id: report.answer.messageId,
    run_id: report.run.id,
    schema_version: report.schemaVersion,
    release_revision: report.releaseRevision,
    manifest_json: report,
    content_sha256: report.contentSha256,
  };
}

function shareRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'share_1234567890123456',
    report_id: report.reportId,
    conversation_id: report.conversation.id,
    message_id: report.answer.messageId,
    created_at: '2026-08-13T04:00:00.000Z',
    expires_at: '2026-08-14T04:00:00.000Z',
    revoked_at: null,
    ...overrides,
  };
}

describe('Commerce report shares', () => {
  it('hashes only the capability token and rejects malformed tokens', () => {
    const token = 'A'.repeat(43);
    expect(commerceReportShareTokenSha256(token)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(() => commerceReportShareTokenSha256('too-short')).toThrow(CommerceReportShareInvalidError);
  });

  it('creates an expiring owner-bound share without persisting the raw token', async () => {
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('INSERT INTO commerce_agent_report_shares')) {
        expect(text).not.toContain('conversation_id, message_id');
        expect(String(values[4])).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(values[5]).toBe(24);
        return result([shareRow({ conversation_id: undefined, message_id: undefined })]);
      }
      if (text.includes('SELECT pg_advisory_xact_lock')) return result();
      if (text.includes('FROM commerce_agent_reports AS report')) return result([reportRow()]);
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const created = await new PostgresCommerceReportShareStore(database).createShare({
      identity,
      conversationId: report.conversation.id,
      messageId: report.answer.messageId,
    });
    expect(created.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(created.conversationId).toBe(report.conversation.id);
    expect(created.expiresAt).toBe('2026-08-14T04:00:00.000Z');
  });

  it('reads only an unrevoked, unexpired share in the owner scope', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('clock_timestamp()')) return result([shareRow()]);
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const active = await new PostgresCommerceReportShareStore(database).getActiveShare(
      identity,
      report.conversation.id,
      report.answer.messageId,
    );
    expect(active).toMatchObject({ id: 'share_1234567890123456', reportId: report.reportId });
  });

  it('revocation is idempotent for the owner and does not expose other users', async () => {
    const database = new ScriptedDatabase((text) => {
      if (text.includes('SELECT pg_advisory_xact_lock')) return result();
      if (text.includes('FROM commerce_agent_report_shares AS share')) return result([shareRow()]);
      if (text.startsWith('UPDATE commerce_agent_report_shares')) return result([shareRow({ revoked_at: '2026-08-13T05:00:00.000Z' })]);
      throw new Error(`Unexpected SQL: ${text}`);
    });
    const store = new PostgresCommerceReportShareStore(database);
    await expect(store.revokeShare(identity, 'share_1234567890123456')).resolves.toMatchObject({
      revokedAt: '2026-08-13T05:00:00.000Z',
    });
    const missing = new PostgresCommerceReportShareStore(new ScriptedDatabase((text) => {
      if (text.includes('SELECT pg_advisory_xact_lock')) return result();
      return result();
    }));
    await expect(missing.revokeShare(identity, 'share_1234567890123456'))
      .rejects.toBeInstanceOf(CommerceReportShareNotFoundError);
  });

  it('resolves a capability token under system context and verifies the frozen manifest', async () => {
    const token = 'B'.repeat(43);
    const database = new ScriptedDatabase((text, values) => {
      expect(text).toContain('share.token_sha256 = $1');
      expect(text).toContain('share.revoked_at IS NULL');
      expect(text).toContain('share.expires_at > clock_timestamp()');
      expect(values[0]).toBe(commerceReportShareTokenSha256(token));
      return result([{
        ...shareRow(),
        report_row_id: report.reportId,
        report_tenant_id: report.owner.tenantId,
        report_user_id: report.owner.userId,
        report_conversation_id: report.conversation.id,
        report_message_id: report.answer.messageId,
        report_run_id: report.run.id,
        report_schema_version: report.schemaVersion,
        report_release_revision: report.releaseRevision,
        report_manifest_json: report,
        report_content_sha256: report.contentSha256,
      }]);
    });
    await expect(new PostgresCommerceReportShareStore(database).getSharedReport(token))
      .resolves.toMatchObject({ report, share: { id: 'share_1234567890123456' } });
  });
});

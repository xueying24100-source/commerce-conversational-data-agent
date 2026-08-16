import { describe, expect, it } from 'vitest';

import type { CommerceDatabase, CommerceQueryResult, CommerceSqlClient } from './database';
import {
  buildReportArtifact,
  canonicalReportJson,
  commerceReportContentSha256,
  CommerceReportIntegrityError,
  CommerceReportNotFoundError,
  insertReportArtifact,
  PostgresCommerceReportStore,
  renderReportHtml,
  renderReportJson,
  renderReportMarkdown,
  type BuildReportArtifactInput,
} from './report-store';
import type { CommerceIdentity } from './types';

const identity: CommerceIdentity = {
  tenantId: 'tenant_report',
  userId: 'operator_report',
  displayName: 'Report operator',
  scopes: ['commerce:data:read'],
  authMode: 'development',
};

const reportInput: BuildReportArtifactInput = {
  reportId: 'report_1234567890123456',
  releaseRevision: '0123456789abcdef0123456789abcdef01234567',
  createdAt: '2026-08-13T03:05:00.000Z',
  identity,
  conversation: { id: 'conv_1234567890123456', title: '昨日经营复盘' },
  run: {
    id: 'run_1234567890123456', requestId: 'request:report-1',
    requestSha256: `sha256:${'a'.repeat(64)}`, model: 'deepseek-v4-flash',
    provider: 'deepseek', startedAt: '2026-08-13T03:00:00.000Z',
    completedAt: '2026-08-13T03:04:59.000Z',
  },
  question: {
    messageId: 'msg_question_1234567890123456', content: '复盘昨日经营表现。',
    createdAt: '2026-08-13T03:00:00.000Z',
  },
  answer: {
    messageId: 'msg_answer_1234567890123456', content: 'GMV 为 100 元。',
    createdAt: '2026-08-13T03:04:59.000Z',
    structured: {
      status: 'answered', answer: 'GMV 为 100 元。',
      answerClaims: [{
        evidenceId: 'evidence_complete', path: '/totals/gmv', metric: 'gmv',
        value: 100, unit: 'currency',
      }],
      findings: [{
        metric: 'gmv', title: 'GMV', detail: '昨日 GMV 为 100 元。',
        claims: [{
          evidenceId: 'evidence_complete', path: '/totals/gmv', metric: 'gmv',
          value: 100, unit: 'currency',
        }],
      }],
      recommendations: [{ action: '检查流量结构', rationale: '确认 GMV 驱动项。', claims: [] }],
      followUps: [],
    },
  },
  traces: [
    {
      evidenceId: 'evidence_complete', operation: 'commerce_metric_summary',
      fetchedAt: '2026-08-13T03:01:00.000Z', rowCount: 1,
      requestSha256: `sha256:${'b'.repeat(64)}`,
      responseSha256: `sha256:${'c'.repeat(64)}`,
      sourceWatermark: '2026-08-13T02:00:00.000Z', request: { metric: 'gmv' },
      preview: { totals: { gmv: 100 } }, previewTruncated: false,
    },
    {
      evidenceId: 'evidence_partial', operation: 'commerce_breakdown',
      fetchedAt: '2026-08-13T03:02:00.000Z', rowCount: 200,
      requestSha256: `sha256:${'d'.repeat(64)}`,
      responseSha256: `sha256:${'e'.repeat(64)}`,
      sourceWatermark: null, request: { dimension: 'sku' },
      preview: { truncated: true }, previewTruncated: true,
    },
  ],
};

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

function storedReportRow(report: ReturnType<typeof buildReportArtifact>) {
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

describe('Commerce report artifacts', () => {
  it('freezes a revision-bound manifest and fails closed on preview completeness', () => {
    const report = buildReportArtifact(reportInput);
    expect(report).toMatchObject({
      artifactType: 'commerce_agent_report', schemaVersion: 1,
      releaseRevision: reportInput.releaseRevision,
      hashScope: 'canonical_manifest_without_content_sha256',
      owner: { tenantId: identity.tenantId, userId: identity.userId },
    });
    expect(report.traces.map((trace) => trace.evidenceCompleteness)).toEqual([
      'complete_preview', 'partial_preview',
    ]);
    expect(report.contentSha256).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(commerceReportContentSha256(report)).toBe(report.contentSha256);
    expect(canonicalReportJson({ z: 1, a: { y: 2, x: 3 } })).toBe('{"a":{"x":3,"y":2},"z":1}');
  });

  it('changes the digest when the frozen answer or release changes', () => {
    const original = buildReportArtifact(reportInput);
    const changed = buildReportArtifact({
      ...reportInput,
      releaseRevision: 'fedcba9876543210fedcba9876543210fedcba98',
    });
    expect(changed.contentSha256).not.toBe(original.contentSha256);
  });

  it('renders auditable JSON and warns that partial previews are not raw-data exports', () => {
    const report = buildReportArtifact(reportInput);
    expect(JSON.parse(renderReportJson(report))).toEqual(report);
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain('证据完整性提示：1 条证据仅保存了部分预览');
    expect(markdown).toContain('## 经营结论');
    expect(markdown).toContain('## 行动卡');
    expect(markdown).toContain('负责人角色：待确认');
    expect(markdown).toContain(report.contentSha256);
    expect(markdown).toContain('evidence_partial');
  });

  it('renders a self-contained business HTML report and escapes persisted content', () => {
    const report = buildReportArtifact({
      ...reportInput,
      conversation: { ...reportInput.conversation, title: '<script>alert(1)</script>' },
      answer: {
        ...reportInput.answer,
        content: '<img src=x onerror=alert(1)>',
        structured: {
          ...reportInput.answer.structured,
          answer: '<img src=x onerror=alert(1)>',
        },
      },
    });
    const html = renderReportHtml(report);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('经营结论');
    expect(html).toContain('Evidence 完整性');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('inserts immutable content and accepts only an exact idempotent replay', async () => {
    const report = buildReportArtifact(reportInput);
    const database = new ScriptedDatabase((text, values) => {
      if (text.includes('INSERT INTO commerce_agent_reports')) {
        expect(text).toContain('ON CONFLICT (tenant_id, user_id, message_id) DO NOTHING');
        expect(values[8]).toBe(report.contentSha256);
        return result();
      }
      if (text.includes('SELECT content_sha256')) return result([{ content_sha256: report.contentSha256 }]);
      throw new Error(`Unexpected SQL: ${text}`);
    });
    await expect(insertReportArtifact(database, report)).resolves.toBeUndefined();
  });

  it('reads only a completed assistant report inside the authenticated owner scope', async () => {
    const report = buildReportArtifact(reportInput);
    const database = new ScriptedDatabase((text, values) => {
      expect(text).toContain("message.role = 'assistant'");
      expect(text).toContain("run.status = 'completed'");
      expect(text).toContain('report.tenant_id = $3 AND report.user_id = $4');
      expect(values).toEqual([
        report.conversation.id, report.answer.messageId, identity.tenantId, identity.userId,
      ]);
      return result([storedReportRow(report)]);
    });
    const store = new PostgresCommerceReportStore(database);
    await expect(store.get(identity, report.conversation.id, report.answer.messageId)).resolves.toEqual(report);
  });

  it('fails closed for missing and tampered artifacts', async () => {
    const missing = new PostgresCommerceReportStore(new ScriptedDatabase(() => result()));
    await expect(missing.get(
      identity, reportInput.conversation.id, reportInput.answer.messageId,
    )).rejects.toBeInstanceOf(CommerceReportNotFoundError);

    const report = buildReportArtifact(reportInput);
    const tampered = { ...report, releaseRevision: 'tampered' };
    const corrupt = new PostgresCommerceReportStore(new ScriptedDatabase(() => result([{
      ...storedReportRow(report), manifest_json: tampered,
    }])));
    await expect(corrupt.get(
      identity, report.conversation.id, report.answer.messageId,
    )).rejects.toBeInstanceOf(CommerceReportIntegrityError);
  });

  it('rejects a self-consistent manifest whose owner metadata does not match its row', async () => {
    const report = buildReportArtifact(reportInput);
    const mismatched = new PostgresCommerceReportStore(new ScriptedDatabase(() => result([{
      ...storedReportRow(report), tenant_id: 'tenant_other',
    }])));
    await expect(mismatched.get(
      identity, report.conversation.id, report.answer.messageId,
    )).rejects.toBeInstanceOf(CommerceReportIntegrityError);
  });
});

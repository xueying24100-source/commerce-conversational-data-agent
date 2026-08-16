import { createHash, randomUUID } from 'node:crypto';

import type { CommerceDatabase, CommerceSqlClient } from './database';
import { getCommerceControlDatabase, withCommerceControlIdentity } from './database';
import { commerceAgentAnswerSchema, type CommerceAgentAnswer, type CommerceIdentity } from './types';

export const COMMERCE_REPORT_SCHEMA_VERSION = 1 as const;
export const COMMERCE_REPORT_HASH_SCOPE = 'canonical_manifest_without_content_sha256' as const;

export type CommerceReportEvidenceCompleteness = 'complete_preview' | 'partial_preview';

export interface CommerceReportTraceInput {
  evidenceId: string;
  operation: string;
  fetchedAt: string;
  rowCount: number;
  requestSha256: string;
  responseSha256: string;
  sourceWatermark: string | null;
  request: unknown;
  preview: unknown;
  previewTruncated: boolean;
}

export interface CommerceReportTraceV1 {
  evidenceId: string;
  operation: string;
  fetchedAt: string;
  rowCount: number;
  requestSha256: string;
  responseSha256: string;
  sourceWatermark: string | null;
  request: unknown;
  preview: unknown;
  evidenceCompleteness: CommerceReportEvidenceCompleteness;
}

export interface ReportManifestV1 {
  artifactType: 'commerce_agent_report';
  schemaVersion: typeof COMMERCE_REPORT_SCHEMA_VERSION;
  reportId: string;
  releaseRevision: string;
  createdAt: string;
  contentSha256: string;
  hashScope: typeof COMMERCE_REPORT_HASH_SCOPE;
  owner: {
    tenantId: string;
    userId: string;
  };
  conversation: {
    id: string;
    title: string;
  };
  run: {
    id: string;
    requestId: string;
    requestSha256: string;
    model: string;
    provider: string;
    startedAt: string;
    completedAt: string;
  };
  question: {
    messageId: string;
    content: string;
    createdAt: string;
  };
  answer: {
    messageId: string;
    content: string;
    structured: CommerceAgentAnswer;
    createdAt: string;
  };
  traces: CommerceReportTraceV1[];
}

export interface BuildReportArtifactInput {
  reportId: string;
  releaseRevision: string;
  createdAt: string;
  identity: Pick<CommerceIdentity, 'tenantId' | 'userId'>;
  conversation: ReportManifestV1['conversation'];
  run: ReportManifestV1['run'];
  question: ReportManifestV1['question'];
  answer: Omit<ReportManifestV1['answer'], 'structured'> & { structured: CommerceAgentAnswer };
  traces: CommerceReportTraceInput[];
}

export type ReportRow = Record<string, unknown> & {
  id: string;
  tenant_id: string;
  user_id: string;
  conversation_id: string;
  message_id: string;
  run_id: string;
  schema_version: unknown;
  release_revision: string;
  manifest_json: unknown;
  content_sha256: string;
};

function iso(value: string, field: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${field} must be an ISO timestamp.`);
  return date.toISOString();
}

function requiredText(value: string, field: string, max = 8_000): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new Error(`${field} is invalid.`);
  return normalized;
}

function assertFingerprint(value: string, field: string): string {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${field} is invalid.`);
  return value;
}

function jsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Report content must be JSON serializable.');
  return JSON.parse(serialized) as unknown;
}

export function canonicalReportJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Report content contains a non-finite number.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalReportJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('Report content is not JSON serializable.');
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalReportJson(entry)}`)
    .join(',')}}`;
}

function manifestPayload(manifest: Omit<ReportManifestV1, 'contentSha256'> | ReportManifestV1) {
  const { contentSha256: _contentSha256, ...payload } = manifest as ReportManifestV1;
  return payload;
}

export function commerceReportContentSha256(
  manifest: Omit<ReportManifestV1, 'contentSha256'> | ReportManifestV1,
): string {
  return `sha256:${createHash('sha256')
    .update(canonicalReportJson(manifestPayload(manifest)), 'utf8')
    .digest('hex')}`;
}

export function newCommerceReportId(): string {
  return `report_${randomUUID()}`;
}

export function buildReportArtifact(input: BuildReportArtifactInput): ReportManifestV1 {
  const structured = commerceAgentAnswerSchema.parse(jsonValue(input.answer.structured));
  const answerContent = requiredText(input.answer.content, 'answer.content');
  if (answerContent !== structured.answer) {
    throw new Error('answer.content must match the persisted structured answer.');
  }
  const payload: Omit<ReportManifestV1, 'contentSha256'> = {
    artifactType: 'commerce_agent_report',
    schemaVersion: COMMERCE_REPORT_SCHEMA_VERSION,
    reportId: requiredText(input.reportId, 'reportId', 100),
    releaseRevision: requiredText(input.releaseRevision, 'releaseRevision', 200),
    createdAt: iso(input.createdAt, 'createdAt'),
    hashScope: COMMERCE_REPORT_HASH_SCOPE,
    owner: {
      tenantId: requiredText(input.identity.tenantId, 'tenantId', 128),
      userId: requiredText(input.identity.userId, 'userId', 128),
    },
    conversation: {
      id: requiredText(input.conversation.id, 'conversation.id', 100),
      title: requiredText(input.conversation.title, 'conversation.title', 240),
    },
    run: {
      id: requiredText(input.run.id, 'run.id', 100),
      requestId: requiredText(input.run.requestId, 'run.requestId', 200),
      requestSha256: assertFingerprint(input.run.requestSha256, 'run.requestSha256'),
      model: requiredText(input.run.model, 'run.model', 200),
      provider: requiredText(input.run.provider, 'run.provider', 100),
      startedAt: iso(input.run.startedAt, 'run.startedAt'),
      completedAt: iso(input.run.completedAt, 'run.completedAt'),
    },
    question: {
      messageId: requiredText(input.question.messageId, 'question.messageId', 100),
      content: requiredText(input.question.content, 'question.content'),
      createdAt: iso(input.question.createdAt, 'question.createdAt'),
    },
    answer: {
      messageId: requiredText(input.answer.messageId, 'answer.messageId', 100),
      content: answerContent,
      structured,
      createdAt: iso(input.answer.createdAt, 'answer.createdAt'),
    },
    traces: input.traces.map((trace) => ({
      evidenceId: requiredText(trace.evidenceId, 'trace.evidenceId', 100),
      operation: requiredText(trace.operation, 'trace.operation', 160),
      fetchedAt: iso(trace.fetchedAt, 'trace.fetchedAt'),
      rowCount: Number.isSafeInteger(trace.rowCount) && trace.rowCount >= 0
        ? trace.rowCount
        : (() => { throw new Error('trace.rowCount is invalid.'); })(),
      requestSha256: assertFingerprint(trace.requestSha256, 'trace.requestSha256'),
      responseSha256: assertFingerprint(trace.responseSha256, 'trace.responseSha256'),
      sourceWatermark: trace.sourceWatermark === null
        ? null
        : iso(trace.sourceWatermark, 'trace.sourceWatermark'),
      request: jsonValue(trace.request),
      preview: jsonValue(trace.preview),
      // Only an explicit persisted false can prove that the stored preview was complete.
      evidenceCompleteness: trace.previewTruncated === false
        ? 'complete_preview'
        : 'partial_preview',
    })),
  };
  return { ...payload, contentSha256: commerceReportContentSha256(payload) };
}

export function parseStoredReportManifest(row: ReportRow): ReportManifestV1 {
  const value = typeof row.manifest_json === 'string'
    ? JSON.parse(row.manifest_json) as unknown
    : row.manifest_json;
  if (!value || typeof value !== 'object') throw new CommerceReportIntegrityError();
  const manifest = value as ReportManifestV1;
  if (
    manifest.artifactType !== 'commerce_agent_report'
    || manifest.schemaVersion !== COMMERCE_REPORT_SCHEMA_VERSION
    || manifest.hashScope !== COMMERCE_REPORT_HASH_SCOPE
    || manifest.contentSha256 !== row.content_sha256
    || commerceReportContentSha256(manifest) !== row.content_sha256
    || manifest.reportId !== row.id
    || manifest.owner.tenantId !== row.tenant_id
    || manifest.owner.userId !== row.user_id
    || manifest.conversation.id !== row.conversation_id
    || manifest.answer.messageId !== row.message_id
    || manifest.run.id !== row.run_id
    || manifest.schemaVersion !== Number(row.schema_version)
    || manifest.releaseRevision !== row.release_revision
  ) {
    throw new CommerceReportIntegrityError();
  }
  return manifest;
}

export class CommerceReportNotFoundError extends Error {
  readonly code = 'COMMERCE_REPORT_NOT_FOUND';

  constructor() {
    super('报告不存在、尚未生成，或不属于当前用户。');
    this.name = 'CommerceReportNotFoundError';
  }
}

export class CommerceReportIntegrityError extends Error {
  readonly code = 'COMMERCE_REPORT_INTEGRITY_FAILED';

  constructor() {
    super('报告完整性校验失败。');
    this.name = 'CommerceReportIntegrityError';
  }
}

export async function insertReportArtifact(
  client: CommerceSqlClient,
  manifest: ReportManifestV1,
): Promise<void> {
  if (commerceReportContentSha256(manifest) !== manifest.contentSha256) {
    throw new CommerceReportIntegrityError();
  }
  const inserted = await client.query<{ content_sha256: string }>(
    `INSERT INTO commerce_agent_reports
       (id, tenant_id, user_id, conversation_id, message_id, run_id, schema_version,
        release_revision, content_sha256, manifest_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz)
     ON CONFLICT (tenant_id, user_id, message_id) DO NOTHING
     RETURNING content_sha256`,
    [
      manifest.reportId,
      manifest.owner.tenantId,
      manifest.owner.userId,
      manifest.conversation.id,
      manifest.answer.messageId,
      manifest.run.id,
      manifest.schemaVersion,
      manifest.releaseRevision,
      manifest.contentSha256,
      JSON.stringify(manifest),
      manifest.createdAt,
    ],
  );
  if (inserted.rowCount === 1) return;
  const existing = await client.query<{ content_sha256: string }>(
    `SELECT content_sha256
     FROM commerce_agent_reports
     WHERE tenant_id = $1 AND user_id = $2 AND message_id = $3`,
    [manifest.owner.tenantId, manifest.owner.userId, manifest.answer.messageId],
  );
  if (existing.rows[0]?.content_sha256 !== manifest.contentSha256) {
    throw new CommerceReportIntegrityError();
  }
}

export class PostgresCommerceReportStore {
  constructor(private readonly database: CommerceDatabase) {}

  get(
    identity: CommerceIdentity,
    conversationId: string,
    messageId: string,
  ): Promise<ReportManifestV1> {
    return withCommerceControlIdentity(identity, async () => {
      const result = await this.database.query<ReportRow>(
        `SELECT report.id, report.tenant_id, report.user_id, report.conversation_id,
                report.message_id, report.run_id, report.schema_version,
                report.release_revision, report.manifest_json, report.content_sha256
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
        [conversationId, messageId, identity.tenantId, identity.userId],
      );
      if (!result.rows[0]) throw new CommerceReportNotFoundError();
      return parseStoredReportManifest(result.rows[0]);
    });
  }
}

function markdownText(value: string): string {
  return value.replace(/\r\n?/gu, '\n').trim();
}

function tableText(value: string | number | null): string {
  return String(value ?? 'none').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

export function renderReportJson(manifest: ReportManifestV1): string {
  if (commerceReportContentSha256(manifest) !== manifest.contentSha256) {
    throw new CommerceReportIntegrityError();
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function renderReportMarkdown(manifest: ReportManifestV1): string {
  if (commerceReportContentSha256(manifest) !== manifest.contentSha256) {
    throw new CommerceReportIntegrityError();
  }
  const partialCount = manifest.traces.filter(
    (trace) => trace.evidenceCompleteness === 'partial_preview',
  ).length;
  const findings = manifest.answer.structured.findings.length
    ? manifest.answer.structured.findings.map((finding, index) => (
      `${index + 1}. **${markdownText(finding.title)}**\n   ${markdownText(finding.detail)}\n   证据：${finding.claims.length
        ? finding.claims.map((claim) => claim.evidenceId).join('、')
        : '未绑定证据'}`
    )).join('\n')
    : '暂无关键发现。';
  const recommendations = manifest.answer.structured.recommendations.length
    ? manifest.answer.structured.recommendations.map((recommendation, index) => (
      [
        `${index + 1}. **${markdownText(recommendation.action)}**`,
        `   - 经营理由：${markdownText(recommendation.rationale)}`,
        `   - 优先级：${recommendation.priority === 'high' ? '高' : recommendation.priority === 'medium' ? '中' : recommendation.priority === 'low' ? '低' : '待确认'}`,
        `   - 负责人角色：${recommendation.ownerRole ?? '待确认'}`,
        `   - 截止日：${recommendation.deadline ?? '待负责人确认'}`,
        `   - 成功指标：${recommendation.successMetric
          ? `${recommendation.successMetric.direction === 'increase' ? '提升' : recommendation.successMetric.direction === 'decrease' ? '降低' : '保持'} ${recommendation.successMetric.metric}${recommendation.successMetric.target === null ? '（目标待确认）' : ` 至 ${recommendation.successMetric.target}`}`
          : '待确认'}`,
        `   - 护栏：${recommendation.guardrails?.length
          ? recommendation.guardrails.map((guardrail) => `${guardrail.metric}${guardrail.threshold === null ? '（阈值待确认）' : ` ${guardrail.operator === 'not_above' ? '不高于' : '不低于'} ${guardrail.threshold}`}`).join('；')
          : '无'}`,
        `   - 状态：${recommendation.status === 'proposed' ? '待确认' : '待确认'}`,
        `   - 证据：${recommendation.claims.length
          ? recommendation.claims.map((claim) => claim.evidenceId).join('、')
          : '未绑定证据'}`,
      ].join('\n')
    )).join('\n')
    : '暂无行动建议。';
  const traces = manifest.traces.length
    ? [
      '| Evidence | Operation | Rows | Completeness | Response SHA-256 |',
      '| --- | --- | ---: | --- | --- |',
      ...manifest.traces.map((trace) => (
        `| ${tableText(trace.evidenceId)} | ${tableText(trace.operation)} | ${trace.rowCount} | ${trace.evidenceCompleteness} | ${trace.responseSha256} |`
      )),
    ].join('\n')
    : 'No evidence traces were attached.';

  return `# 经营数据分析报告

${partialCount > 0
    ? `> 证据完整性提示：${partialCount} 条证据仅保存了部分预览。本报告不是完整原始数据导出。\n\n`
    : ''}## 经营结论

${markdownText(manifest.answer.structured.answer)}

## 关键发现

${findings}

## 行动卡

${recommendations}

## Evidence 完整性

${manifest.traces.length
    ? `共 ${manifest.traces.length} 条证据；${manifest.traces.filter((trace) => trace.evidenceCompleteness === 'complete_preview').length} 条为完整预览，${partialCount} 条为部分预览。`
    : '本次回答未绑定证据。'}

## 审计元数据

| 字段 | 值 |
| --- | --- |
| 报告 ID | ${tableText(manifest.reportId)} |
| Schema 版本 | ${manifest.schemaVersion} |
| 内容 SHA-256 | ${manifest.contentSha256} |
| 发布版本 | ${tableText(manifest.releaseRevision)} |
| 生成时间 | ${manifest.createdAt} |
| 会话 ID | ${tableText(manifest.conversation.id)} |
| Run ID | ${tableText(manifest.run.id)} |
| 模型 | ${tableText(manifest.run.model)} |
| Provider | ${tableText(manifest.run.provider)} |

## 用户问题

${markdownText(manifest.question.content)}

## Evidence 清单

${traces}
`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function htmlEscape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/gu, (character) => HTML_ESCAPES[character]);
}

function htmlText(value: unknown): string {
  return htmlEscape(value).replace(/\r?\n/gu, '<br>');
}

function htmlPriority(value: CommerceAgentAnswer['recommendations'][number]['priority']): string {
  return value === 'high' ? '高' : value === 'medium' ? '中' : value === 'low' ? '低' : '待确认';
}

function htmlDirection(value: NonNullable<CommerceAgentAnswer['recommendations'][number]['successMetric']>['direction']): string {
  return value === 'increase' ? '提升' : value === 'decrease' ? '降低' : '保持';
}

function htmlOperator(value: NonNullable<CommerceAgentAnswer['recommendations'][number]['guardrails']>[number]['operator']): string {
  return value === 'not_above' ? '不高于' : '不低于';
}

/**
 * Render a self-contained, read-only business view of the immutable manifest.
 * Keep this intentionally dependency-free: a capability URL must remain useful
 * even when the normal application shell or client JavaScript is unavailable.
 */
export function renderReportHtml(manifest: ReportManifestV1): string {
  if (commerceReportContentSha256(manifest) !== manifest.contentSha256) {
    throw new CommerceReportIntegrityError();
  }
  const answer = manifest.answer.structured;
  const partialCount = manifest.traces.filter(
    (trace) => trace.evidenceCompleteness === 'partial_preview',
  ).length;
  const completeCount = manifest.traces.length - partialCount;
  const findings = answer.findings.length
    ? `<ol class="finding-list">${answer.findings.map((finding) => (
      `<li><h3>${htmlEscape(finding.title)}</h3><p>${htmlText(finding.detail)}</p><p class="evidence-ref">证据：${finding.claims.length
        ? finding.claims.map((claim) => htmlEscape(claim.evidenceId)).join('、')
        : '未绑定证据'}</p></li>`
    )).join('')}</ol>`
    : '<p class="muted">暂无关键发现。</p>';
  const recommendations = answer.recommendations.length
    ? `<ol class="action-list">${answer.recommendations.map((recommendation) => {
      const successMetric = recommendation.successMetric
        ? `${htmlDirection(recommendation.successMetric.direction)} ${htmlEscape(recommendation.successMetric.metric)}${recommendation.successMetric.target === null
          ? '（目标待确认）'
          : ` 至 ${htmlEscape(recommendation.successMetric.target)}`}${recommendation.successMetric.evaluationWindowDays === null
          ? ''
          : `，${recommendation.successMetric.evaluationWindowDays} 天评估`}`
        : '待确认';
      const guardrails = recommendation.guardrails?.length
        ? recommendation.guardrails.map((guardrail) => `${htmlEscape(guardrail.metric)} ${htmlOperator(guardrail.operator)}${guardrail.threshold === null
          ? '（阈值待确认）'
          : ` ${htmlEscape(guardrail.threshold)}`}`).join('；')
        : '无';
      return `<li><h3>${htmlEscape(recommendation.action)}</h3><p>${htmlText(recommendation.rationale)}</p><dl class="action-meta"><div><dt>优先级</dt><dd>${htmlPriority(recommendation.priority)}</dd></div><div><dt>负责人角色</dt><dd>${htmlEscape(recommendation.ownerRole ?? '待确认')}</dd></div><div><dt>截止日</dt><dd>${htmlEscape(recommendation.deadline ?? '待负责人确认')}</dd></div><div><dt>成功指标</dt><dd>${successMetric}</dd></div><div><dt>护栏</dt><dd>${guardrails}</dd></div></dl><p class="evidence-ref">证据：${recommendation.claims.length
        ? recommendation.claims.map((claim) => htmlEscape(claim.evidenceId)).join('、')
        : '未绑定证据'}</p></li>`;
    }).join('')}</ol>`
    : '<p class="muted">暂无行动建议。</p>';
  const traces = manifest.traces.length
    ? `<div class="table-wrap"><table><thead><tr><th>Evidence</th><th>Operation</th><th>Rows</th><th>完整性</th><th>Response SHA-256</th></tr></thead><tbody>${manifest.traces.map((trace) => (
      `<tr><td><code>${htmlEscape(trace.evidenceId)}</code></td><td>${htmlEscape(trace.operation)}</td><td>${trace.rowCount}</td><td><span class="integrity ${trace.evidenceCompleteness === 'complete_preview' ? 'complete' : 'partial'}">${trace.evidenceCompleteness === 'complete_preview' ? '完整预览' : '部分预览'}</span></td><td><code>${htmlEscape(trace.responseSha256)}</code></td></tr>`
    )).join('')}</tbody></table></div>`
    : '<p class="muted">本次回答未绑定证据。</p>';
  const integrityNotice = partialCount > 0
    ? `<aside class="notice warning">证据完整性提示：${partialCount} 条证据仅保存了部分预览。本报告不是完整原始数据导出。</aside>`
    : '<aside class="notice">Evidence 预览完整性已记录在审计清单中。</aside>';
  const title = htmlEscape(manifest.conversation.title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title} · 经营数据分析报告</title>
  <style>
    :root{color-scheme:light;--ink:#111827;--muted:#5b6472;--line:#d7dbe2;--paper:#fff;--wash:#f5f6f8;--accent:#4f46e5;--accent-soft:#eef2ff;--warn:#92400e;--warn-soft:#fff7ed}
    *{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font:15px/1.65 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
    .sheet{max-width:1080px;margin:0 auto;background:var(--paper);min-height:100vh;padding:0 48px 64px}.masthead{border-top:7px solid var(--accent);padding:30px 0 24px;border-bottom:1px solid var(--line)}
    .kicker{margin:0 0 8px;color:var(--accent);font-size:11px;font-weight:700;letter-spacing:0}.masthead h1{margin:0;font-size:30px;line-height:1.2;letter-spacing:0}.subtitle{margin:12px 0 0;color:var(--muted)}
    section{padding:28px 0;border-bottom:1px solid var(--line)}h2{margin:0 0 14px;font-size:18px;line-height:1.3}h3{margin:0 0 5px;font-size:15px;line-height:1.4}p{margin:0 0 10px}.lead{font-size:19px;line-height:1.55;max-width:850px}.muted{color:var(--muted)}
    .finding-list,.action-list{margin:0;padding-left:24px}.finding-list li,.action-list li{padding:0 0 18px;margin:0 0 18px;border-bottom:1px solid var(--line)}.finding-list li:last-child,.action-list li:last-child{border-bottom:0;margin-bottom:0;padding-bottom:0}.evidence-ref{color:var(--muted);font-size:12px}
    .action-meta{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px;margin:14px 0 8px}.action-meta div{border-left:2px solid var(--accent-soft);padding-left:9px}.action-meta dt{color:var(--muted);font-size:11px}.action-meta dd{margin:2px 0 0;font-size:13px;overflow-wrap:anywhere}
    .notice{margin-top:18px;padding:11px 14px;border-left:3px solid var(--accent);background:var(--accent-soft);font-size:13px}.notice.warning{border-color:#f59e0b;background:var(--warn-soft);color:var(--warn)}
    .table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:12px}th,td{padding:9px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-size:11px;color:var(--muted);font-weight:700;white-space:nowrap}code{font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace;overflow-wrap:anywhere}.integrity{display:inline-block;padding:2px 6px;border:1px solid var(--line);font-size:11px;white-space:nowrap}.integrity.complete{color:#166534;background:#f0fdf4;border-color:#bbf7d0}.integrity.partial{color:var(--warn);background:var(--warn-soft);border-color:#fed7aa}
    .metadata{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px 22px;margin:0}.metadata div{min-width:0}.metadata dt{color:var(--muted);font-size:11px}.metadata dd{margin:2px 0 0;overflow-wrap:anywhere}.footer{padding-top:22px;color:var(--muted);font-size:12px}
    @media (max-width:760px){.sheet{padding:0 20px 42px}.masthead h1{font-size:25px}.lead{font-size:17px}.action-meta{grid-template-columns:repeat(2,minmax(0,1fr))}.metadata{grid-template-columns:1fr 1fr}th,td{padding:8px 6px}}
    @media print{body{background:#fff}.sheet{max-width:none;padding:0 20px}.masthead{border-top:0}.notice{break-inside:avoid}.finding-list li,.action-list li{break-inside:avoid}}
  </style>
</head>
<body>
  <main class="sheet">
    <header class="masthead">
      <p class="kicker">COMMERCE DATA MEMO</p>
      <h1>经营数据分析报告</h1>
      <p class="subtitle">${title} · 生成于 ${htmlEscape(manifest.createdAt)}</p>
    </header>
    <section><h2>经营结论</h2><p class="lead">${htmlText(answer.answer)}</p>${integrityNotice}</section>
    <section><h2>关键发现</h2>${findings}</section>
    <section><h2>行动卡</h2>${recommendations}</section>
    <section><h2>Evidence 完整性</h2><p>共 ${manifest.traces.length} 条证据；${completeCount} 条为完整预览，${partialCount} 条为部分预览。</p>${traces}</section>
    <section><h2>审计元数据</h2><dl class="metadata"><div><dt>报告 ID</dt><dd><code>${htmlEscape(manifest.reportId)}</code></dd></div><div><dt>内容 SHA-256</dt><dd><code>${htmlEscape(manifest.contentSha256)}</code></dd></div><div><dt>发布版本</dt><dd><code>${htmlEscape(manifest.releaseRevision)}</code></dd></div><div><dt>Run ID</dt><dd><code>${htmlEscape(manifest.run.id)}</code></dd></div><div><dt>模型 / Provider</dt><dd>${htmlEscape(manifest.run.model)} / ${htmlEscape(manifest.run.provider)}</dd></div><div><dt>用户问题</dt><dd>${htmlText(manifest.question.content)}</dd></div></dl></section>
    <footer class="footer">此页面由 Commerce Data Agent 生成。分享链接为只读 capability，过期或撤销后不可访问。</footer>
  </main>
</body>
</html>`;
}

let singleton: PostgresCommerceReportStore | null = null;

export function getCommerceReportStore(): PostgresCommerceReportStore {
  if (singleton && process.env.NODE_ENV !== 'test') return singleton;
  const store = new PostgresCommerceReportStore(getCommerceControlDatabase());
  if (process.env.NODE_ENV !== 'test') singleton = store;
  return store;
}

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import { resolveCommerceIdentity } from '@/lib/domains/commerce/agent/auth';
import {
  CommerceReportNotFoundError,
  getCommerceReportStore,
  renderReportJson,
  renderReportMarkdown,
} from '@/lib/domains/commerce/agent/report-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const conversationIdSchema = z.string().regex(/^conv_[A-Za-z0-9-]{16,80}$/u);
const messageIdSchema = z.string().regex(/^msg_[A-Za-z0-9-]{16,100}$/u);
const formatSchema = z.enum(['json', 'markdown']);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string; messageId: string }> },
) {
  try {
    const identity = resolveCommerceIdentity(request);
    const params = await context.params;
    const conversationId = conversationIdSchema.parse(params.conversationId);
    const messageId = messageIdSchema.parse(params.messageId);
    const format = formatSchema.parse(request.nextUrl.searchParams.get('format') ?? 'json');
    const report = await getCommerceReportStore().get(identity, conversationId, messageId);
    const markdown = format === 'markdown';
    return new NextResponse(
      markdown ? renderReportMarkdown(report) : renderReportJson(report),
      {
        headers: {
          'Cache-Control': 'private, no-store, max-age=0',
          'Content-Disposition': `attachment; filename="commerce-report-${messageId}.${markdown ? 'md' : 'json'}"`,
          'Content-Type': `${markdown ? 'text/markdown' : 'application/json'}; charset=utf-8`,
          'X-Content-Type-Options': 'nosniff',
          'X-Report-Content-SHA256': report.contentSha256,
          'X-Report-Schema-Version': String(report.schemaVersion),
        },
      },
    );
  } catch (error) {
    if (error instanceof CommerceReportNotFoundError) {
      return NextResponse.json(
        { success: false, error: error.code, message: error.message },
        { status: 404, headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
      );
    }
    return commerceApiError(error);
  }
}

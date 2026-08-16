import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { CommerceReportIntegrityError } from '@/lib/domains/commerce/agent/report-store';
import {
  CommerceReportShareInvalidError,
  CommerceReportShareNotFoundError,
  getCommerceReportShareStore,
} from '@/lib/domains/commerce/agent/report-share-store';
import { renderReportHtml } from '@/lib/domains/commerce/agent/report-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

const securityHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ token: string }> },
) {
  try {
    const token = tokenSchema.parse((await context.params).token);
    const shared = await getCommerceReportShareStore().getSharedReport(token);
    return new NextResponse(renderReportHtml(shared.report), {
      headers: {
        ...securityHeaders,
        'Content-Type': 'text/html; charset=utf-8',
        'X-Report-Content-SHA256': shared.report.contentSha256,
        'X-Report-Schema-Version': String(shared.report.schemaVersion),
      },
    });
  } catch (error) {
    if (
      error instanceof z.ZodError
      || error instanceof CommerceReportShareInvalidError
      || error instanceof CommerceReportShareNotFoundError
      || error instanceof CommerceReportIntegrityError
    ) {
      return NextResponse.json(
        { success: false, error: 'COMMERCE_REPORT_SHARE_NOT_FOUND', message: '分享链接不可用。' },
        { status: 404, headers: securityHeaders },
      );
    }
    return NextResponse.json(
      { success: false, error: 'COMMERCE_REPORT_SHARE_UNAVAILABLE', message: '分享报告暂时不可用。' },
      { status: 503, headers: securityHeaders },
    );
  }
}

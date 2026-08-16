import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  assertCommerceMutationOrigin,
  resolveCommerceIdentity,
} from '@/lib/domains/commerce/agent/auth';
import { commerceApiError, readCommerceJson } from '@/lib/domains/commerce/agent/api';
import { getCommerceAgentRuntimeConfig } from '@/lib/domains/commerce/agent/config';
import {
  COMMERCE_REPORT_SHARE_DEFAULT_HOURS,
  COMMERCE_REPORT_SHARE_MAX_HOURS,
  getCommerceReportShareStore,
} from '@/lib/domains/commerce/agent/report-share-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
  conversationId: z.string().regex(/^conv_[A-Za-z0-9-]{16,80}$/u),
  messageId: z.string().regex(/^msg_[A-Za-z0-9-]{16,100}$/u),
}).strict();

const createSchema = z.object({
  expiresInHours: z.number().int().min(1).max(COMMERCE_REPORT_SHARE_MAX_HOURS)
    .default(COMMERCE_REPORT_SHARE_DEFAULT_HOURS),
}).strict();

function shareUrl(request: NextRequest, token: string): string {
  const configuredOrigin = getCommerceAgentRuntimeConfig().publicOrigin;
  const origin = configuredOrigin || request.nextUrl.origin;
  return `${origin}/api/commerce/reports/shared/${encodeURIComponent(token)}`;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string; messageId: string }> },
) {
  try {
    const identity = resolveCommerceIdentity(request);
    const params = paramsSchema.parse(await context.params);
    const share = await getCommerceReportShareStore().getActiveShare(
      identity,
      params.conversationId,
      params.messageId,
    );
    return NextResponse.json(
      { success: true, share },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string; messageId: string }> },
) {
  try {
    assertCommerceMutationOrigin(request);
    const identity = resolveCommerceIdentity(request);
    const params = paramsSchema.parse(await context.params);
    const body = createSchema.parse(await readCommerceJson(request));
    const share = await getCommerceReportShareStore().createShare({
      identity,
      conversationId: params.conversationId,
      messageId: params.messageId,
      expiresInHours: body.expiresInHours,
    });
    const { token, ...metadata } = share;
    return NextResponse.json(
      { success: true, share: { ...metadata, url: shareUrl(request, token) } },
      { status: 201, headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  assertCommerceMutationOrigin,
  resolveCommerceIdentity,
} from '@/lib/domains/commerce/agent/auth';
import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import { getCommerceReportShareStore } from '@/lib/domains/commerce/agent/report-share-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
  conversationId: z.string().regex(/^conv_[A-Za-z0-9-]{16,80}$/u),
  messageId: z.string().regex(/^msg_[A-Za-z0-9-]{16,100}$/u),
  shareId: z.string().regex(/^share_[A-Za-z0-9-]{16,80}$/u),
}).strict();

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string; messageId: string; shareId: string }> },
) {
  try {
    assertCommerceMutationOrigin(request);
    const identity = resolveCommerceIdentity(request);
    const params = paramsSchema.parse(await context.params);
    const share = await getCommerceReportShareStore().revokeShare(
      identity,
      params.shareId,
      { conversationId: params.conversationId, messageId: params.messageId },
    );
    return NextResponse.json(
      { success: true, share },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

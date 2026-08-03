import { z } from 'zod';
import { NextResponse, type NextRequest } from 'next/server';

import {
  assertCommerceMutationOrigin,
  resolveCommerceIdentity,
} from '@/lib/domains/commerce/agent/auth';
import {
  commerceApiError,
  readCommerceJson,
} from '@/lib/domains/commerce/agent/api';
import { getCommerceAsyncAgentService } from '@/lib/domains/commerce/agent/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const messageSchema = z.object({
  message: z.string().trim().min(2).max(4_000),
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
}).strict();
const conversationIdSchema = z.string().regex(/^conv_[A-Za-z0-9-]{16,80}$/u);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    assertCommerceMutationOrigin(request);
    const identity = resolveCommerceIdentity(request);
    const { conversationId: rawConversationId } = await context.params;
    const conversationId = conversationIdSchema.parse(rawConversationId);
    const body = messageSchema.parse(await readCommerceJson(request));
    const job = await getCommerceAsyncAgentService().enqueueTurn({
      identity,
      conversationId,
      message: body.message,
      requestId: body.requestId,
    });
    return NextResponse.json(
      { success: true, job },
      { status: 202, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

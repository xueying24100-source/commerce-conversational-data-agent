import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { resolveCommerceIdentity } from '@/lib/domains/commerce/agent/auth';
import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import { getCommerceAgentService } from '@/lib/domains/commerce/agent/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const conversationIdSchema = z.string().regex(/^conv_[A-Za-z0-9-]{16,80}$/u);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const identity = resolveCommerceIdentity(request);
    const { conversationId: rawConversationId } = await context.params;
    const conversationId = conversationIdSchema.parse(rawConversationId);
    const conversation = await getCommerceAgentService().getConversation(identity, conversationId);
    return NextResponse.json(
      { success: true, conversation },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

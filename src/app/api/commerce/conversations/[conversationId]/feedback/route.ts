import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { commerceApiError, readCommerceJson } from '@/lib/domains/commerce/agent/api';
import {
  assertCommerceMutationOrigin,
  resolveCommerceIdentity,
} from '@/lib/domains/commerce/agent/auth';
import { getCommerceFeedbackStore } from '@/lib/domains/commerce/agent/feedback-store';
import { getCommerceFeedbackStatusStore } from '@/lib/domains/commerce/agent/feedback-status-store';
import { commerceFeedbackSubmissionSchema } from '@/lib/domains/commerce/agent/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const conversationIdSchema = z.string().regex(/^conv_[A-Za-z0-9-]{16,80}$/u);
const messageIdSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    const identity = resolveCommerceIdentity(request);
    const { conversationId: rawConversationId } = await context.params;
    const conversationId = conversationIdSchema.parse(rawConversationId);
    const messageId = messageIdSchema.parse(request.nextUrl.searchParams.get('messageId'));
    const feedback = await getCommerceFeedbackStatusStore().getLatest(
      identity,
      conversationId,
      messageId,
    );
    return NextResponse.json(
      { success: true, feedback },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string }> },
) {
  try {
    assertCommerceMutationOrigin(request);
    const identity = resolveCommerceIdentity(request);
    const { conversationId: rawConversationId } = await context.params;
    const conversationId = conversationIdSchema.parse(rawConversationId);
    const body = commerceFeedbackSubmissionSchema.parse(await readCommerceJson(request));
    const feedback = await getCommerceFeedbackStore().submit(identity, conversationId, body);
    return NextResponse.json(
      { success: true, feedback },
      { status: 201, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

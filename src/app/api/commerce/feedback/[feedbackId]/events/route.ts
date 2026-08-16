import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { commerceApiError, readCommerceJson } from '@/lib/domains/commerce/agent/api';
import {
  assertCommerceFeedbackReviewer,
  assertCommerceMutationOrigin,
  resolveCommerceIdentity,
} from '@/lib/domains/commerce/agent/auth';
import { getCommerceFeedbackStore } from '@/lib/domains/commerce/agent/feedback-store';
import { commerceFeedbackReviewEventSchema } from '@/lib/domains/commerce/agent/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const feedbackIdSchema = z.string().regex(/^feedback_[A-Za-z0-9-]{16,80}$/u);

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ feedbackId: string }> },
) {
  try {
    assertCommerceMutationOrigin(request);
    const identity = resolveCommerceIdentity(request);
    assertCommerceFeedbackReviewer(identity);
    const { feedbackId: rawFeedbackId } = await context.params;
    const event = await getCommerceFeedbackStore().appendReviewEvent(
      identity,
      feedbackIdSchema.parse(rawFeedbackId),
      commerceFeedbackReviewEventSchema.parse(await readCommerceJson(request)),
    );
    return NextResponse.json(
      { success: true, event },
      { status: 201, headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

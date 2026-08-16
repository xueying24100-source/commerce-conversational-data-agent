import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import {
  assertCommerceFeedbackReviewer,
  resolveCommerceIdentity,
} from '@/lib/domains/commerce/agent/auth';
import { getCommerceFeedbackStore } from '@/lib/domains/commerce/agent/feedback-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const feedbackIdSchema = z.string().regex(/^feedback_[A-Za-z0-9-]{16,80}$/u);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ feedbackId: string }> },
) {
  try {
    const identity = resolveCommerceIdentity(request);
    assertCommerceFeedbackReviewer(identity);
    const { feedbackId: rawFeedbackId } = await context.params;
    const feedback = await getCommerceFeedbackStore().getForReview(
      identity,
      feedbackIdSchema.parse(rawFeedbackId),
    );
    return NextResponse.json(
      { success: true, feedback },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

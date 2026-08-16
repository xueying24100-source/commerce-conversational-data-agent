import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import {
  assertCommerceFeedbackReviewer,
  resolveCommerceIdentity,
} from '@/lib/domains/commerce/agent/auth';
import { getCommerceFeedbackStore } from '@/lib/domains/commerce/agent/feedback-store';
import {
  commerceFeedbackCategorySchema,
  commerceFeedbackStatusSchema,
} from '@/lib/domains/commerce/agent/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  status: commerceFeedbackStatusSchema.optional(),
  category: commerceFeedbackCategorySchema.optional(),
  cursor: z.string().trim().min(1).max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const identity = resolveCommerceIdentity(request);
    assertCommerceFeedbackReviewer(identity);
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    const page = await getCommerceFeedbackStore().listForReview(identity, query);
    return NextResponse.json(
      { success: true, ...page },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { getCommerceActionStore } from '@/lib/domains/commerce/agent/action-store';
import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import { resolveCommerceIdentity } from '@/lib/domains/commerce/agent/auth';
import { COMMERCE_ACTION_LIST_FILTERS } from '@/lib/domains/commerce/agent/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const querySchema = z.object({
  status: z.enum(COMMERCE_ACTION_LIST_FILTERS).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const identity = resolveCommerceIdentity(request);
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    const actions = await getCommerceActionStore().list(identity, query);
    return NextResponse.json(
      { success: true, actions },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

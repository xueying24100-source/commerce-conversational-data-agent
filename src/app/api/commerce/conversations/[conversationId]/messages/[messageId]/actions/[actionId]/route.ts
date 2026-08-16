import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import {
  assertCommerceMutationOrigin,
  resolveCommerceIdentity,
} from '@/lib/domains/commerce/agent/auth';
import { getCommerceActionStore } from '@/lib/domains/commerce/agent/action-store';
import { commerceApiError, readCommerceJson } from '@/lib/domains/commerce/agent/api';
import { commerceActionTransitionSchema } from '@/lib/domains/commerce/agent/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const paramsSchema = z.object({
  conversationId: z.string().regex(/^conv_[A-Za-z0-9-]{16,80}$/u),
  messageId: z.string().regex(/^msg_[A-Za-z0-9-]{16,80}$/u),
  actionId: z.string().regex(/^action_[a-f0-9]{24}$/u),
}).strict();

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ conversationId: string; messageId: string; actionId: string }> },
) {
  try {
    assertCommerceMutationOrigin(request);
    const identity = resolveCommerceIdentity(request);
    const params = paramsSchema.parse(await context.params);
    const input = commerceActionTransitionSchema.parse(await readCommerceJson(request));
    const actionState = await getCommerceActionStore().transition(identity, { ...params, ...input });
    return NextResponse.json(
      { success: true, actionState },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

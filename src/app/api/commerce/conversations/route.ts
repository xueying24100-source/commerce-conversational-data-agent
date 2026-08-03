import { z } from 'zod';
import { NextResponse, type NextRequest } from 'next/server';

import {
  DEEPSEEK_MODEL_ID,
  LOCAL_QWEN_MODEL_ID,
  MODELPORT_DEEPSEEK_MODEL_ID,
} from '@/lib/constants/models';
import {
  assertCommerceMutationOrigin,
  resolveCommerceIdentity,
} from '@/lib/domains/commerce/agent/auth';
import {
  commerceApiError,
  readCommerceJson,
} from '@/lib/domains/commerce/agent/api';
import { getCommerceAgentService } from '@/lib/domains/commerce/agent/service';
import { getCommerceAsyncAgentService } from '@/lib/domains/commerce/agent/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const createSchema = z.object({
  message: z.string().trim().min(2).max(4_000),
  model: z.enum([LOCAL_QWEN_MODEL_ID, MODELPORT_DEEPSEEK_MODEL_ID, DEEPSEEK_MODEL_ID]),
  requestId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u),
}).strict();

export async function GET(request: NextRequest) {
  try {
    const identity = resolveCommerceIdentity(request);
    const conversations = await getCommerceAgentService().listConversations(identity);
    return NextResponse.json(
      { success: true, conversations },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    assertCommerceMutationOrigin(request);
    const identity = resolveCommerceIdentity(request);
    const body = createSchema.parse(await readCommerceJson(request));
    const job = await getCommerceAsyncAgentService().enqueueConversation({
      identity,
      message: body.message,
      model: body.model,
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

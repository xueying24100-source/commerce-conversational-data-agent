import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { resolveCommerceIdentity } from '@/lib/domains/commerce/agent/auth';
import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import { getCommerceAsyncAgentService } from '@/lib/domains/commerce/agent/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const jobIdSchema = z.string().regex(/^job_[A-Za-z0-9-]{16,80}$/u);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ jobId: string }> },
) {
  try {
    const identity = resolveCommerceIdentity(request);
    const { jobId: rawJobId } = await context.params;
    const job = await getCommerceAsyncAgentService().getJob(
      identity,
      jobIdSchema.parse(rawJobId),
    );
    return NextResponse.json(
      { success: true, job },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

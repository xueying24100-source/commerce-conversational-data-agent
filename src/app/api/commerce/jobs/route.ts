import { NextResponse, type NextRequest } from 'next/server';

import { resolveCommerceIdentity } from '@/lib/domains/commerce/agent/auth';
import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import { getCommerceAsyncAgentService } from '@/lib/domains/commerce/agent/jobs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const identity = resolveCommerceIdentity(request);
    const jobs = await getCommerceAsyncAgentService().listActiveJobs(identity);
    return NextResponse.json(
      { success: true, jobs },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

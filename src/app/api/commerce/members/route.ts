import { NextResponse, type NextRequest } from 'next/server';

import { resolveCommerceIdentity } from '@/lib/domains/commerce/agent/auth';
import { commerceApiError } from '@/lib/domains/commerce/agent/api';
import { getCommerceAgentRuntimeConfig } from '@/lib/domains/commerce/agent/config';
import { getCommerceFeishuOutboxStore } from '@/lib/domains/commerce/agent/feishu-outbox';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const identity = resolveCommerceIdentity(request);
    if (!getCommerceAgentRuntimeConfig().notificationsEnabled) {
      return NextResponse.json(
        { success: true, enabled: false, members: [] },
        { headers: { 'Cache-Control': 'no-store, max-age=0' } },
      );
    }
    const members = await getCommerceFeishuOutboxStore().listMembers(identity);
    return NextResponse.json(
      { success: true, enabled: true, members },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } },
    );
  } catch (error) {
    return commerceApiError(error);
  }
}

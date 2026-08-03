import { NextResponse } from 'next/server';

import { checkCommerceReadiness } from '@/lib/domains/commerce/agent/readiness';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const readiness = await checkCommerceReadiness();
  return NextResponse.json(
    {
      ok: readiness.ready,
      service: 'commerce-data-agent',
      revision: process.env.COMMERCE_RELEASE_REVISION || 'unversioned',
      scope: readiness.scope,
      checks: readiness.checks,
      issues: readiness.issues,
    },
    {
      status: readiness.ready ? 200 : 503,
      headers: { 'Cache-Control': 'no-store, max-age=0' },
    },
  );
}

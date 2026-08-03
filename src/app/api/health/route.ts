import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json(
    {
      ok: true,
      service: 'commerce-data-agent-web',
      revision: process.env.COMMERCE_RELEASE_REVISION || 'unversioned',
    },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}

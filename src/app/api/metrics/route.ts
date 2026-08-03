import { type NextRequest } from 'next/server';

import {
  authorizeCommerceMetrics,
  collectCommercePrometheusMetrics,
  commerceMetricsTenantId,
} from '@/lib/domains/commerce/agent/metrics';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!authorizeCommerceMetrics(request.headers.get('authorization'))) {
    return new Response('Not found.\n', { status: 404 });
  }
  try {
    const tenantId = commerceMetricsTenantId(
      request.headers.get('x-commerce-metrics-tenant-id'),
    );
    return new Response(await collectCommercePrometheusMetrics(tenantId), {
      headers: {
        'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid metrics tenant id.') {
      return new Response('Invalid metrics tenant id.\n', { status: 400 });
    }
    return new Response('Commerce metrics unavailable.\n', { status: 503 });
  }
}

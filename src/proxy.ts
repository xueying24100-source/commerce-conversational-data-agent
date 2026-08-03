import { NextResponse, type NextRequest } from 'next/server';

/**
 * Commerce API routes enforce trusted-proxy identity, tenant and entitlement
 * checks themselves; health probes remain anonymous on the private service
 * network. Keep this proxy neutral so it cannot invent or rewrite identity.
 */
export function proxy(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};

import { isIP } from 'node:net';

/**
 * Returns only the single address written by the trusted ingress. The application never
 * consumes a caller-controlled X-Forwarded-For chain for anti-abuse accounting.
 */
export function commerceTrustedClientIp(headers: Pick<Headers, 'get'>): string | null {
  const value = headers.get('x-real-ip')?.trim() ?? '';
  return isIP(value) ? value : null;
}

import { timingSafeEqual } from 'node:crypto';

import type { NextRequest } from 'next/server';

import {
  getCommerceAgentRuntimeConfig,
  isValidTrustedProxySecret,
} from './config';
import type { CommerceIdentity } from './types';

export class CommerceAuthorizationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 401) {
    super(message);
    this.name = 'CommerceAuthorizationError';
    this.code = code;
    this.status = status;
  }
}

function boundedIdentity(value: string | null, field: string): string {
  const normalized = value?.trim() || '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u.test(normalized)) {
    throw new CommerceAuthorizationError('INVALID_IDENTITY', `${field} 无效。`, 403);
  }
  return normalized;
}

function safeSecretEqual(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length
    && timingSafeEqual(actualBytes, expectedBytes);
}

const REQUIRED_COMMERCE_SCOPE = 'commerce:data:read';

function commerceScopes(value: string | null): string[] {
  const scopes = Array.from(new Set(
    (value ?? '')
      .split(/[\s,]+/u)
      .map((scope) => scope.trim())
      .filter(Boolean),
  ));
  if (
    scopes.length > 32
    || scopes.some((scope) => !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,95}$/u.test(scope))
  ) {
    throw new CommerceAuthorizationError('INVALID_SCOPES', 'Commerce 权限范围无效。', 403);
  }
  if (!scopes.includes(REQUIRED_COMMERCE_SCOPE)) {
    throw new CommerceAuthorizationError(
      'COMMERCE_ACCESS_DENIED',
      '当前身份没有 Commerce Data Agent 读取权限。',
      403,
    );
  }
  return scopes;
}

export function resolveCommerceIdentity(request: NextRequest): CommerceIdentity {
  const config = getCommerceAgentRuntimeConfig();
  if (config.developmentAuthBypass && process.env.NODE_ENV !== 'production') {
    return {
      tenantId: boundedIdentity(config.developmentTenantId, 'development tenant'),
      userId: boundedIdentity(config.developmentUserId, 'development user'),
      displayName: 'Local operator',
      scopes: [REQUIRED_COMMERCE_SCOPE],
      authMode: 'development',
    };
  }
  const expectedSecret = config.trustedProxySecret;
  const actualSecret = request.headers.get('x-commerce-proxy-secret')?.trim() || '';
  if (!isValidTrustedProxySecret(expectedSecret) || !safeSecretEqual(actualSecret, expectedSecret)) {
    throw new CommerceAuthorizationError(
      'UNAUTHORIZED',
      '请求必须经过受信任的身份代理。',
    );
  }
  return {
    tenantId: boundedIdentity(request.headers.get('x-commerce-tenant-id'), 'tenant identity'),
    userId: boundedIdentity(request.headers.get('x-commerce-user-id'), 'user identity'),
    displayName: request.headers.get('x-commerce-user-name')?.trim().slice(0, 120) || 'Operator',
    scopes: commerceScopes(request.headers.get('x-commerce-scopes')),
    authMode: 'trusted_proxy',
  };
}

export function assertCommerceMutationOrigin(request: NextRequest): void {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) {
    throw new CommerceAuthorizationError('CROSS_SITE_REQUEST', '拒绝跨站写请求。', 403);
  }
  const configuredOrigin = getCommerceAgentRuntimeConfig().publicOrigin;
  const origin = request.headers.get('origin')?.replace(/\/$/u, '') || null;
  if (configuredOrigin && origin && origin !== configuredOrigin) {
    throw new CommerceAuthorizationError('ORIGIN_MISMATCH', '请求 Origin 不受信任。', 403);
  }
}

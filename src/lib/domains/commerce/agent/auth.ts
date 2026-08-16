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

export const REQUIRED_COMMERCE_SCOPE = 'commerce:data:read';
export const COMMERCE_FEEDBACK_REVIEW_SCOPE = 'commerce:feedback:review';
export const COMMERCE_NOTIFICATION_WRITE_SCOPE = 'commerce:notifications:write';
const DEVELOPMENT_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function assertDevelopmentLoopback(request: NextRequest): void {
  const hostname = request.nextUrl.hostname.trim().toLowerCase();
  if (!DEVELOPMENT_LOOPBACK_HOSTS.has(hostname)) {
    throw new CommerceAuthorizationError(
      'DEV_AUTH_LOOPBACK_ONLY',
      '开发鉴权绕过只允许从当前电脑访问。',
      403,
    );
  }
}

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
    assertDevelopmentLoopback(request);
    const developmentScopes = commerceScopes(
      process.env.COMMERCE_DEV_SCOPES || REQUIRED_COMMERCE_SCOPE,
    );
    return {
      tenantId: boundedIdentity(config.developmentTenantId, 'development tenant'),
      userId: boundedIdentity(config.developmentUserId, 'development user'),
      displayName: 'Local operator',
      scopes: developmentScopes,
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

export function assertCommerceScope(identity: CommerceIdentity, scope: string): void {
  if (!identity.scopes.includes(scope)) {
    throw new CommerceAuthorizationError(
      'COMMERCE_SCOPE_REQUIRED',
      '当前身份没有执行此操作所需的 Commerce 权限。',
      403,
    );
  }
}

export function assertCommerceFeedbackReviewer(identity: CommerceIdentity): void {
  assertCommerceScope(identity, COMMERCE_FEEDBACK_REVIEW_SCOPE);
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

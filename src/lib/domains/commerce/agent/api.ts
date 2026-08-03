import { ZodError } from 'zod';
import { NextResponse, type NextRequest } from 'next/server';

import { CommerceAuthorizationError } from './auth';
import {
  CommerceConversationBusyError,
  CommerceIdempotencyConflictError,
} from './conversation-store';
import { CommerceModelConfigurationError } from './model-provider';
import { CommerceAgentRunError } from './runtime';
import {
  CommerceConversationNotFoundError,
  CommerceRateLimitError,
  CommerceRequestStateError,
  CommerceTurnExecutionError,
} from './service';
import { logCommerceFailure } from './telemetry';
import {
  CommerceJobConflictError,
  CommerceJobNotFoundError,
  CommerceJobQueueFullError,
} from './job-store';

export async function readCommerceJson(request: NextRequest): Promise<unknown> {
  const contentType = request.headers.get('content-type')?.toLowerCase() || '';
  if (!/^application\/json(?:\s*;|$)/u.test(contentType)) {
    throw new CommerceAgentRunError('INVALID_CONTENT_TYPE', 'Content-Type 必须是 application/json。');
  }
  const contentLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 24_000) {
    throw new CommerceAgentRunError('REQUEST_TOO_LARGE', '请求体不能超过 24KB。');
  }
  try {
    if (!request.body) throw new Error('missing body');
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 24_000) {
        await reader.cancel('Commerce request body exceeded 24KB.').catch(() => undefined);
        throw new CommerceAgentRunError('REQUEST_TOO_LARGE', '请求体不能超过 24KB。');
      }
      chunks.push(value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch (error) {
    if (error instanceof CommerceAgentRunError) throw error;
    throw new CommerceAgentRunError('INVALID_JSON', '请求体必须是 JSON object。');
  }
}

export function commerceApiError(error: unknown): NextResponse {
  const conversationId = error instanceof CommerceTurnExecutionError
    ? error.conversationId
    : null;
  if (error instanceof CommerceTurnExecutionError) error = error.originalError;
  const context = conversationId ? { conversationId } : {};
  if (error instanceof CommerceAuthorizationError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message, ...context },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { success: false, error: 'INVALID_REQUEST', message: error.issues[0]?.message ?? '请求参数无效。', ...context },
      { status: 400 },
    );
  }
  if (error instanceof CommerceConversationNotFoundError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message, ...context },
      { status: 404 },
    );
  }
  if (error instanceof CommerceJobNotFoundError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message, ...context },
      { status: 404 },
    );
  }
  if (
    error instanceof CommerceIdempotencyConflictError
    || error instanceof CommerceJobConflictError
    || error instanceof CommerceConversationBusyError
    || error instanceof CommerceRequestStateError
  ) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message, ...context },
      { status: 409 },
    );
  }
  if (error instanceof CommerceJobQueueFullError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message, ...context },
      { status: 429, headers: { 'Retry-After': '10' } },
    );
  }
  if (error instanceof CommerceRateLimitError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message, ...context },
      { status: 429, headers: { 'Retry-After': '60' } },
    );
  }
  if (error instanceof CommerceModelConfigurationError) {
    return NextResponse.json(
      { success: false, error: error.code, message: error.message, ...context },
      { status: 503 },
    );
  }
  if (error instanceof CommerceAgentRunError) {
    const status = error.code === 'REQUEST_TOO_LARGE'
      ? 413
      : error.code === 'INVALID_CONTENT_TYPE'
        ? 415
        : ['INVALID_JSON', 'INVALID_MESSAGE'].includes(error.code)
          ? 400
          : 502;
    return NextResponse.json(
      { success: false, error: error.code, message: error.message, ...context },
      { status },
    );
  }
  const message = error instanceof Error ? error.message : 'Commerce Agent request failed.';
  const configurationFailure = /COMMERCE_.*DATABASE_URL|ECONNREFUSED|relation .* does not exist/iu.test(message);
  logCommerceFailure('commerce.request.failed', error, { conversationId });
  return NextResponse.json(
    {
      success: false,
      error: configurationFailure ? 'COMMERCE_DATA_UNAVAILABLE' : 'COMMERCE_AGENT_FAILED',
      message: configurationFailure
        ? '生产数据库不可用或尚未执行 commerce-agent migration。'
        : 'Commerce Data Agent 运行失败，请使用 request ID 检查服务日志。',
      ...context,
    },
    { status: configurationFailure ? 503 : 500 },
  );
}

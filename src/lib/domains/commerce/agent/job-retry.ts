const RETRYABLE_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'NETWORK_ERROR',
  'COMMERCE_CONVERSATION_BUSY',
  'COMMERCE_RATE_LIMITED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
  '40001',
  '40P01',
  '55P03',
]);

type ErrorShape = {
  code?: unknown;
  status?: unknown;
  retryAfterMs?: unknown;
  cause?: unknown;
  originalError?: unknown;
};

function shape(value: unknown): ErrorShape | null {
  return value && typeof value === 'object' ? value as ErrorShape : null;
}

export function commerceJobRetrySignal(error: unknown): {
  retryable: boolean;
  retryAfterMs: number | null;
} {
  const visited = new Set<unknown>();
  const pending = [error];
  let retryAfterMs: number | null = null;
  while (pending.length) {
    const current = pending.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const candidate = shape(current);
    if (!candidate) continue;
    const status = Number(candidate.status);
    const code = typeof candidate.code === 'string' ? candidate.code : '';
    const delay = Number(candidate.retryAfterMs);
    if (Number.isFinite(delay) && delay >= 0) {
      retryAfterMs = Math.max(retryAfterMs ?? 0, delay);
    }
    if (RETRYABLE_HTTP_STATUS.has(status) || RETRYABLE_CODES.has(code) || /^08/u.test(code)) {
      return { retryable: true, retryAfterMs };
    }
    pending.push(candidate.originalError, candidate.cause);
  }
  return { retryable: false, retryAfterMs };
}

export function commerceJobRetryDelay(input: {
  attemptCount: number;
  baseMs: number;
  maxMs: number;
  retryAfterMs?: number | null;
  random?: () => number;
}): number {
  const exponent = Math.max(0, input.attemptCount - 1);
  const exponential = Math.min(input.maxMs, input.baseMs * (2 ** exponent));
  const floor = Math.min(input.maxMs, Math.max(exponential, input.retryAfterMs ?? 0));
  const random = input.random ?? Math.random;
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.max(1, Math.min(input.maxMs, Math.round(floor * jitter)));
}

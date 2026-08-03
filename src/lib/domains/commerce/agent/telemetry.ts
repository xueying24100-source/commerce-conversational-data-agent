const SECRET_PATTERNS = [
  /\b(?:postgres(?:ql)?|redis|rediss):\/\/[^\s@]+@/giu,
  /\b(?:sk|key|token|secret)[-_A-Za-z0-9]{12,}\b/giu,
];

function redact(value: string): string {
  return SECRET_PATTERNS.reduce(
    (result, pattern) => result.replace(pattern, '[redacted]'),
    value,
  ).slice(0, 2_000);
}

function errorDetails(error: unknown) {
  if (!(error instanceof Error)) {
    return { name: 'UnknownError', message: redact(String(error)) };
  }
  const code = 'code' in error ? String(error.code) : null;
  return {
    name: error.name,
    code,
    message: redact(error.message),
    ...(process.env.NODE_ENV === 'production' ? {} : { stack: redact(error.stack || '') }),
  };
}

export function logCommerceEvent(
  event: string,
  context: Record<string, string | number | boolean | null> = {},
): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    service: 'commerce-data-agent',
    revision: process.env.COMMERCE_RELEASE_REVISION || 'unversioned',
    event,
    ...context,
  }));
}

export function logCommerceFailure(
  event: string,
  error: unknown,
  context: Record<string, string | number | boolean | null> = {},
): void {
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    service: 'commerce-data-agent',
    revision: process.env.COMMERCE_RELEASE_REVISION || 'unversioned',
    event,
    ...context,
    error: errorDetails(error),
  }));
}

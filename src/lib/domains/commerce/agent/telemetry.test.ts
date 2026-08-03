import { afterEach, describe, expect, it, vi } from 'vitest';

import { logCommerceFailure } from './telemetry';

describe('Commerce structured telemetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('emits bounded JSON and redacts credentials without production stacks', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const output = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    logCommerceFailure(
      'commerce.test.failed',
      new Error('postgresql://user:password@db.internal:5432/app sk-supersecretmaterial123'),
      { conversationId: 'conv_test' },
    );

    expect(output).toHaveBeenCalledOnce();
    const record = JSON.parse(String(output.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: 'error',
      service: 'commerce-data-agent',
      event: 'commerce.test.failed',
      conversationId: 'conv_test',
    });
    expect(JSON.stringify(record)).not.toContain('password');
    expect(JSON.stringify(record)).not.toContain('supersecretmaterial');
    expect(record.error).not.toHaveProperty('stack');
  });
});

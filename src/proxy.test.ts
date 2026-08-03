import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { proxy } from './proxy';

describe('data agent proxy', () => {
  it('keeps the local commerce API reachable without an account layer', () => {
    const response = proxy(new NextRequest('http://localhost:3000/api/commerce', {
      method: 'POST',
    }));

    expect(response.headers.get('x-middleware-next')).toBe('1');
  });
});

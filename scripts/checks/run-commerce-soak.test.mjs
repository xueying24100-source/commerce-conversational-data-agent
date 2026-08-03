import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { percentile } = require('./run-commerce-soak.js');

describe('Commerce soak report helpers', () => {
  it('calculates stable nearest-rank latency percentiles', () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([10, 50, 20, 40, 30], 0.5)).toBe(30);
    expect(percentile([10, 50, 20, 40, 30], 0.95)).toBe(50);
  });
});

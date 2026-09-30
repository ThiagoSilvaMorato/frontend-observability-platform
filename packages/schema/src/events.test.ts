import { describe, expect, it } from 'vitest';
import { rateWebVital } from './events.ts';

describe('rateWebVital', () => {
  it.each([
    ['LCP', 2500, 'good'],
    ['LCP', 2501, 'needs-improvement'],
    ['LCP', 4000, 'needs-improvement'],
    ['LCP', 4001, 'poor'],
    ['CLS', 0.1, 'good'],
    ['CLS', 0.3, 'poor'],
    ['INP', 350, 'needs-improvement'],
  ] as const)('%s = %d is %s (thresholds are inclusive upper bounds)', (name, value, rating) => {
    expect(rateWebVital(name, value)).toBe(rating);
  });
});

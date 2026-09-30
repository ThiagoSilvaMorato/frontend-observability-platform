import { describe, expect, it } from 'vitest';
import { createRateLimiter } from './rate-limit.ts';

function setup() {
  let time = 0;
  const limiter = createRateLimiter({ max: 2, windowMs: 1_000, now: () => time });
  return { limiter, advance: (ms: number) => (time += ms) };
}

describe('rate limiter', () => {
  it('allows up to max per key per window', () => {
    const { limiter } = setup();

    expect(limiter.check('a')).toEqual({ allowed: true, suppressed: 0 });
    expect(limiter.check('a')).toEqual({ allowed: true, suppressed: 0 });
    expect(limiter.check('a')).toEqual({ allowed: false });
    expect(limiter.check('b')).toEqual({ allowed: true, suppressed: 0 });
  });

  it('reports how many occurrences were suppressed on the next allowed one', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 10; i++) limiter.check('a');

    advance(1_000);

    expect(limiter.check('a')).toEqual({ allowed: true, suppressed: 8 });
    expect(limiter.check('a')).toEqual({ allowed: true, suppressed: 0 });
  });

  it('prunes expired keys without losing pending suppressed counts', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 5; i++) limiter.check('storm');
    for (let i = 0; i < 99; i++) limiter.check(`k${i}`);
    advance(1_000);

    // Tracking is full, so a new key triggers pruning of expired windows.
    limiter.check('new');

    expect(limiter.check('storm')).toEqual({ allowed: true, suppressed: 3 });
  });
});

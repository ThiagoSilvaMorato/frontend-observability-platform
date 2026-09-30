export interface RateLimiterOptions {
  /** Occurrences allowed per key per window. */
  max: number;
  windowMs: number;
  now?: () => number;
}

export type RateLimitDecision =
  | { allowed: true; /** Occurrences dropped since the last allowed one. */ suppressed: number }
  | { allowed: false };

const MAX_TRACKED_KEYS = 100;

/**
 * Fixed-window limiter per key. It exists for error storms: a render loop or
 * a failing interval can throw the same error hundreds of times per second,
 * which would flood the queue, evict every other event and burn the user's
 * bandwidth — all to report one bug. The first occurrence after a suppressed
 * run carries the suppressed count, so the volume is not silently lost.
 */
export function createRateLimiter({ max, windowMs, now = Date.now }: RateLimiterOptions) {
  const windows = new Map<string, { start: number; count: number; suppressed: number }>();

  function prune(time: number) {
    for (const [key, entry] of windows) {
      if (time - entry.start >= windowMs && entry.suppressed === 0) windows.delete(key);
    }
  }

  return {
    check(key: string): RateLimitDecision {
      const time = now();
      let entry = windows.get(key);
      if (!entry || time - entry.start >= windowMs) {
        if (!entry && windows.size >= MAX_TRACKED_KEYS) prune(time);
        entry = { start: time, count: 0, suppressed: entry?.suppressed ?? 0 };
        windows.set(key, entry);
      }

      if (entry.count >= max) {
        entry.suppressed++;
        return { allowed: false };
      }
      entry.count++;
      const suppressed = entry.suppressed;
      entry.suppressed = 0;
      return { allowed: true, suppressed };
    },
  };
}

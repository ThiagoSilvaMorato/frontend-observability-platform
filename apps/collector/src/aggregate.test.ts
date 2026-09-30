import { describe, expect, it } from 'vitest';
import {
  buildErrorGroups,
  buildEventsPage,
  buildOverview,
  buildRequestGroups,
  chooseBucketMs,
  percentile,
} from './aggregate.ts';
import { customEvent, errorEvent, requestEvent, stored, T0, vitalEvent } from './test-utils.ts';

const MINUTE = 60_000;
const window = { from: T0, to: T0 + 60 * MINUTE };

describe('percentile', () => {
  it('uses nearest rank', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 50)).toBe(5);
    expect(percentile(values, 95)).toBe(10);
    expect(percentile([42], 75)).toBe(42);
  });
});

describe('chooseBucketMs', () => {
  it.each([
    [60 * MINUTE, MINUTE],
    [6 * 60 * MINUTE, 15 * MINUTE],
    [24 * 60 * MINUTE, 30 * MINUTE],
  ])('picks a round bucket for a %i ms window', (span, expected) => {
    expect(chooseBucketMs({ from: 0, to: span })).toBe(expected);
  });
});

describe('buildOverview', () => {
  it('computes error rate per session, not per event', () => {
    const events = [
      errorEvent({}, { sessionId: 's1' }),
      errorEvent({}, { sessionId: 's1' }),
      customEvent('x', { sessionId: 's2' }),
      customEvent('x', { sessionId: 's3' }),
      customEvent('x', { sessionId: 's4' }),
    ].map((event) => stored(event));

    const overview = buildOverview(events, window);

    expect(overview.totals).toMatchObject({
      events: 5,
      sessions: 4,
      errors: 2,
      sessionsWithErrors: 1,
    });
    expect(overview.errorRate).toBe(0.25);
  });

  it('excludes aborted requests from the API error rate and failed ones from latency', () => {
    const events = [
      requestEvent({ status: 200, durationMs: 100 }),
      requestEvent({ status: 200, durationMs: 300 }),
      requestEvent({ status: 500, durationMs: 200, outcome: 'http_error' }),
      requestEvent({ status: 0, durationMs: 10_000, outcome: 'timeout' }),
      requestEvent({ status: 0, durationMs: 5, outcome: 'aborted' }),
    ].map((event) => stored(event));

    const overview = buildOverview(events, window);

    expect(overview.totals).toMatchObject({ requests: 5, failedRequests: 2 });
    expect(overview.apiErrorRate).toBe(0.5);
    expect(overview.latency).toEqual({ avg: 200, p50: 200, p95: 300 });
  });

  it('reports null rates instead of 0 when there is nothing to divide', () => {
    const overview = buildOverview([], window);

    expect(overview.errorRate).toBeNull();
    expect(overview.apiErrorRate).toBeNull();
    expect(overview.latency).toBeNull();
  });

  it('assesses web vitals at p75 with ratings recomputed from thresholds', () => {
    const lcp = [1000, 2000, 3000, 5000].map((value) =>
      stored(vitalEvent({ name: 'LCP', value, rating: 'good' })),
    );

    const { webVitals } = buildOverview(lcp, window);

    expect(webVitals.LCP).toEqual({
      samples: 4,
      p75: 3000,
      rating: 'needs-improvement',
      ratings: { good: 2, 'needs-improvement': 1, poor: 1 },
    });
    expect(webVitals.INP).toBeUndefined();
  });

  it('fills a continuous time series, including empty buckets', () => {
    const events = [
      stored(errorEvent({}, { timestamp: T0 + 30_000 })),
      stored(requestEvent({ outcome: 'network_error', status: 0 }, { timestamp: T0 + 2 * MINUTE })),
    ];

    const { timeseries, window: result } = buildOverview(events, window);

    expect(result.bucketMs).toBe(MINUTE);
    expect(timeseries).toHaveLength(60);
    expect(timeseries[0]).toMatchObject({ start: T0, events: 1, errors: 1 });
    expect(timeseries[1]).toMatchObject({ events: 0 });
    expect(timeseries[2]).toMatchObject({ requests: 1, failedRequests: 1 });
  });
});

describe('buildErrorGroups', () => {
  it('groups by fingerprint, counting sessions and ranking pages', () => {
    const events = [
      stored(errorEvent({ message: 'old' }, { sessionId: 's1', page: '/a', timestamp: T0 }), 'fp1'),
      stored(
        errorEvent(
          { message: 'new', stack: 'at x' },
          { sessionId: 's2', page: '/b', timestamp: T0 + 2 },
        ),
        'fp1',
      ),
      stored(errorEvent({}, { sessionId: 's2', page: '/b', timestamp: T0 + 1 }), 'fp1'),
      stored(errorEvent({ name: 'RangeError' }, { timestamp: T0 }), 'fp2'),
    ];

    const { groups } = buildErrorGroups(events, window);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      fingerprint: 'fp1',
      count: 3,
      sessions: 2,
      pages: ['/b', '/a'],
      firstSeen: T0,
      lastSeen: T0 + 2,
      message: 'new',
      lastStack: 'at x',
    });
    expect(groups[1]).toMatchObject({ fingerprint: 'fp2', name: 'RangeError', count: 1 });
  });
});

describe('buildRequestGroups', () => {
  it('groups by method and normalized endpoint', () => {
    const events = [
      requestEvent({ url: 'https://api.test/pokemon/1', durationMs: 100 }),
      requestEvent({ url: 'https://api.test/pokemon/2', durationMs: 300 }),
      requestEvent({ url: 'https://api.test/pokemon/3', status: 404, outcome: 'http_error' }),
      requestEvent({ url: 'https://api.test/pokemon/1', method: 'DELETE' }),
    ].map((event) => stored(event));

    const { groups } = buildRequestGroups(events, window);

    expect(groups[0]).toMatchObject({
      method: 'GET',
      endpoint: 'https://api.test/pokemon/:id',
      count: 3,
      failures: 1,
      statuses: { 200: 2, 404: 1 },
    });
    expect(groups[0]!.errorRate).toBeCloseTo(1 / 3);
    expect(groups[1]).toMatchObject({ method: 'DELETE', count: 1 });
  });
});

describe('buildEventsPage', () => {
  it('returns the newest events first, up to the limit, with the full total', () => {
    const events = [0, 2, 1].map((offset) =>
      stored(customEvent(`e${offset}`, { timestamp: T0 + offset })),
    );

    const page = buildEventsPage(events, window, 2);

    expect(page.total).toBe(3);
    expect(page.items.map((event) => event.occurredAt)).toEqual([T0 + 2, T0 + 1]);
  });
});

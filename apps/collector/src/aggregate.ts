import {
  rateWebVital,
  type ErrorGroup,
  type ErrorsResponse,
  type EventsResponse,
  type LatencySummary,
  type OverviewResponse,
  type QueryWindow,
  type RequestGroup,
  type RequestOutcome,
  type RequestsResponse,
  type StoredEvent,
  type TimeBucket,
  type WebVitalName,
  type WebVitalRating,
  type WebVitalSummary,
} from '@fop/schema';
import { normalizeEndpoint } from './grouping.ts';

/**
 * Aggregations are pure functions over the events of one query window. At demo
 * scale a linear scan is simpler than maintaining pre-aggregated counters; a
 * persistent store can push these down to SQL behind the same responses.
 */

const FAILED_OUTCOMES: ReadonlySet<RequestOutcome> = new Set([
  'http_error',
  'network_error',
  'timeout',
]);

const MINUTE = 60_000;
const BUCKET_SIZES = [1, 5, 15, 30, 60, 180, 360, 720, 1440].map((minutes) => minutes * MINUTE);
const MAX_BUCKETS = 60;

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

export function summarizeLatency(durations: number[]): LatencySummary | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return { avg: total / sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95) };
}

/** Smallest "round" bucket that keeps the chart at or under MAX_BUCKETS points. */
export function chooseBucketMs({ from, to }: QueryWindow): number {
  const span = to - from;
  return BUCKET_SIZES.find((size) => span / size <= MAX_BUCKETS) ?? BUCKET_SIZES.at(-1)!;
}

const ratio = (part: number, whole: number) => (whole === 0 ? null : part / whole);

export function buildOverview(events: StoredEvent[], window: QueryWindow): OverviewResponse {
  const bucketMs = chooseBucketMs(window);
  const firstBucket = Math.floor(window.from / bucketMs) * bucketMs;
  const timeseries: TimeBucket[] = [];
  for (let start = firstBucket; start < window.to; start += bucketMs) {
    timeseries.push({ start, events: 0, errors: 0, requests: 0, failedRequests: 0 });
  }

  const sessions = new Set<string>();
  const sessionsWithErrors = new Set<string>();
  const durations: number[] = [];
  const vitals = new Map<WebVitalName, number[]>();
  let errors = 0;
  let requests = 0;
  let completedRequests = 0;
  let failedRequests = 0;

  for (const event of events) {
    const bucket = timeseries[Math.floor((event.occurredAt - firstBucket) / bucketMs)];
    if (bucket) bucket.events++;
    sessions.add(event.sessionId);

    switch (event.type) {
      case 'error':
        errors++;
        sessionsWithErrors.add(event.sessionId);
        if (bucket) bucket.errors++;
        break;
      case 'request': {
        const { outcome, status, durationMs } = event.request;
        requests++;
        if (bucket) bucket.requests++;
        if (outcome !== 'aborted') completedRequests++;
        if (FAILED_OUTCOMES.has(outcome)) {
          failedRequests++;
          if (bucket) bucket.failedRequests++;
        }
        if (status > 0) durations.push(durationMs);
        break;
      }
      case 'web_vital': {
        const values = vitals.get(event.webVital.name) ?? [];
        values.push(event.webVital.value);
        vitals.set(event.webVital.name, values);
        break;
      }
    }
  }

  return {
    window: { ...window, bucketMs },
    totals: {
      events: events.length,
      sessions: sessions.size,
      errors,
      sessionsWithErrors: sessionsWithErrors.size,
      requests,
      failedRequests,
    },
    errorRate: ratio(sessionsWithErrors.size, sessions.size),
    apiErrorRate: ratio(failedRequests, completedRequests),
    latency: summarizeLatency(durations),
    webVitals: Object.fromEntries(
      [...vitals].map(([name, values]) => [name, summarizeVital(name, values)]),
    ),
    timeseries,
  };
}

/**
 * Ratings are recomputed from the thresholds rather than trusted from the
 * client, and the headline rating is the one of the p75 — how Core Web Vitals
 * are assessed.
 */
function summarizeVital(name: WebVitalName, values: number[]): WebVitalSummary {
  const sorted = [...values].sort((a, b) => a - b);
  const ratings: Record<WebVitalRating, number> = { good: 0, 'needs-improvement': 0, poor: 0 };
  for (const value of sorted) ratings[rateWebVital(name, value)]++;
  const p75 = percentile(sorted, 75);
  return { samples: sorted.length, p75, rating: rateWebVital(name, p75), ratings };
}

export function buildErrorGroups(events: StoredEvent[], window: QueryWindow): ErrorsResponse {
  const groups = new Map<
    string,
    { group: ErrorGroup; sessions: Set<string>; pages: Map<string, number> }
  >();

  for (const event of events) {
    if (event.type !== 'error' || !event.fingerprint) continue;
    let entry = groups.get(event.fingerprint);
    if (!entry) {
      entry = {
        group: {
          fingerprint: event.fingerprint,
          name: event.error.name,
          message: event.error.message,
          source: event.error.source,
          count: 0,
          sessions: 0,
          pages: [],
          firstSeen: event.occurredAt,
          lastSeen: event.occurredAt,
        },
        sessions: new Set(),
        pages: new Map(),
      };
      groups.set(event.fingerprint, entry);
    }

    const { group } = entry;
    group.count++;
    entry.sessions.add(event.sessionId);
    entry.pages.set(event.page, (entry.pages.get(event.page) ?? 0) + 1);
    group.firstSeen = Math.min(group.firstSeen, event.occurredAt);
    if (event.occurredAt >= group.lastSeen) {
      // The latest occurrence represents the group: its message and stack are
      // what someone debugging it right now will see.
      group.lastSeen = event.occurredAt;
      group.message = event.error.message;
      if (event.error.stack) group.lastStack = event.error.stack;
    }
  }

  return {
    window,
    groups: [...groups.values()]
      .map(({ group, sessions, pages }) => ({
        ...group,
        sessions: sessions.size,
        pages: [...pages]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([page]) => page),
      }))
      .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen),
  };
}

export function buildRequestGroups(events: StoredEvent[], window: QueryWindow): RequestsResponse {
  const groups = new Map<string, { group: RequestGroup; durations: number[]; completed: number }>();

  for (const event of events) {
    if (event.type !== 'request') continue;
    const { method, url, status, durationMs, outcome } = event.request;
    const endpoint = normalizeEndpoint(url);
    const key = `${method} ${endpoint}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        group: {
          method,
          endpoint,
          count: 0,
          failures: 0,
          errorRate: null,
          latency: null,
          statuses: {},
          lastSeen: event.occurredAt,
        },
        durations: [],
        completed: 0,
      };
      groups.set(key, entry);
    }

    const { group } = entry;
    group.count++;
    if (outcome !== 'aborted') entry.completed++;
    if (FAILED_OUTCOMES.has(outcome)) group.failures++;
    if (status > 0) entry.durations.push(durationMs);
    group.statuses[status] = (group.statuses[status] ?? 0) + 1;
    group.lastSeen = Math.max(group.lastSeen, event.occurredAt);
  }

  return {
    window,
    groups: [...groups.values()]
      .map(({ group, durations, completed }) => ({
        ...group,
        errorRate: ratio(group.failures, completed),
        latency: summarizeLatency(durations),
      }))
      .sort((a, b) => b.count - a.count),
  };
}

export function buildEventsPage(
  events: StoredEvent[],
  window: QueryWindow,
  limit: number,
): EventsResponse {
  const items = [...events].sort((a, b) => b.occurredAt - a.occurredAt).slice(0, limit);
  return { window, total: events.length, items };
}

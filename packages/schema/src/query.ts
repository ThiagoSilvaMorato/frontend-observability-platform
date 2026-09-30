import type {
  ErrorSource,
  EventType,
  ObservabilityEvent,
  WebVitalName,
  WebVitalRating,
} from './events.ts';

/**
 * Read-side contract between the collector's query API and the dashboard.
 * Aggregation happens in the collector; the dashboard only presents.
 */

export interface QueryWindow {
  from: number;
  to: number;
}

/** A stored event as returned by the query API. */
export type StoredEvent = ObservabilityEvent & {
  /** Collector clock when the batch arrived. */
  receivedAt: number;
  /** `timestamp` corrected by the batch's clock skew (receivedAt - sentAt). */
  occurredAt: number;
  /** Error events only: the key errors are grouped by. */
  fingerprint?: string;
};

export interface EventsResponse {
  window: QueryWindow;
  /** Matching events in the window, before `limit` is applied. */
  total: number;
  /** Newest first. */
  items: StoredEvent[];
}

export interface LatencySummary {
  avg: number;
  p50: number;
  p95: number;
}

export interface WebVitalSummary {
  samples: number;
  /** Core Web Vitals are assessed at the 75th percentile. */
  p75: number;
  rating: WebVitalRating;
  ratings: Record<WebVitalRating, number>;
}

export interface TimeBucket {
  start: number;
  events: number;
  errors: number;
  requests: number;
  failedRequests: number;
}

export interface OverviewResponse {
  window: QueryWindow & { bucketMs: number };
  totals: {
    events: number;
    sessions: number;
    errors: number;
    sessionsWithErrors: number;
    requests: number;
    failedRequests: number;
  };
  /** Share of sessions with at least one error; null without sessions. */
  errorRate: number | null;
  /** Failed / completed requests (aborted ones excluded); null without requests. */
  apiErrorRate: number | null;
  /** Over requests that received a response; null when there are none. */
  latency: LatencySummary | null;
  webVitals: Partial<Record<WebVitalName, WebVitalSummary>>;
  timeseries: TimeBucket[];
}

export interface ErrorGroup {
  fingerprint: string;
  name: string;
  message: string;
  source: ErrorSource;
  count: number;
  sessions: number;
  /** Most frequent pages first, at most 5. */
  pages: string[];
  firstSeen: number;
  lastSeen: number;
  lastStack?: string;
}

export interface ErrorsResponse {
  window: QueryWindow;
  /** Most frequent first. */
  groups: ErrorGroup[];
}

export interface RequestGroup {
  method: string;
  /** URL with id-like path segments replaced by `:id`. */
  endpoint: string;
  count: number;
  failures: number;
  errorRate: number | null;
  latency: LatencySummary | null;
  /** Keyed by HTTP status, `0` for requests without a response. */
  statuses: Record<string, number>;
  lastSeen: number;
}

export interface RequestsResponse {
  window: QueryWindow;
  /** Highest volume first. */
  groups: RequestGroup[];
}

export interface EventQuery {
  application?: string;
  environment?: string;
  type?: EventType;
  from?: number;
  to?: number;
}

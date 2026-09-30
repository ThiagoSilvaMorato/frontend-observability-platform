/**
 * Wire format version. Bumped only on breaking changes; the collector rejects
 * batches it does not understand instead of guessing.
 */
export const SCHEMA_VERSION = 1;

export const EVENT_TYPES = ['error', 'request', 'web_vital', 'navigation', 'custom'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Metadata is deliberately flat and primitive-only: it keeps payloads small,
 * makes it queryable without schema knowledge, and prevents apps from dumping
 * whole objects (and whatever PII they contain) into telemetry.
 */
export type MetadataValue = string | number | boolean | null;
export type Metadata = Record<string, MetadataValue>;

/** Fields every event carries, regardless of type. */
export interface EventContext {
  /** Client-generated UUID. Doubles as the idempotency key for retried batches. */
  id: string;
  /** Epoch milliseconds, client clock. */
  timestamp: number;
  application: string;
  environment: string;
  release?: string;
  sessionId: string;
  /** Route path only (no query string or hash) — see privacy rules. */
  page: string;
  metadata?: Metadata;
}

export const ERROR_SOURCES = ['uncaught', 'unhandled_rejection', 'manual'] as const;
export type ErrorSource = (typeof ERROR_SOURCES)[number];

export interface ErrorEvent extends EventContext {
  type: 'error';
  error: {
    source: ErrorSource;
    name: string;
    message: string;
    stack?: string;
  };
}

export const REQUEST_OUTCOMES = [
  'success',
  'http_error',
  'network_error',
  'timeout',
  'aborted',
] as const;
export type RequestOutcome = (typeof REQUEST_OUTCOMES)[number];

export interface RequestEvent extends EventContext {
  type: 'request';
  request: {
    method: string;
    /** Origin + path only; query strings may carry tokens. */
    url: string;
    /** HTTP status, or 0 when no response was received. */
    status: number;
    durationMs: number;
    outcome: RequestOutcome;
    /** 1-based attempt number when the app retries; retries = attempt - 1. */
    attempt?: number;
  };
}

export const WEB_VITAL_NAMES = ['LCP', 'INP', 'CLS', 'FCP', 'TTFB'] as const;
export type WebVitalName = (typeof WEB_VITAL_NAMES)[number];

export const WEB_VITAL_RATINGS = ['good', 'needs-improvement', 'poor'] as const;
export type WebVitalRating = (typeof WEB_VITAL_RATINGS)[number];

export interface WebVitalEvent extends EventContext {
  type: 'web_vital';
  webVital: {
    name: WebVitalName;
    value: number;
    rating: WebVitalRating;
  };
}

export const NAVIGATION_KINDS = ['initial', 'push', 'replace', 'pop'] as const;
export type NavigationKind = (typeof NAVIGATION_KINDS)[number];

export interface NavigationEvent extends EventContext {
  type: 'navigation';
  /** The destination is `page`; only the origin needs to be recorded. */
  navigation: {
    from: string | null;
    kind: NavigationKind;
  };
}

export interface CustomEvent extends EventContext {
  type: 'custom';
  custom: {
    name: string;
  };
}

export type ObservabilityEvent =
  ErrorEvent | RequestEvent | WebVitalEvent | NavigationEvent | CustomEvent;

/** Envelope sent by the SDK transport. One HTTP request carries one batch. */
export interface EventBatch {
  schemaVersion: typeof SCHEMA_VERSION;
  /** Client clock at send time; lets the collector estimate clock skew. */
  sentAt: number;
  events: ObservabilityEvent[];
}

/**
 * Hard limits shared by producer and validator. The SDK truncates to fit;
 * the collector rejects anything that still exceeds them.
 */
export const LIMITS = {
  maxEventsPerBatch: 100,
  maxStringLength: 256,
  maxMessageLength: 1024,
  maxStackLength: 8192,
  maxUrlLength: 2048,
  maxMetadataKeys: 20,
  maxMetadataKeyLength: 64,
} as const;

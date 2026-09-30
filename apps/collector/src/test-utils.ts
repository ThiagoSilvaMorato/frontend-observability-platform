import { randomUUID } from 'node:crypto';
import type {
  ErrorEvent,
  EventContext,
  ObservabilityEvent,
  RequestEvent,
  StoredEvent,
  WebVitalEvent,
} from '@fop/schema';

/** Hour-aligned, so time buckets in tests start exactly at T0. */
export const T0 = 1_789_999_200_000;

function context(overrides: Partial<EventContext> = {}): EventContext {
  return {
    id: randomUUID(),
    timestamp: T0,
    application: 'demo-app',
    environment: 'test',
    sessionId: 'session-1',
    page: '/',
    ...overrides,
  };
}

export function errorEvent(
  error: Partial<ErrorEvent['error']> = {},
  overrides: Partial<EventContext> = {},
): ErrorEvent {
  return {
    ...context(overrides),
    type: 'error',
    error: { source: 'uncaught', name: 'TypeError', message: 'boom', ...error },
  };
}

export function requestEvent(
  request: Partial<RequestEvent['request']> = {},
  overrides: Partial<EventContext> = {},
): RequestEvent {
  return {
    ...context(overrides),
    type: 'request',
    request: {
      method: 'GET',
      url: 'https://api.test/pokemon',
      status: 200,
      durationMs: 100,
      outcome: 'success',
      ...request,
    },
  };
}

export function vitalEvent(
  webVital: WebVitalEvent['webVital'],
  overrides: Partial<EventContext> = {},
): WebVitalEvent {
  return { ...context(overrides), type: 'web_vital', webVital };
}

export function customEvent(name = 'custom', overrides: Partial<EventContext> = {}) {
  return { ...context(overrides), type: 'custom', custom: { name } } satisfies ObservabilityEvent;
}

/** Stores an event as if received with no clock skew. */
export function stored(event: ObservabilityEvent, fingerprint?: string): StoredEvent {
  return {
    ...event,
    receivedAt: event.timestamp,
    occurredAt: event.timestamp,
    ...(fingerprint ? { fingerprint } : {}),
  };
}

import { describe, expect, it } from 'vitest';
import { LIMITS, SCHEMA_VERSION, type ObservabilityEvent } from './events.ts';
import { validateBatch, validateEvent } from './validate.ts';

const context = {
  id: '4f7c2a5e-8f1b-4a57-9d8e-3b1c2d4e5f60',
  timestamp: 1_790_000_000_000,
  application: 'demo-app',
  environment: 'development',
  sessionId: 'session-1',
  page: '/pokemon',
};

const validEvents: ObservabilityEvent[] = [
  {
    ...context,
    type: 'error',
    error: { source: 'uncaught', name: 'TypeError', message: 'x is undefined', stack: 'at a.js:1' },
  },
  {
    ...context,
    type: 'request',
    request: {
      method: 'GET',
      url: 'https://api.example.com/pokemon',
      status: 0,
      durationMs: 30_000,
      outcome: 'timeout',
      attempt: 3,
    },
  },
  { ...context, type: 'web_vital', webVital: { name: 'CLS', value: 0.02, rating: 'good' } },
  { ...context, type: 'navigation', navigation: { from: null, kind: 'initial' } },
  { ...context, type: 'custom', custom: { name: 'pokemon_search' }, metadata: { term: 'pika' } },
];

describe('validateEvent', () => {
  it.each(validEvents.map((event) => [event.type, event] as const))(
    'accepts a well-formed %s event unchanged',
    (_type, event) => {
      expect(validateEvent(event)).toEqual({ ok: true, event });
    },
  );

  it('drops unknown fields instead of passing them through to storage', () => {
    const result = validateEvent({
      ...context,
      type: 'custom',
      custom: { name: 'checkout', password: 'hunter2' },
      userEmail: 'someone@example.com',
    });

    expect(result).toEqual({
      ok: true,
      event: { ...context, type: 'custom', custom: { name: 'checkout' } },
    });
  });

  it('accepts an empty error message, since `throw new Error()` is legitimate', () => {
    const result = validateEvent({
      ...context,
      type: 'error',
      error: { source: 'manual', name: 'Error', message: '' },
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ['a non-object', 'nope', 'event must be an object'],
    ['an unknown type', { ...context, type: 'click' }, 'type must be one of'],
    [
      'a missing sessionId',
      { ...context, sessionId: undefined, type: 'custom', custom: { name: 'x' } },
      'sessionId',
    ],
    [
      'a float timestamp',
      { ...context, timestamp: 1.5, type: 'custom', custom: { name: 'x' } },
      'timestamp',
    ],
    ['a missing type payload', { ...context, type: 'request' }, 'request must be an object'],
    [
      'an out-of-range status',
      {
        ...context,
        type: 'request',
        request: { method: 'GET', url: '/a', status: 700, durationMs: 1, outcome: 'success' },
      },
      'request.status',
    ],
    [
      'a negative duration',
      {
        ...context,
        type: 'request',
        request: { method: 'GET', url: '/a', status: 200, durationMs: -1, outcome: 'success' },
      },
      'request.durationMs',
    ],
    [
      'an oversized stack',
      {
        ...context,
        type: 'error',
        error: {
          source: 'uncaught',
          name: 'E',
          message: 'm',
          stack: 'x'.repeat(LIMITS.maxStackLength + 1),
        },
      },
      'error.stack',
    ],
  ])('rejects %s', (_label, input, reason) => {
    const result = validateEvent(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain(reason);
  });

  describe('metadata', () => {
    const withMetadata = (metadata: unknown) =>
      validateEvent({ ...context, type: 'custom', custom: { name: 'x' }, metadata });

    it('rejects nested objects, which could smuggle arbitrary payloads', () => {
      expect(withMetadata({ user: { email: 'a@b.c' } }).ok).toBe(false);
    });

    it('rejects more keys than the limit', () => {
      const tooMany = Object.fromEntries(
        Array.from({ length: LIMITS.maxMetadataKeys + 1 }, (_, i) => [`k${i}`, i]),
      );
      expect(withMetadata(tooMany).ok).toBe(false);
    });

    it('rejects non-finite numbers', () => {
      expect(withMetadata({ ratio: Number.NaN }).ok).toBe(false);
    });
  });
});

describe('validateBatch', () => {
  const batch = (events: unknown[]) => ({
    schemaVersion: SCHEMA_VERSION,
    sentAt: context.timestamp,
    events,
  });

  it('accepts valid events and reports invalid ones by index', () => {
    const result = validateBatch(batch([validEvents[0], { nope: true }, validEvents[1]]));

    expect(result).toMatchObject({
      ok: true,
      accepted: [validEvents[0], validEvents[1]],
      rejected: [{ index: 1 }],
    });
  });

  it.each([
    ['an unsupported schema version', { ...batch([]), schemaVersion: 99 }],
    ['a missing sentAt', { schemaVersion: SCHEMA_VERSION, events: [] }],
    ['events that are not an array', { ...batch([]), events: {} }],
    [
      'more events than the batch limit',
      batch(Array.from({ length: LIMITS.maxEventsPerBatch + 1 }, () => validEvents[0])),
    ],
  ])('rejects the whole envelope for %s', (_label, input) => {
    expect(validateBatch(input).ok).toBe(false);
  });
});

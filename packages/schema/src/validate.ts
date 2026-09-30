import {
  ERROR_SOURCES,
  EVENT_TYPES,
  LIMITS,
  NAVIGATION_KINDS,
  REQUEST_OUTCOMES,
  SCHEMA_VERSION,
  WEB_VITAL_NAMES,
  WEB_VITAL_RATINGS,
  type EventContext,
  type Metadata,
  type ObservabilityEvent,
} from './events.ts';

export type EventValidation =
  { ok: true; event: ObservabilityEvent } | { ok: false; reason: string };

export type BatchValidation =
  | {
      ok: true;
      sentAt: number;
      accepted: ObservabilityEvent[];
      rejected: { index: number; reason: string }[];
    }
  | { ok: false; reason: string };

/**
 * Validates an untrusted payload and rebuilds it from known fields only, so
 * unknown properties never reach storage.
 */
export function validateEvent(input: unknown): EventValidation {
  try {
    return { ok: true, event: parseEvent(input) };
  } catch (error) {
    if (error instanceof InvalidField) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * The envelope is all-or-nothing, but events are validated individually: one
 * malformed event must not cost the rest of the batch.
 */
export function validateBatch(input: unknown): BatchValidation {
  if (!isRecord(input)) return { ok: false, reason: 'batch must be an object' };
  if (input.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, reason: `unsupported schemaVersion (expected ${SCHEMA_VERSION})` };
  }
  if (!isTimestamp(input.sentAt)) return { ok: false, reason: 'sentAt must be a timestamp' };
  if (!Array.isArray(input.events)) return { ok: false, reason: 'events must be an array' };
  if (input.events.length > LIMITS.maxEventsPerBatch) {
    return { ok: false, reason: `batch exceeds ${LIMITS.maxEventsPerBatch} events` };
  }

  const accepted: ObservabilityEvent[] = [];
  const rejected: { index: number; reason: string }[] = [];
  input.events.forEach((candidate, index) => {
    const result = validateEvent(candidate);
    if (result.ok) accepted.push(result.event);
    else rejected.push({ index, reason: result.reason });
  });

  return { ok: true, sentAt: input.sentAt, accepted, rejected };
}

class InvalidField extends Error {}

function parseEvent(input: unknown): ObservabilityEvent {
  const raw = record(input, 'event');
  const context = parseContext(raw);
  const type = oneOf(raw, 'type', EVENT_TYPES);

  switch (type) {
    case 'error': {
      const error = record(raw.error, 'error');
      return {
        ...context,
        type,
        error: {
          source: oneOf(error, 'source', ERROR_SOURCES, 'error.'),
          name: string(error, 'name', LIMITS.maxStringLength, 'error.'),
          message: string(error, 'message', LIMITS.maxMessageLength, 'error.', {
            allowEmpty: true,
          }),
          ...optional(error, 'stack', () =>
            string(error, 'stack', LIMITS.maxStackLength, 'error.'),
          ),
        },
      };
    }
    case 'request': {
      const request = record(raw.request, 'request');
      return {
        ...context,
        type,
        request: {
          method: string(request, 'method', 16, 'request.'),
          url: string(request, 'url', LIMITS.maxUrlLength, 'request.'),
          status: integer(request, 'status', 0, 599, 'request.'),
          durationMs: number(request, 'durationMs', 0, 'request.'),
          outcome: oneOf(request, 'outcome', REQUEST_OUTCOMES, 'request.'),
          ...optional(request, 'attempt', () =>
            integer(request, 'attempt', 1, Number.MAX_SAFE_INTEGER, 'request.'),
          ),
        },
      };
    }
    case 'web_vital': {
      const webVital = record(raw.webVital, 'webVital');
      return {
        ...context,
        type,
        webVital: {
          name: oneOf(webVital, 'name', WEB_VITAL_NAMES, 'webVital.'),
          value: number(webVital, 'value', 0, 'webVital.'),
          rating: oneOf(webVital, 'rating', WEB_VITAL_RATINGS, 'webVital.'),
        },
      };
    }
    case 'navigation': {
      const navigation = record(raw.navigation, 'navigation');
      return {
        ...context,
        type,
        navigation: {
          from:
            navigation.from === null
              ? null
              : string(navigation, 'from', LIMITS.maxUrlLength, 'navigation.'),
          kind: oneOf(navigation, 'kind', NAVIGATION_KINDS, 'navigation.'),
        },
      };
    }
    case 'custom': {
      const custom = record(raw.custom, 'custom');
      return {
        ...context,
        type,
        custom: { name: string(custom, 'name', LIMITS.maxStringLength, 'custom.') },
      };
    }
  }
}

function parseContext(raw: Record<string, unknown>): EventContext {
  if (!isTimestamp(raw.timestamp)) throw new InvalidField('timestamp must be a timestamp');
  return {
    id: string(raw, 'id', 64),
    timestamp: raw.timestamp,
    application: string(raw, 'application', LIMITS.maxStringLength),
    environment: string(raw, 'environment', LIMITS.maxStringLength),
    sessionId: string(raw, 'sessionId', 64),
    page: string(raw, 'page', LIMITS.maxUrlLength),
    ...optional(raw, 'release', () => string(raw, 'release', LIMITS.maxStringLength)),
    ...optional(raw, 'metadata', () => metadata(raw.metadata)),
  };
}

function metadata(input: unknown): Metadata {
  const raw = record(input, 'metadata');
  const entries = Object.entries(raw);
  if (entries.length > LIMITS.maxMetadataKeys) {
    throw new InvalidField(`metadata exceeds ${LIMITS.maxMetadataKeys} keys`);
  }
  const result: Metadata = {};
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > LIMITS.maxMetadataKeyLength) {
      throw new InvalidField(`metadata key "${key.slice(0, 16)}" has an invalid length`);
    }
    const valid =
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= LIMITS.maxStringLength);
    if (!valid) throw new InvalidField(`metadata.${key} must be a short primitive`);
    result[key] = value;
  }
  return result;
}

// --- field helpers: each throws InvalidField with a path-qualified message ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new InvalidField(`${path} must be an object`);
  return value;
}

function string(
  raw: Record<string, unknown>,
  key: string,
  max: number,
  prefix = '',
  { allowEmpty = false } = {},
): string {
  const value = raw[key];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max) {
    throw new InvalidField(`${prefix}${key} must be a string of at most ${max} chars`);
  }
  return value;
}

function number(raw: Record<string, unknown>, key: string, min: number, prefix = ''): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new InvalidField(`${prefix}${key} must be a finite number >= ${min}`);
  }
  return value;
}

function integer(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  prefix = '',
): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidField(`${prefix}${key} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function oneOf<T extends string>(
  raw: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  prefix = '',
): T {
  const value = raw[key];
  if (!allowed.includes(value as T)) {
    throw new InvalidField(`${prefix}${key} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

/** Spreads `{ [key]: parse() }` only when the field is present. */
function optional<K extends string, V>(
  raw: Record<string, unknown>,
  key: K,
  parse: () => V,
): { [P in K]?: V } {
  return raw[key] === undefined ? {} : ({ [key]: parse() } as { [P in K]: V });
}

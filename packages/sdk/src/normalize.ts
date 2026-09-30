import { LIMITS, type Metadata } from '@fop/schema';

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface NormalizedError {
  name: string;
  message: string;
  stack?: string;
}

/** Anything can be thrown in JS; the event model needs a name and a message. */
export function normalizeError(error: unknown): NormalizedError {
  if (error instanceof Error) {
    return {
      name: truncate(error.name || 'Error', LIMITS.maxStringLength),
      message: truncate(error.message, LIMITS.maxMessageLength),
      ...(error.stack ? { stack: truncate(error.stack, LIMITS.maxStackLength) } : {}),
    };
  }
  return { name: 'NonError', message: truncate(describe(error), LIMITS.maxMessageLength) };
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular structures and BigInt make JSON.stringify throw.
    return Object.prototype.toString.call(value);
  }
}

/**
 * Makes metadata fit the schema instead of rejecting the event: callers may be
 * plain JS, and losing a whole event over one bad field is the worse outcome.
 */
export function sanitizeMetadata(input: unknown): Metadata | undefined {
  if (typeof input !== 'object' || input === null) return undefined;

  const result: Metadata = {};
  let count = 0;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (count >= LIMITS.maxMetadataKeys) break;
    if (key.length === 0 || key.length > LIMITS.maxMetadataKeyLength) continue;

    if (typeof value === 'string') {
      result[key] = truncate(value, LIMITS.maxStringLength);
    } else if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      result[key] = value;
    } else {
      continue;
    }
    count++;
  }
  return count > 0 ? result : undefined;
}

import { LIMITS } from '@fop/schema';
import { describe, expect, it } from 'vitest';
import { normalizeError, sanitizeMetadata, truncate } from './normalize.ts';

describe('truncate', () => {
  it('keeps the result within the limit and marks the cut', () => {
    const result = truncate('abcdef', 4);
    expect(result).toBe('abc…');
    expect(result).toHaveLength(4);
  });
});

describe('normalizeError', () => {
  it('extracts name, message and stack from Error instances', () => {
    const error = new TypeError('bad');
    expect(normalizeError(error)).toEqual({
      name: 'TypeError',
      message: 'bad',
      stack: error.stack,
    });
  });

  it.each([
    ['a string', 'plain failure', 'plain failure'],
    ['an object', { code: 42 }, '{"code":42}'],
    ['undefined', undefined, 'undefined'],
    [
      'a circular object',
      (() => {
        const o: Record<string, unknown> = {};
        o.self = o;
        return o;
      })(),
      '[object Object]',
    ],
  ])('describes %s thrown as a non-Error', (_label, thrown, message) => {
    expect(normalizeError(thrown)).toEqual({ name: 'NonError', message });
  });

  it('truncates oversized messages and stacks to the schema limits', () => {
    const error = new Error('m'.repeat(LIMITS.maxMessageLength * 2));
    error.stack = 's'.repeat(LIMITS.maxStackLength * 2);

    const result = normalizeError(error);

    expect(result.message).toHaveLength(LIMITS.maxMessageLength);
    expect(result.stack).toHaveLength(LIMITS.maxStackLength);
  });
});

describe('sanitizeMetadata', () => {
  it('keeps primitives and drops what the schema would reject', () => {
    expect(
      sanitizeMetadata({
        term: 'pika',
        count: 3,
        ok: true,
        none: null,
        nested: { a: 1 },
        list: [1],
        fn: () => 1,
        nan: Number.NaN,
        missing: undefined,
      }),
    ).toEqual({ term: 'pika', count: 3, ok: true, none: null });
  });

  it('truncates long strings rather than dropping them', () => {
    const result = sanitizeMetadata({ query: 'q'.repeat(LIMITS.maxStringLength + 10) });
    expect(result?.query).toHaveLength(LIMITS.maxStringLength);
  });

  it('caps the number of keys', () => {
    const input = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizeMetadata(input) ?? {})).toHaveLength(LIMITS.maxMetadataKeys);
  });

  it('returns undefined when nothing survives, so events carry no empty metadata', () => {
    expect(sanitizeMetadata({ nested: {} })).toBeUndefined();
    expect(sanitizeMetadata('not an object')).toBeUndefined();
  });
});

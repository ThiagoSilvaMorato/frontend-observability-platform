import { describe, expect, it, vi } from 'vitest';
import { createId } from './context.ts';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('createId', () => {
  it('produces a v4 UUID', () => {
    expect(createId()).toMatch(UUID_V4);
  });

  it('falls back to getRandomValues outside secure contexts, where randomUUID is missing', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });

    const ids = new Set(Array.from({ length: 100 }, createId));

    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});

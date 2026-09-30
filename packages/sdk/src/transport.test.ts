import { SCHEMA_VERSION, type EventBatch } from '@fop/schema';
import { describe, expect, it, vi } from 'vitest';
import { fakeEvent } from './test-utils.ts';
import { createFetchTransport } from './transport.ts';

const batch: EventBatch = { schemaVersion: SCHEMA_VERSION, sentAt: 1, events: [fakeEvent()] };
const ENDPOINT = 'https://collector.test/v1/events';

describe('fetch transport', () => {
  it('posts the batch as a CORS-simple request without credentials', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 202 }));

    await createFetchTransport(ENDPOINT, { fetch }).send(batch);

    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe(ENDPOINT);
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      credentials: 'omit',
    });
    expect(JSON.parse(init!.body as string)).toEqual(batch);
  });

  it('uses the fetch that existed at creation, not one patched later', async () => {
    const original = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', original);
    const transport = createFetchTransport(ENDPOINT);
    const patched = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', patched);

    await transport.send(batch);

    expect(original).toHaveBeenCalledOnce();
    expect(patched).not.toHaveBeenCalled();
  });

  it.each([
    [202, { ok: true }],
    [500, { ok: false, retryable: true, reason: 'HTTP 500' }],
    [429, { ok: false, retryable: true, reason: 'HTTP 429' }],
    [400, { ok: false, retryable: false, reason: 'HTTP 400' }],
    [413, { ok: false, retryable: false, reason: 'HTTP 413' }],
  ])('classifies HTTP %i', async (status, expected) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status }));

    expect(await createFetchTransport(ENDPOINT, { fetch }).send(batch)).toEqual(expected);
  });

  it('resolves network failures as retryable instead of rejecting', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new TypeError('Failed to fetch'));

    expect(await createFetchTransport(ENDPOINT, { fetch }).send(batch)).toEqual({
      ok: false,
      retryable: true,
      reason: 'network error',
    });
  });

  it('distinguishes timeouts', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new DOMException('signal timed out', 'TimeoutError'));

    expect(await createFetchTransport(ENDPOINT, { fetch }).send(batch)).toMatchObject({
      reason: 'timeout',
    });
  });
});

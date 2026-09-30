import { SCHEMA_VERSION, type EventBatch, type ObservabilityEvent } from '@fop/schema';
import { describe, expect, it, vi } from 'vitest';
import { fakeEvent } from './test-utils.ts';
import { createFetchTransport, KEEPALIVE_MAX_BYTES, splitToFit } from './transport.ts';

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

describe('fetch transport: keepalive and backpressure signals', () => {
  const okFetch = () =>
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null, { status: 202 }));

  it('uses keepalive for regular sends that fit the browser quota, so they survive unload', async () => {
    const fetch = okFetch();
    const transport = createFetchTransport(ENDPOINT, { fetch });
    const huge: EventBatch = { ...batch, events: [bigEvent(KEEPALIVE_MAX_BYTES)] };

    await transport.send(batch);
    await transport.send(huge);

    expect(fetch.mock.calls.map(([, init]) => init?.keepalive)).toEqual([true, false]);
  });

  it.each([
    ['delay-seconds', '30', 30_000],
    ['an HTTP date', new Date(Date.now() + 60_000).toUTCString(), expect.closeTo(60_000, -4)],
  ])('reports Retry-After given as %s', async (_label, header, expected) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': header } }));

    expect(await createFetchTransport(ENDPOINT, { fetch }).send(batch)).toMatchObject({
      retryable: true,
      retryAfterMs: expected as number,
    });
  });
});

describe('fetch transport: sendOnExit', () => {
  it('sends with keepalive and without credentials (unlike sendBeacon)', () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));

    createFetchTransport(ENDPOINT, { fetch }).sendOnExit!(batch);

    expect(fetch.mock.calls[0]![1]).toMatchObject({ keepalive: true, credentials: 'omit' });
  });

  it('splits batches that exceed the keepalive quota', () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(null));
    const events = Array.from({ length: 4 }, () => bigEvent(KEEPALIVE_MAX_BYTES / 3));

    createFetchTransport(ENDPOINT, { fetch }).sendOnExit!({ ...batch, events });

    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, init] of fetch.mock.calls) {
      expect(new TextEncoder().encode(init!.body as string).length).toBeLessThanOrEqual(
        KEEPALIVE_MAX_BYTES,
      );
    }
  });

  it('swallows both rejected and synchronously throwing fetches', () => {
    const rejecting = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('quota'));
    const throwing = vi.fn<typeof globalThis.fetch>().mockImplementation(() => {
      throw new TypeError('sync');
    });

    expect(() =>
      createFetchTransport(ENDPOINT, { fetch: rejecting }).sendOnExit!(batch),
    ).not.toThrow();
    expect(() =>
      createFetchTransport(ENDPOINT, { fetch: throwing }).sendOnExit!(batch),
    ).not.toThrow();
  });
});

describe('splitToFit', () => {
  it('gives up on a single event that can never fit, rather than looping', () => {
    expect(splitToFit({ ...batch, events: [bigEvent(2_000)] }, 1_000)).toEqual([]);
  });
});

function bigEvent(bytes: number): ObservabilityEvent {
  return { ...fakeEvent(), metadata: { blob: 'x'.repeat(Math.ceil(bytes)) } };
}

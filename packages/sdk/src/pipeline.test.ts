import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPipeline } from './pipeline.ts';
import { createControllableTransport, createRecordingTransport, fakeEvent } from './test-utils.ts';
import type { Transport } from './transport.ts';

function setup(transport: Transport, overrides: { maxBatchSize?: number } = {}) {
  const onDrop = vi.fn();
  const pipeline = createPipeline({
    transport,
    maxBatchSize: overrides.maxBatchSize ?? 3,
    flushIntervalMs: 1_000,
    onDrop,
  });
  return { pipeline, onDrop };
}

describe('pipeline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('does not send a request per event', () => {
    const { transport, send } = createRecordingTransport();
    const { pipeline } = setup(transport);

    pipeline.enqueue(fakeEvent());
    pipeline.enqueue(fakeEvent());

    expect(send).not.toHaveBeenCalled();
  });

  it('sends a batch as soon as it reaches maxBatchSize', () => {
    const { transport, batches } = createRecordingTransport();
    const { pipeline } = setup(transport);

    pipeline.enqueue(fakeEvent('a'));
    pipeline.enqueue(fakeEvent('b'));
    pipeline.enqueue(fakeEvent('c'));

    expect(batches()).toHaveLength(1);
    expect(batches()[0]).toMatchObject({ schemaVersion: 1, events: [{}, {}, {}] });
  });

  it('sends a partial batch once the flush interval elapses', async () => {
    const { transport, events } = createRecordingTransport();
    const { pipeline } = setup(transport);

    pipeline.enqueue(fakeEvent('lonely'));
    await vi.advanceTimersByTimeAsync(999);
    expect(events()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(events()).toMatchObject([{ custom: { name: 'lonely' } }]);
  });

  it('keeps at most one request in flight and sends what arrived meanwhile afterwards', async () => {
    const { transport, pending } = createControllableTransport();
    const { pipeline } = setup(transport, { maxBatchSize: 2 });

    pipeline.enqueue(fakeEvent('a'));
    pipeline.enqueue(fakeEvent('b'));
    pipeline.enqueue(fakeEvent('c'));
    pipeline.enqueue(fakeEvent('d'));
    pipeline.enqueue(fakeEvent('e'));
    expect(pending).toHaveLength(1);

    pending[0]!.resolve({ ok: true });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.resolve({ ok: true });
    await vi.waitFor(() => expect(pending).toHaveLength(3));
    pending[2]!.resolve({ ok: true });

    const names = pending.map(({ batch }) =>
      batch.events.map((event) => (event.type === 'custom' ? event.custom.name : '')),
    );
    expect(names).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
  });

  it('flush() resolves only after everything buffered has been handed to the transport', async () => {
    const { transport, events } = createRecordingTransport();
    const { pipeline } = setup(transport, { maxBatchSize: 2 });
    for (const name of ['a', 'b', 'c', 'd', 'e']) pipeline.enqueue(fakeEvent(name));

    await pipeline.flush();

    expect(events()).toHaveLength(5);
  });

  it('flush() with nothing buffered resolves without sending', async () => {
    const { transport, send } = createRecordingTransport();
    const { pipeline } = setup(transport);

    await pipeline.flush();

    expect(send).not.toHaveBeenCalled();
  });

  it('reports dropped events when delivery fails, and keeps delivering later batches', async () => {
    const { transport, send } = createRecordingTransport();
    send.mockResolvedValueOnce({ ok: false, retryable: true, reason: 'HTTP 503' });
    const { pipeline, onDrop } = setup(transport, { maxBatchSize: 1 });

    pipeline.enqueue(fakeEvent('lost'));
    pipeline.enqueue(fakeEvent('delivered'));
    await pipeline.flush();

    expect(onDrop).toHaveBeenCalledWith(1, 'HTTP 503');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('treats a transport that throws as a failed send instead of propagating', async () => {
    const transport: Transport = { send: () => Promise.reject(new Error('boom')) };
    const { pipeline, onDrop } = setup(transport);

    pipeline.enqueue(fakeEvent());
    await expect(pipeline.flush()).resolves.toBeUndefined();

    expect(onDrop).toHaveBeenCalledWith(1, expect.stringContaining('boom'));
  });

  it('keeps delivering after the drop reporter itself throws', async () => {
    const { transport, send } = createRecordingTransport({
      ok: false,
      retryable: false,
      reason: 'HTTP 400',
    });
    const pipeline = createPipeline({
      transport,
      maxBatchSize: 1,
      flushIntervalMs: 1_000,
      onDrop: () => {
        throw new Error('logger broke');
      },
    });

    pipeline.enqueue(fakeEvent());
    await expect(pipeline.flush()).resolves.toBeUndefined();
    pipeline.enqueue(fakeEvent());
    await pipeline.flush();

    expect(send).toHaveBeenCalledTimes(2);
  });
});

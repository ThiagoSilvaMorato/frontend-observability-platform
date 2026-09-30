import type { EventBatch, ObservabilityEvent } from '@fop/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPipeline, type PipelineOptions } from './pipeline.ts';
import {
  createControllableTransport,
  createRecordingTransport,
  fakeEvent,
  fakeError,
} from './test-utils.ts';
import type { SendResult, Transport } from './transport.ts';

function setup(transport: Transport, overrides: Partial<PipelineOptions> = {}) {
  const onDrop = vi.fn();
  const pipeline = createPipeline({
    transport,
    maxBatchSize: 3,
    flushIntervalMs: 1_000,
    maxQueueSize: 100,
    onDrop,
    retry: { baseDelayMs: 1_000, maxDelayMs: 8_000 },
    isOnline: () => true,
    // Midpoint jitter: delay = 0.75 × the exponential step.
    random: () => 0.5,
    ...overrides,
  });
  return { pipeline, onDrop };
}

const names = (events: ObservabilityEvent[]) =>
  events.map((event) => (event.type === 'custom' ? event.custom.name : event.type));

const unavailable: SendResult = { ok: false, retryable: true, reason: 'HTTP 503' };

describe('pipeline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  describe('batching', () => {
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
      expect(names(events())).toEqual(['lonely']);
    });

    it('keeps at most one request in flight and sends what arrived meanwhile afterwards', async () => {
      const { transport, pending } = createControllableTransport();
      const { pipeline } = setup(transport, { maxBatchSize: 2 });

      for (const name of ['a', 'b', 'c', 'd', 'e']) pipeline.enqueue(fakeEvent(name));
      expect(pending).toHaveLength(1);

      pending[0]!.resolve({ ok: true });
      await vi.waitFor(() => expect(pending).toHaveLength(2));
      pending[1]!.resolve({ ok: true });
      await vi.waitFor(() => expect(pending).toHaveLength(3));
      pending[2]!.resolve({ ok: true });

      expect(pending.map(({ batch }) => names(batch.events))).toEqual([
        ['a', 'b'],
        ['c', 'd'],
        ['e'],
      ]);
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
  });

  describe('failures', () => {
    it('drops batches the collector rejected as invalid, and keeps delivering', async () => {
      const { transport, send } = createRecordingTransport();
      send.mockResolvedValueOnce({ ok: false, retryable: false, reason: 'HTTP 400' });
      const { pipeline, onDrop } = setup(transport, { maxBatchSize: 1 });

      pipeline.enqueue(fakeEvent('invalid'));
      pipeline.enqueue(fakeEvent('valid'));
      await pipeline.flush();

      expect(onDrop).toHaveBeenCalledWith(1, 'HTTP 400');
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('retries a retryable failure after a backoff, without losing or reordering events', async () => {
      const { transport, send } = createRecordingTransport();
      send.mockResolvedValueOnce(unavailable);
      const { pipeline, onDrop } = setup(transport);

      pipeline.enqueue(fakeEvent('a'));
      await pipeline.flush();
      pipeline.enqueue(fakeEvent('b'));
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(750);

      expect(send).toHaveBeenCalledTimes(2);
      expect(names(send.mock.calls[1]![0].events)).toEqual(['a', 'b']);
      expect(onDrop).not.toHaveBeenCalled();
    });

    it('backs off exponentially up to the cap, and resets after a success', async () => {
      const { transport, send } = createRecordingTransport(unavailable);
      const { pipeline } = setup(transport);
      pipeline.enqueue(fakeEvent());
      await pipeline.flush();

      const attemptTimes: number[] = [];
      send.mockImplementation(() => {
        attemptTimes.push(Date.now());
        return Promise.resolve(unavailable);
      });
      const start = Date.now();
      await vi.advanceTimersByTimeAsync(30_000);

      // 0.75 × 1s, 2s, 4s, 8s, then capped at 8s.
      const gaps = attemptTimes.map((time, i) => time - (attemptTimes[i - 1] ?? start));
      expect(gaps.slice(0, 6)).toEqual([750, 1_500, 3_000, 6_000, 6_000, 6_000]);

      send.mockResolvedValue({ ok: true });
      await vi.advanceTimersByTimeAsync(6_000);
      send.mockResolvedValueOnce(unavailable);
      const beforeFailure = send.mock.calls.length;
      pipeline.enqueue(fakeEvent());
      await pipeline.flush();
      await vi.advanceTimersByTimeAsync(750);
      expect(send.mock.calls.length).toBe(beforeFailure + 2);
    });

    it('waits at least as long as the server asks via Retry-After', async () => {
      const { transport, send } = createRecordingTransport();
      send.mockResolvedValueOnce({ ...unavailable, reason: 'HTTP 429', retryAfterMs: 5_000 });
      const { pipeline } = setup(transport);

      pipeline.enqueue(fakeEvent());
      await pipeline.flush();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(send).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(2);
    });

    it('does not let new events bypass the backoff', async () => {
      const { transport, send } = createRecordingTransport();
      send.mockResolvedValueOnce(unavailable);
      const { pipeline } = setup(transport);

      pipeline.enqueue(fakeEvent());
      await pipeline.flush();
      for (let i = 0; i < 10; i++) pipeline.enqueue(fakeEvent());
      await pipeline.flush();

      expect(send).toHaveBeenCalledTimes(1);
    });

    it('treats a transport that throws as a retryable failure instead of propagating', async () => {
      const send = vi
        .fn<Transport['send']>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue({ ok: true });
      const { pipeline } = setup({ send });

      pipeline.enqueue(fakeEvent());
      await expect(pipeline.flush()).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(750);

      expect(send).toHaveBeenCalledTimes(2);
    });

    it('keeps delivering after the drop reporter itself throws', async () => {
      const { transport, send } = createRecordingTransport({
        ok: false,
        retryable: false,
        reason: 'HTTP 400',
      });
      const { pipeline } = setup(transport, {
        maxBatchSize: 1,
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

  describe('offline', () => {
    it('does not attempt delivery while offline, and sends immediately on resume', async () => {
      let online = false;
      const { transport, send } = createRecordingTransport();
      const { pipeline } = setup(transport, { isOnline: () => online });

      for (let i = 0; i < 5; i++) pipeline.enqueue(fakeEvent());
      await vi.advanceTimersByTimeAsync(10_000);
      expect(send).not.toHaveBeenCalled();

      online = true;
      pipeline.resume();
      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    });

    it('resume() skips the remaining backoff', async () => {
      const { transport, send } = createRecordingTransport();
      send.mockResolvedValueOnce(unavailable);
      const { pipeline } = setup(transport);
      pipeline.enqueue(fakeEvent());
      await pipeline.flush();

      pipeline.resume();

      await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    });
  });

  describe('queue bound', () => {
    it('drops the oldest non-error events first when full', async () => {
      const { transport, events } = createRecordingTransport();
      const { pipeline, onDrop } = setup(transport, { maxQueueSize: 3, maxBatchSize: 10 });

      pipeline.enqueue(fakeEvent('old'));
      pipeline.enqueue(fakeError());
      pipeline.enqueue(fakeEvent('mid'));
      pipeline.enqueue(fakeEvent('new'));
      await pipeline.flush();

      expect(names(events())).toEqual(['error', 'mid', 'new']);
      expect(onDrop).toHaveBeenCalledWith(1, 'queue full');
    });

    it('drops the oldest error only when everything queued is an error', async () => {
      const { transport, events } = createRecordingTransport();
      const { pipeline } = setup(transport, { maxQueueSize: 2, maxBatchSize: 10 });
      const [first, second, third] = [fakeError(), fakeError(), fakeError()];

      pipeline.enqueue(first);
      pipeline.enqueue(second);
      pipeline.enqueue(third);
      await pipeline.flush();

      expect(events().map((event) => event.id)).toEqual([second.id, third.id]);
    });

    it('bounds memory during an outage, keeping the newest events', async () => {
      const { transport, send } = createRecordingTransport(unavailable);
      const { pipeline } = setup(transport, { maxQueueSize: 5, maxBatchSize: 5 });

      for (let i = 0; i < 50; i++) pipeline.enqueue(fakeEvent(`e${i}`));
      // Let the first attempt fail: its batch is re-queued, then evicted by newer events.
      await pipeline.flush();
      send.mockResolvedValue({ ok: true });
      pipeline.resume();
      await pipeline.flush();

      expect(names(send.mock.calls.at(-1)![0].events)).toEqual(['e45', 'e46', 'e47', 'e48', 'e49']);
    });
  });

  describe('flushOnExit', () => {
    function exitTransport() {
      const exits: EventBatch[] = [];
      const recording = createRecordingTransport();
      const transport: Transport = {
        send: recording.send,
        sendOnExit: (batch) => void exits.push(batch),
      };
      return { transport, exits, send: recording.send };
    }

    it('hands the whole queue to sendOnExit, errors first, in batch-sized chunks', () => {
      const { transport, exits } = exitTransport();
      const { pipeline } = setup(transport, { maxBatchSize: 10 });
      pipeline.enqueue(fakeEvent('a'));
      pipeline.enqueue(fakeError());
      pipeline.enqueue(fakeEvent('b'));

      pipeline.flushOnExit();

      expect(exits.map((batch) => names(batch.events))).toEqual([['error', 'a', 'b']]);
    });

    it('empties the queue so the next flush does not resend', async () => {
      const { transport, send } = exitTransport();
      const { pipeline } = setup(transport);
      pipeline.enqueue(fakeEvent());

      pipeline.flushOnExit();
      await pipeline.flush();

      expect(send).not.toHaveBeenCalled();
    });

    it('keeps events in memory while backing off, since the collector is known to be failing', async () => {
      const { transport, exits, send } = exitTransport();
      send.mockResolvedValueOnce(unavailable);
      const { pipeline } = setup(transport);
      pipeline.enqueue(fakeEvent());
      await pipeline.flush();

      pipeline.flushOnExit();

      expect(exits).toHaveLength(0);
    });

    it('does nothing when the transport has no exit path', () => {
      const { transport, send } = createRecordingTransport();
      const { pipeline } = setup(transport);
      pipeline.enqueue(fakeEvent());

      expect(() => pipeline.flushOnExit()).not.toThrow();
      expect(send).not.toHaveBeenCalled();
    });
  });
});

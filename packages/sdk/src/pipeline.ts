import { SCHEMA_VERSION, type ObservabilityEvent } from '@fop/schema';
import type { SendResult, Transport } from './transport.ts';

export interface PipelineOptions {
  transport: Transport;
  /** Send as soon as this many events are buffered. */
  maxBatchSize: number;
  /** Otherwise send whatever is buffered this long after the first event arrives. */
  flushIntervalMs: number;
  onDrop: (count: number, reason: string) => void;
}

export interface Pipeline {
  enqueue(event: ObservabilityEvent): void;
  /** Sends everything buffered. Never rejects. */
  flush(): Promise<void>;
}

/**
 * Buffers events and ships them in batches, with at most one request in flight.
 *
 * Sequential delivery keeps the network cost of telemetry bounded (a burst of
 * events becomes a few requests, not dozens of parallel ones) and gives retry
 * logic a single place to live.
 */
export function createPipeline({
  transport,
  maxBatchSize,
  flushIntervalMs,
  onDrop,
}: PipelineOptions): Pipeline {
  const queue: ObservabilityEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let draining: Promise<void> | undefined;

  function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (!draining && queue.length > 0) draining = drain();
    return draining ?? Promise.resolve();
  }

  // Events enqueued while a request is in flight are picked up by the same loop.
  async function drain(): Promise<void> {
    try {
      while (queue.length > 0) {
        const events = queue.splice(0, maxBatchSize);
        const result = await send(events);
        if (!result.ok) onDrop(events.length, result.reason);
      }
    } catch {
      // A failing drop reporter must not wedge delivery; the next flush resumes.
    } finally {
      // Cleared synchronously with the empty-queue check: clearing it later (e.g.
      // in `.finally()`) would let an event enqueued in between be stranded.
      draining = undefined;
    }
  }

  async function send(events: ObservabilityEvent[]): Promise<SendResult> {
    try {
      return await transport.send({ schemaVersion: SCHEMA_VERSION, sentAt: Date.now(), events });
    } catch (error) {
      return { ok: false, retryable: true, reason: `transport threw: ${String(error)}` };
    }
  }

  return {
    enqueue(event) {
      queue.push(event);
      if (queue.length >= maxBatchSize) {
        void flush();
      } else {
        timer ??= setTimeout(() => void flush(), flushIntervalMs);
      }
    },
    flush,
  };
}

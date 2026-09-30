import { SCHEMA_VERSION, type EventBatch, type ObservabilityEvent } from '@fop/schema';
import type { SendResult, Transport } from './transport.ts';

export interface PipelineOptions {
  transport: Transport;
  /** Send as soon as this many events are buffered. */
  maxBatchSize: number;
  /** Otherwise send whatever is buffered this long after the first event arrives. */
  flushIntervalMs: number;
  /** Beyond this, the oldest low-priority events are dropped. */
  maxQueueSize: number;
  onDrop: (count: number, reason: string) => void;
  retry?: { baseDelayMs: number; maxDelayMs: number };
  /** `navigator.onLine === false` is reliable; `true` is not, so it only pauses. */
  isOnline?: () => boolean;
  random?: () => number;
}

export interface Pipeline {
  enqueue(event: ObservabilityEvent): void;
  /**
   * Sends everything buffered, unless delivery is paused (offline or backing
   * off after failures). Never rejects.
   */
  flush(): Promise<void>;
  /** Connectivity came back: skip the remaining backoff and send now. */
  resume(): void;
  /** The page may be going away: hand everything to the transport synchronously. */
  flushOnExit(): void;
}

const DEFAULT_RETRY = { baseDelayMs: 1_000, maxDelayMs: 5 * 60_000 };
const defaultIsOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/**
 * Buffers events and ships them in batches, with at most one request in flight.
 *
 * Sequential delivery keeps the network cost of telemetry bounded (a burst of
 * events becomes a few requests, not dozens of parallel ones) and gives retry
 * a single place to live: a retryable failure puts the batch back at the head
 * of the queue and pauses delivery with exponential backoff. Events are never
 * lost to an outage, only to the queue bound — so memory stays flat and the
 * newest data survives.
 */
export function createPipeline({
  transport,
  maxBatchSize,
  flushIntervalMs,
  maxQueueSize,
  onDrop,
  retry = DEFAULT_RETRY,
  isOnline = defaultIsOnline,
  random = Math.random,
}: PipelineOptions): Pipeline {
  const queue: ObservabilityEvent[] = [];
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let consecutiveFailures = 0;
  let draining: Promise<void> | undefined;

  const backingOff = () => retryTimer !== undefined;

  function flush(): Promise<void> {
    clearTimeout(batchTimer);
    batchTimer = undefined;
    // The preconditions mirror drain's loop condition on purpose: drain must
    // reach its first `await` before returning, or its `finally` would clear
    // `draining` before this assignment and leave it stuck on a settled promise.
    if (!draining && !backingOff() && queue.length > 0 && isOnline()) draining = drain();
    return draining ?? Promise.resolve();
  }

  // Events enqueued while a request is in flight are picked up by the same loop.
  async function drain(): Promise<void> {
    try {
      while (queue.length > 0 && isOnline()) {
        const events = queue.splice(0, maxBatchSize);
        const result = await send(events);
        if (result.ok) {
          consecutiveFailures = 0;
        } else if (!result.retryable) {
          onDrop(events.length, result.reason);
        } else {
          queue.unshift(...events);
          enforceBound();
          scheduleRetry(result.retryAfterMs);
          break;
        }
      }
    } catch {
      // A failing drop reporter must not wedge delivery; the next flush resumes.
    } finally {
      // Cleared synchronously with the loop condition: clearing it later (e.g.
      // in `.finally()`) would let an event enqueued in between be stranded.
      draining = undefined;
    }
  }

  async function send(events: ObservabilityEvent[]): Promise<SendResult> {
    try {
      return await transport.send(toBatch(events));
    } catch (error) {
      return { ok: false, retryable: true, reason: `transport threw: ${String(error)}` };
    }
  }

  /**
   * Exponential backoff with "equal jitter": half the delay is fixed, half is
   * random. The fixed half guarantees real backoff; the random half keeps many
   * clients that failed together from retrying in lockstep when the collector
   * recovers. A server-provided Retry-After wins if it asks for longer.
   */
  function scheduleRetry(retryAfterMs = 0) {
    consecutiveFailures++;
    const exponential = Math.min(
      retry.maxDelayMs,
      retry.baseDelayMs * 2 ** (consecutiveFailures - 1),
    );
    const jittered = exponential / 2 + random() * (exponential / 2);
    const delay = Math.min(retry.maxDelayMs, Math.max(jittered, retryAfterMs));
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void flush();
    }, delay);
  }

  /** Errors are the most valuable signal; everything else goes first. */
  function enforceBound() {
    let overflow = queue.length - maxQueueSize;
    if (overflow <= 0) return;
    onDrop(overflow, 'queue full');
    while (overflow-- > 0) {
      const lowPriority = queue.findIndex((event) => event.type !== 'error');
      queue.splice(lowPriority === -1 ? 0 : lowPriority, 1);
    }
  }

  return {
    enqueue(event) {
      queue.push(event);
      enforceBound();
      if (backingOff()) return;
      if (queue.length >= maxBatchSize) {
        void flush();
      } else {
        batchTimer ??= setTimeout(() => void flush(), flushIntervalMs);
      }
    },

    flush,

    resume() {
      clearTimeout(retryTimer);
      retryTimer = undefined;
      consecutiveFailures = 0;
      void flush();
    },

    flushOnExit() {
      // While backing off the collector is known to be failing: an exit send
      // would most likely be lost, whereas keeping the events in memory lets a
      // tab that is merely hidden deliver them once it recovers.
      if (!transport.sendOnExit || backingOff() || !isOnline() || queue.length === 0) return;
      clearTimeout(batchTimer);
      batchTimer = undefined;
      // Errors first: if the page's keepalive quota runs out, lose the rest.
      const events = queue
        .splice(0)
        .sort((a, b) => Number(b.type === 'error') - Number(a.type === 'error'));
      for (let i = 0; i < events.length; i += maxBatchSize) {
        transport.sendOnExit(toBatch(events.slice(i, i + maxBatchSize)));
      }
    },
  };
}

function toBatch(events: ObservabilityEvent[]): EventBatch {
  // sentAt is stamped per attempt so the collector's clock-skew correction
  // stays valid for retried and long-queued events.
  return { schemaVersion: SCHEMA_VERSION, sentAt: Date.now(), events };
}

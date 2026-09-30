import type { ObservabilityEvent, StoredEvent } from '@fop/schema';
import { errorFingerprint } from './grouping.ts';

/**
 * Client clocks can be off by minutes or hours. Every batch carries the
 * client's `sentAt`, so `receivedAt - sentAt` is the skew (plus network
 * latency, which is negligible at this resolution). Because the SDK stamps
 * `sentAt` at each send attempt, the correction stays valid for events that
 * were queued offline or retried.
 */
export function toStoredEvents(
  events: ObservabilityEvent[],
  sentAt: number,
  receivedAt: number,
): StoredEvent[] {
  const skew = receivedAt - sentAt;
  return events.map((event) => ({
    ...event,
    receivedAt,
    // An event cannot have happened after it arrived.
    occurredAt: Math.min(event.timestamp + skew, receivedAt),
    ...(event.type === 'error' ? { fingerprint: errorFingerprint(event.error) } : {}),
  }));
}

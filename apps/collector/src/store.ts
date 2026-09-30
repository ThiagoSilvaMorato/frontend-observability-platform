import type { EventQuery, StoredEvent } from '@fop/schema';

/**
 * Storage seam. The in-memory implementation comes first; a persistent one can
 * replace it without touching ingestion or the query API.
 */
export interface EventStore {
  /**
   * Idempotent by event id: the SDK retries with at-least-once semantics, so a
   * re-sent event is counted as a duplicate instead of being stored twice.
   */
  append(events: StoredEvent[]): { inserted: number; duplicates: number };
  /** Matching events in insertion order. The window is `[from, to)` on `occurredAt`. */
  query(query: EventQuery): StoredEvent[];
}

/**
 * Bounded FIFO: once `capacity` is reached the oldest events are evicted, so
 * memory stays flat no matter how much traffic arrives. Dedup covers retained
 * events only, which comfortably spans any realistic retry window.
 */
export function createMemoryStore({ capacity = 100_000 } = {}): EventStore {
  const events: StoredEvent[] = [];
  const ids = new Set<string>();

  return {
    append(batch) {
      let inserted = 0;
      let duplicates = 0;
      for (const event of batch) {
        if (ids.has(event.id)) {
          duplicates++;
          continue;
        }
        ids.add(event.id);
        events.push(event);
        inserted++;
      }

      const overflow = events.length - capacity;
      if (overflow > 0) {
        for (const evicted of events.splice(0, overflow)) ids.delete(evicted.id);
      }
      return { inserted, duplicates };
    },

    query({ application, environment, type, from, to }) {
      return events.filter(
        (event) =>
          (application === undefined || event.application === application) &&
          (environment === undefined || event.environment === environment) &&
          (type === undefined || event.type === type) &&
          (from === undefined || event.occurredAt >= from) &&
          (to === undefined || event.occurredAt < to),
      );
    },
  };
}

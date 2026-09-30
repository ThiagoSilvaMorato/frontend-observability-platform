import { describe, expect, it } from 'vitest';
import { createMemoryStore } from './store.ts';
import { customEvent, errorEvent, stored, T0 } from './test-utils.ts';

describe('memory store', () => {
  it('stores a re-sent event once and reports it as a duplicate', () => {
    const store = createMemoryStore();
    const event = stored(customEvent());

    expect(store.append([event])).toEqual({ inserted: 1, duplicates: 0 });
    expect(store.append([event, stored(customEvent())])).toEqual({ inserted: 1, duplicates: 1 });
    expect(store.query({})).toHaveLength(2);
  });

  it('dedupes within a single batch', () => {
    const store = createMemoryStore();
    const event = stored(customEvent());

    expect(store.append([event, event])).toEqual({ inserted: 1, duplicates: 1 });
  });

  it('evicts the oldest events beyond capacity, and forgets their ids', () => {
    const store = createMemoryStore({ capacity: 2 });
    const [a, b, c] = ['a', 'b', 'c'].map((name) => stored(customEvent(name)));

    store.append([a!, b!, c!]);

    expect(store.query({}).map((event) => event.id)).toEqual([b!.id, c!.id]);
    expect(store.append([a!])).toEqual({ inserted: 1, duplicates: 0 });
  });

  it('filters by application, environment, type and a [from, to) window', () => {
    const store = createMemoryStore();
    const match = stored(errorEvent({}, { timestamp: T0 }));
    store.append([
      match,
      stored(errorEvent({}, { timestamp: T0, application: 'other' })),
      stored(errorEvent({}, { timestamp: T0, environment: 'production' })),
      stored(customEvent('x', { timestamp: T0 })),
      stored(errorEvent({}, { timestamp: T0 + 1_000 })),
      stored(errorEvent({}, { timestamp: T0 - 1 })),
    ]);

    const result = store.query({
      application: 'demo-app',
      environment: 'test',
      type: 'error',
      from: T0,
      to: T0 + 1_000,
    });

    expect(result).toEqual([match]);
  });
});

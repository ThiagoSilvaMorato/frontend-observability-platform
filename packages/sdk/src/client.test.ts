import { validateEvent, type EventBatch, type Metadata } from '@fop/schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createObservability, type ObservabilityOptions } from './client.ts';
import { createRecordingTransport } from './test-utils.ts';
import type { Transport } from './transport.ts';

function setup(overrides: Partial<ObservabilityOptions> = {}) {
  const recording = createRecordingTransport();
  const observability = createObservability({
    application: 'demo-app',
    environment: 'test',
    transport: recording.transport,
    ...overrides,
  } as ObservabilityOptions);
  return { observability, ...recording };
}

describe('createObservability', () => {
  beforeEach(() => {
    sessionStorage.clear();
    history.replaceState(null, '', '/');
  });
  afterEach(() => vi.useRealTimers());

  it('produces events that satisfy the collector contract, even from messy input', async () => {
    const { observability, events } = setup({ release: '1.2.3' });

    // Plain-JS callers can pass anything; the cast simulates one.
    const untyped = { attempt: 2, nested: { no: 1 } } as unknown as Metadata;
    observability.captureError(new Error('x'.repeat(10_000)), untyped);
    observability.captureError('string failure');
    observability.track('n'.repeat(1_000), { term: 't'.repeat(1_000) });
    await observability.flush();

    expect(events()).toHaveLength(3);
    for (const event of events()) expect(validateEvent(event)).toMatchObject({ ok: true });
  });

  it('enriches events with application context and the path without query string', async () => {
    history.pushState(null, '', '/pokemon/25?token=secret#top');
    const { observability, events } = setup({ release: '1.2.3' });

    observability.track('pokemon_search', { term: 'pika' });
    await observability.flush();

    expect(events()[0]).toMatchObject({
      application: 'demo-app',
      environment: 'test',
      release: '1.2.3',
      page: '/pokemon/25',
      type: 'custom',
      custom: { name: 'pokemon_search' },
      metadata: { term: 'pika' },
    });
  });

  it('marks manually captured errors with their source', async () => {
    const { observability, events } = setup();

    observability.captureError(new RangeError('out of range'));
    await observability.flush();

    expect(events()[0]).toMatchObject({
      type: 'error',
      error: { source: 'manual', name: 'RangeError', message: 'out of range' },
    });
  });

  it('keeps one session per tab across SDK instances (i.e. reloads)', async () => {
    const first = setup();
    const second = setup();

    first.observability.track('a');
    second.observability.track('b');
    await Promise.all([first.observability.flush(), second.observability.flush()]);

    expect(first.events()[0]!.sessionId).toBe(second.events()[0]!.sessionId);
  });

  it('still works when sessionStorage is unavailable', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    const { observability, events } = setup();

    observability.track('a');
    await observability.flush();

    expect(events()[0]!.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ignores track() without a name', async () => {
    const { observability, send } = setup();

    observability.track('');
    await observability.flush();

    expect(send).not.toHaveBeenCalled();
  });

  describe('never breaks the host application', () => {
    it('contains a transport that throws synchronously', async () => {
      const transport: Transport = {
        send: () => {
          throw new Error('transport exploded');
        },
      };
      const observability = createObservability({
        application: 'a',
        environment: 'e',
        transport,
        maxBatchSize: 1,
      });

      expect(() => observability.track('a')).not.toThrow();
      await expect(observability.flush()).resolves.toBeUndefined();
    });

    it('contains hostile metadata', () => {
      const { observability } = setup();
      const hostile = Object.defineProperty({}, 'boom', {
        enumerable: true,
        get() {
          throw new Error('getter exploded');
        },
      });

      expect(() => observability.track('a', hostile)).not.toThrow();
    });

    it('returns a no-op client and warns on invalid configuration', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const observability = createObservability({ environment: 'e' } as ObservabilityOptions);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('`application` is required'));
      expect(() => observability.captureError(new Error('x'))).not.toThrow();
      await expect(observability.shutdown()).resolves.toBeUndefined();
    });
  });

  it('shutdown() delivers buffered events and ignores later ones', async () => {
    const { observability, events } = setup();

    observability.track('before');
    await observability.shutdown();
    observability.track('after');
    await observability.flush();

    expect(events()).toMatchObject([{ custom: { name: 'before' } }]);
  });

  it('reports dropped batches only in debug mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing: Transport = {
      send: () => Promise.resolve({ ok: false, retryable: false, reason: 'HTTP 400' }),
    };

    const quiet = createObservability({ application: 'a', environment: 'e', transport: failing });
    quiet.track('a');
    await quiet.flush();
    expect(warn).not.toHaveBeenCalled();

    const verbose = createObservability({
      application: 'a',
      environment: 'e',
      transport: failing,
      debug: true,
    });
    verbose.track('a');
    await verbose.flush();
    expect(warn).toHaveBeenCalledWith('[observability] dropped 1 event(s): HTTP 400');
  });
});

describe('error storms', () => {
  afterEach(() => vi.useRealTimers());

  it('captures a repeated error a bounded number of times and reports the rest as a count', async () => {
    vi.useFakeTimers();
    const { observability, events } = setup({ maxBatchSize: 100 });

    for (let i = 0; i < 100; i++) observability.captureError(new Error('render loop'));
    observability.captureError(new Error('a different bug'));
    await observability.flush();
    expect(events()).toHaveLength(11);

    vi.advanceTimersByTime(60_000);
    observability.captureError(new Error('render loop'), { feature: 'list' });
    await observability.flush();

    expect(events().at(-1)).toMatchObject({
      error: { message: 'render loop' },
      metadata: { suppressedOccurrences: 90, feature: 'list' },
    });
  });
});

describe('page lifecycle', () => {
  function exitSetup() {
    const exits: EventBatch[] = [];
    const recording = createRecordingTransport();
    const observability = createObservability({
      application: 'a',
      environment: 'e',
      transport: { send: recording.send, sendOnExit: (batch) => void exits.push(batch) },
    });
    return { observability, exits, send: recording.send };
  }

  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  }

  afterEach(() => setVisibility('visible'));

  it('hands buffered events to the exit path when the page is hidden', async () => {
    const { observability, exits } = exitSetup();
    observability.track('before-hide');

    setVisibility('hidden');

    expect(exits).toHaveLength(1);
    await observability.shutdown();
  });

  it('also flushes on pagehide', async () => {
    const { observability, exits } = exitSetup();
    observability.track('before-navigation');

    window.dispatchEvent(new Event('pagehide'));

    expect(exits).toHaveLength(1);
    await observability.shutdown();
  });

  it('stops listening after shutdown', async () => {
    const { observability, exits } = exitSetup();
    await observability.shutdown();

    window.dispatchEvent(new Event('pagehide'));

    expect(exits).toHaveLength(0);
  });

  it('never lets an exit-path failure escape into the page', async () => {
    const observability = createObservability({
      application: 'a',
      environment: 'e',
      transport: {
        send: () => Promise.resolve({ ok: true }),
        sendOnExit: () => {
          throw new Error('exit exploded');
        },
      },
    });
    observability.track('x');
    const uncaught = vi.fn();
    window.addEventListener('error', uncaught);

    window.dispatchEvent(new Event('pagehide'));

    expect(uncaught).not.toHaveBeenCalled();
    window.removeEventListener('error', uncaught);
    await observability.shutdown();
  });
});

describe('connectivity', () => {
  it('holds events while the browser is offline and delivers them on the online event', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { observability, send } = setup();

    observability.track('while-offline');
    await observability.flush();
    expect(send).not.toHaveBeenCalled();

    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await observability.shutdown();
  });
});

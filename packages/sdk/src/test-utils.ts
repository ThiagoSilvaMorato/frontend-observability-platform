import type { EventBatch, ObservabilityEvent } from '@fop/schema';
import { vi } from 'vitest';
import type { SendResult, Transport } from './transport.ts';

/** A transport that records batches and resolves every send with `result`. */
export function createRecordingTransport(result: SendResult = { ok: true }) {
  const send = vi.fn<(batch: EventBatch) => Promise<SendResult>>(() => Promise.resolve(result));
  const transport: Transport = { send };
  const batches = () => send.mock.calls.map(([batch]) => batch);
  const events = () => batches().flatMap((batch) => batch.events);
  return { transport, send, batches, events };
}

/** A transport whose sends stay pending until the test resolves them. */
export function createControllableTransport() {
  const pending: { batch: EventBatch; resolve: (result: SendResult) => void }[] = [];
  const transport: Transport = {
    send: (batch) => new Promise((resolve) => pending.push({ batch, resolve })),
  };
  return { transport, pending };
}

export function fakeEvent(name = 'test'): ObservabilityEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    application: 'app',
    environment: 'test',
    sessionId: 'session',
    page: '/',
    type: 'custom',
    custom: { name },
  };
}

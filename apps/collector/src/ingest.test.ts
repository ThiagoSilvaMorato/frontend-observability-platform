import { describe, expect, it } from 'vitest';
import { toStoredEvents } from './ingest.ts';
import { customEvent, errorEvent, T0 } from './test-utils.ts';

describe('toStoredEvents', () => {
  it('corrects event time by the batch clock skew', () => {
    // Client clock is 1h behind: it thinks it sent at T0, the collector sees T0 + 1h.
    const hour = 3_600_000;
    const event = customEvent('x', { timestamp: T0 - 5_000 });

    const [result] = toStoredEvents([event], T0, T0 + hour);

    expect(result).toMatchObject({
      receivedAt: T0 + hour,
      occurredAt: T0 + hour - 5_000,
      timestamp: T0 - 5_000,
    });
  });

  it('never places an event after its arrival', () => {
    const [result] = toStoredEvents([customEvent('x', { timestamp: T0 + 10 })], T0, T0);
    expect(result!.occurredAt).toBe(T0);
  });

  it('fingerprints error events only', () => {
    const [error, custom] = toStoredEvents([errorEvent(), customEvent()], T0, T0);

    expect(error!.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(custom).not.toHaveProperty('fingerprint');
  });
});

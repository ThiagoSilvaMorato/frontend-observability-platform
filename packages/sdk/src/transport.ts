import type { EventBatch } from '@fop/schema';

export type SendResult = { ok: true } | { ok: false; retryable: boolean; reason: string };

/**
 * The seam between the pipeline and wherever events go. Implementations must
 * resolve — never reject — so callers can treat failure as data.
 */
export interface Transport {
  send(batch: EventBatch): Promise<SendResult>;
}

export interface FetchTransportOptions {
  /**
   * Defaults to the `fetch` present at creation time. Capturing it here, before
   * any instrumentation patches `window.fetch`, keeps the SDK from observing its
   * own traffic.
   */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createFetchTransport(
  endpoint: string,
  {
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    timeoutMs = 10_000,
  }: FetchTransportOptions = {},
): Transport {
  return {
    async send(batch) {
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          // text/plain keeps this a CORS "simple request": no preflight, so one
          // round-trip per batch instead of two.
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: JSON.stringify(batch),
          // Telemetry has no business carrying the user's cookies.
          credentials: 'omit',
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return { ok: true };
        return {
          ok: false,
          retryable: response.status >= 500 || response.status === 429,
          reason: `HTTP ${response.status}`,
        };
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        return { ok: false, retryable: true, reason: timedOut ? 'timeout' : 'network error' };
      }
    },
  };
}

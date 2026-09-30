import type { EventBatch } from '@fop/schema';

export type SendResult =
  { ok: true } | { ok: false; retryable: boolean; reason: string; retryAfterMs?: number };

/**
 * The seam between the pipeline and wherever events go. Implementations must
 * resolve — never reject — so callers can treat failure as data.
 */
export interface Transport {
  send(batch: EventBatch): Promise<SendResult>;
  /**
   * Best-effort, fire-and-forget delivery for when the page may be going away:
   * nothing can be awaited, so there is no result. Optional for custom transports.
   */
  sendOnExit?(batch: EventBatch): void;
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

/**
 * Browsers cap the total body size of in-flight `keepalive` requests at 64 KiB
 * per page; stay under it with some headroom.
 */
export const KEEPALIVE_MAX_BYTES = 60 * 1024;

export function createFetchTransport(
  endpoint: string,
  {
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    timeoutMs = 10_000,
  }: FetchTransportOptions = {},
): Transport {
  const baseInit: RequestInit = {
    method: 'POST',
    // text/plain keeps this a CORS "simple request": no preflight, so one
    // round-trip per batch instead of two.
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    // Telemetry has no business carrying the user's cookies.
    credentials: 'omit',
  };

  return {
    async send(batch) {
      try {
        const body = JSON.stringify(batch);
        const response = await fetchImpl(endpoint, {
          ...baseInit,
          body,
          // A regular send can still be in flight when the page unloads;
          // keepalive lets it finish, when it fits the browser's quota.
          keepalive: byteLength(body) <= KEEPALIVE_MAX_BYTES,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (response.ok) return { ok: true };

        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        return {
          ok: false,
          retryable: response.status >= 500 || response.status === 429,
          reason: `HTTP ${response.status}`,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        return { ok: false, retryable: true, reason: timedOut ? 'timeout' : 'network error' };
      }
    },

    /**
     * `fetch` + `keepalive` rather than `navigator.sendBeacon`: a beacon always
     * sends the user's cookies, and keepalive supports `credentials: 'omit'`.
     */
    sendOnExit(batch) {
      for (const body of splitToFit(batch, KEEPALIVE_MAX_BYTES)) {
        try {
          fetchImpl(endpoint, { ...baseInit, body, keepalive: true }).catch(() => {});
        } catch {
          // Nothing useful can be done while the page is going away.
        }
      }
    },
  };
}

/** Serializes a batch into bodies that each fit `maxBytes`, halving as needed. */
export function splitToFit(batch: EventBatch, maxBytes: number): string[] {
  const body = JSON.stringify(batch);
  if (byteLength(body) <= maxBytes) return [body];
  // A single event that does not fit cannot be delivered this way.
  if (batch.events.length <= 1) return [];
  const middle = Math.ceil(batch.events.length / 2);
  return [
    ...splitToFit({ ...batch, events: batch.events.slice(0, middle) }, maxBytes),
    ...splitToFit({ ...batch, events: batch.events.slice(middle) }, maxBytes),
  ];
}

const encoder = new TextEncoder();
function byteLength(value: string): number {
  return encoder.encode(value).length;
}

/** `Retry-After` is either delay-seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

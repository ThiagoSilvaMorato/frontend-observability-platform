# 0005. SDK reliability: failure modes and the mechanism for each

## Problem

Observability must never become the application's single point of failure, and it should not
lose data to the failures it exists to observe. The SDK core (0003) dropped any batch whose
delivery failed. Each failure mode below needed its own answer.

## Solution

| Failure mode                                     | Mechanism                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Collector down, 5xx, 429, timeout, network error | Batch goes back to the head of the queue; delivery pauses with exponential backoff (1 s → 5 min cap) and **equal jitter**. `Retry-After` wins if longer. Success resets the backoff. |
| Collector rejects the payload (4xx)              | Drop and report via `debug`: resending the same payload cannot succeed.                                                                                                              |
| Retry after a request that actually succeeded    | Nothing in the SDK: the collector dedupes by event id (0004). At-least-once is enough.                                                                                               |
| Browser offline                                  | No attempts while `navigator.onLine === false`; the `online` event resumes immediately and resets backoff.                                                                           |
| Long outage → unbounded memory                   | Queue capped (500). Overflow drops the **oldest non-error** events first; errors only when nothing else is left.                                                                     |
| Error storm (render loop throwing 100×/s)        | Per-error (name + message) limit of 10 per minute. The next allowed occurrence carries `suppressedOccurrences`, so volume is reported, not lost.                                     |
| Tab closed / hidden with events buffered         | On `visibilitychange → hidden` and `pagehide`, the queue goes out via `fetch(..., { keepalive: true })`, errors first, split to fit the 64 KiB keepalive quota.                      |
| Tab closed while a regular request is in flight  | Regular sends also use `keepalive` when the body fits the quota, so the browser completes them after unload.                                                                         |

## Why this approach

- **Re-queue instead of per-batch retry counters.** An outage is a property of the collector, not
  of a batch. Holding events in one bounded queue behind one backoff means cost stays at one
  request per backoff interval, however long the outage lasts, and the queue bound alone decides
  what is lost (the oldest, least valuable events).
- **Equal jitter** (half fixed, half random) guarantees an actual delay while still spreading
  clients that failed together, so a recovering collector is not hit by a synchronized wave.
- **`fetch` + `keepalive` instead of `sendBeacon`.** A beacon always carries the user's cookies;
  keepalive supports `credentials: 'omit'`, consistent with the rest of the transport.
- **`visibilitychange` as the primary exit signal.** On mobile, backgrounded pages are often
  killed without `pagehide`. `unload` is never used: it disables the back/forward cache.
- **No exit send while backing off.** The collector is known to be failing, so the send would be
  lost; keeping events in memory lets a tab that was only hidden deliver them once it recovers.

## Alternatives

- **Unbounded retries per batch with parallel requests**: fastest recovery, but multiplies load
  on a collector that is already failing.
- **`navigator.sendBeacon`**: simplest exit path and widely known, rejected for the cookie issue.
- **Persisting the queue in `localStorage` / IndexedDB** to survive reloads and offline closes.
  Deferred, not rejected: it covers "user closes the tab while offline", but brings storage
  quotas, cross-tab coordination and synchronous `localStorage` writes on the main thread.
  Because the collector is idempotent, it can be added later without protocol changes.
- **Rate limiting by stack trace**: more precise, but the key would need normalization equal to
  the collector's fingerprint; name + message is cheap and good enough for storms.

## Trade-offs

- Events are held in memory only: if the page is closed during an outage, they are lost.
- `flush()` returns immediately while delivery is paused. It reflects reality instead of
  pretending to deliver.
- The keepalive quota is per page and shared; on exit, whatever exceeds it is lost, which is why
  errors go first.

## How it is tested

- `pipeline.test.ts`: backoff sequence and cap, reset after success, `Retry-After`, no bypass by
  new events, re-queue order, offline pause and `resume()`, queue bound priorities, memory bound
  during an outage, exit flush (priority, chunking, skipped while backing off).
- `transport.test.ts`: keepalive on regular sends, `Retry-After` parsing, exit sends without
  credentials, splitting to fit the quota, swallowed failures.
- `rate-limit.test.ts`: limits per key, suppressed counts, pruning.
- `client.test.ts`: error storms end to end, lifecycle events (hidden, pagehide, online),
  listener removal on shutdown, exit failures never surface as page errors.

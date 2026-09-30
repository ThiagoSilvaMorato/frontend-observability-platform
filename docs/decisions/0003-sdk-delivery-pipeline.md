# 0003. SDK delivery: buffered batches, one request in flight

## Problem

Telemetry competes with the application for the main thread and the network. Sending one
request per event multiplies connection and header overhead, and a burst of errors could open
dozens of parallel requests at the worst possible moment. At the same time, the SDK must never
throw into application code, whatever the input or the network does.

## Solution

- **Capture is synchronous and cheap**: build a plain object, push it onto an in-memory queue.
  Serialization and network happen later, off the caller's path.
- **Batching by size or time**: send when `maxBatchSize` (20) events are buffered, or
  `flushIntervalMs` (5 s) after the first buffered event — whichever comes first.
- **One request in flight**: a single drain loop sends batches sequentially and picks up events
  that arrive while a request is pending.
- **Transport as a seam**: `Transport.send(batch)` resolves to `{ ok } | { ok: false, retryable,
reason }` and never rejects, so failure is data, not control flow.
- **Fetch transport details**:
  - `Content-Type: text/plain` keeps the request CORS-"simple": no preflight, one round-trip per
    batch instead of two. The collector parses the body as JSON regardless.
  - `credentials: 'omit'`: telemetry has no reason to carry the user's cookies.
  - The `fetch` reference is captured when the transport is created, before any instrumentation
    patches `window.fetch`, so the SDK cannot observe (and loop on) its own traffic.
  - `AbortSignal.timeout` bounds every request.
- **Containment**: every public method runs inside a guard; an invalid configuration returns a
  no-op client (with a console warning, since silently doing nothing hides misconfiguration).
  Metadata is sanitized to fit the schema instead of rejecting the event.

## Why this approach

The goal is bounded cost: a fixed number of requests per time window regardless of event volume,
and a fixed amount of work per captured event.

## Alternatives

- **Send immediately**: simplest and lowest latency, but cost scales with event volume.
- **Parallel batch requests**: faster drain under huge volume, but loses ordering and makes
  retry/backoff (step 4) much harder to reason about.
- **Web Worker for processing**: moves serialization off the main thread, but the work per batch
  is tiny (a `JSON.stringify` of ≤ 100 small objects) compared to the cost of worker setup and
  message passing.
- **`application/json`**: more "correct", but every batch would pay for a preflight request.

## Trade-offs

- Up to 5 s of latency before an event reaches the collector. Acceptable for a dashboard;
  error-priority flushing can shorten it later if needed.
- Until step 4, a failed send drops its batch (reported via `debug`). Retry, offline handling,
  unload flushing and queue limits are deliberately separate, each tied to a failure mode.

## How it is tested

- `pipeline.test.ts`: size- and time-based flushing, a single request in flight, events arriving
  mid-request, failed/throwing transports, a throwing drop reporter.
- `transport.test.ts`: request shape, use of the pre-patch `fetch`, status classification,
  network errors and timeouts.
- `client.test.ts`: every event the SDK emits passes the collector's `validateEvent` (contract
  test), context enrichment, hostile input and broken transports never reach the caller.

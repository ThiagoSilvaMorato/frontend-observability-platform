# 0004. Collector: idempotent ingest and explicit metric definitions

## Problem

The collector is the trust boundary and the source of truth for every number the dashboard
shows. It receives untrusted payloads from clients with wrong clocks, over a delivery mechanism
that retries (so duplicates are expected), and it must turn raw events into metrics whose meaning
is unambiguous.

## Solution

**Ingest (`POST /v1/events`)**

- Body parsed as JSON regardless of `Content-Type` (the SDK sends `text/plain` to avoid CORS
  preflights; `sendBeacon` can't send JSON headers). Size capped at 1 MiB → `413`.
- Envelope invalid → `400` (the SDK treats 4xx as non-retryable). Individual invalid events are
  rejected by index in a `202` response; the rest are stored.
- **Idempotent by `event.id`**: the store counts re-sent events as duplicates. With this, the SDK
  can use simple at-least-once delivery.
- **Clock-skew correction**: `occurredAt = timestamp + (receivedAt − sentAt)`, capped at
  `receivedAt`. The original `timestamp` is kept.
- **Error fingerprinting at ingest**: `sha1(name | normalized message | top frame)`, where the
  message has numbers/UUIDs/hex replaced and the frame drops line/column, query string and
  bundle hash, so groups survive deploys.
- CORS `*`: ingest is public by nature and requests carry no credentials.

**Metric definitions** (`GET /v1/overview`, `/v1/errors`, `/v1/requests`, `/v1/events`)

| Metric         | Definition                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| Error rate     | Sessions with ≥ 1 error ÷ sessions. Per event would let one noisy session dominate.                                 |
| API error rate | (`http_error` + `network_error` + `timeout`) ÷ non-aborted requests. Aborts are user navigation, not failures.      |
| API latency    | avg / p50 / p95 over requests that got a response (`status > 0`); timeouts would report the timeout, not latency.   |
| Web Vitals     | p75 per metric (how Core Web Vitals are assessed); ratings recomputed from thresholds, not trusted from the client. |
| Endpoint       | Method + URL with numeric/UUID/long-hex path segments replaced by `:id`.                                            |
| Empty ratios   | `null`, not `0` — "no data" and "no errors" are different statements.                                               |

**Storage**: `EventStore` interface with a bounded in-memory FIFO (100k events). Aggregations are
pure functions over the window's events.

## Why this approach

Every definition above is a product decision the dashboard would otherwise make implicitly. Doing
it once, server-side, keeps the dashboard a pure presentation layer and makes the numbers
testable.

## Alternatives

- **Exactly-once delivery** (acks + client-side sequence tracking): far more complex than dedup on
  an id the client already generates.
- **Fingerprinting in the SDK**: saves collector CPU, but grouping rules could then never change
  without shipping new clients, and old clients would disagree with new ones.
- **Pre-aggregated counters** at ingest: O(1) queries, but fixes the set of questions up front.
  A linear scan is fine at demo scale; the persistent store (step 8) can push aggregation to SQL.
- **Express/Hono**: the service has six routes; `node:http` plus a route map is enough.

## Trade-offs

- In-memory storage loses data on restart and dedup only covers retained events — acceptable until
  step 8.
- Skew correction also absorbs network latency (typically < 1 s).
- No authentication or rate limiting on ingest; a production collector needs per-project keys and
  quotas.

## How it is tested

- `server.test.ts`: real HTTP server on an ephemeral port — partial acceptance, idempotent retries,
  400/413/404/405, CORS preflight, query validation, each query endpoint.
- `aggregate.test.ts`: each metric definition, including the edge cases in the table.
- `grouping.test.ts`: fingerprint stability across variable data, deploys and browsers; endpoint
  normalization.
- `ingest.test.ts` and `store.test.ts`: skew correction, dedup, eviction, filtering.

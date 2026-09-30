# Architecture

## Components

```text
┌──────────────────┐        ┌──────────────────────────────────────────────┐
│ Demo Application │──uses─▶│ @fop/sdk                                     │
└──────────────────┘        │  integrations ─▶ pipeline ─▶ transport        │
                            │  (errors, fetch,  (normalize,  (fetch keepalive│
                            │   navigation,      sample,      / sendBeacon,  │
                            │   web vitals)      queue,       retry)         │
                            │                    batch)                      │
                            └───────────────────────┬──────────────────────┘
                                                    │ POST /v1/events (EventBatch)
                                                    ▼
                            ┌──────────────────────────────────────────────┐
                            │ apps/collector (Node)                        │
                            │  validate ─▶ dedupe (event id) ─▶ EventStore  │
                            │  query API: /v1/metrics, /v1/events, ...     │
                            └───────────────────────┬──────────────────────┘
                                                    │ GET (JSON)
                                                    ▼
                            ┌──────────────────────────────────────────────┐
                            │ apps/dashboard (React)                       │
                            └──────────────────────────────────────────────┘

          @fop/schema — event types, limits, validation — shared by all three
```

| Unit             | Responsibility                                                            | Must not know about                |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------- |
| `@fop/schema`    | Wire contract: event types, limits, `validateBatch`                       | Anything runtime-specific          |
| `@fop/sdk`       | Capture, normalize, queue, batch, deliver. Never break the host app       | Collector internals, storage       |
| `apps/collector` | Trust boundary: validate, dedupe, store, aggregate, serve queries         | SDK internals                      |
| `apps/dashboard` | Present metrics as a product (overview, errors, requests, perf, explorer) | The SDK, how events are collected  |
| `apps/demo`      | Realistic SDK consumer that deliberately produces every event type        | The collector (talks only via SDK) |

The replaceable seams are explicit:

- **SDK → collector**: the `Transport` interface. Swapping HTTP for another sink does not touch
  capture or pipeline code.
- **Collector → storage**: the `EventStore` interface. In-memory first, SQLite later, same API.
- **Collector → dashboard**: a small HTTP query API. The dashboard never reads storage directly.

## Stack analysis

| Suggested                  | Decision            | Why                                                                                                                                                                               |
| -------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| React, TypeScript, Vite    | Keep                | Fit for the two UI apps. The SDK uses none of them at runtime.                                                                                                                    |
| TypeScript 7               | **Use 6.0**         | `typescript-eslint` supports `<6.1`. Type-aware linting is worth more than the TS 7 compiler speed for a repo this size. Revisit when tooling catches up.                         |
| Axios or Fetch             | **Fetch only**      | Axios adds nothing the platform lacks, and the SDK instruments `fetch`. Using Axios in the demo would require a second instrumentation path (XHR) just to observe our own choice. |
| TanStack Query             | Keep (dashboard)    | The dashboard is a polling client of a read API: caching, `refetchInterval`, stale state and background refresh are exactly what it solves.                                       |
| React Router               | Keep                | Several views, and filters belong in the URL (shareable, back-button friendly).                                                                                                   |
| Vitest + RTL               | Keep                | One runner for all packages via Vitest projects.                                                                                                                                  |
| _Added:_ `happy-dom`       | Add (tests)         | DOM for SDK/React tests. Current jsdom (30) requires Node ≥ 22.22; happy-dom is lighter, faster and sufficient for these APIs (storage, history, fetch primitives).               |
| Playwright                 | Keep, **later**     | Its real value is the full-pipeline test (demo → collector → dashboard) and the "collector down, app still works" test. Not before the pipeline exists.                           |
| ESLint + Prettier          | Keep                | Biome would be faster, but ESLint's type-aware rules and `react-hooks` plugin matter more here.                                                                                   |
| _Added:_ pnpm workspaces   | Add                 | Four units with a shared contract. Workspaces enforce the dependency boundaries; Turborepo/Nx would be overhead at this size.                                                     |
| _Added:_ `web-vitals`      | Add (SDK, step 5)   | ~2 KB, maintained by the Chrome team. INP/CLS have subtle edge cases (bfcache, visibility, session windows); reimplementing them would be the _wrong_ demonstration of judgment.  |
| _Added:_ `tsx` (collector) | Add (step 3)        | Node 22.14 cannot run TypeScript natively; `tsx` is the smallest dev-time bridge.                                                                                                 |
| _Rejected:_ Zod            | Hand-written guards | The schema is small and stable. Zod would add ~13 KB if it ever leaked into the SDK bundle, and the validator is a pure function that is easy to test exhaustively.               |
| _Rejected:_ Express/Hono   | `node:http`         | The collector has ~4 routes. Revisit if routing/middleware grows.                                                                                                                 |
| Charts                     | Decide at step 7    | Evaluate hand-rolled SVG vs a library once the actual chart set is known.                                                                                                         |

## Risks identified in the original proposal

1. **Self-instrumentation loop.** An SDK that patches `fetch` will observe its own transport
   requests, generate events about them, send those, observe that… The transport must bypass
   instrumentation (it captures the original `fetch` before patching).
2. **Error storms.** A render loop throwing the same error 60 times/second would flood the queue
   and the network. Needs per-fingerprint rate limiting, not just a queue cap.
3. **Retries create duplicates.** A batch that timed out may have been stored anyway. At-least-once
   delivery + idempotent collector (dedupe on `event.id`) is simpler and more honest than trying
   for exactly-once.
4. **Page unload loses the buffer.** `fetch` started in `unload` is unreliable. Flush on
   `visibilitychange: hidden` / `pagehide` with `sendBeacon` or `fetch({ keepalive: true })`.
5. **"Retry count" is not observable by patching `fetch`.** App-level retries look like
   independent requests. It needs either an explicit `attempt` supplied by the app's HTTP client or
   correlation — the schema carries an optional `attempt`, and the demo's client will supply it.
6. **Privacy leaks via URLs.** Query strings routinely carry tokens and emails. URLs are reduced
   to origin + path by default; request/response bodies and headers are never captured.
7. **Client clocks are wrong.** The batch carries `sentAt` so the collector can estimate skew.

## Incremental plan

Each step ends with typecheck, lint, format check, tests, and an architecture review.

| #   | Step                                                                                            | Status |
| --- | ----------------------------------------------------------------------------------------------- | ------ |
| 0   | Monorepo scaffold, tooling, docs, `CLAUDE.md`                                                   | ✅     |
| 1   | `@fop/schema`: event model, limits, batch validation                                            | ✅     |
| 2   | SDK core: `createObservability`, context enrichment, queue, size/time batching, fetch transport | ✅     |
| 3   | Collector: ingest endpoint, validation, idempotent in-memory store, query API                   | ✅     |
| 4   | SDK reliability: retry + backoff + jitter, offline pause, unload flush, queue cap, error dedup  | ✅     |
| 5   | SDK integrations: global errors, fetch instrumentation, navigation, Web Vitals, sampling        | ⏳     |
| 6   | Demo app generating every event type                                                            |        |
| 7   | Dashboard: overview, errors (grouped), requests, performance, event explorer                    |        |
| 8   | Persistent storage (SQLite via `node:sqlite`) behind the same `EventStore`                      |        |
| 9   | Playwright: end-to-end pipeline and "collector down" resilience                                 |        |

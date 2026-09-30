# Frontend Observability Platform

A small observability platform for frontend applications, built to show how a browser app can
**collect, deliver, process and visualize telemetry** — errors, API requests, Web Vitals,
navigation and custom events — while staying fast, private and resilient.

It is not a Datadog/Sentry clone. The scope is deliberately small so the interesting parts are
visible: SDK design, an event pipeline with batching and retries, a validating collector, and
the engineering trade-offs behind each piece.

> **Observability should never become the application's single point of failure.**

## How it fits together

```text
Demo App ──▶ @fop/sdk ──▶ (queue → batch → transport) ──▶ Collector ──▶ Storage ──▶ Dashboard
                         └──────────── @fop/schema: the shared event contract ────────────┘
```

- **`@fop/sdk`** — framework-agnostic TypeScript SDK. Captures errors, requests, navigation and
  Web Vitals; batches and delivers them without ever throwing into the host app.
- **`@fop/schema`** — the wire contract: event types, limits and validation.
- **Collector** — Node service; validates, dedupes and stores events, and serves a query API.
- **Dashboard** — React app presenting overview, errors, requests, performance and an event
  explorer.
- **Demo app** — a real SDK consumer that intentionally produces every kind of event.

See [docs/architecture.md](docs/architecture.md) for the architecture, stack analysis, identified
risks and roadmap, and [docs/decisions/](docs/decisions/) for decision records.

## Status

Work in progress, built incrementally. Done: repository scaffold, the event schema, the SDK core
(manual capture, batching, fetch transport — ~1.9 KB gzipped) and the collector (idempotent ingest,
error grouping, query API over an in-memory store). Next: SDK reliability.

Run the collector with `pnpm --filter @fop/collector dev` (port 4318, override with `PORT`).

```ts
import { createObservability } from '@fop/sdk';

const observability = createObservability({
  application: 'demo-app',
  environment: 'development',
  endpoint: 'http://localhost:4318/v1/events',
});

observability.track('pokemon_search', { term: 'pikachu' });
observability.captureError(error, { feature: 'search' });
```

## Development

Requires Node ≥ 22.12 and pnpm 10.

```bash
pnpm install
pnpm check   # typecheck + lint + format + tests
```

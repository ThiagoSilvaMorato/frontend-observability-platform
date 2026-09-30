# CLAUDE.md

Frontend Observability Platform: a small, portfolio-grade observability platform for frontend apps.
The main technical product is the **SDK and the event pipeline**; the dashboard is the interface.
Architecture, stack rationale and roadmap: [docs/architecture.md](docs/architecture.md).
Decision records: [docs/decisions/](docs/decisions/).

## Layout

```text
packages/schema     @fop/schema — event types, LIMITS, validateBatch (zero deps)
packages/sdk        @fop/sdk — browser SDK (step 2+)
apps/collector      Node ingest + query API (step 3+)
apps/demo           React app that consumes the SDK (step 6+)
apps/dashboard      React observability UI (step 7+)
```

Internal packages export TS source (`"exports": { ".": "./src/index.ts" }`); there is no build
step between packages. Imports use explicit `.ts` extensions.

## Dependency rules (do not break)

- `schema` depends on nothing.
- `sdk` depends only on `schema` (+ `web-vitals`). Never on collector, dashboard, React.
- `collector` depends on `schema`. It is the trust boundary: validate everything.
- `dashboard` depends on `schema` types and the collector's HTTP API — never on `sdk`.
- `demo` depends on `sdk` only. It never calls the collector directly.

## Commands

```bash
pnpm install
pnpm check          # typecheck + lint + format:check + test — run after every step
pnpm typecheck      # tsc per package
pnpm lint           # eslint (type-aware)
pnpm format         # prettier --write
pnpm test           # vitest, all projects
pnpm vitest run packages/schema   # a single project
pnpm --filter @fop/collector dev  # collector on :4318 (PORT to override)
```

## SDK invariants

1. **Never break the host app.** Every public method and every browser hook is wrapped so SDK
   failures are swallowed (and optionally reported via a `debug` logger). No SDK code path may
   throw into application code or block the main thread with synchronous work on capture.
2. **Never observe yourself.** The transport uses the original `fetch`, captured before
   instrumentation, and instrumentation ignores the collector endpoint.
3. **Bounded everything.** Queue size, batch size, payload size, retry attempts, error rate per
   fingerprint. When a bound is hit, drop low-priority events first and count what was dropped.
4. **Private by default.** URLs are reduced to origin + path. Never capture request/response
   bodies, headers, form values, or element text. Metadata is explicit and flat.
5. **At-least-once delivery.** Events carry a UUID; the collector dedupes by `id`.

## Engineering rules

- Before adding a feature or abstraction, ask: _does this demonstrate a relevant engineering
  decision, or is it just complexity?_ Mechanisms (retry, dedup, backpressure, sampling) exist only
  when a real failure mode justifies them — name that failure mode in a test.
- New dependency → evaluate problem solved, complexity, alternatives, value, architectural impact,
  and record it in `docs/architecture.md` (stack table) or a decision record.
- Relevant architectural decisions get a record in `docs/decisions/` using the template there.
  Do not document obvious code.
- Prefer browser/Node platform APIs over libraries. Prefer small interfaces at real seams
  (`Transport`, `EventStore`) over speculative ones.
- Tests describe behavior and failure modes, not implementation. Use fake timers and fake
  transports for the SDK instead of real network.
- Implement in small, verifiable steps; after each: `pnpm check`, review boundaries, remove
  abstractions that did not earn their place, update the roadmap status in `docs/architecture.md`.

## Conventions

- Code, comments, docs and commits in English.
- TypeScript strict with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- TypeScript is pinned to 6.0.x because `typescript-eslint` does not support 7 yet.
- Comments explain _why_, not _what_.

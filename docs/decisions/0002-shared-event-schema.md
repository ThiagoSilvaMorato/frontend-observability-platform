# 0002. Shared event schema with hand-written validation

## Problem

Three parties touch events: the SDK produces them, the collector accepts them from an untrusted
network, and the dashboard reads them. If each defines its own shape, they drift silently.
The collector also cannot trust anything the browser sends.

## Solution

`@fop/schema` owns:

- a discriminated union `ObservabilityEvent` (`error`, `request`, `web_vital`, `navigation`,
  `custom`) over a common `EventContext` (id, timestamp, application, environment, release,
  sessionId, page, metadata);
- the `EventBatch` envelope (`schemaVersion`, `sentAt`, `events`);
- shared `LIMITS` (string lengths, metadata keys, batch size);
- `validateBatch` / `validateEvent`, pure functions that **rebuild** events from known fields.

Type-specific data lives under a key named after the type (`error`, `request`, `webVital`, ...),
so the common context and the payload never collide and each payload validates independently.

## Why this approach

- **Rebuild, don't pass through.** Unknown fields are dropped, so a buggy or malicious client
  cannot push arbitrary data (or PII) into storage.
- **Partial acceptance.** The envelope is all-or-nothing, but events are validated one by one; a
  single malformed event does not cost the other 99 in the batch.
- **Flat, primitive metadata.** Keeps payloads small and queryable, and prevents dumping whole
  objects into telemetry.
- **Shared limits.** The SDK truncates to fit the same limits the collector enforces, so
  well-behaved clients never get rejected.

## Alternatives

- **Zod / Valibot**: less code, but a runtime dependency in the contract package that could leak
  into the SDK bundle. The schema is small enough that explicit guards are clear and exhaustively
  testable.
- **JSON Schema + Ajv**: good for polyglot consumers; everything here is TypeScript.
- **Generic `{ type, data: Record<string, unknown> }` event**: maximally flexible, but moves all
  validation and typing into every consumer.

## Trade-offs

Adding an event type means editing both the type and the validator by hand. The validator's
`switch` over the discriminant is exhaustive, so the compiler flags a missing case.

## How it is tested

`validate.test.ts` covers each event type round-tripping, unknown-field stripping, boundary
violations (limits, ranges, types), metadata rules, and batch partial acceptance vs envelope
rejection.

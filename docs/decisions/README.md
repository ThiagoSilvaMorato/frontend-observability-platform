# Engineering decisions

Short records of decisions that shaped the architecture. Each one answers: problem, solution, why,
alternatives, trade-offs, and how it is tested. Obvious code choices are not recorded here.

| #                                             | Decision                                                     |
| --------------------------------------------- | ------------------------------------------------------------ |
| [0001](0001-monorepo-with-source-packages.md) | pnpm monorepo with source-first internal packages            |
| [0002](0002-shared-event-schema.md)           | Shared event schema with hand-written validation             |
| [0003](0003-sdk-delivery-pipeline.md)         | SDK delivery: buffered batches, one request in flight        |
| [0004](0004-collector-ingest-and-metrics.md)  | Collector: idempotent ingest and explicit metric definitions |
| [0005](0005-sdk-reliability.md)               | SDK reliability: failure modes and the mechanism for each    |

Template:

```markdown
# NNNN. Title

## Problem

## Solution

## Why this approach

## Alternatives

## Trade-offs

## How it is tested
```

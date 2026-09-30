# 0001. pnpm monorepo with source-first internal packages

## Problem

The SDK, collector and dashboard share one contract (the event model) but must stay decoupled:
the SDK cannot depend on the collector, and the dashboard cannot depend on the SDK.

## Solution

A pnpm workspace with `packages/*` (libraries) and `apps/*` (deployables). Internal packages
export their TypeScript source directly (`"exports": { ".": "./src/index.ts" }`), so there is no
build step between packages during development.

## Why this approach

- Package boundaries make illegal dependencies visible: an import that is not declared in
  `package.json` fails.
- Source exports keep the inner loop instant — Vite, Vitest and `tsx` all consume TS natively.

## Alternatives

- **Single app with folders**: no enforced boundaries; the SDK would drift into importing app code.
- **Turborepo / Nx**: task caching and graphs pay off with many packages or slow builds. With four
  units, they are configuration without benefit.
- **Compiled packages (`dist/`)**: required for publishing, but adds watch processes and stale
  build artifacts during development.

## Trade-offs

Source-first packages cannot be published to npm as-is. If the SDK is ever published, it gets a
build step (and a bundle-size check) at that point — not before.

## How it is tested

`pnpm typecheck` runs per package, so each package is checked against only its declared
dependencies.

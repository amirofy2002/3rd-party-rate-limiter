# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Pre-implementation. Repository currently contains only design documents under `design/`. No code, no `package.json`, no build/test tooling exists yet. Scaffolding is the next step.

## Project Purpose

NPM library for managing third-party API rate limits (e.g. Binance weight-based limits). Tracks weighted usage, prevents threshold violations, and schedules requests via reject / delay / queue strategies. Supports single-process (memory) and horizontally scaled (Redis) deployments.

## Design Documents

Read these in order before changing anything. They are the source of truth until code exists:

- `design/00-request.md` — original requirements from the user
- `design/01-design.md` — condensed design summary (architecture, interfaces, folder layout, v1 vs v2)
- `design/02-architecture.md` — full architectural specification (component model, lifecycle diagrams, ADRs, defaults). This is the authoritative document; if `01-design.md` and `02-architecture.md` disagree, `02-architecture.md` wins.

When asked to implement, follow the roadmap in `02-architecture.md` §25 and the v1 defaults in §28.

## Core Architectural Principles

These are load-bearing decisions from the ADRs in `02-architecture.md` §26. Do not violate without explicit user approval:

1. **Pessimistic reservation** — consume capacity *before* executing the user's request, refund only when appropriate. Overshoot is more expensive than underutilization because providers ban clients.
2. **Local queue + global counter** — each process owns its priority queue; Redis owns atomic counters and ban state. Do not introduce a distributed queue in v1.
3. **Storage is the distributed boundary** — scheduler and algorithms talk to `RateLimitStore`, never to Redis directly. Memory and Redis modes must share scheduler behavior.
4. **Transport stays outside the library** — the caller provides `execute()`. The library never owns HTTP/fetch/axios. Adapters parse provider responses but do not issue them.
5. **Provider feedback reconciles upward** — when provider headers report higher usage than local tracking, trust the provider. Downward reconciliation requires the adapter to mark the header as authoritative.

## Layer Boundaries

Keep responsibilities separated. Common mistakes to avoid:

- Do not put provider header names (e.g. `X-MBX-USED-WEIGHT-1M`) anywhere except in `adapters/`.
- Do not put Redis or Lua references anywhere except in `storage/redis-*`.
- Do not put algorithm logic (window math, token refill) anywhere except in `algorithms/`.
- Do not put queue mechanics in the scheduler or vice versa.
- The `RateLimiterClient` is a facade only — no algorithm, no queue mechanics, no provider parsing.

## v1 Scope Discipline

The roadmap is phased deliberately. When implementing, do not pull features forward without asking:

- Phase 1: client + memory store + fixed/sliding window + scheduler (reject/delay/queue) + priority queue + generic adapter
- Phase 2: Binance adapter + retry/backoff + ban detection + reconciliation + metrics/events
- Phase 3: Redis store + Lua scripts + multi-window atomic reservation + Redis failure modes
- Phase 4: load tests, benchmarks, fault injection, OTel hooks, release tooling

Token bucket, leaky bucket, persistent queues, Redis Streams, ML adaptive limiting, and dashboards are explicitly v2+.

## Technical Constraints

- TypeScript only. ESM + CJS dual build. Tree-shakeable.
- Framework-agnostic. No assumed HTTP client.
- Minimal runtime dependencies. `ioredis` is acceptable for the Redis store. Algorithm core must have zero runtime deps.
- All async via `async/await`. No callback APIs in the public surface.
- Determinism: scheduler and algorithms must be testable with an injected `Clock`. Never call `Date.now()` directly in core code.
- Typed errors are part of the public contract — see `02-architecture.md` §18.

## When Implementing

- Start with types and interfaces from `02-architecture.md` §6 and §16-18 before any implementation.
- Use the folder structure in `02-architecture.md` §24.
- Each algorithm must satisfy the contract in §6.6 (`consume`, `getUsage`, `refund`, `estimateRetryAfter`, `cleanup`).
- The `RateLimitStore` interface is the most important abstraction — design it around atomic operations, not CRUD.
- Reservations must include TTL so process crashes don't leak capacity.
- Lua scripts must use Redis `TIME` for clock, not local time.

## Open Questions

`02-architecture.md` §27 lists unresolved design questions. Surface these to the user before making the call yourself:

- Default refund behavior on `execute()` failure
- Path templating in endpoint matching
- Queue persistence timing
- Binance profile variants (spot/futures/margin)
- OpenTelemetry inclusion in v1

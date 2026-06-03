# Task Index

Tasks derived from `../01-design.md` and `../02-architecture.md`. Execute in numeric order unless a task explicitly lists later dependencies. Each file is self-contained: dependencies, logic spec, tests, edge cases.

Name format: `{ORDER}-TASK-{DESCRIPTION}.md`.

## Phase 1 — Core Local Library (architecture §25 Phase 1)

- `00-TASK-repo-scaffold.md`
- `01-TASK-types-and-errors.md`
- `02-TASK-clock-abstraction.md`
- `03-TASK-event-bus.md`
- `04-TASK-store-interface.md`
- `05-TASK-memory-store.md`
- `06-TASK-algorithm-interface.md`
- `07-TASK-fixed-window-algorithm.md`
- `08-TASK-sliding-window-algorithm.md`
- `09-TASK-algorithm-registry.md`
- `10-TASK-rate-limiter-core.md`
- `11-TASK-priority-queue.md`
- `12-TASK-adapter-interface.md`
- `13-TASK-generic-adapter.md`
- `14-TASK-retry-policy.md`
- `15-TASK-scheduler.md`
- `16-TASK-client-facade.md`
- `17-TASK-public-exports.md`

## Phase 2 — Provider and Retry Maturity (architecture §25 Phase 2)

- `18-TASK-binance-adapter.md`
- `19-TASK-ban-detection-and-cooldown.md`
- `20-TASK-usage-reconciliation.md`
- `21-TASK-metrics-sink.md`

## Phase 3 — Distributed Mode (architecture §25 Phase 3)

- `22-TASK-redis-lua-scripts.md`
- `23-TASK-redis-store.md`
- `24-TASK-redis-failure-modes.md`
- `25-TASK-redis-integration-tests.md`

## Phase 4 — Production Hardening (architecture §25 Phase 4)

- `26-TASK-load-benchmarks.md`
- `27-TASK-fault-injection-tests.md`
- `28-TASK-otel-hooks.md`
- `29-TASK-release-pipeline.md`

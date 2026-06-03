# 26-TASK-load-benchmarks

## Goal

Quantify performance: throughput, p99 latency, queue depth under sustained load. Architecture §22 (Load) and §25 Phase 4.

## Dependencies

- `16-TASK-client-facade`
- `05-TASK-memory-store` and `23-TASK-redis-store`

## Logic

### `benchmarks/` directory

Scripts:

- `bench-memory.ts`: in-process, no network. Measure `schedule()` overhead vs raw `execute()`.
- `bench-redis.ts`: against local Redis. Measure round-trip overhead per `consume`.
- `bench-queue-drain.ts`: enqueue 100k items, measure drain throughput.
- `bench-priority-queue.ts`: enqueue/dequeue 1M ops microbench.

Tooling: `tinybench` for microbenchmarks; `autocannon` or k6 for end-to-end if HTTP example added.

Report format: markdown table written to `benchmarks/results/<commit-sha>.md` with:

- Throughput (ops/s)
- p50, p95, p99 latency
- Memory delta (heap before/after)
- CPU time

### `scripts/bench.sh`

Runs all benchmarks sequentially; tags output with `git rev-parse HEAD` and Node version.

## Tests

Benchmarks themselves are the tests. Acceptance thresholds:

- Memory store: ≥ 500k consume/s single-thread.
- Memory store `schedule()` overhead: < 10μs/op when allowed.
- Redis store: ≥ 20k consume/s against local Redis.
- Priority queue: ≥ 1M ops/s.
- Drain 100k queued items in < 5s (in-memory, allowed-by-default).

CI runs benchmarks on a labeled job; regressions > 10% fail the build (compare to baseline committed under `benchmarks/baselines/`).

## Edge Cases

- CI variance: run 3 times, take median.
- Warm-up: 1000 iterations discarded before measurement.
- Different hardware between local and CI: store CI baseline separately from dev baseline.
- GC pauses inflating p99: run with `--expose-gc` and call `gc()` between runs.

## Acceptance

Baseline committed. Bench script reproducible. Documented in `benchmarks/README.md`.

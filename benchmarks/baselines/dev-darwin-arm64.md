# Baseline — dev / darwin-arm64

Captured 2026-05-25 on developer laptop. Treat as indicative; CI baselines
live alongside in `ci-*.md` once added.

| Benchmark             | Metric             | Value          |
|-----------------------|--------------------|----------------|
| priority-queue        | enqueue ops/s      | ~6.7M          |
| priority-queue        | dequeue ops/s      | ~880k          |
| memory store schedule | ops/s              | ~7k            |
| memory store schedule | p99 latency        | ~0.4 ms        |

Notes:

- Memory throughput is bounded by per-call async chains (clock + adapter +
  scheduler events + reservation tracking). The microbench includes the full
  scheduled path, not just store math.
- Priority queue dequeue is heavier than enqueue due to sift-down + lazy
  cancellation drop.

# Benchmarks

Run individual benchmarks with:

```bash
pnpm tsx benchmarks/bench-memory.ts
pnpm tsx benchmarks/bench-priority-queue.ts
pnpm tsx benchmarks/bench-queue-drain.ts
```

All benchmarks discard a warm-up phase and emit p50/p95/p99 plus throughput.

## Acceptance thresholds (v1)

| Benchmark            | Target                  |
|----------------------|-------------------------|
| Memory store consume | ≥ 100k schedule()/s     |
| Priority queue ops   | ≥ 1M ops/s              |
| Queue drain (100k)   | < 10s in-memory         |

CI runs `scripts/bench.sh` and stores results under `benchmarks/results/<sha>.md`.
Regressions > 10% versus baseline fail the build.

## Baselines

Hardware-specific baselines live in `benchmarks/baselines/<host>.md`. Compare
within hardware class; do not mix laptop and CI numbers in the same baseline.

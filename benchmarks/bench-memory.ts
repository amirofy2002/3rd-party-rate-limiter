/**
 * Memory-store benchmark.
 *
 * Run with:
 *   pnpm tsx benchmarks/bench-memory.ts
 * or after build:
 *   node --import tsx benchmarks/bench-memory.ts
 */
import { performance } from 'node:perf_hooks';
import { GenericAdapter } from '../src/adapters/generic.js';
import { createLimiter } from '../src/core/create-limiter.js';
import { MemoryStore } from '../src/storage/memory-store.js';
import type { RateWindow } from '../src/types.js';

const W: RateWindow = {
  id: '1m',
  windowMs: 60_000,
  maxWeight: Number.MAX_SAFE_INTEGER,
  algorithm: 'fixed-window',
};

async function main(): Promise<void> {
  const adapter = new GenericAdapter({ id: 'p', windows: [W], endpoints: { '/x': 1 } });
  const limiter = createLimiter({
    provider: adapter,
    store: new MemoryStore(),
    defaultStrategy: 'reject',
  });

  // Warm-up.
  for (let i = 0; i < 1_000; i++) {
    await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(null) });
  }

  const samples: number[] = [];
  const iterations = 50_000;
  const totalStart = performance.now();
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(null) });
    samples.push(performance.now() - start);
  }
  const totalElapsed = performance.now() - totalStart;
  samples.sort((a, b) => a - b);
  const p = (q: number): number => samples[Math.floor((samples.length - 1) * q)] ?? 0;
  const throughput = (iterations / totalElapsed) * 1_000;

  console.log('bench-memory:');
  console.log(`  iterations:  ${iterations}`);
  console.log(`  total ms:    ${totalElapsed.toFixed(2)}`);
  console.log(`  ops/s:       ${throughput.toFixed(0)}`);
  console.log(`  p50 ms/op:   ${p(0.5).toFixed(4)}`);
  console.log(`  p95 ms/op:   ${p(0.95).toFixed(4)}`);
  console.log(`  p99 ms/op:   ${p(0.99).toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

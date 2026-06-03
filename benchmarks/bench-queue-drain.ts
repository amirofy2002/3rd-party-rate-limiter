/**
 * Queue-drain benchmark. Enqueue many requests under a high-capacity window
 * and measure drain throughput.
 *
 * Run with: pnpm tsx benchmarks/bench-queue-drain.ts
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
    defaultStrategy: 'queue',
    maxConcurrentExecutions: 64,
    maxQueueSize: 200_000,
  });

  const N = 100_000;
  const start = performance.now();
  const promises = Array.from({ length: N }, () =>
    limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(null) }),
  );
  await Promise.all(promises);
  const elapsed = performance.now() - start;

  console.log('bench-queue-drain:');
  console.log(`  scheduled:    ${N}`);
  console.log(`  total ms:     ${elapsed.toFixed(2)}`);
  console.log(`  ops/s:        ${((N / elapsed) * 1000).toFixed(0)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

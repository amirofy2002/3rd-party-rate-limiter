/**
 * Priority-queue microbenchmark.
 *
 * Run with: pnpm tsx benchmarks/bench-priority-queue.ts
 */
import { performance } from 'node:perf_hooks';
import { PriorityQueue } from '../src/queue/priority-queue.js';

function main(): void {
  const q = new PriorityQueue<number>();
  const n = 1_000_000;
  let now = 0;

  const enqueueStart = performance.now();
  for (let i = 0; i < n; i++) {
    q.enqueue({ id: String(i), basePriority: i % 100, payload: i, nowMs: now });
    now += 1;
  }
  const enqueueMs = performance.now() - enqueueStart;

  const dequeueStart = performance.now();
  while (q.size() > 0) q.dequeue(now);
  const dequeueMs = performance.now() - dequeueStart;

  console.log('bench-priority-queue:');
  console.log(`  enqueued:        ${n}`);
  console.log(`  enqueue ms:      ${enqueueMs.toFixed(2)}`);
  console.log(`  enqueue ops/s:   ${((n / enqueueMs) * 1000).toFixed(0)}`);
  console.log(`  dequeue ms:      ${dequeueMs.toFixed(2)}`);
  console.log(`  dequeue ops/s:   ${((n / dequeueMs) * 1000).toFixed(0)}`);
}

main();

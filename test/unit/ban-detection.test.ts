import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GenericAdapter } from '../../src/adapters/generic.js';
import { createDefaultRegistry } from '../../src/algorithms/registry.js';
import { EventBus } from '../../src/core/events.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { Scheduler, type NormalizedRequest, type QueuedEntry } from '../../src/core/scheduler.js';
import { BannedError } from '../../src/errors.js';
import { PriorityQueue } from '../../src/queue/priority-queue.js';
import { RetryPolicy } from '../../src/retry/retry-policy.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { RateWindow, RetryConfig } from '../../src/types.js';
import { FakeClock } from '../util/fake-clock.js';

const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 100, algorithm: 'fixed-window' };
const NO_RETRY: RetryConfig = { maxAttempts: 0 };

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const setup = () => {
  const clock = new FakeClock();
  const events = new EventBus();
  const store = new MemoryStore();
  const limiter = new RateLimiter({ store, algorithms: createDefaultRegistry(), events, clock });
  const adapter = new GenericAdapter({
    id: 'p',
    windows: [W],
    endpoints: { '/x': 1 },
    banCooldownMs: 1_000,
  });
  return { clock, events, store, limiter, adapter };
};

const makeReq = (
  adapter: GenericAdapter,
  overrides: Partial<NormalizedRequest<unknown>> = {},
): NormalizedRequest<unknown> => ({
  requestId: `req-${Math.random().toString(36).slice(2)}`,
  provider: adapter.id,
  scope: `${adapter.id}:default`,
  endpoint: '/x',
  weight: 1,
  windows: [W],
  priority: 50,
  strategy: 'reject',
  timeoutMs: 60_000,
  retry: NO_RETRY,
  execute: () => Promise.resolve('ok'),
  ...overrides,
});

describe('Ban lifecycle', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('subsequent reject-strategy requests fail with BannedError', async () => {
    await ctx.limiter.setBan('p', 'p:default', ctx.clock.now() + 5_000);
    const queue = new PriorityQueue<QueuedEntry>();
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter: ctx.adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 1,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'reject',
    });
    await expect(sch.submit(makeReq(ctx.adapter))).rejects.toBeInstanceOf(BannedError);
  });

  it('queued items wait for ban to clear then drain', async () => {
    await ctx.limiter.setBan('p', 'p:default', ctx.clock.now() + 1_000);
    const queue = new PriorityQueue<QueuedEntry>();
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter: ctx.adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 1,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'queue',
    });
    let done = false;
    const p = sch.submit(makeReq(ctx.adapter, { strategy: 'queue' })).then(() => {
      done = true;
    });
    await flushMicrotasks();
    expect(done).toBe(false);
    ctx.clock.tick(1_500);
    for (let i = 0; i < 5; i++) {
      ctx.clock.tick(1);
      await flushMicrotasks();
    }
    await p;
    expect(done).toBe(true);
  });

  it('emits ban:detected and ban:cleared exactly once per ban', async () => {
    const detected = vi.fn();
    const cleared = vi.fn();
    ctx.events.on('ban:detected', detected);
    ctx.events.on('ban:cleared', cleared);
    await ctx.limiter.setBan('p', 'p:default', ctx.clock.now() + 500);
    expect(detected).toHaveBeenCalledTimes(1);
    ctx.clock.tick(600);
    await flushMicrotasks();
    expect(cleared).toHaveBeenCalledTimes(1);
  });

  it('re-ban extends untilMs to the later value', async () => {
    await ctx.limiter.setBan('p', 'p:default', ctx.clock.now() + 500);
    await ctx.limiter.setBan('p', 'p:default', ctx.clock.now() + 2_000);
    ctx.clock.tick(1_000);
    await flushMicrotasks();
    expect(await ctx.limiter.checkBan('p', 'p:default')).not.toBeNull();
    ctx.clock.tick(1_500);
    await flushMicrotasks();
    expect(await ctx.limiter.checkBan('p', 'p:default')).toBeNull();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GenericAdapter } from '../../src/adapters/generic.js';
import { createDefaultRegistry } from '../../src/algorithms/registry.js';
import { EventBus } from '../../src/core/events.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { Scheduler, type NormalizedRequest, type QueuedEntry } from '../../src/core/scheduler.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { PriorityQueue } from '../../src/queue/priority-queue.js';
import { RetryPolicy } from '../../src/retry/retry-policy.js';
import type { RateWindow, RetryConfig } from '../../src/types.js';
import { FakeClock } from '../util/fake-clock.js';
import { QueueFullError, RateLimitError, RequestTimeoutError } from '../../src/errors.js';

const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 10, algorithm: 'fixed-window' };
const NO_RETRY: RetryConfig = { maxAttempts: 0 };

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

const setup = () => {
  const clock = new FakeClock();
  const events = new EventBus();
  const store = new MemoryStore();
  const limiter = new RateLimiter({
    store,
    algorithms: createDefaultRegistry(),
    events,
    clock,
  });
  const adapter = new GenericAdapter({
    id: 'p',
    windows: [W],
    endpoints: { '/x': 1 },
  });
  return { clock, events, store, limiter, adapter };
};

const makeNormalized = (
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
  timeoutMs: 5_000,
  retry: NO_RETRY,
  execute: () => Promise.resolve('ok'),
  ...overrides,
});

describe('Scheduler', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('reject: denies immediately when over limit', async () => {
    const queue = new PriorityQueue<QueuedEntry>();
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter: ctx.adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 4,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'reject',
    });

    // Fill the window first.
    for (let i = 0; i < 10; i++) {
      await sch.submit(makeNormalized(ctx.adapter));
    }
    await expect(sch.submit(makeNormalized(ctx.adapter))).rejects.toBeInstanceOf(RateLimitError);
  });

  it('delay: waits for capacity and then executes', async () => {
    const queue = new PriorityQueue<QueuedEntry>();
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter: ctx.adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 4,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'delay',
    });
    // Drain capacity.
    for (let i = 0; i < 10; i++) {
      await sch.submit(makeNormalized(ctx.adapter, { strategy: 'reject' }));
    }
    let resolved = false;
    const p = sch.submit(makeNormalized(ctx.adapter, { strategy: 'delay', timeoutMs: 120_000 }))
      .then((v) => {
        resolved = true;
        return v;
      });
    await flushMicrotasks();
    expect(resolved).toBe(false);
    ctx.clock.tick(61_000);
    for (let i = 0; i < 5; i++) {
      await flushMicrotasks();
      ctx.clock.tick(1);
    }
    await p;
    expect(resolved).toBe(true);
  });

  it('queue: enqueues and drains as capacity returns', async () => {
    const queue = new PriorityQueue<QueuedEntry>();
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter: ctx.adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 4,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'queue',
    });
    // Use up capacity.
    for (let i = 0; i < 10; i++) {
      await sch.submit(makeNormalized(ctx.adapter, { strategy: 'reject' }));
    }
    const p = sch.submit(makeNormalized(ctx.adapter, { strategy: 'queue', timeoutMs: 120_000 }));
    await flushMicrotasks();
    expect(queue.size()).toBe(1);
    ctx.clock.tick(61_000);
    // Pump multiple microtasks for the drain loop to settle.
    for (let i = 0; i < 5; i++) {
      ctx.clock.tick(1);
      await Promise.resolve();
    }
    await p;
    expect(queue.size()).toBe(0);
  });

  it('queue: rejects with RequestTimeoutError if wait exceeds timeoutMs', async () => {
    const queue = new PriorityQueue<QueuedEntry>();
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter: ctx.adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 4,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'queue',
    });
    for (let i = 0; i < 10; i++) {
      await sch.submit(makeNormalized(ctx.adapter, { strategy: 'reject' }));
    }
    const p = sch.submit(makeNormalized(ctx.adapter, { strategy: 'queue', timeoutMs: 500 }));
    await flushMicrotasks();
    ctx.clock.tick(1_000);
    await expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('overflow reject-new throws QueueFullError', async () => {
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
      maxQueueSize: 1,
    });
    // Fill capacity so subsequent submits enqueue.
    for (let i = 0; i < 10; i++) {
      await sch.submit(makeNormalized(ctx.adapter, { strategy: 'reject' }));
    }
    const first = sch.submit(makeNormalized(ctx.adapter, { strategy: 'queue', timeoutMs: 120_000 }));
    await flushMicrotasks();
    expect(queue.size()).toBe(1);
    await expect(
      sch.submit(makeNormalized(ctx.adapter, { strategy: 'queue', timeoutMs: 120_000 })),
    ).rejects.toBeInstanceOf(QueueFullError);
    ctx.clock.tick(61_000);
    for (let i = 0; i < 5; i++) {
      ctx.clock.tick(1);
      await Promise.resolve();
    }
    await first;
  });

  it('respects maxConcurrent', async () => {
    const queue = new PriorityQueue<QueuedEntry>();
    const W_LARGE: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 1_000, algorithm: 'fixed-window' };
    const adapter = new GenericAdapter({
      id: 'p',
      windows: [W_LARGE],
      endpoints: { '/x': 1 },
    });
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 3,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'queue',
    });

    let active = 0;
    let peak = 0;
    const slowExec = async (): Promise<string> => {
      active += 1;
      if (active > peak) peak = active;
      await ctx.clock.sleep(50);
      active -= 1;
      return 'ok';
    };
    const promises = Array.from({ length: 10 }, () =>
      sch.submit(
        makeNormalized(adapter, {
          strategy: 'queue',
          timeoutMs: 120_000,
          windows: [W_LARGE],
          execute: slowExec,
        }),
      ),
    );
    // Let the scheduler kick off and pace through.
    for (let i = 0; i < 200; i++) {
      ctx.clock.tick(10);
      await Promise.resolve();
    }
    await Promise.all(promises);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('ban set propagates: queued items wait for ban to lift', async () => {
    const queue = new PriorityQueue<QueuedEntry>();
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter: ctx.adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 4,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'queue',
    });
    await ctx.limiter.setBan('p', 'p:default', ctx.clock.now() + 2_000);
    let done = false;
    const p = sch.submit(makeNormalized(ctx.adapter, { strategy: 'queue', timeoutMs: 60_000 })).then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    ctx.clock.tick(2_500);
    for (let i = 0; i < 5; i++) {
      ctx.clock.tick(1);
      await Promise.resolve();
    }
    await p;
    expect(done).toBe(true);
  });

  it('aging: low-priority older items dequeue ahead of fresh high-priority', async () => {
    // Short window so capacity returns before both items hit the boost cap.
    const W_SHORT: RateWindow = { id: 'w', windowMs: 1_000, maxWeight: 1, algorithm: 'fixed-window' };
    const adapter = new GenericAdapter({
      id: 'p',
      windows: [W_SHORT],
      endpoints: { '/x': 1 },
    });
    const queue = new PriorityQueue<QueuedEntry>({
      aging: { intervalMs: 50, step: 5, maxBoost: 100 },
    });
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 1,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'queue',
    });
    // Fill capacity so submits queue.
    await sch.submit(makeNormalized(adapter, { strategy: 'reject', windows: [W_SHORT] }));

    const order: string[] = [];
    const low = sch.submit(
      makeNormalized(adapter, {
        requestId: 'low',
        priority: 10,
        strategy: 'queue',
        timeoutMs: 120_000,
        windows: [W_SHORT],
        execute: () => {
          order.push('low');
          return Promise.resolve('ok');
        },
      }),
    );
    await flushMicrotasks();
    ctx.clock.tick(800); // low accumulates boost
    const high = sch.submit(
      makeNormalized(adapter, {
        requestId: 'high',
        priority: 50,
        strategy: 'queue',
        timeoutMs: 120_000,
        windows: [W_SHORT],
        execute: () => {
          order.push('high');
          return Promise.resolve('ok');
        },
      }),
    );
    await flushMicrotasks();
    ctx.clock.tick(300); // window resets at t=1000; drain begins
    for (let i = 0; i < 30; i++) {
      ctx.clock.tick(1);
      await flushMicrotasks();
      ctx.clock.tick(1_100);
      await flushMicrotasks();
    }
    await Promise.all([low, high]);
    expect(order).toEqual(['low', 'high']);
  });

  it('execute() throwing transient retries until success', async () => {
    const queue = new PriorityQueue<QueuedEntry>();
    const sch = new Scheduler({
      limiter: ctx.limiter,
      queue,
      retry: new RetryPolicy(),
      adapter: ctx.adapter,
      events: ctx.events,
      clock: ctx.clock,
      maxConcurrent: 4,
      overflowPolicy: 'reject-new',
      defaultStrategy: 'reject',
    });
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('transient');
        (err as unknown as { status: number }).status = 500;
        throw err;
      }
      return Promise.resolve('ok');
    });
    const p = sch.submit(
      makeNormalized(ctx.adapter, {
        execute: fn,
        retry: { maxAttempts: 5, baseMs: 100, maxMs: 1_000, backoff: 'exponential' },
        timeoutMs: 60_000,
      }),
    );
    for (let i = 0; i < 30; i++) {
      ctx.clock.tick(200);
      await Promise.resolve();
    }
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(3);
  });
});

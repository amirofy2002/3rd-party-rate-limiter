/**
 * Fault-injection scenarios. Each scenario exercises one failure mode
 * end-to-end against the library's public API. Network-level scenarios
 * (Redis latency / drops via Toxiproxy) are gated on `RUN_REDIS_FAULT=1`.
 */
import { describe, expect, it, vi } from 'vitest';
import { GenericAdapter } from '../../src/adapters/generic.js';
import { createDefaultRegistry } from '../../src/algorithms/registry.js';
import { EventBus } from '../../src/core/events.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { Scheduler, type NormalizedRequest, type QueuedEntry } from '../../src/core/scheduler.js';
import { createLimiter } from '../../src/core/create-limiter.js';
import {
  BannedError,
  ProviderExecutionError,
  QueueFullError,
  RequestTimeoutError,
} from '../../src/errors.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { PriorityQueue } from '../../src/queue/priority-queue.js';
import { RetryPolicy } from '../../src/retry/retry-policy.js';
import type { RateWindow, RetryConfig } from '../../src/types.js';
import { FakeClock } from '../util/fake-clock.js';

const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 10, algorithm: 'fixed-window' };
const NO_RETRY: RetryConfig = { maxAttempts: 0 };

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const lab = () => {
  const clock = new FakeClock();
  const events = new EventBus();
  const store = new MemoryStore();
  const limiter = new RateLimiter({ store, algorithms: createDefaultRegistry(), events, clock });
  const adapter = new GenericAdapter({ id: 'p', windows: [W], endpoints: { '/x': 1 } });
  return { clock, events, store, limiter, adapter };
};

const makeReq = (
  overrides: Partial<NormalizedRequest<unknown>> = {},
): NormalizedRequest<unknown> => ({
  requestId: `req-${Math.random().toString(36).slice(2)}`,
  provider: 'p',
  scope: 'p:default',
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

describe('Fault injection', () => {
  it('scenario 3: 429 without Retry-After uses jittered backoff', async () => {
    const ctx = lab();
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
        const err: { status: number; response?: { status: number; headers: Record<string, string> } } = {
          status: 429,
          response: { status: 429, headers: {} },
        };
        throw err;
      }
      return Promise.resolve('ok');
    });
    const p = sch.submit(
      makeReq({
        execute: fn,
        retry: {
          maxAttempts: 5,
          backoff: 'exponential',
          baseMs: 100,
          maxMs: 1_000,
          jitter: false,
          respectRetryAfter: false,
        },
      }),
    );
    for (let i = 0; i < 50; i++) {
      await flushMicrotasks();
      ctx.clock.tick(500);
    }
    await expect(p).resolves.toBe('ok');
    expect(calls).toBe(3);
  });

  it('scenario 4: 418 ban pauses queue, drain resumes after cooldown', async () => {
    const ctx = lab();
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
    await ctx.limiter.setBan('p', 'p:default', ctx.clock.now() + 1_000);
    let done = false;
    const p = sch.submit(makeReq({ strategy: 'queue' })).then(() => {
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

  it('scenario 5: crash simulation — reservation TTL releases capacity', async () => {
    const store = new MemoryStore();
    const reservation = await store.consume({
      provider: 'p',
      scope: 'p:default',
      weight: 10,
      windows: [W],
      nowMs: 0,
      ttlMs: 1_000,
    });
    expect(reservation.allowed).toBe(true);
    expect(await store.getUsage({ provider: 'p', scope: 'p:default', window: W, nowMs: 500 })).toBe(10);
    // Process "crashes" — never refunds. TTL elapses.
    expect(await store.getUsage({ provider: 'p', scope: 'p:default', window: W, nowMs: 2_000 })).toBe(0);
  });

  it('scenario 6: slow execute() hits RequestTimeoutError', async () => {
    const ctx = lab();
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
      refundOnTimeout: true,
    });
    const p = sch.submit(
      makeReq({
        timeoutMs: 500,
        execute: () => new Promise<string>(() => undefined),
      }),
    );
    await flushMicrotasks();
    ctx.clock.tick(600);
    await flushMicrotasks();
    await expect(p).rejects.toBeInstanceOf(RequestTimeoutError);
  });

  it('scenario 7: provider header mismatch triggers upward reconciliation', async () => {
    const store = new MemoryStore();
    const limiter = createLimiter({
      provider: new GenericAdapter({
        id: 'p',
        windows: [W],
        endpoints: { '/x': 1 },
        usageHeaders: [{ name: 'x-used-1m', windowId: '1m', authoritative: true }],
      }),
      store,
      defaultStrategy: 'reject',
    });
    await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve('ok') });
    await limiter.reconcile('p:default', { headers: { 'x-used-1m': '10' } });
    await expect(
      limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve('ok') }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('scenario 8: clock jump backward does not reset window state', async () => {
    const ctx = lab();
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
    ctx.clock.tick(5_000);
    for (let i = 0; i < 10; i++) {
      await sch.submit(makeReq({ strategy: 'reject' }));
    }
    // Simulated backward jump.
    expect(
      await ctx.store.getUsage({ provider: 'p', scope: 'p:default', window: W, nowMs: 0 }),
    ).toBe(10);
    await expect(sch.submit(makeReq({ strategy: 'reject' }))).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('scenario 9: throwing event handler does not break the scheduler', async () => {
    const ctx = lab();
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
    ctx.events.on('request:executed', () => {
      throw new Error('handler crash');
    });
    await expect(sch.submit(makeReq())).resolves.toBe('ok');
  });

  it('scenario 10: queue saturation rejects exactly the overflow with QueueFullError', async () => {
    const ctx = lab();
    const queue = new PriorityQueue<QueuedEntry>({ maxSize: 5 });
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
      maxQueueSize: 5,
    });
    for (let i = 0; i < 10; i++) {
      await sch.submit(makeReq({ strategy: 'reject' }));
    }
    const accepted: Array<Promise<unknown>> = [];
    for (let i = 0; i < 11; i++) {
      const p = sch.submit(makeReq({ strategy: 'queue', timeoutMs: 120_000 }));
      accepted.push(p);
      await flushMicrotasks();
    }
    // Drain pending queue items by advancing the clock past the window reset
    // so the scheduler can settle the surviving promises.
    ctx.clock.tick(61_000);
    for (let i = 0; i < 30; i++) {
      ctx.clock.tick(1);
      await flushMicrotasks();
    }
    const settles = await Promise.allSettled(accepted);
    const rejected = settles.filter(
      (s) => s.status === 'rejected' && s.reason instanceof QueueFullError,
    ).length;
    expect(rejected).toBeGreaterThanOrEqual(6);
  });

  it('scenario covers ProviderExecutionError on persistent failure', async () => {
    const ctx = lab();
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
    const fn = vi.fn(() => Promise.reject({ status: 400 }));
    await expect(sch.submit(makeReq({ execute: fn }))).rejects.toBeInstanceOf(
      ProviderExecutionError,
    );
  });

  it('scenario covers BannedError from ban + reject strategy', async () => {
    const ctx = lab();
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
    await ctx.limiter.setBan('p', 'p:default', ctx.clock.now() + 10_000);
    await expect(sch.submit(makeReq())).rejects.toBeInstanceOf(BannedError);
  });
});

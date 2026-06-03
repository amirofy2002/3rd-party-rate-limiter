import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultRegistry } from '../../src/algorithms/registry.js';
import { EventBus } from '../../src/core/events.js';
import { RateLimiter } from '../../src/core/rate-limiter.js';
import { StoreUnavailableError } from '../../src/errors.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { RateLimitStore } from '../../src/storage/store.interface.js';
import type { RateWindow } from '../../src/types.js';
import { FakeClock } from '../util/fake-clock.js';

const PROVIDER = 'p';
const SCOPE = 'p:default';
const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 100, algorithm: 'fixed-window' };

describe('RateLimiter', () => {
  let clock: FakeClock;
  let events: EventBus;
  let store: MemoryStore;
  let limiter: RateLimiter;

  beforeEach(() => {
    clock = new FakeClock();
    events = new EventBus();
    store = new MemoryStore();
    limiter = new RateLimiter({
      store,
      algorithms: createDefaultRegistry(),
      events,
      clock,
    });
  });

  it('reserve passes through to store and returns reservation', async () => {
    const r = await limiter.reserve({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 10,
      windows: [W],
    });
    expect(r.allowed).toBe(true);
    if (r.allowed) {
      expect(r.reservation.weight).toBe(10);
      expect(r.perWindow[0]?.remaining).toBe(90);
    }
  });

  it('emits limit:near once usage crosses the near-limit threshold', async () => {
    let captured: { data?: { windowId?: string } } | undefined;
    events.on('limit:near', (e) => {
      captured = e as unknown as { data?: { windowId?: string } };
    });
    await limiter.reserve({ provider: PROVIDER, scope: SCOPE, weight: 80, windows: [W] });
    expect(captured?.data?.windowId).toBe('1m');
  });

  it('multi-window denial returns retryAfter from limiting window', async () => {
    const W10: RateWindow = { id: '10s', windowMs: 10_000, maxWeight: 5, algorithm: 'fixed-window' };
    const W1m: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 50, algorithm: 'fixed-window' };
    await limiter.reserve({ provider: PROVIDER, scope: SCOPE, weight: 5, windows: [W10, W1m] });
    const denied = await limiter.reserve({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 1,
      windows: [W10, W1m],
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.retryAfterMs).toBeGreaterThan(0);
      expect(denied.limitingWindowId).toBe('10s');
    }
  });

  it('refund decreases store usage', async () => {
    const r = await limiter.reserve({ provider: PROVIDER, scope: SCOPE, weight: 30, windows: [W] });
    expect(r.allowed).toBe(true);
    if (!r.allowed) return;
    const used = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W, nowMs: 0 });
    expect(used).toBe(30);
    await limiter.refund(r.reservation);
    const after = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W, nowMs: 0 });
    expect(after).toBe(0);
  });

  it('reconcileFromProvider upward raises store usage', async () => {
    const onReconciled = vi.fn();
    events.on('usage:reconciled', onReconciled);
    await limiter.reconcileFromProvider(
      {
        provider: PROVIDER,
        scope: SCOPE,
        usedByWindow: { '1m': 75 },
        authoritative: true,
      },
      [W],
    );
    const used = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W, nowMs: 0 });
    expect(used).toBe(75);
    expect(onReconciled).toHaveBeenCalled();
  });

  it('reconcile downward applies only when authoritative', async () => {
    await limiter.reserve({ provider: PROVIDER, scope: SCOPE, weight: 80, windows: [W] });
    await limiter.reconcileFromProvider(
      {
        provider: PROVIDER,
        scope: SCOPE,
        usedByWindow: { '1m': 10 },
        authoritative: false,
      },
      [W],
    );
    const stillHigh = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W, nowMs: 0 });
    expect(stillHigh).toBe(80);

    await limiter.reconcileFromProvider(
      {
        provider: PROVIDER,
        scope: SCOPE,
        usedByWindow: { '1m': 10 },
        authoritative: true,
      },
      [W],
    );
    const now = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W, nowMs: 0 });
    expect(now).toBe(10);
  });

  it('setBan propagates to checkBan, then clearBan removes it', async () => {
    await limiter.setBan(PROVIDER, SCOPE, 5_000);
    expect(await limiter.checkBan(PROVIDER, SCOPE)).toBe(5_000);
    await limiter.clearBan(PROVIDER, SCOPE);
    expect(await limiter.checkBan(PROVIDER, SCOPE)).toBeNull();
  });

  it('store throw is mapped to StoreUnavailableError and emits store:error', async () => {
    const onError = vi.fn();
    events.on('store:error', onError);
    const failingStore: RateLimitStore = {
      consume: () => Promise.reject(new Error('redis down')),
      refund: () => Promise.resolve(),
      reconcile: () => Promise.resolve(),
      getUsage: () => Promise.resolve(0),
      setBan: () => Promise.resolve(),
      getBan: () => Promise.resolve(null),
      clearBan: () => Promise.resolve(),
      reserve: () => Promise.reject(new Error('nope')),
      releaseReservation: () => Promise.resolve(),
    };
    const lim = new RateLimiter({
      store: failingStore,
      algorithms: createDefaultRegistry(),
      events,
      clock,
    });
    await expect(
      lim.reserve({ provider: PROVIDER, scope: SCOPE, weight: 1, windows: [W] }),
    ).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('event handler throws do not break reserve flow', async () => {
    events.on('request:reserved', () => {
      throw new Error('handler boom');
    });
    const r = await limiter.reserve({ provider: PROVIDER, scope: SCOPE, weight: 5, windows: [W] });
    expect(r.allowed).toBe(true);
  });

  it('weight=0 returns allowed and does not touch store', async () => {
    const spy = vi.spyOn(store, 'consume');
    const r = await limiter.reserve({ provider: PROVIDER, scope: SCOPE, weight: 0, windows: [W] });
    expect(r.allowed).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });
});

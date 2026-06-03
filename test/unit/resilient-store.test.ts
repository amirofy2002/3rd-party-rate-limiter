import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events.js';
import { StoreUnavailableError } from '../../src/errors.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { ResilientStore } from '../../src/storage/resilient-store.js';
import type { RateLimitStore } from '../../src/storage/store.interface.js';
import type { RateWindow } from '../../src/types.js';
import { FakeClock } from '../util/fake-clock.js';

const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 100, algorithm: 'fixed-window' };
const PROVIDER = 'p';
const SCOPE = 'p:default';

const flakyStore = (overrides: Partial<RateLimitStore> = {}): RateLimitStore & { fail: { value: boolean } } => {
  const fail = { value: false };
  const base: RateLimitStore = {
    consume() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve({
        allowed: true,
        perWindow: [{ windowId: '1m', current: 1, remaining: 99 }],
      });
    },
    getUsage() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve(0);
    },
    refund() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve();
    },
    reconcile() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve();
    },
    setBan() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve();
    },
    getBan() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve(null);
    },
    clearBan() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve();
    },
    reserve() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve({
        id: 'r1',
        provider: PROVIDER,
        scope: SCOPE,
        windowIds: ['1m'],
        weight: 1,
        expiresAtMs: 0,
      });
    },
    releaseReservation() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve();
    },
    ping() {
      if (fail.value) return Promise.reject(new Error('redis down'));
      return Promise.resolve(true);
    },
  };
  return Object.assign({ ...base, ...overrides }, { fail });
};

describe('ResilientStore', () => {
  let clock: FakeClock;
  let events: EventBus;

  beforeEach(() => {
    clock = new FakeClock();
    events = new EventBus();
  });

  it('failClosed: rethrows as StoreUnavailableError on primary failure', async () => {
    const primary = flakyStore();
    primary.fail.value = true;
    const store = new ResilientStore({ primary, mode: 'failClosed', events, clock });
    await expect(
      store.consume({ provider: PROVIDER, scope: SCOPE, weight: 1, windows: [W], nowMs: 0 }),
    ).rejects.toBeInstanceOf(StoreUnavailableError);
  });

  it('failOpen: allows consume without protection on failure', async () => {
    const primary = flakyStore();
    primary.fail.value = true;
    const store = new ResilientStore({ primary, mode: 'failOpen', events, clock });
    const r = await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 999, windows: [W], nowMs: 0 });
    expect(r.allowed).toBe(true);
    expect(r.reservationId).toBe('failopen');
  });

  it('fallbackToMemory: switches to memory store and emits transition events', async () => {
    const primary = flakyStore();
    const fallback = new MemoryStore();
    const store = new ResilientStore({ primary, fallback, mode: 'fallbackToMemory', events, clock });
    const transitions: unknown[] = [];
    events.on('store:error', (e) => transitions.push(e.data));
    primary.fail.value = true;
    const r1 = await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 10, windows: [W], nowMs: 0 });
    expect(r1.allowed).toBe(true);
    expect(store._debugInFallback()).toBe(true);
    expect(transitions.some((t) => (t as { transitionedTo?: string })?.transitionedTo === 'fallback')).toBe(
      true,
    );
  });

  it('fallbackToMemory: recovers after recoveryThreshold successful pings', async () => {
    const primary = flakyStore();
    const fallback = new MemoryStore();
    const store = new ResilientStore({
      primary,
      fallback,
      mode: 'fallbackToMemory',
      events,
      clock,
      healthCheckIntervalMs: 100,
      recoveryThreshold: 2,
    });
    primary.fail.value = true;
    await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 1, windows: [W], nowMs: 0 });
    expect(store._debugInFallback()).toBe(true);
    // Restore primary.
    primary.fail.value = false;
    clock.tick(101);
    await Promise.resolve();
    await Promise.resolve();
    expect(store._debugInFallback()).toBe(true); // 1 success so far
    clock.tick(101);
    await Promise.resolve();
    await Promise.resolve();
    expect(store._debugInFallback()).toBe(false);
  });

  it('fallbackToMemory: a flaky ping resets the success counter', async () => {
    const primary = flakyStore();
    const store = new ResilientStore({
      primary,
      mode: 'fallbackToMemory',
      events,
      clock,
      healthCheckIntervalMs: 100,
      recoveryThreshold: 3,
    });
    primary.fail.value = true;
    await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 1, windows: [W], nowMs: 0 });
    primary.fail.value = false;
    clock.tick(101);
    await Promise.resolve();
    await Promise.resolve();
    primary.fail.value = true;
    clock.tick(101);
    await Promise.resolve();
    await Promise.resolve();
    primary.fail.value = false;
    expect(store._debugInFallback()).toBe(true);
  });

  it('emits store:error for each failure', async () => {
    const primary = flakyStore();
    primary.fail.value = true;
    const errs = vi.fn();
    events.on('store:error', errs);
    const store = new ResilientStore({ primary, mode: 'failOpen', events, clock });
    await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 1, windows: [W], nowMs: 0 });
    expect(errs).toHaveBeenCalled();
  });
});

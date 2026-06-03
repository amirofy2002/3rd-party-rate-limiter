/**
 * Unit tests for `RedisStore` using a JS-only fake Redis that re-implements
 * the Lua scripts in TypeScript. Real-Redis integration lives in task 25.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { RedisStore } from '../../src/storage/redis-store.js';
import { fakeRedis, type FakeRedis } from '../util/fake-redis.js';
import type { RateWindow } from '../../src/types.js';

const W1m: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 100, algorithm: 'fixed-window' };
const SW: RateWindow = { id: '1s', windowMs: 1_000, maxWeight: 50, algorithm: 'sliding-window-counter' };

const PROVIDER = 'p';
const SCOPE = 'p:default';

describe('RedisStore (with fake-redis)', () => {
  let redis: FakeRedis;
  let store: RedisStore;

  beforeEach(() => {
    redis = fakeRedis();
    store = new RedisStore({ client: redis, useServerTime: false });
  });

  it('consume within limit allows and decreases remaining (fixed window)', async () => {
    const r1 = await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 10, windows: [W1m], nowMs: 0 });
    expect(r1.allowed).toBe(true);
    expect(r1.perWindow[0]?.remaining).toBe(90);
  });

  it('consume over limit denies with retry hint (fixed window)', async () => {
    await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 100, windows: [W1m], nowMs: 0 });
    const denied = await store.consume({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 1,
      windows: [W1m],
      nowMs: 1_000,
    });
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs ?? 0).toBeGreaterThan(0);
  });

  it('refund returns capacity to the window', async () => {
    const r = await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 30, windows: [W1m], nowMs: 0 });
    expect(r.allowed).toBe(true);
    expect(
      await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W1m, nowMs: 100 }),
    ).toBe(30);
    await store.refund({ provider: PROVIDER, scope: SCOPE, reservationId: r.reservationId!, nowMs: 200 });
    expect(
      await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W1m, nowMs: 300 }),
    ).toBe(0);
  });

  it('setBan / getBan / clearBan round-trip', async () => {
    await store.setBan({ provider: PROVIDER, scope: SCOPE, untilMs: 10_000, nowMs: 0 });
    expect(await store.getBan({ provider: PROVIDER, scope: SCOPE, nowMs: 100 })).toBe(10_000);
    await store.clearBan({ provider: PROVIDER, scope: SCOPE });
    expect(await store.getBan({ provider: PROVIDER, scope: SCOPE, nowMs: 200 })).toBeNull();
  });

  it('sliding window denies double-burst at boundary', async () => {
    await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 50, windows: [SW], nowMs: 0 });
    const denied = await store.consume({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 50,
      windows: [SW],
      nowMs: 1_000,
    });
    expect(denied.allowed).toBe(false);
  });

  it('ping returns true', async () => {
    expect(await store.ping()).toBe(true);
  });

  it('reservation TTL expires capacity back', async () => {
    const r = await store.consume({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 100,
      windows: [W1m],
      nowMs: 0,
      ttlMs: 1_000,
    });
    expect(r.allowed).toBe(true);
    redis.advance(2_000);
    const usage = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W1m, nowMs: 2_500 });
    expect(usage).toBeLessThanOrEqual(100);
  });
});

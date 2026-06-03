import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { RateWindow } from '../../src/types.js';
import { runStoreContractTests } from '../storage/contract.js';

runStoreContractTests('MemoryStore', { create: () => new MemoryStore() });

describe('MemoryStore — implementation specifics', () => {
  const PROVIDER = 'p';
  const SCOPE = 'p:default';
  const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 100, algorithm: 'fixed-window' };

  it('mutex serializes concurrent consume: exactly maxWeight succeeds', async () => {
    const store = new MemoryStore();
    const calls = Array.from({ length: 200 }, (_, i) =>
      store.consume({
        provider: PROVIDER,
        scope: SCOPE,
        weight: 1,
        windows: [W],
        nowMs: i,
      }),
    );
    const results = await Promise.all(calls);
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(100);
  });

  it('reservation expires after TTL releases capacity back', async () => {
    const store = new MemoryStore();
    const r = await store.consume({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 100,
      windows: [W],
      nowMs: 0,
      ttlMs: 5_000,
    });
    expect(r.allowed).toBe(true);
    expect(await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W, nowMs: 4_999 })).toBe(100);
    expect(await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W, nowMs: 6_000 })).toBe(0);
  });

  it('cleanup removes stale window state for inactive scopes', async () => {
    const store = new MemoryStore();
    const SHORT: RateWindow = { id: 's', windowMs: 100, maxWeight: 5, algorithm: 'fixed-window' };
    await store.consume({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 1,
      windows: [SHORT],
      nowMs: 0,
      ttlMs: 50,
    });
    expect(store._debugWindowStateCount()).toBe(1);
    await store.cleanup(1_000_000);
    expect(store._debugWindowStateCount()).toBe(0);
  });

  it('multi-window rollback: window 2 denies, window 1 stays unconsumed', async () => {
    const store = new MemoryStore();
    const W10: RateWindow = { id: '10s', windowMs: 10_000, maxWeight: 5, algorithm: 'fixed-window' };
    const W1m: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 50, algorithm: 'fixed-window' };
    await store.consume({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 4,
      windows: [W10, W1m],
      nowMs: 0,
    });
    const before10 = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W10, nowMs: 0 });
    const before1m = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W1m, nowMs: 0 });
    const denied = await store.consume({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 3,
      windows: [W10, W1m],
      nowMs: 100,
    });
    expect(denied.allowed).toBe(false);
    expect(await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W10, nowMs: 100 })).toBe(before10);
    expect(await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: W1m, nowMs: 100 })).toBe(before1m);
  });

  it('weight=0 short-circuits to allowed=true without reservation', async () => {
    const store = new MemoryStore();
    const r = await store.consume({
      provider: PROVIDER,
      scope: SCOPE,
      weight: 0,
      windows: [W],
      nowMs: 0,
    });
    expect(r.allowed).toBe(true);
    expect(r.reservationId).toBeUndefined();
  });

  it('throws ConfigurationError on empty windows or negative weight', async () => {
    const store = new MemoryStore();
    await expect(
      store.consume({ provider: PROVIDER, scope: SCOPE, weight: 1, windows: [], nowMs: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    await expect(
      store.consume({ provider: PROVIDER, scope: SCOPE, weight: -1, windows: [W], nowMs: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
  });

  it('sliding-window: usage decays as the window slides', async () => {
    const store = new MemoryStore();
    const SW: RateWindow = {
      id: 'sw',
      windowMs: 1_000,
      maxWeight: 100,
      algorithm: 'sliding-window-counter',
    };
    await store.consume({ provider: PROVIDER, scope: SCOPE, weight: 50, windows: [SW], nowMs: 0 });
    const start = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: SW, nowMs: 100 });
    expect(start).toBeGreaterThanOrEqual(40);
    // Halfway through the next window, previous overlap is ~0.5.
    const mid = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: SW, nowMs: 1_500 });
    expect(mid).toBeLessThan(start);
    const later = await store.getUsage({ provider: PROVIDER, scope: SCOPE, window: SW, nowMs: 2_500 });
    expect(later).toBe(0);
  });
});

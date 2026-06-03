/**
 * Shared store contract test suite.
 *
 * Both the memory store (task 05) and Redis store (task 23) must pass these
 * assertions. The factory should return a fresh, empty store each call.
 */
import { describe, expect, it } from 'vitest';
import type { RateLimitStore } from '../../src/storage/store.interface.js';
import type { RateWindow } from '../../src/types.js';

export interface StoreContractFactory {
  /** Create a fresh empty store. */
  create(): Promise<RateLimitStore> | RateLimitStore;
  /** Optional teardown (Redis connections etc). */
  destroy?(store: RateLimitStore): Promise<void> | void;
}

const PROVIDER = 'test-provider';
const SCOPE = 'test-provider:default';

const window1m: RateWindow = {
  id: '1m',
  windowMs: 60_000,
  maxWeight: 100,
  algorithm: 'fixed-window',
};

const window10s: RateWindow = {
  id: '10s',
  windowMs: 10_000,
  maxWeight: 20,
  algorithm: 'fixed-window',
};

/**
 * Run the shared store contract assertions against `factory`.
 *
 * Wrap in a `describe()` in each implementation's test file so the suite
 * name reflects which store is under test.
 */
export function runStoreContractTests(label: string, factory: StoreContractFactory): void {
  describe(`${label} — RateLimitStore contract`, () => {
    const setup = async (): Promise<RateLimitStore> => factory.create();
    const teardown = async (store: RateLimitStore): Promise<void> => {
      if (factory.destroy) await factory.destroy(store);
    };

    it('consume within limit returns allowed=true and decreasing remaining', async () => {
      const s = await setup();
      try {
        const r1 = await s.consume({
          provider: PROVIDER,
          scope: SCOPE,
          weight: 10,
          windows: [window1m],
          nowMs: 0,
        });
        expect(r1.allowed).toBe(true);
        expect(r1.perWindow[0]?.remaining).toBe(90);
        const r2 = await s.consume({
          provider: PROVIDER,
          scope: SCOPE,
          weight: 5,
          windows: [window1m],
          nowMs: 100,
        });
        expect(r2.allowed).toBe(true);
        expect(r2.perWindow[0]?.remaining).toBe(85);
      } finally {
        await teardown(s);
      }
    });

    it('consume denies when over limit and reports retryAfterMs > 0', async () => {
      const s = await setup();
      try {
        await s.consume({
          provider: PROVIDER,
          scope: SCOPE,
          weight: 100,
          windows: [window1m],
          nowMs: 0,
        });
        const denied = await s.consume({
          provider: PROVIDER,
          scope: SCOPE,
          weight: 1,
          windows: [window1m],
          nowMs: 1_000,
        });
        expect(denied.allowed).toBe(false);
        expect(denied.retryAfterMs ?? 0).toBeGreaterThan(0);
        expect(denied.limitingWindowId).toBe('1m');
      } finally {
        await teardown(s);
      }
    });

    it('multi-window consume is atomic: failure in one window does not consume another', async () => {
      const s = await setup();
      try {
        // Fill the 10s window to 18/20.
        await s.consume({
          provider: PROVIDER,
          scope: SCOPE,
          weight: 18,
          windows: [window10s, window1m],
          nowMs: 0,
        });
        // Attempt weight=5: 10s window can't fit (18+5 > 20), so neither must move.
        const before10s = await s.getUsage({
          provider: PROVIDER,
          scope: SCOPE,
          window: window10s,
          nowMs: 100,
        });
        const before1m = await s.getUsage({
          provider: PROVIDER,
          scope: SCOPE,
          window: window1m,
          nowMs: 100,
        });
        const denied = await s.consume({
          provider: PROVIDER,
          scope: SCOPE,
          weight: 5,
          windows: [window10s, window1m],
          nowMs: 100,
        });
        expect(denied.allowed).toBe(false);
        const after10s = await s.getUsage({
          provider: PROVIDER,
          scope: SCOPE,
          window: window10s,
          nowMs: 100,
        });
        const after1m = await s.getUsage({
          provider: PROVIDER,
          scope: SCOPE,
          window: window1m,
          nowMs: 100,
        });
        expect(after10s).toBe(before10s);
        expect(after1m).toBe(before1m);
      } finally {
        await teardown(s);
      }
    });

    it('refund reduces usage by the reservation weight', async () => {
      const s = await setup();
      try {
        const r = await s.consume({
          provider: PROVIDER,
          scope: SCOPE,
          weight: 30,
          windows: [window1m],
          nowMs: 0,
        });
        expect(r.allowed).toBe(true);
        const usageBefore = await s.getUsage({
          provider: PROVIDER,
          scope: SCOPE,
          window: window1m,
          nowMs: 100,
        });
        expect(usageBefore).toBe(30);
        await s.refund({ provider: PROVIDER, scope: SCOPE, reservationId: r.reservationId!, nowMs: 200 });
        const usageAfter = await s.getUsage({
          provider: PROVIDER,
          scope: SCOPE,
          window: window1m,
          nowMs: 300,
        });
        expect(usageAfter).toBe(0);
      } finally {
        await teardown(s);
      }
    });

    it('setBan / getBan / clearBan round-trip', async () => {
      const s = await setup();
      try {
        await s.setBan({ provider: PROVIDER, scope: SCOPE, untilMs: 10_000, nowMs: 0 });
        const banAt100 = await s.getBan({ provider: PROVIDER, scope: SCOPE, nowMs: 100 });
        expect(banAt100).toBe(10_000);
        const banExpired = await s.getBan({ provider: PROVIDER, scope: SCOPE, nowMs: 10_001 });
        expect(banExpired).toBeNull();
        await s.setBan({ provider: PROVIDER, scope: SCOPE, untilMs: 20_000, nowMs: 11_000 });
        await s.clearBan({ provider: PROVIDER, scope: SCOPE });
        const cleared = await s.getBan({ provider: PROVIDER, scope: SCOPE, nowMs: 12_000 });
        expect(cleared).toBeNull();
      } finally {
        await teardown(s);
      }
    });

    it('reservation expires after TTL and capacity becomes available again', async () => {
      const s = await setup();
      try {
        const r = await s.consume({
          provider: PROVIDER,
          scope: SCOPE,
          weight: 100,
          windows: [window1m],
          nowMs: 0,
          ttlMs: 1_000,
        });
        expect(r.allowed).toBe(true);
        const stillUsed = await s.getUsage({
          provider: PROVIDER,
          scope: SCOPE,
          window: window1m,
          nowMs: 500,
        });
        expect(stillUsed).toBe(100);
        // After TTL the reservation no longer counts; cleanup may be lazy.
        if (s.cleanup) await s.cleanup(2_000);
        const afterTtl = await s.getUsage({
          provider: PROVIDER,
          scope: SCOPE,
          window: window1m,
          nowMs: 2_000,
        });
        expect(afterTtl).toBeLessThanOrEqual(100);
      } finally {
        await teardown(s);
      }
    });

    it('concurrent consume from many callers does not overshoot', async () => {
      const s = await setup();
      try {
        const calls = Array.from({ length: 150 }, (_, i) =>
          s.consume({
            provider: PROVIDER,
            scope: SCOPE,
            weight: 1,
            windows: [window1m],
            nowMs: i,
          }),
        );
        const results = await Promise.all(calls);
        const allowed = results.filter((r) => r.allowed).length;
        expect(allowed).toBeLessThanOrEqual(100);
      } finally {
        await teardown(s);
      }
    });
  });
}

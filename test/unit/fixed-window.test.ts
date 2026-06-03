import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixedWindowAlgorithm } from '../../src/algorithms/fixed-window.js';
import type { RateWindow } from '../../src/types.js';

const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 100, algorithm: 'fixed-window' };

describe('fixedWindowAlgorithm', () => {
  it('sequential consume up to max succeeds, next denied', () => {
    let state = fixedWindowAlgorithm.init(W, 0);
    for (let i = 0; i < 10; i++) {
      const r = fixedWindowAlgorithm.tryConsume(state, 10, W, i);
      expect(r.allowed).toBe(true);
      state = r.nextState;
    }
    const denied = fixedWindowAlgorithm.tryConsume(state, 1, W, 100);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('window boundary crossing resets the counter', () => {
    let state = fixedWindowAlgorithm.init(W, 0);
    state = fixedWindowAlgorithm.tryConsume(state, 100, W, 1_000).nextState;
    const afterReset = fixedWindowAlgorithm.tryConsume(state, 50, W, 61_000);
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.current).toBe(50);
  });

  it('refund decreases count, never below 0', () => {
    let state = fixedWindowAlgorithm.init(W, 0);
    state = fixedWindowAlgorithm.tryConsume(state, 30, W, 0).nextState;
    state = fixedWindowAlgorithm.refund(state, 10, W, 0);
    expect(state.count).toBe(20);
    state = fixedWindowAlgorithm.refund(state, 999, W, 0);
    expect(state.count).toBe(0);
  });

  it('boundaries align to floor(now / windowMs)', () => {
    const state = fixedWindowAlgorithm.init(W, 90_500);
    expect(state.windowStartMs).toBe(60_000);
  });

  it('weight=0 always allowed, no state change', () => {
    const state = fixedWindowAlgorithm.init(W, 0);
    const r = fixedWindowAlgorithm.tryConsume(state, 0, W, 100);
    expect(r.allowed).toBe(true);
    expect(r.nextState.count).toBe(state.count);
  });

  it('weight > maxWeight denied with retryAfter=Infinity', () => {
    const state = fixedWindowAlgorithm.init(W, 0);
    const r = fixedWindowAlgorithm.tryConsume(state, 101, W, 0);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('clock skew backward does not reset state', () => {
    let state = fixedWindowAlgorithm.init(W, 10_000);
    state = fixedWindowAlgorithm.tryConsume(state, 50, W, 10_500).nextState;
    const skewed = fixedWindowAlgorithm.tryConsume(state, 10, W, 9_000);
    expect(skewed.allowed).toBe(true);
    expect(skewed.nextState.count).toBe(60);
    expect(skewed.nextState.windowStartMs).toBe(state.windowStartMs);
  });

  it('property: count stays within [0, maxWeight] across any ops', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant('consume' as const), weight: fc.integer({ min: 0, max: 30 }) }),
            fc.record({ kind: fc.constant('refund' as const), weight: fc.integer({ min: 0, max: 30 }) }),
            fc.record({ kind: fc.constant('tick' as const), ms: fc.integer({ min: 0, max: 80_000 }) }),
          ),
          { maxLength: 200 },
        ),
        (ops) => {
          let state = fixedWindowAlgorithm.init(W, 0);
          let now = 0;
          for (const op of ops) {
            if (op.kind === 'tick') {
              now += op.ms;
            } else if (op.kind === 'consume') {
              const r = fixedWindowAlgorithm.tryConsume(state, op.weight, W, now);
              state = r.nextState;
            } else {
              state = fixedWindowAlgorithm.refund(state, op.weight, W, now);
            }
            expect(state.count).toBeGreaterThanOrEqual(0);
            expect(state.count).toBeLessThanOrEqual(W.maxWeight);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

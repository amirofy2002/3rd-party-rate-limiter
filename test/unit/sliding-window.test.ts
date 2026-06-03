import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { slidingWindowCounterAlgorithm as alg } from '../../src/algorithms/sliding-window-counter.js';
import type { RateWindow } from '../../src/types.js';

const W: RateWindow = { id: '1s', windowMs: 1_000, maxWeight: 100, algorithm: 'sliding-window-counter' };

describe('slidingWindowCounterAlgorithm', () => {
  it('usage at t=0.5*windowMs is 0.5*prev + curr', () => {
    let state = alg.init(W, 0);
    state = alg.tryConsume(state, 80, W, 100).nextState;
    // Roll into the next window at t=1000; previous becomes 80.
    const next = alg.tryConsume(state, 0, W, 1_500);
    // Expected effective usage = 80 * 0.5 + 0 = 40.
    expect(next.current).toBe(40);
  });

  it('no double-burst at boundary: 100 at t=999ms denies 100 at t=1000ms', () => {
    let state = alg.init(W, 0);
    state = alg.tryConsume(state, 100, W, 999).nextState;
    const second = alg.tryConsume(state, 100, W, 1_000);
    expect(second.allowed).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it('skip multiple windows: idle resets both counts to zero', () => {
    let state = alg.init(W, 0);
    state = alg.tryConsume(state, 90, W, 0).nextState;
    const afterIdle = alg.tryConsume(state, 10, W, 5_000_000);
    expect(afterIdle.allowed).toBe(true);
    expect(afterIdle.nextState.previousCount).toBe(0);
    expect(afterIdle.nextState.currentCount).toBe(10);
  });

  it('refund subtracts from current first, then previous', () => {
    let state = alg.init(W, 0);
    state = alg.tryConsume(state, 80, W, 100).nextState; // currentCount=80
    state = alg.tryConsume(state, 0, W, 1_100).nextState; // roll: prev=80, curr=0
    state = alg.tryConsume(state, 10, W, 1_200).nextState; // curr=10
    state = alg.refund(state, 5, W, 1_300);
    expect(state.currentCount).toBe(5);
    expect(state.previousCount).toBe(80);
    state = alg.refund(state, 20, W, 1_400);
    expect(state.currentCount).toBe(0);
    expect(state.previousCount).toBe(65);
  });

  it('weight=0 always allowed', () => {
    const state = alg.init(W, 0);
    const r = alg.tryConsume(state, 0, W, 0);
    expect(r.allowed).toBe(true);
  });

  it('weight > maxWeight denied with retryAfter=Infinity', () => {
    const state = alg.init(W, 0);
    const r = alg.tryConsume(state, 101, W, 0);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(Number.POSITIVE_INFINITY);
  });

  it('clock skew backward clamps now to currentStart', () => {
    let state = alg.init(W, 5_000);
    state = alg.tryConsume(state, 50, W, 5_500).nextState;
    const skewed = alg.tryConsume(state, 10, W, 4_500);
    expect(skewed.allowed).toBe(true);
    expect(skewed.nextState.currentCount).toBe(60);
  });

  it('property: usage stays within [0, maxWeight] across any ops', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.record({ kind: fc.constant('consume' as const), weight: fc.integer({ min: 0, max: 30 }) }),
            fc.record({ kind: fc.constant('refund' as const), weight: fc.integer({ min: 0, max: 30 }) }),
            fc.record({ kind: fc.constant('tick' as const), ms: fc.integer({ min: 0, max: 3_000 }) }),
          ),
          { maxLength: 200 },
        ),
        (ops) => {
          let state = alg.init(W, 0);
          let now = 0;
          for (const op of ops) {
            if (op.kind === 'tick') {
              now += op.ms;
            } else if (op.kind === 'consume') {
              state = alg.tryConsume(state, op.weight, W, now).nextState;
            } else {
              state = alg.refund(state, op.weight, W, now);
            }
            const usage = alg.getUsage(state, W, now);
            expect(usage).toBeGreaterThanOrEqual(0);
            expect(usage).toBeLessThanOrEqual(W.maxWeight);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('property: usage is smooth across boundary (no jump > maxWeight)', () => {
    let state = alg.init(W, 0);
    state = alg.tryConsume(state, 100, W, 900).nextState;
    const samples: number[] = [];
    for (let t = 900; t <= 1_100; t += 5) {
      samples.push(alg.getUsage(state, W, t));
    }
    // Usage should not increase as time advances (no refund).
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]!).toBeLessThanOrEqual(samples[i - 1]! + 1);
    }
  });
});

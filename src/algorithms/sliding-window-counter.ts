import type { RateWindow } from '../types.js';
import type { AlgorithmConsumeResult, RateAlgorithm } from './algorithm.interface.js';

const EPSILON = 1e-9;

export interface SlidingWindowState {
  /** Wall-clock start of the current window, aligned to `windowMs`. */
  currentStart: number;
  /** Accumulated weight in the current window. */
  currentCount: number;
  /** Accumulated weight in the immediately previous window. */
  previousCount: number;
}

function floorToWindow(nowMs: number, windowMs: number): number {
  return nowMs - ((nowMs % windowMs) + windowMs) % windowMs;
}

function roll(state: SlidingWindowState, window: RateWindow, nowMs: number): SlidingWindowState {
  const clampedNow = Math.max(nowMs, state.currentStart);
  const elapsed = clampedNow - state.currentStart;
  if (elapsed >= 2 * window.windowMs) {
    return {
      currentStart: floorToWindow(clampedNow, window.windowMs),
      currentCount: 0,
      previousCount: 0,
    };
  }
  if (elapsed >= window.windowMs) {
    return {
      currentStart: state.currentStart + window.windowMs,
      currentCount: 0,
      previousCount: state.currentCount,
    };
  }
  return state;
}

function effectiveUsage(state: SlidingWindowState, window: RateWindow, nowMs: number): number {
  const clampedNow = Math.max(nowMs, state.currentStart);
  const elapsedInCurrent = clampedNow - state.currentStart;
  const overlapRatio = Math.max(0, 1 - elapsedInCurrent / window.windowMs);
  return state.previousCount * overlapRatio + state.currentCount;
}

/**
 * Sliding-window counter.
 *
 * Hybrid of two adjacent fixed windows interpolated by elapsed-in-current
 * fraction. Cheaper than per-request event logs and smoother than fixed
 * windows at the boundary (no 2x burst at the reset edge).
 *
 * `effectiveUsage` is fractional; comparisons use an epsilon tolerance to
 * avoid spurious denials from float rounding. `getUsage()` returns the
 * rounded integer so external consumers don't have to handle fractions.
 */
export const slidingWindowCounterAlgorithm: RateAlgorithm<SlidingWindowState> = {
  name: 'sliding-window-counter',

  init(window: RateWindow, nowMs: number): SlidingWindowState {
    return {
      currentStart: floorToWindow(nowMs, window.windowMs),
      currentCount: 0,
      previousCount: 0,
    };
  },

  tryConsume(
    inputState: SlidingWindowState | undefined,
    weight: number,
    window: RateWindow,
    nowMs: number,
  ): AlgorithmConsumeResult<SlidingWindowState> {
    const seed = inputState ?? this.init(window, nowMs);
    const state = roll(seed, window, nowMs);

    if (weight === 0) {
      const usage = effectiveUsage(state, window, nowMs);
      return {
        allowed: true,
        current: Math.round(usage),
        remaining: Math.max(0, window.maxWeight - Math.round(usage)),
        retryAfterMs: 0,
        nextState: state,
      };
    }

    if (weight > window.maxWeight) {
      const usage = effectiveUsage(state, window, nowMs);
      return {
        allowed: false,
        current: Math.round(usage),
        remaining: Math.max(0, window.maxWeight - Math.round(usage)),
        retryAfterMs: Number.POSITIVE_INFINITY,
        nextState: state,
      };
    }

    const usage = effectiveUsage(state, window, nowMs);
    if (usage + weight > window.maxWeight + EPSILON) {
      return {
        allowed: false,
        current: Math.round(usage),
        remaining: Math.max(0, window.maxWeight - Math.round(usage)),
        retryAfterMs: this.estimateRetryAfter(state, weight, window, nowMs),
        nextState: state,
      };
    }

    const nextState: SlidingWindowState = {
      currentStart: state.currentStart,
      currentCount: state.currentCount + weight,
      previousCount: state.previousCount,
    };
    const nextUsage = effectiveUsage(nextState, window, nowMs);
    return {
      allowed: true,
      current: Math.round(nextUsage),
      remaining: Math.max(0, window.maxWeight - Math.round(nextUsage)),
      retryAfterMs: 0,
      nextState,
    };
  },

  refund(
    state: SlidingWindowState,
    weight: number,
    _window: RateWindow,
    _nowMs: number,
  ): SlidingWindowState {
    const fromCurrent = Math.min(state.currentCount, weight);
    const remaining = weight - fromCurrent;
    return {
      currentStart: state.currentStart,
      currentCount: state.currentCount - fromCurrent,
      previousCount: Math.max(0, state.previousCount - remaining),
    };
  },

  getUsage(state: SlidingWindowState | undefined, window: RateWindow, nowMs: number): number {
    if (!state) return 0;
    const rolled = roll(state, window, nowMs);
    return Math.round(effectiveUsage(rolled, window, nowMs));
  },

  estimateRetryAfter(
    state: SlidingWindowState | undefined,
    weight: number,
    window: RateWindow,
    nowMs: number,
  ): number {
    if (weight <= 0) return 0;
    if (weight > window.maxWeight) return Number.POSITIVE_INFINITY;
    if (!state) return 0;
    const rolled = roll(state, window, nowMs);
    const clampedNow = Math.max(nowMs, rolled.currentStart);
    const elapsedInCurrent = clampedNow - rolled.currentStart;
    // Solve: previousCount * (1 - (elapsed + t) / windowMs) + currentCount + weight <= maxWeight.
    // → previousCount * (1 - (elapsed + t)/windowMs) <= maxWeight - currentCount - weight
    // → (1 - (elapsed + t)/windowMs) <= (maxWeight - currentCount - weight) / previousCount
    const allowance = window.maxWeight - rolled.currentCount - weight;
    if (allowance >= 0 && rolled.previousCount === 0) return 0;
    if (rolled.previousCount <= 0) {
      // No previous contribution; have to wait for currentCount alone to age out.
      // currentCount cannot decrease without refund — return time until current window ends.
      return Math.max(1, rolled.currentStart + window.windowMs - clampedNow);
    }
    if (allowance < 0) {
      // Even with zero previousCount overlap, currentCount alone is over budget.
      return Math.max(1, rolled.currentStart + window.windowMs - clampedNow);
    }
    const allowedOverlap = allowance / rolled.previousCount;
    const requiredElapsed = (1 - allowedOverlap) * window.windowMs;
    const ms = Math.max(0, requiredElapsed - elapsedInCurrent);
    return Math.max(1, Math.ceil(ms));
  },

  cleanup(state: SlidingWindowState, window: RateWindow, nowMs: number): SlidingWindowState {
    return roll(state, window, nowMs);
  },
};

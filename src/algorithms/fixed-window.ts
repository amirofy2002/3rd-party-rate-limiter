import type { RateWindow } from '../types.js';
import type { AlgorithmConsumeResult, RateAlgorithm } from './algorithm.interface.js';

export interface FixedWindowState {
  /** Wall-clock start of the active window, aligned to `windowMs`. */
  windowStartMs: number;
  /** Accumulated weight within the active window. */
  count: number;
}

function floorToWindow(nowMs: number, windowMs: number): number {
  return nowMs - ((nowMs % windowMs) + windowMs) % windowMs;
}

function rotateIfNeeded(state: FixedWindowState, window: RateWindow, nowMs: number): FixedWindowState {
  if (nowMs < state.windowStartMs) return state;
  if (nowMs - state.windowStartMs < window.windowMs) return state;
  return { windowStartMs: floorToWindow(nowMs, window.windowMs), count: 0 };
}

/**
 * Fixed-window counter.
 *
 * Boundaries are aligned to wall-clock so all instances pivot at the same
 * moment. This is the right algorithm for providers that publish a hard
 * reset-based quota (e.g. Binance per-minute weight headers).
 *
 * Known limitation — burst at boundary: 100 weight at t=59s plus 100 weight
 * at t=60s issues 200 weight in 1 second of real time. Callers wanting a
 * smoother distribution should use `sliding-window-counter` instead.
 */
export const fixedWindowAlgorithm: RateAlgorithm<FixedWindowState> = {
  name: 'fixed-window',

  init(window: RateWindow, nowMs: number): FixedWindowState {
    return { windowStartMs: floorToWindow(nowMs, window.windowMs), count: 0 };
  },

  tryConsume(
    inputState: FixedWindowState | undefined,
    weight: number,
    window: RateWindow,
    nowMs: number,
  ): AlgorithmConsumeResult<FixedWindowState> {
    const fresh = inputState ?? this.init(window, nowMs);
    const state = rotateIfNeeded(fresh, window, nowMs);

    if (weight === 0) {
      return {
        allowed: true,
        current: state.count,
        remaining: Math.max(0, window.maxWeight - state.count),
        retryAfterMs: 0,
        nextState: state,
      };
    }

    if (weight > window.maxWeight) {
      return {
        allowed: false,
        current: state.count,
        remaining: Math.max(0, window.maxWeight - state.count),
        retryAfterMs: Number.POSITIVE_INFINITY,
        nextState: state,
      };
    }

    if (state.count + weight > window.maxWeight) {
      const retryAfterMs = Math.max(1, state.windowStartMs + window.windowMs - nowMs);
      return {
        allowed: false,
        current: state.count,
        remaining: Math.max(0, window.maxWeight - state.count),
        retryAfterMs,
        nextState: state,
      };
    }

    const nextState: FixedWindowState = {
      windowStartMs: state.windowStartMs,
      count: state.count + weight,
    };
    return {
      allowed: true,
      current: nextState.count,
      remaining: Math.max(0, window.maxWeight - nextState.count),
      retryAfterMs: 0,
      nextState,
    };
  },

  refund(state: FixedWindowState, weight: number, _window: RateWindow, _nowMs: number): FixedWindowState {
    return { windowStartMs: state.windowStartMs, count: Math.max(0, state.count - weight) };
  },

  getUsage(state: FixedWindowState | undefined, window: RateWindow, nowMs: number): number {
    if (!state) return 0;
    const rotated = rotateIfNeeded(state, window, nowMs);
    return rotated.count;
  },

  estimateRetryAfter(
    state: FixedWindowState | undefined,
    weight: number,
    window: RateWindow,
    nowMs: number,
  ): number {
    if (weight <= 0) return 0;
    if (weight > window.maxWeight) return Number.POSITIVE_INFINITY;
    if (!state) return 0;
    const rotated = rotateIfNeeded(state, window, nowMs);
    if (rotated.count + weight <= window.maxWeight) return 0;
    return Math.max(1, rotated.windowStartMs + window.windowMs - nowMs);
  },

  cleanup(state: FixedWindowState, window: RateWindow, nowMs: number): FixedWindowState {
    return rotateIfNeeded(state, window, nowMs);
  },
};

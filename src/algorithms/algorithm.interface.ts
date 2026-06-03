import type { AlgorithmKind, RateWindow } from '../types.js';

/** Outcome of a `tryConsume` call. */
export interface AlgorithmConsumeResult<State> {
  /** Whether the weight fits. */
  allowed: boolean;
  /** Current measured usage after the call (whether allowed or not). */
  current: number;
  /** Remaining capacity after the call. */
  remaining: number;
  /** Suggested wait until capacity may become available (only meaningful when denied). */
  retryAfterMs: number;
  /** Next state after the call. Pure return; algorithms never mutate input state. */
  nextState: State;
}

/**
 * Pure rate-limit algorithm contract.
 *
 * Algorithms are state-functional: callers (typically the store) hold state
 * and pass it back in on each call. Implementations must:
 *
 * - Never perform I/O.
 * - Never read time except via `nowMs` parameter.
 * - Never mutate input state — return a `nextState` instead.
 * - Be deterministic.
 *
 * `weight > maxWeight` must return `allowed: false` with
 * `retryAfterMs: Number.POSITIVE_INFINITY`; the limiter translates that into a
 * `ConfigurationError`. `weight === 0` is always allowed with no state change.
 */
export interface RateAlgorithm<State = unknown> {
  /** Algorithm key. Matches the `algorithm` field on `RateWindow`. */
  readonly name: AlgorithmKind;

  /** Initial state for a fresh window. */
  init(window: RateWindow, nowMs: number): State;

  /** Attempt to consume `weight` against `state`. Returns next state. */
  tryConsume(
    state: State | undefined,
    weight: number,
    window: RateWindow,
    nowMs: number,
  ): AlgorithmConsumeResult<State>;

  /** Refund `weight` previously consumed. Returns next state. */
  refund(state: State, weight: number, window: RateWindow, nowMs: number): State;

  /** Current usage given state. */
  getUsage(state: State | undefined, window: RateWindow, nowMs: number): number;

  /** Suggested wait until `weight` may fit. */
  estimateRetryAfter(
    state: State | undefined,
    weight: number,
    window: RateWindow,
    nowMs: number,
  ): number;

  /** Optional GC hint. Returns next state (possibly empty). */
  cleanup?(state: State, window: RateWindow, nowMs: number): State;
}

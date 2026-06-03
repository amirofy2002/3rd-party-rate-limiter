import type { ProviderErrorKind, ProviderObservation } from '../adapters/adapter.interface.js';
import type { RetryConfig } from '../types.js';
import { nextDelay } from './backoff.js';

const DEFAULT_BASE_MS = 200;
const DEFAULT_MAX_MS = 5_000;

export interface RetryDecision {
  retry: boolean;
  delayMs: number;
}

/** Reasons retries are or aren't attempted. */
export type RetryReason =
  | 'attempts-exhausted'
  | 'permanent-error'
  | 'rate-limited'
  | 'transient'
  | 'banned'
  | 'unknown';

/**
 * Pure retry decision-maker. Owns no timers — callers use `clock.sleep` with
 * the returned `delayMs`.
 *
 * Rules:
 * - Never retry past `cfg.maxAttempts`.
 * - Do not retry `permanent` errors (most 4xx).
 * - Always retry `rate-limited` and `transient` while attempts remain.
 * - When `cfg.respectRetryAfter` is true and the observation suggests a
 *   `retryAfterMs`, the returned delay is at least that long.
 * - `banned` triggers retry only if the caller explicitly opts in via
 *   `cfg.maxAttempts > 0`. Caller is responsible for pausing the queue
 *   until the ban lifts.
 */
export class RetryPolicy {
  public shouldRetry(
    kind: ProviderErrorKind,
    attempt: number,
    cfg: RetryConfig,
  ): { retry: boolean; reason: RetryReason } {
    if (attempt >= cfg.maxAttempts) return { retry: false, reason: 'attempts-exhausted' };
    if (kind === 'permanent') return { retry: false, reason: 'permanent-error' };
    if (kind === 'rate-limited') return { retry: true, reason: 'rate-limited' };
    if (kind === 'transient') return { retry: true, reason: 'transient' };
    if (kind === 'banned') return { retry: cfg.maxAttempts > 0, reason: 'banned' };
    // `unknown`: be conservative — retry if attempts remain.
    return { retry: true, reason: 'unknown' };
  }

  public computeDelay(
    attempt: number,
    cfg: RetryConfig,
    observation?: ProviderObservation,
    random?: () => number,
  ): number {
    const backoff = nextDelay({
      attempt,
      baseMs: cfg.baseMs ?? DEFAULT_BASE_MS,
      maxMs: cfg.maxMs ?? DEFAULT_MAX_MS,
      kind: cfg.backoff ?? 'exponential',
      jitter: cfg.jitter ?? false,
      ...(random ? { random } : {}),
    });
    if (cfg.respectRetryAfter && observation?.retryAfterMs !== undefined) {
      return Math.max(backoff, observation.retryAfterMs);
    }
    return backoff;
  }

  /** Convenience: combined retry + delay decision. */
  public decide(
    kind: ProviderErrorKind,
    attempt: number,
    cfg: RetryConfig,
    observation?: ProviderObservation,
    random?: () => number,
  ): RetryDecision & { reason: RetryReason } {
    const { retry, reason } = this.shouldRetry(kind, attempt, cfg);
    if (!retry) return { retry: false, delayMs: 0, reason };
    return { retry: true, delayMs: this.computeDelay(attempt, cfg, observation, random), reason };
  }
}

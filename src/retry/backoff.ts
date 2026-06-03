import type { BackoffKind } from '../types.js';

export interface BackoffOptions {
  /** 1-indexed retry attempt number. */
  attempt: number;
  /** Base delay in ms. */
  baseMs: number;
  /** Maximum delay in ms. Output is capped to this. */
  maxMs: number;
  /** Backoff curve. */
  kind: BackoffKind;
  /** Apply full jitter (`random() * delay`). */
  jitter: boolean;
  /** Injectable random source (0..1). Default `Math.random`. */
  random?: () => number;
}

/**
 * Compute the delay before retry attempt #`attempt`.
 *
 * - Exponential: `base * 2^(attempt-1)`, capped at `maxMs`.
 * - Linear: `base * attempt`, capped at `maxMs`.
 * - Jitter (full jitter): scale by `random()` in `[0, 1)`.
 */
export function nextDelay(opts: BackoffOptions): number {
  const attempt = Math.max(1, Math.floor(opts.attempt));
  const raw = opts.kind === 'exponential' ? opts.baseMs * 2 ** (attempt - 1) : opts.baseMs * attempt;
  const capped = Math.min(opts.maxMs, raw);
  if (!opts.jitter) return Math.max(0, capped);
  const rand = (opts.random ?? Math.random)();
  return Math.max(0, Math.floor(capped * rand));
}

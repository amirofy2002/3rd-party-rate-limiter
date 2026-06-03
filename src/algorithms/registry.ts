import { ConfigurationError } from '../errors.js';
import type { AlgorithmKind } from '../types.js';
import type { RateAlgorithm } from './algorithm.interface.js';
import { fixedWindowAlgorithm } from './fixed-window.js';
import { slidingWindowCounterAlgorithm } from './sliding-window-counter.js';

/** Default algorithm name when a `RateWindow.algorithm` field is missing. */
export const DEFAULT_ALGORITHM: AlgorithmKind = 'sliding-window-counter';

/**
 * Per-`createLimiter` registry of rate-limit algorithms.
 *
 * Instances are isolated so multiple limiters in the same process do not
 * share registration state (or each other's bugs).
 */
export class AlgorithmRegistry {
  private readonly map = new Map<string, RateAlgorithm>();

  public register(
    algo: RateAlgorithm,
    opts: { override?: boolean } = {},
  ): void {
    const exists = this.map.has(algo.name);
    if (exists && !opts.override) {
      throw new ConfigurationError(`algorithm already registered: ${algo.name}`);
    }
    this.map.set(algo.name, algo);
  }

  public get(name: string): RateAlgorithm {
    const algo = this.map.get(name);
    if (!algo) {
      if (name === 'token-bucket') {
        throw new ConfigurationError(
          'algorithm "token-bucket" is not registered. Token bucket is on the v2 roadmap; ' +
            'use "sliding-window-counter" or "fixed-window" for v1, or register your own implementation.',
        );
      }
      throw new ConfigurationError(`unknown algorithm: ${name}`);
    }
    return algo;
  }

  public has(name: string): boolean {
    return this.map.has(name);
  }

  public list(): readonly string[] {
    return Array.from(this.map.keys());
  }
}

/** Build the default registry with fixed-window and sliding-window-counter. */
export function createDefaultRegistry(): AlgorithmRegistry {
  const r = new AlgorithmRegistry();
  r.register(slidingWindowCounterAlgorithm);
  r.register(fixedWindowAlgorithm);
  return r;
}

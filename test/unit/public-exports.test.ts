import { describe, expect, it } from 'vitest';
import * as pkg from '../../src/index.js';

describe('public exports', () => {
  it('exposes createLimiter and core adapters/store', () => {
    expect(typeof pkg.createLimiter).toBe('function');
    expect(typeof pkg.GenericAdapter).toBe('function');
    expect(typeof pkg.MemoryStore).toBe('function');
    expect(typeof pkg.SystemClock).toBe('function');
    expect(typeof pkg.systemClock).toBe('object');
    expect(typeof pkg.AlgorithmRegistry).toBe('function');
    expect(typeof pkg.createDefaultRegistry).toBe('function');
    expect(pkg.DEFAULT_ALGORITHM).toBe('sliding-window-counter');
  });

  it('exposes every typed error class', () => {
    expect(typeof pkg.RateLimiterError).toBe('function');
    expect(typeof pkg.RateLimitError).toBe('function');
    expect(typeof pkg.QueueFullError).toBe('function');
    expect(typeof pkg.RequestTimeoutError).toBe('function');
    expect(typeof pkg.BannedError).toBe('function');
    expect(typeof pkg.ProviderExecutionError).toBe('function');
    expect(typeof pkg.StoreUnavailableError).toBe('function');
    expect(typeof pkg.ConfigurationError).toBe('function');
  });

  it('exposes algorithm instances by name', () => {
    expect(pkg.fixedWindowAlgorithm.name).toBe('fixed-window');
    expect(pkg.slidingWindowCounterAlgorithm.name).toBe('sliding-window-counter');
  });

  it('does NOT expose internal modules', () => {
    expect((pkg as Record<string, unknown>)['Scheduler']).toBeUndefined();
    expect((pkg as Record<string, unknown>)['RateLimiter']).toBeUndefined();
    expect((pkg as Record<string, unknown>)['PriorityQueue']).toBeUndefined();
    expect((pkg as Record<string, unknown>)['EventBus']).toBeUndefined();
    expect((pkg as Record<string, unknown>)['RetryPolicy']).toBeUndefined();
  });

  it('error codes are unique across all error classes', () => {
    const codes = [
      new pkg.RateLimitError().code,
      new pkg.QueueFullError().code,
      new pkg.RequestTimeoutError().code,
      new pkg.BannedError().code,
      new pkg.ProviderExecutionError().code,
      new pkg.StoreUnavailableError().code,
      new pkg.ConfigurationError().code,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

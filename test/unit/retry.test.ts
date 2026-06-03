import { describe, expect, it } from 'vitest';
import { nextDelay } from '../../src/retry/backoff.js';
import { RetryPolicy } from '../../src/retry/retry-policy.js';

describe('nextDelay', () => {
  it('exponential growth, capped at maxMs', () => {
    const opts = { baseMs: 100, maxMs: 1_000, kind: 'exponential' as const, jitter: false };
    expect(nextDelay({ ...opts, attempt: 1 })).toBe(100);
    expect(nextDelay({ ...opts, attempt: 2 })).toBe(200);
    expect(nextDelay({ ...opts, attempt: 3 })).toBe(400);
    expect(nextDelay({ ...opts, attempt: 4 })).toBe(800);
    expect(nextDelay({ ...opts, attempt: 5 })).toBe(1_000); // capped
  });

  it('linear growth', () => {
    const opts = { baseMs: 100, maxMs: 1_000, kind: 'linear' as const, jitter: false };
    expect(nextDelay({ ...opts, attempt: 1 })).toBe(100);
    expect(nextDelay({ ...opts, attempt: 2 })).toBe(200);
    expect(nextDelay({ ...opts, attempt: 3 })).toBe(300);
  });

  it('jitter bounded in [0, delay]', () => {
    for (let i = 0; i < 100; i++) {
      const d = nextDelay({
        attempt: 4,
        baseMs: 100,
        maxMs: 10_000,
        kind: 'exponential',
        jitter: true,
      });
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(800);
    }
  });

  it('deterministic under injected random', () => {
    const fixed = () => 0.5;
    const d = nextDelay({
      attempt: 3,
      baseMs: 100,
      maxMs: 10_000,
      kind: 'exponential',
      jitter: true,
      random: fixed,
    });
    // exponential @ attempt 3 = 400; jitter scales by 0.5 → 200.
    expect(d).toBe(200);
  });
});

describe('RetryPolicy', () => {
  const policy = new RetryPolicy();

  it('respects maxAttempts=0', () => {
    expect(policy.shouldRetry('rate-limited', 0, { maxAttempts: 0 }).retry).toBe(false);
  });

  it('does not retry permanent errors', () => {
    expect(policy.shouldRetry('permanent', 0, { maxAttempts: 5 }).retry).toBe(false);
  });

  it('retries rate-limited and transient while attempts remain', () => {
    expect(policy.shouldRetry('rate-limited', 0, { maxAttempts: 3 }).retry).toBe(true);
    expect(policy.shouldRetry('transient', 1, { maxAttempts: 3 }).retry).toBe(true);
    expect(policy.shouldRetry('rate-limited', 3, { maxAttempts: 3 }).retry).toBe(false);
  });

  it('respectRetryAfter widens delay to the larger of backoff or header', () => {
    const delay = policy.computeDelay(
      1,
      { maxAttempts: 3, baseMs: 100, maxMs: 10_000, backoff: 'exponential', respectRetryAfter: true },
      { retryAfterMs: 5_000 },
    );
    expect(delay).toBe(5_000);
  });

  it('respectRetryAfter false: ignores header', () => {
    const delay = policy.computeDelay(
      1,
      { maxAttempts: 3, baseMs: 100, maxMs: 10_000, respectRetryAfter: false },
      { retryAfterMs: 5_000 },
    );
    expect(delay).toBe(100);
  });

  it('decide combines decision + delay', () => {
    const d = policy.decide(
      'rate-limited',
      0,
      { maxAttempts: 3, baseMs: 200, maxMs: 5_000 },
    );
    expect(d.retry).toBe(true);
    expect(d.delayMs).toBe(200);
    expect(d.reason).toBe('rate-limited');
  });

  it('decide on permanent: retry=false, delay=0', () => {
    const d = policy.decide('permanent', 0, { maxAttempts: 3 });
    expect(d).toEqual({ retry: false, delayMs: 0, reason: 'permanent-error' });
  });
});

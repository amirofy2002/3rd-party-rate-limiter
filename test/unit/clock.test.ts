import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../src/core/clock.js';
import { FakeClock } from '../util/fake-clock.js';

describe('SystemClock', () => {
  const clock = new SystemClock();

  it('now() approximates Date.now() within 5 ms', () => {
    const a = Date.now();
    const b = clock.now();
    expect(Math.abs(a - b)).toBeLessThan(5);
  });

  it('monotonic() is non-decreasing across rapid calls', () => {
    let prev = clock.monotonic();
    for (let i = 0; i < 1000; i++) {
      const next = clock.monotonic();
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
  });

  it('sleep(50) resolves after at least 40 ms', async () => {
    const start = clock.monotonic();
    await clock.sleep(50);
    const elapsed = clock.monotonic() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  it('sleep rejects with AbortError when signal already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(clock.sleep(1000, ctrl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('sleep cleans up timer on abort', async () => {
    const ctrl = new AbortController();
    const p = clock.sleep(1000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('FakeClock', () => {
  it('tick advances now() by the specified amount', () => {
    const c = new FakeClock(1_000);
    c.tick(250);
    expect(c.now()).toBe(1_250);
    expect(c.monotonic()).toBe(250);
  });

  it('tick fires timers up to target time in chronological order', () => {
    const c = new FakeClock();
    const fired: number[] = [];
    c.setTimeout(() => fired.push(20), 20);
    c.setTimeout(() => fired.push(5), 5);
    c.setTimeout(() => fired.push(10), 10);
    c.tick(15);
    expect(fired).toEqual([5, 10]);
    c.tick(10);
    expect(fired).toEqual([5, 10, 20]);
  });

  it('timers scheduled for the same time fire in FIFO order', () => {
    const c = new FakeClock();
    const fired: string[] = [];
    c.setTimeout(() => fired.push('a'), 10);
    c.setTimeout(() => fired.push('b'), 10);
    c.setTimeout(() => fired.push('c'), 10);
    c.tick(10);
    expect(fired).toEqual(['a', 'b', 'c']);
  });

  it('clearTimeout prevents firing', () => {
    const c = new FakeClock();
    const fired: string[] = [];
    const t = c.setTimeout(() => fired.push('x'), 5);
    c.clearTimeout(t);
    c.tick(100);
    expect(fired).toEqual([]);
  });

  it('sleep resolves after tick passes target time', async () => {
    const c = new FakeClock();
    let done = false;
    const p = c.sleep(50).then(() => {
      done = true;
    });
    c.tick(49);
    await Promise.resolve();
    expect(done).toBe(false);
    c.tick(1);
    await p;
    expect(done).toBe(true);
  });

  it('sleep rejects with AbortError when aborted before tick', async () => {
    const c = new FakeClock();
    const ctrl = new AbortController();
    const p = c.sleep(100, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('tick with ms<=0 timer fires asynchronously, not synchronously', () => {
    const c = new FakeClock();
    const fired: number[] = [];
    c.setTimeout(() => fired.push(1), 0);
    // Should not have fired yet — setTimeout queues, even with 0ms.
    expect(fired).toEqual([]);
    c.tick(0);
    expect(fired).toEqual([1]);
  });
});

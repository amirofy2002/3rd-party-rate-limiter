import { describe, expect, expectTypeOf, it } from 'vitest';
import { GenericAdapter } from '../../src/adapters/generic.js';
import { createLimiter } from '../../src/core/create-limiter.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import { ConfigurationError, RateLimitError } from '../../src/errors.js';
import type { RateWindow } from '../../src/types.js';
import { FakeClock } from '../util/fake-clock.js';

const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 3, algorithm: 'fixed-window' };

const makeAdapter = () =>
  new GenericAdapter({ id: 'p', windows: [W], endpoints: { '/x': 1 } });

describe('createLimiter', () => {
  it('schedule end-to-end returns the execute() result with preserved typing', async () => {
    const limiter = createLimiter({
      provider: makeAdapter(),
      store: new MemoryStore(),
      defaultStrategy: 'reject',
    });
    const result = await limiter.schedule<{ ok: true; n: number }>({
      endpoint: '/x',
      execute: () => Promise.resolve({ ok: true as const, n: 42 }),
    });
    expect(result).toEqual({ ok: true, n: 42 });
    expectTypeOf(result).toEqualTypeOf<{ ok: true; n: number }>();
  });

  it('rate-limit error surfaced under reject strategy', async () => {
    const limiter = createLimiter({
      provider: makeAdapter(),
      store: new MemoryStore(),
      defaultStrategy: 'reject',
    });
    for (let i = 0; i < 3; i++) {
      await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(i) });
    }
    await expect(
      limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(99) }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('wrap preserves arity and return type', async () => {
    const limiter = createLimiter({
      provider: makeAdapter(),
      defaultStrategy: 'reject',
    });
    const original = (a: number, b: number): Promise<number> => Promise.resolve(a + b);
    const wrapped = limiter.wrap('/x', original);
    expectTypeOf(wrapped).toEqualTypeOf<(a: number, b: number) => Promise<number>>();
    await expect(wrapped(2, 3)).resolves.toBe(5);
  });

  it('wrap preserves `this` binding via apply', async () => {
    const limiter = createLimiter({
      provider: makeAdapter(),
      defaultStrategy: 'reject',
    });
    const obj = {
      base: 10,
      addImpl(this: { base: number }, n: number): Promise<number> {
        return Promise.resolve(this.base + n);
      },
    };
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const addFn = obj.addImpl;
    const wrapped = limiter.wrap('/x', addFn).bind(obj);
    await expect(wrapped(5)).resolves.toBe(15);
  });

  it('invalid config (missing provider) throws ConfigurationError', () => {
    expect(() =>
      createLimiter({ provider: undefined as unknown as never }),
    ).toThrow(ConfigurationError);
  });

  it('invalid provider shape throws ConfigurationError', () => {
    expect(() => createLimiter({ provider: { id: 'x' } as never })).toThrow(ConfigurationError);
  });

  it('invalid schedule input throws ConfigurationError', async () => {
    const limiter = createLimiter({ provider: makeAdapter(), defaultStrategy: 'reject' });
    await expect(
      limiter.schedule({ endpoint: '', execute: () => Promise.resolve(1) }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      limiter.schedule({ endpoint: '/x', execute: undefined as unknown as () => Promise<unknown> }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('drain then schedule rejects with ConfigurationError', async () => {
    const limiter = createLimiter({ provider: makeAdapter(), defaultStrategy: 'reject' });
    await limiter.drain();
    await expect(
      limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(1) }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('weight override on schedule takes precedence over adapter resolution', async () => {
    const limiter = createLimiter({
      provider: makeAdapter(),
      store: new MemoryStore(),
      defaultStrategy: 'reject',
    });
    await limiter.schedule({ endpoint: '/x', weight: 3, execute: () => Promise.resolve('ok') });
    await expect(
      limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve('ok') }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('stats returns queue depth and totals', async () => {
    const clock = new FakeClock();
    const limiter = createLimiter({
      provider: makeAdapter(),
      defaultStrategy: 'reject',
      clock,
    });
    await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve('ok') });
    const s = limiter.stats();
    expect(s.totalReceived).toBe(1);
    expect(s.totalExecuted).toBe(1);
    expect(s.queueDepth).toBe(0);
  });
});

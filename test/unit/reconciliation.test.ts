import { describe, expect, it, vi } from 'vitest';
import { GenericAdapter } from '../../src/adapters/generic.js';
import { createLimiter } from '../../src/core/create-limiter.js';
import { MemoryStore } from '../../src/storage/memory-store.js';
import type { RateWindow } from '../../src/types.js';
import { FakeClock } from '../util/fake-clock.js';

const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 1_000, algorithm: 'fixed-window' };

const makeAdapter = () =>
  new GenericAdapter({
    id: 'p',
    windows: [W],
    endpoints: { '/x': 1 },
    usageHeaders: [{ name: 'x-used-1m', windowId: '1m', authoritative: true }],
  });

describe('Usage reconciliation', () => {
  it('upward reconciliation: local 100, provider says 150 → store at 150', async () => {
    const store = new MemoryStore();
    const adapter = makeAdapter();
    const clock = new FakeClock();
    const limiter = createLimiter({
      provider: adapter,
      store,
      defaultStrategy: 'reject',
      clock,
    });
    for (let i = 0; i < 100; i++) {
      await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(null) });
    }
    expect(await store.getUsage({ provider: 'p', scope: 'p:default', window: W, nowMs: 0 })).toBe(100);
    await limiter.reconcile('p:default', { headers: { 'x-used-1m': '150' } });
    expect(await store.getUsage({ provider: 'p', scope: 'p:default', window: W, nowMs: 0 })).toBe(150);
  });

  it('downward reconciliation only when authoritative', async () => {
    const store = new MemoryStore();
    const adapter = new GenericAdapter({
      id: 'p',
      windows: [W],
      endpoints: { '/x': 1 },
      usageHeaders: [{ name: 'x-used-1m-soft', windowId: '1m', authoritative: false }],
    });
    const limiter = createLimiter({ provider: adapter, store, defaultStrategy: 'reject' });
    for (let i = 0; i < 80; i++) {
      await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(null) });
    }
    await limiter.reconcile('p:default', { headers: { 'x-used-1m-soft': '20' } });
    expect(await store.getUsage({ provider: 'p', scope: 'p:default', window: W, nowMs: 0 })).toBe(80);
  });

  it('parseResponseFromResult hook fires after successful execute', async () => {
    const store = new MemoryStore();
    const adapter = makeAdapter();
    const limiter = createLimiter({
      provider: adapter,
      store,
      defaultStrategy: 'reject',
    });
    const reconciled = vi.fn();
    limiter.on('usage:reconciled', reconciled);
    await limiter.schedule<{ ok: true }>({
      endpoint: '/x',
      execute: () => Promise.resolve({ ok: true }),
      parseResponseFromResult: () => ({ headers: { 'x-used-1m': '777' } }),
    });
    expect(reconciled).toHaveBeenCalledTimes(1);
    expect(await store.getUsage({ provider: 'p', scope: 'p:default', window: W, nowMs: 0 })).toBe(777);
  });
});

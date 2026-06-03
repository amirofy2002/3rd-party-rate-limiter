import { describe, expect, it } from 'vitest';
import { BinanceAdapter } from '../../src/adapters/binance.js';
import { ConfigurationError } from '../../src/errors.js';
import type { ScheduledRequest } from '../../src/types.js';

const req = (overrides: Partial<ScheduledRequest<unknown>> = {}): ScheduledRequest<unknown> => ({
  endpoint: 'GET /api/v3/account',
  execute: () => Promise.resolve(null),
  ...overrides,
});

describe('BinanceAdapter', () => {
  it('non-spot profile throws ConfigurationError', () => {
    expect(() => new BinanceAdapter({ profile: 'futures' })).toThrow(ConfigurationError);
  });

  it('resolves known endpoints to documented weights', () => {
    const a = new BinanceAdapter();
    expect(a.resolveWeight('GET /api/v3/account')).toBe(20);
    expect(a.resolveWeight('GET /api/v3/exchangeInfo')).toBe(20);
    expect(a.resolveWeight('POST /api/v3/order')).toBe(1);
    expect(a.resolveWeight('GET /api/v3/myTrades')).toBe(10);
  });

  it('unknown endpoint throws when no defaultWeight', () => {
    const a = new BinanceAdapter();
    expect(() => a.resolveWeight('GET /api/v3/nope')).toThrow(ConfigurationError);
  });

  it('falls back to defaultWeight when configured', () => {
    const a = new BinanceAdapter({ defaultWeight: 7 });
    expect(a.resolveWeight('GET /api/v3/nope')).toBe(7);
  });

  it('user override beats bundled weight', () => {
    const a = new BinanceAdapter({ endpointWeights: { 'GET /api/v3/account': 99 } });
    expect(a.resolveWeight('GET /api/v3/account')).toBe(99);
  });

  it('batch order weight scales with batchSize', () => {
    const a = new BinanceAdapter();
    expect(a.resolveWeight('POST /api/v3/batchOrders', { payload: { batchSize: 5 } })).toBe(5);
    expect(a.resolveWeight('POST /api/v3/batchOrders')).toBe(1);
  });

  it('parses x-mbx-used-weight-1m', () => {
    const a = new BinanceAdapter();
    const obs = a.parseResponse({ headers: { 'x-mbx-used-weight-1m': '1199' } });
    expect(obs.usage).toEqual([{ windowId: '1m', observedWeight: 1199, authoritative: true }]);
  });

  it('plain x-mbx-used-weight maps to 1m', () => {
    const a = new BinanceAdapter();
    const obs = a.parseResponse({ headers: { 'X-MBX-USED-WEIGHT': '50' } });
    expect(obs.usage).toEqual([{ windowId: '1m', observedWeight: 50, authoritative: true }]);
  });

  it('418 response yields banUntilMs ≈ now + cooldown', () => {
    const a = new BinanceAdapter();
    const t0 = Date.now();
    const obs = a.parseResponse({ status: 418, headers: {} });
    expect(obs.banUntilMs).toBeGreaterThanOrEqual(t0 + 179_000);
    expect(obs.banUntilMs).toBeLessThanOrEqual(t0 + 181_000);
  });

  it('429 with retry-after honors the header', () => {
    const a = new BinanceAdapter();
    const obs = a.parseResponse({ status: 429, headers: { 'retry-after': '10' } });
    expect(obs.retryAfterMs).toBe(10_000);
  });

  it('classifyError: 418=banned, 429=rate-limited, 5xx=transient', () => {
    const a = new BinanceAdapter();
    expect(a.classifyError({ status: 418 })).toBe('banned');
    expect(a.classifyError({ status: 429 })).toBe('rate-limited');
    expect(a.classifyError({ status: 503 })).toBe('transient');
    expect(a.classifyError({ status: 400 })).toBe('permanent');
  });

  it('resolveScope uses meta.account or "default"', () => {
    const a = new BinanceAdapter();
    expect(a.resolveScope(req())).toBe('binance:default');
    expect(a.resolveScope(req({ meta: { account: 'acct-1' } }))).toBe('binance:acct-1');
  });

  it('snapshotDate is exposed', () => {
    expect(typeof BinanceAdapter.snapshotDate()).toBe('string');
  });
});

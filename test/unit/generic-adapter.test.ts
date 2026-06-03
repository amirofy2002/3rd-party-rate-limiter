import { describe, expect, it, vi } from 'vitest';
import { GenericAdapter } from '../../src/adapters/generic.js';
import { ConfigurationError } from '../../src/errors.js';
import type { RateWindow, ScheduledRequest } from '../../src/types.js';

const W1: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 1_200, algorithm: 'fixed-window' };

const makeReq = (overrides: Partial<ScheduledRequest<unknown>> = {}): ScheduledRequest<unknown> => ({
  endpoint: '/api/v3/order',
  execute: () => Promise.resolve(null),
  ...overrides,
});

describe('GenericAdapter', () => {
  it('resolves known endpoint weight', () => {
    const a = new GenericAdapter({
      id: 'binance',
      windows: [W1],
      endpoints: { '/api/v3/order': 1, '/api/v3/account': 10 },
    });
    expect(a.resolveWeight('/api/v3/order')).toBe(1);
    expect(a.resolveWeight('/api/v3/account')).toBe(10);
  });

  it('falls back to defaultWeight for unknown endpoints', () => {
    const a = new GenericAdapter({
      id: 'p',
      windows: [W1],
      defaultWeight: 5,
    });
    expect(a.resolveWeight('/unknown')).toBe(5);
  });

  it('throws when endpoint missing and no defaultWeight', () => {
    const a = new GenericAdapter({ id: 'p', windows: [W1], endpoints: { '/known': 1 } });
    expect(() => a.resolveWeight('/missing')).toThrow(ConfigurationError);
  });

  it('parses usage headers for configured windows', () => {
    const a = new GenericAdapter({
      id: 'binance',
      windows: [W1],
      usageHeaders: [
        { name: 'X-MBX-USED-WEIGHT-1M', windowId: '1m', authoritative: true },
      ],
    });
    const obs = a.parseResponse({
      headers: { 'x-mbx-used-weight-1m': '250' },
    });
    expect(obs.usage).toEqual([{ windowId: '1m', observedWeight: 250, authoritative: true }]);
  });

  it('header missing produces no observation rather than zero', () => {
    const a = new GenericAdapter({
      id: 'p',
      windows: [W1],
      usageHeaders: [{ name: 'x-used', windowId: '1m' }],
    });
    const obs = a.parseResponse({ headers: {} });
    expect(obs.usage).toBeUndefined();
  });

  it('parses Retry-After seconds form', () => {
    const a = new GenericAdapter({ id: 'p', windows: [W1] });
    const obs = a.parseResponse({ headers: { 'retry-after': '30' } });
    expect(obs.retryAfterMs).toBe(30_000);
  });

  it('parses Retry-After HTTP-date form', () => {
    const a = new GenericAdapter({ id: 'p', windows: [W1] });
    const future = new Date(Date.now() + 5_000).toUTCString();
    const obs = a.parseResponse({ headers: { 'retry-after': future } });
    expect(obs.retryAfterMs).toBeGreaterThan(0);
  });

  it('429 yields rate-limited classification and ban hint', () => {
    const a = new GenericAdapter({ id: 'p', windows: [W1] });
    expect(a.classifyError({ status: 429 })).toBe('rate-limited');
    const obs = a.parseResponse({ status: 429, headers: { 'retry-after': '10' } });
    expect(obs.banUntilMs).toBeDefined();
    expect(obs.retryAfterMs).toBe(10_000);
  });

  it('418 yields banned classification', () => {
    const a = new GenericAdapter({ id: 'p', windows: [W1] });
    expect(a.classifyError({ status: 418 })).toBe('banned');
  });

  it('5xx is transient, 4xx is permanent (excluding rate-limit codes)', () => {
    const a = new GenericAdapter({ id: 'p', windows: [W1] });
    expect(a.classifyError({ status: 500 })).toBe('transient');
    expect(a.classifyError({ status: 401 })).toBe('permanent');
  });

  it('uses provided scopeStrategy function', () => {
    const fn = vi.fn(() => 'tenant-42');
    const a = new GenericAdapter({ id: 'p', windows: [W1], scopeStrategy: fn });
    expect(a.resolveScope(makeReq())).toBe('p:tenant-42');
    expect(fn).toHaveBeenCalled();
  });

  it('scopeStrategy=account uses meta.account, defaults to "default"', () => {
    const a = new GenericAdapter({ id: 'p', windows: [W1], scopeStrategy: 'account' });
    expect(a.resolveScope(makeReq({ meta: { account: 'acct1' } }))).toBe('p:account:acct1');
    expect(a.resolveScope(makeReq())).toBe('p:account:default');
  });

  it('throws on duplicate window id', () => {
    expect(() => new GenericAdapter({ id: 'p', windows: [W1, W1] })).toThrow(ConfigurationError);
  });

  it('classifyError returns unknown for non-HTTP errors', () => {
    const a = new GenericAdapter({ id: 'p', windows: [W1] });
    expect(a.classifyError(new Error('boom'))).toBe('unknown');
    expect(a.classifyError({})).toBe('unknown');
  });

  it('parses array-valued headers (Node fetch quirk)', () => {
    const a = new GenericAdapter({
      id: 'p',
      windows: [W1],
      usageHeaders: [{ name: 'x-used', windowId: '1m' }],
    });
    const obs = a.parseResponse({ headers: { 'x-used': ['77', '99'] } });
    expect(obs.usage?.[0]?.observedWeight).toBe(77);
  });
});

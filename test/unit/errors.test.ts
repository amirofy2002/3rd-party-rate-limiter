import { describe, expect, it } from 'vitest';
import {
  BannedError,
  ConfigurationError,
  ProviderExecutionError,
  QueueFullError,
  RateLimitError,
  RateLimiterError,
  RequestTimeoutError,
  StoreUnavailableError,
} from '../../src/errors.js';

describe('RateLimiterError subclasses', () => {
  const cases = [
    { ctor: RateLimitError, code: 'RATE_LIMITED' },
    { ctor: QueueFullError, code: 'QUEUE_FULL' },
    { ctor: RequestTimeoutError, code: 'REQUEST_TIMEOUT' },
    { ctor: BannedError, code: 'PROVIDER_BANNED' },
    { ctor: ProviderExecutionError, code: 'PROVIDER_EXECUTION_FAILED' },
    { ctor: StoreUnavailableError, code: 'STORE_UNAVAILABLE' },
    { ctor: ConfigurationError, code: 'INVALID_CONFIG' },
  ] as const;

  it.each(cases)('$ctor.name is instanceof RateLimiterError and Error with code $code', ({ ctor, code }) => {
    const err = new ctor();
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RateLimiterError);
    expect(err).toBeInstanceOf(ctor);
    expect(err.code).toBe(code);
    expect(err.name).toBe(ctor.name);
  });

  it('preserves cause chain', () => {
    const root = new Error('boom');
    const err = new ProviderExecutionError('wrapped', { cause: root });
    expect(err.cause).toBe(root);
  });

  it('toJSON returns code, provider, scope, endpoint, requestId', () => {
    const err = new RateLimitError('nope', {
      provider: 'binance',
      scope: 'binance:acct:abc',
      endpoint: '/api/v3/order',
      requestId: 'req-1',
      retryAfterMs: 1234,
    });
    const json = JSON.parse(JSON.stringify(err)) as Record<string, unknown>;
    expect(json).toMatchObject({
      name: 'RateLimitError',
      code: 'RATE_LIMITED',
      message: 'nope',
      provider: 'binance',
      scope: 'binance:acct:abc',
      endpoint: '/api/v3/order',
      requestId: 'req-1',
      retryAfterMs: 1234,
    });
  });

  it('toJSON omits undefined fields', () => {
    const err = new QueueFullError();
    const json = err.toJSON();
    expect('provider' in json).toBe(false);
    expect('scope' in json).toBe(false);
    expect('retryAfterMs' in json).toBe(false);
  });

  it('toJSON serializes nested RateLimiterError cause', () => {
    const inner = new StoreUnavailableError('redis down');
    const outer = new ProviderExecutionError('upstream', { cause: inner });
    const json = outer.toJSON();
    expect(json.cause).toMatchObject({ code: 'STORE_UNAVAILABLE', message: 'redis down' });
  });

  it('BannedError.retryAfterMs is undefined when not supplied (no falsy 0 bug)', () => {
    const err = new BannedError();
    expect(err.retryAfterMs).toBeUndefined();
  });

  it('captures stack trace', () => {
    const err = new RateLimitError();
    expect(typeof err.stack).toBe('string');
    expect(err.stack).toContain('RateLimitError');
  });
});

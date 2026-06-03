import { describe, expect, it, vi } from 'vitest';
import { LuaLoader, type RedisLike } from '../../src/storage/lua-loader.js';
import { ALL_SCRIPTS } from '../../src/storage/redis-scripts.js';
import { StoreUnavailableError } from '../../src/errors.js';

const ok = Promise.resolve.bind(Promise);

const makeRedis = (overrides: Partial<RedisLike> = {}): RedisLike => ({
  script: vi.fn((_sub: 'LOAD', src: string) => Promise.resolve(`sha-${src.length}`)) as RedisLike['script'],
  evalsha: vi.fn(() => Promise.resolve([1, 0, 0, 0])) as RedisLike['evalsha'],
  eval: vi.fn(() => Promise.resolve([1, 0, 0, 0])) as RedisLike['eval'],
  ...overrides,
});

describe('LuaLoader', () => {
  it('loadAll caches SHAs for every bundled script', async () => {
    const redis = makeRedis();
    const loader = new LuaLoader(redis);
    await loader.loadAll();
    for (const name of Object.keys(ALL_SCRIPTS) as Array<keyof typeof ALL_SCRIPTS>) {
      expect(loader.shaFor(name)).toBeDefined();
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const scriptFn = redis.script as ReturnType<typeof vi.fn>;
    expect(scriptFn.mock.calls.length).toBe(Object.keys(ALL_SCRIPTS).length);
  });

  it('run uses cached SHA', async () => {
    const redis = makeRedis();
    const loader = new LuaLoader(redis);
    await loader.loadAll();
    await loader.run('refund', ['k1'], []);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const evalshaFn = redis.evalsha as ReturnType<typeof vi.fn>;
    expect(evalshaFn).toHaveBeenCalledTimes(1);
  });

  it('NOSCRIPT triggers reload + retry, then EVAL fallback', async () => {
    const redis = makeRedis({
      evalsha: vi
        .fn()
        .mockImplementationOnce(() => Promise.reject(new Error('NOSCRIPT no script')))
        .mockImplementationOnce(() => Promise.reject(new Error('NOSCRIPT still missing'))) as RedisLike['evalsha'],
      eval: vi.fn(() => ok([1, 0, 0, 0])) as RedisLike['eval'],
    });
    const loader = new LuaLoader(redis);
    await loader.loadAll();
    const result = await loader.run('refund', ['k1'], []);
    expect(result).toEqual([1, 0, 0, 0]);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const evalFn = redis.eval as ReturnType<typeof vi.fn>;
    expect(evalFn).toHaveBeenCalled();
  });

  it('non-NOSCRIPT error propagates', async () => {
    const redis = makeRedis({
      evalsha: vi.fn(() => Promise.reject(new Error('CONNREFUSED'))) as RedisLike['evalsha'],
    });
    const loader = new LuaLoader(redis);
    await loader.loadAll();
    await expect(loader.run('refund', ['k1'], [])).rejects.toThrow(/CONNREFUSED/);
  });

  it('SCRIPT LOAD failure becomes StoreUnavailableError', async () => {
    const redis = makeRedis({
      script: vi.fn(() => Promise.reject(new Error('redis down'))) as RedisLike['script'],
    });
    const loader = new LuaLoader(redis);
    await expect(loader.loadAll()).rejects.toBeInstanceOf(StoreUnavailableError);
  });

  it('every bundled script is non-empty and under 4KB', () => {
    for (const [name, src] of Object.entries(ALL_SCRIPTS)) {
      expect(src.length, name).toBeGreaterThan(0);
      expect(src.length, name).toBeLessThan(4_096);
    }
  });
});

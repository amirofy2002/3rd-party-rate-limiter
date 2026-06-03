import { describe, expect, it } from 'vitest';
import {
  AlgorithmRegistry,
  createDefaultRegistry,
  DEFAULT_ALGORITHM,
} from '../../src/algorithms/registry.js';
import type { RateAlgorithm } from '../../src/algorithms/algorithm.interface.js';
import { ConfigurationError } from '../../src/errors.js';
import type { RateWindow } from '../../src/types.js';

const dummyAlgo = (name: string): RateAlgorithm => ({
  name: name as RateAlgorithm['name'],
  init: () => ({}),
  tryConsume: (_, _w, _win, _now) => ({
    allowed: true,
    current: 0,
    remaining: 0,
    retryAfterMs: 0,
    nextState: {},
  }),
  refund: (s) => s as object,
  getUsage: () => 0,
  estimateRetryAfter: () => 0,
});

const sampleWindow = (algorithm: RateWindow['algorithm']): RateWindow => ({
  id: 'w',
  windowMs: 1_000,
  maxWeight: 100,
  algorithm,
});

describe('AlgorithmRegistry', () => {
  it('default registry resolves sliding and fixed', () => {
    const reg = createDefaultRegistry();
    expect(reg.get('sliding-window-counter').name).toBe('sliding-window-counter');
    expect(reg.get('fixed-window').name).toBe('fixed-window');
  });

  it('unknown name throws ConfigurationError', () => {
    const reg = createDefaultRegistry();
    expect(() => reg.get('does-not-exist')).toThrow(ConfigurationError);
  });

  it('token-bucket throws a roadmap-aware ConfigurationError', () => {
    const reg = createDefaultRegistry();
    try {
      reg.get('token-bucket');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigurationError);
      expect((err as Error).message).toMatch(/v2/);
    }
  });

  it('custom algorithm is registered and resolvable', () => {
    const reg = new AlgorithmRegistry();
    const algo = dummyAlgo('sliding-window-counter');
    reg.register(algo);
    const r = reg.get('sliding-window-counter');
    // tryConsume returns the dummy shape.
    const out = r.tryConsume({}, 1, sampleWindow('sliding-window-counter'), 0);
    expect(out.allowed).toBe(true);
  });

  it('duplicate register throws unless override: true', () => {
    const reg = createDefaultRegistry();
    expect(() => reg.register(dummyAlgo('sliding-window-counter'))).toThrow(ConfigurationError);
    expect(() => reg.register(dummyAlgo('sliding-window-counter'), { override: true })).not.toThrow();
  });

  it('list and has reflect registration state', () => {
    const reg = createDefaultRegistry();
    expect(reg.has('fixed-window')).toBe(true);
    expect(reg.list()).toEqual(expect.arrayContaining(['fixed-window', 'sliding-window-counter']));
  });

  it('DEFAULT_ALGORITHM is sliding-window-counter', () => {
    expect(DEFAULT_ALGORITHM).toBe('sliding-window-counter');
  });

  it('per-call instance does not share state across calls', () => {
    const a = createDefaultRegistry();
    const b = createDefaultRegistry();
    a.register(dummyAlgo('fixed-window'), { override: true });
    expect(b.get('fixed-window').name).toBe('fixed-window');
    // b's instance is the real fixed-window, not the dummy.
    expect(b.get('fixed-window') === a.get('fixed-window')).toBe(false);
  });
});

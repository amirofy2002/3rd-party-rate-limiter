/**
 * Lua-free fake Redis sufficient for `RedisStore` unit tests.
 *
 * Scripts loaded via `SCRIPT LOAD` are matched against the bundled sources
 * in `redis-scripts.ts` and dispatched to JS implementations that mirror
 * the Lua logic. This is *not* a complete Redis emulation — only the
 * operations our scripts exercise are implemented.
 */
import { createHash } from 'node:crypto';
import {
  ALL_SCRIPTS,
  CONSUME_FIXED_LUA,
  CONSUME_SLIDING_LUA,
  GET_BAN_LUA,
  REFUND_LUA,
  SET_BAN_LUA,
} from '../../src/storage/redis-scripts.js';

interface HashEntry {
  kind: 'hash';
  fields: Map<string, string>;
  expiresAtMs?: number;
}
interface StringEntry {
  kind: 'string';
  value: string;
  expiresAtMs?: number;
}
type Entry = HashEntry | StringEntry;

export interface FakeRedis {
  script(subcommand: 'LOAD', source: string): Promise<string>;
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  // Server-side Lua execution. Method name is dictated by the Redis protocol.
  // eslint-disable-next-line @typescript-eslint/method-signature-style
  eval: (source: string, numKeys: number, ...args: (string | number)[]) => Promise<unknown>;
  ping(): Promise<string>;
  del(key: string): Promise<number>;
  hset(key: string, ...fieldsAndValues: string[]): Promise<number>;
  advance(ms: number): void;
}

export function fakeRedis(): FakeRedis {
  const data = new Map<string, Entry>();
  const shaToSource = new Map<string, string>();
  let virtualNow = 0;

  const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

  const getEntry = (key: string): Entry | undefined => {
    const e = data.get(key);
    if (!e) return undefined;
    if (e.expiresAtMs !== undefined && e.expiresAtMs <= virtualNow) {
      data.delete(key);
      return undefined;
    }
    return e;
  };

  const hget = (key: string, field: string): string | undefined => {
    const e = getEntry(key);
    if (!e || e.kind !== 'hash') return undefined;
    return e.fields.get(field);
  };

  const hset = (key: string, fields: ReadonlyArray<[string, string]>): void => {
    let e = getEntry(key);
    if (!e || e.kind !== 'hash') {
      e = { kind: 'hash', fields: new Map() };
      data.set(key, e);
    }
    for (const [k, v] of fields) e.fields.set(k, v);
  };

  const pexpire = (key: string, ms: number): void => {
    const e = getEntry(key);
    if (!e) return;
    e.expiresAtMs = virtualNow + ms;
  };

  const del = (key: string): number => {
    return data.delete(key) ? 1 : 0;
  };

  const setPx = (key: string, value: string, pxMs: number): void => {
    data.set(key, { kind: 'string', value, expiresAtMs: virtualNow + pxMs });
  };

  const getStr = (key: string): string | undefined => {
    const e = getEntry(key);
    if (!e || e.kind !== 'string') return undefined;
    return e.value;
  };

  const resolveNow = (raw: string): number => {
    const n = Number(raw);
    return n < 0 ? virtualNow : n;
  };

  const runConsumeFixed = (keys: string[], args: string[]): [number, number, number, number] => {
    const [windowMsS, maxWeightS, weightS, nowMsS, ttlMsS] = args;
    const windowMs = Number(windowMsS);
    const maxWeight = Number(maxWeightS);
    const weight = Number(weightS);
    const nowMs = resolveNow(nowMsS!);
    const ttlMs = Number(ttlMsS);
    const [usageKey, reservationKey] = keys;

    const startRaw = hget(usageKey!, 'start');
    const countRaw = hget(usageKey!, 'count');
    let start = startRaw !== undefined ? Number(startRaw) : nowMs - (nowMs % windowMs);
    let count = countRaw !== undefined ? Number(countRaw) : 0;
    if (nowMs - start >= windowMs) {
      start = nowMs - (nowMs % windowMs);
      count = 0;
    }
    if (weight > maxWeight) {
      return [0, count, Math.max(0, maxWeight - count), -1];
    }
    if (count + weight > maxWeight) {
      const retry = Math.max(1, start + windowMs - nowMs);
      return [0, count, Math.max(0, maxWeight - count), retry];
    }
    count += weight;
    hset(usageKey!, [
      ['start', String(start)],
      ['count', String(count)],
    ]);
    pexpire(usageKey!, windowMs * 2);
    if (reservationKey) {
      hset(reservationKey, [
        ['weight', String(weight)],
        ['windowKey', usageKey!],
      ]);
      pexpire(reservationKey, ttlMs);
    }
    return [1, count, Math.max(0, maxWeight - count), 0];
  };

  const runConsumeSliding = (keys: string[], args: string[]): [number, number, number, number] => {
    const [windowMsS, maxWeightS, weightS, nowMsS, ttlMsS] = args;
    const windowMs = Number(windowMsS);
    const maxWeight = Number(maxWeightS);
    const weight = Number(weightS);
    const nowMs = resolveNow(nowMsS!);
    const ttlMs = Number(ttlMsS);
    const [usageKey, reservationKey] = keys;

    const curStartRaw = hget(usageKey!, 'cur_start');
    const curCountRaw = hget(usageKey!, 'cur_count');
    const prevCountRaw = hget(usageKey!, 'prev_count');
    let curStart = curStartRaw !== undefined ? Number(curStartRaw) : nowMs - (nowMs % windowMs);
    let curCount = curCountRaw !== undefined ? Number(curCountRaw) : 0;
    let prevCount = prevCountRaw !== undefined ? Number(prevCountRaw) : 0;
    const elapsed = nowMs - curStart;
    if (elapsed >= 2 * windowMs) {
      curStart = nowMs - (nowMs % windowMs);
      curCount = 0;
      prevCount = 0;
    } else if (elapsed >= windowMs) {
      curStart += windowMs;
      prevCount = curCount;
      curCount = 0;
    }
    const elapsedInCurrent = nowMs - curStart;
    const overlap = Math.max(0, 1 - elapsedInCurrent / windowMs);
    const usage = prevCount * overlap + curCount;

    if (weight > maxWeight) {
      return [0, Math.round(usage), Math.max(0, maxWeight - Math.round(usage)), -1];
    }
    if (usage + weight > maxWeight + 0.000_001) {
      let retry: number;
      if (prevCount <= 0) {
        retry = Math.max(1, curStart + windowMs - nowMs);
      } else {
        const allowance = maxWeight - curCount - weight;
        if (allowance < 0) {
          retry = Math.max(1, curStart + windowMs - nowMs);
        } else {
          const allowedOverlap = allowance / prevCount;
          const required = (1 - allowedOverlap) * windowMs - elapsedInCurrent;
          retry = Math.max(1, Math.ceil(required));
        }
      }
      return [0, Math.round(usage), Math.max(0, maxWeight - Math.round(usage)), retry];
    }
    curCount += weight;
    hset(usageKey!, [
      ['cur_start', String(curStart)],
      ['cur_count', String(curCount)],
      ['prev_count', String(prevCount)],
    ]);
    pexpire(usageKey!, windowMs * 4);
    if (reservationKey) {
      hset(reservationKey, [
        ['weight', String(weight)],
        ['windowKey', usageKey!],
      ]);
      pexpire(reservationKey, ttlMs);
    }
    const newUsage = prevCount * overlap + curCount;
    return [1, Math.round(newUsage), Math.max(0, maxWeight - Math.round(newUsage)), 0];
  };

  const runRefund = (keys: string[]): number => {
    const [reservationKey] = keys;
    const weight = Number(hget(reservationKey!, 'weight') ?? '0');
    const windowKey = hget(reservationKey!, 'windowKey');
    if (!windowKey || weight <= 0) {
      del(reservationKey!);
      return 0;
    }
    const hasSliding = hget(windowKey, 'cur_count') !== undefined;
    if (hasSliding) {
      const cur = Number(hget(windowKey, 'cur_count') ?? '0');
      const fromCur = Math.min(cur, weight);
      const remaining = weight - fromCur;
      const prev = Number(hget(windowKey, 'prev_count') ?? '0');
      hset(windowKey, [
        ['cur_count', String(cur - fromCur)],
        ['prev_count', String(Math.max(0, prev - remaining))],
      ]);
    } else {
      const count = Number(hget(windowKey, 'count') ?? '0');
      hset(windowKey, [['count', String(Math.max(0, count - weight))]]);
    }
    del(reservationKey!);
    return 1;
  };

  const runSetBan = (keys: string[], args: string[]): number => {
    const [banKey] = keys;
    const untilMs = Number(args[0]);
    const nowMs = resolveNow(args[1]!);
    if (untilMs <= nowMs) {
      del(banKey!);
      return 0;
    }
    setPx(banKey!, String(untilMs), untilMs - nowMs);
    return 1;
  };

  const runGetBan = (keys: string[], args: string[]): number | null => {
    const [banKey] = keys;
    const nowMs = resolveNow(args[0]!);
    const v = getStr(banKey!);
    if (!v) return null;
    const untilMs = Number(v);
    if (!Number.isFinite(untilMs) || untilMs <= nowMs) {
      del(banKey!);
      return null;
    }
    return untilMs;
  };

  const dispatch = (source: string, keys: string[], args: string[]): unknown => {
    if (source === CONSUME_FIXED_LUA) return runConsumeFixed(keys, args);
    if (source === CONSUME_SLIDING_LUA) return runConsumeSliding(keys, args);
    if (source === REFUND_LUA) return runRefund(keys);
    if (source === SET_BAN_LUA) return runSetBan(keys, args);
    if (source === GET_BAN_LUA) return runGetBan(keys, args);
    throw new Error('fakeRedis: unknown script source');
  };

  const evalImpl = (source: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> => {
    const keys = args.slice(0, numKeys).map(String);
    const rest = args.slice(numKeys).map(String);
    return Promise.resolve(dispatch(source, keys, rest));
  };

  const api: FakeRedis = {
    script(_sub, source) {
      const sha = sha1(source);
      shaToSource.set(sha, source);
      const found = Object.values(ALL_SCRIPTS).some((s) => s === source);
      if (!found) return Promise.reject(new Error('fakeRedis: script not recognised'));
      return Promise.resolve(sha);
    },
    evalsha(sha, numKeys, ...args) {
      const source = shaToSource.get(sha);
      if (!source) {
        const err = new Error('NOSCRIPT No matching script. Please use server-side Lua.');
        Object.assign(err, { code: 'NOSCRIPT' });
        return Promise.reject(err);
      }
      return evalImpl(source, numKeys, ...args);
    },
    eval: evalImpl,
    ping() {
      return Promise.resolve('PONG');
    },
    del(key) {
      return Promise.resolve(del(key));
    },
    hset(key, ...fieldsAndValues) {
      const pairs: Array<[string, string]> = [];
      for (let i = 0; i < fieldsAndValues.length; i += 2) {
        pairs.push([fieldsAndValues[i]!, fieldsAndValues[i + 1]!]);
      }
      hset(key, pairs);
      return Promise.resolve(pairs.length);
    },
    advance(ms: number) {
      virtualNow += Math.max(0, ms);
    },
  };
  return api;
}

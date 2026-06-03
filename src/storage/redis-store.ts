import { ConfigurationError, StoreUnavailableError } from '../errors.js';
import type {
  ProviderId,
  RateWindow,
  Reservation,
  ScopeKey,
} from '../types.js';
import { LuaLoader, type RedisLike } from './lua-loader.js';
import type {
  ConsumeRequest,
  ConsumeResult,
  PerWindowOutcome,
  RateLimitStore,
  ReconcileRequest,
  RefundRequest,
  ReserveRequest,
} from './store.interface.js';

export interface RedisStoreOptions {
  /** Bring-your-own ioredis client. Not disposed by the store. */
  client: RedisLike & { ping?: () => Promise<string> };
  /** Key namespace. Default `'rl:'`. */
  keyPrefix?: string;
  /** Use Redis `TIME` instead of caller-supplied `nowMs`. Default `true`. */
  useServerTime?: boolean;
  /** Default reservation TTL in ms when caller omits one. */
  defaultReservationTtlMs?: number;
  /** Maximum reservation TTL accepted. Clamps callers. */
  maxReservationTtlMs?: number;
}

const DEFAULT_PREFIX = 'rl:';
const DEFAULT_TTL_MS = 30_000;
const MAX_TTL_MS = 60 * 60 * 1_000; // 1 hour

/**
 * Redis-backed implementation of `RateLimitStore`.
 *
 * Uses the Lua scripts from `redis-scripts.ts`. Reservations are written
 * as separate hash keys with PX TTL so an expired reservation cannot leak
 * capacity.
 *
 * Hash tags on keys (`rl:{provider:scope}:...`) keep all keys for one scope
 * on the same Redis Cluster slot — required for atomic multi-key Lua.
 *
 * v1 limitation: multi-window consume runs one script per window with a
 * client-side rollback on the first denial. A full `consume_multi` Lua that
 * simulates and commits in one round-trip is on the v2 roadmap.
 */
export class RedisStore implements RateLimitStore {
  private readonly client: RedisLike & { ping?: () => Promise<string> };
  private readonly loader: LuaLoader;
  private readonly keyPrefix: string;
  private readonly useServerTime: boolean;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly reservationKindByKey = new Map<string, 'fixed-window' | 'sliding-window-counter'>();
  private reservationSeq = 0;
  private loaded = false;

  public constructor(opts: RedisStoreOptions) {
    if (!opts.client) {
      throw new ConfigurationError('RedisStore: `client` is required');
    }
    this.client = opts.client;
    this.loader = new LuaLoader(opts.client);
    this.keyPrefix = opts.keyPrefix ?? DEFAULT_PREFIX;
    this.useServerTime = opts.useServerTime !== false;
    this.defaultTtlMs = opts.defaultReservationTtlMs ?? DEFAULT_TTL_MS;
    this.maxTtlMs = opts.maxReservationTtlMs ?? MAX_TTL_MS;
  }

  public async consume(req: ConsumeRequest): Promise<ConsumeResult> {
    if (!req.windows || req.windows.length === 0) {
      throw new ConfigurationError('RedisStore.consume: windows must be non-empty', {
        provider: req.provider,
        scope: req.scope,
      });
    }
    if (req.weight < 0) {
      throw new ConfigurationError('RedisStore.consume: weight must be non-negative', {
        provider: req.provider,
        scope: req.scope,
      });
    }
    await this.ensureLoaded();
    if (req.weight === 0) {
      const perWindow: PerWindowOutcome[] = [];
      for (const w of req.windows) {
        const usage = await this.getUsage({
          provider: req.provider,
          scope: req.scope,
          window: w,
          nowMs: req.nowMs,
        });
        perWindow.push({ windowId: w.id, current: usage, remaining: Math.max(0, w.maxWeight - usage) });
      }
      return { allowed: true, perWindow };
    }

    const ttlMs = Math.min(this.maxTtlMs, req.ttlMs ?? this.defaultTtlMs);
    const reservationId = req.reservationId ?? this.nextReservationId();
    const reservationKey = this.reservationKey(req.provider, req.scope, reservationId);

    // Simulate atomic multi-window consume by running scripts in sequence,
    // tracking which windows succeeded so we can roll back on failure.
    const committed: { window: RateWindow; usageKey: string }[] = [];
    const perWindow: PerWindowOutcome[] = [];
    let denialRetryAfter: number | undefined;
    let limitingWindowId: string | undefined;
    for (const window of req.windows) {
      const usageKey = this.usageKey(req.provider, req.scope, window.id);
      const script = scriptForAlgorithm(window.algorithm);
      const result = await this.runConsume(
        script,
        usageKey,
        reservationKey,
        window,
        req.weight,
        req.nowMs,
        ttlMs,
      );
      perWindow.push({
        windowId: window.id,
        current: result.current,
        remaining: result.remaining,
      });
      if (result.allowed) {
        committed.push({ window, usageKey });
      } else {
        if (denialRetryAfter === undefined || result.retryAfterMs > denialRetryAfter) {
          denialRetryAfter = result.retryAfterMs;
          limitingWindowId = window.id;
        }
        // Roll back any previously committed windows. The refund script
        // releases the reservation in one call; we trust prior commits to
        // be reflected in the reservation hash.
        if (committed.length > 0) {
          await this.loader.run('refund', [reservationKey], []);
        }
        const denyResult: ConsumeResult = { allowed: false, perWindow };
        if (denialRetryAfter !== undefined) denyResult.retryAfterMs = denialRetryAfter;
        if (limitingWindowId !== undefined) denyResult.limitingWindowId = limitingWindowId;
        return denyResult;
      }
    }

    // Track algorithm so refund knows which schema to use.
    for (const c of committed) {
      this.reservationKindByKey.set(reservationKey, c.window.algorithm === 'fixed-window' ? 'fixed-window' : 'sliding-window-counter');
    }

    return { allowed: true, reservationId, perWindow };
  }

  public async getUsage(args: {
    provider: ProviderId;
    scope: ScopeKey;
    window: RateWindow;
    nowMs: number;
  }): Promise<number> {
    await this.ensureLoaded();
    const usageKey = this.usageKey(args.provider, args.scope, args.window.id);
    // Reuse the consume script with weight=0 so the rolling/expiry logic runs.
    const script = scriptForAlgorithm(args.window.algorithm);
    const result = await this.runConsume(script, usageKey, '', args.window, 0, args.nowMs, 0);
    return result.current;
  }

  public async refund(req: RefundRequest): Promise<void> {
    await this.ensureLoaded();
    const reservationKey = this.reservationKey(req.provider, req.scope, req.reservationId);
    try {
      await this.loader.run('refund', [reservationKey], []);
    } catch (err) {
      throw new StoreUnavailableError('RedisStore.refund failed', { cause: err });
    }
    this.reservationKindByKey.delete(reservationKey);
  }

  public async reconcile(req: ReconcileRequest): Promise<void> {
    // Reconciliation in Redis is best-effort: bump or refund per window.
    await this.ensureLoaded();
    const { observation, windows, nowMs } = req;
    for (const w of windows) {
      const reported = observation.usedByWindow[w.id];
      if (reported === undefined) continue;
      const local = await this.getUsage({
        provider: observation.provider,
        scope: observation.scope,
        window: w,
        nowMs,
      });
      const diff = reported - local;
      if (diff > 0) {
        // Push capacity up without a reservation handle: synthesize a transient one.
        const dummyId = `recon-${this.nextReservationId()}`;
        const reservationKey = this.reservationKey(observation.provider, observation.scope, dummyId);
        const script = scriptForAlgorithm(w.algorithm);
        await this.runConsume(
          script,
          this.usageKey(observation.provider, observation.scope, w.id),
          reservationKey,
          w,
          diff,
          nowMs,
          1, // immediate expire — we don't want to keep it
        );
      } else if (diff < 0 && observation.authoritative) {
        // No general "subtract" script — re-issue setBan if banUntilMs known,
        // otherwise just write the value directly. For simplicity, set the
        // current count via HSET (best-effort, non-atomic against in-flight ops).
        const usageKey = this.usageKey(observation.provider, observation.scope, w.id);
        const target = Math.max(0, Math.floor(reported));
        if (w.algorithm === 'fixed-window') {
          await this.directHSet(usageKey, ['count', String(target)]);
        } else {
          await this.directHSet(usageKey, ['cur_count', String(target), 'prev_count', '0']);
        }
      }
    }
    if (observation.banUntilMs !== undefined && observation.banUntilMs > nowMs) {
      await this.setBan({
        provider: observation.provider,
        scope: observation.scope,
        untilMs: observation.banUntilMs,
        nowMs,
      });
    }
  }

  public async setBan(args: {
    provider: ProviderId;
    scope: ScopeKey;
    untilMs: number;
    nowMs: number;
  }): Promise<void> {
    await this.ensureLoaded();
    try {
      await this.loader.run(
        'setBan',
        [this.banKey(args.provider, args.scope)],
        [String(args.untilMs), this.timeArg(args.nowMs)],
      );
    } catch (err) {
      throw new StoreUnavailableError('RedisStore.setBan failed', { cause: err });
    }
  }

  public async getBan(args: {
    provider: ProviderId;
    scope: ScopeKey;
    nowMs: number;
  }): Promise<number | null> {
    await this.ensureLoaded();
    let raw: unknown;
    try {
      raw = await this.loader.run(
        'getBan',
        [this.banKey(args.provider, args.scope)],
        [this.timeArg(args.nowMs)],
      );
    } catch (err) {
      throw new StoreUnavailableError('RedisStore.getBan failed', { cause: err });
    }
    if (raw === null || raw === undefined) return null;
    const num = typeof raw === 'string' ? Number(raw) : (raw as number);
    return Number.isFinite(num) ? num : null;
  }

  public async clearBan(args: { provider: ProviderId; scope: ScopeKey }): Promise<void> {
    const r = this.client as unknown as { del: (k: string) => Promise<number> };
    try {
      await r.del(this.banKey(args.provider, args.scope));
    } catch (err) {
      throw new StoreUnavailableError('RedisStore.clearBan failed', { cause: err });
    }
  }

  public async reserve(req: ReserveRequest): Promise<Reservation> {
    await this.ensureLoaded();
    const id = this.nextReservationId();
    return {
      id,
      provider: req.provider,
      scope: req.scope,
      windowIds: req.windowIds,
      weight: req.weight,
      expiresAtMs: req.nowMs + Math.min(this.maxTtlMs, req.ttlMs),
    };
  }

  public async releaseReservation(args: {
    provider: ProviderId;
    scope: ScopeKey;
    reservationId: string;
    nowMs: number;
  }): Promise<void> {
    return this.refund({
      provider: args.provider,
      scope: args.scope,
      reservationId: args.reservationId,
      nowMs: args.nowMs,
    });
  }

  public async ping(): Promise<boolean> {
    const r = this.client as { ping?: () => Promise<string> };
    if (typeof r.ping !== 'function') return false;
    try {
      const result = await r.ping();
      return result === 'PONG' || typeof result === 'string';
    } catch {
      return false;
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      await this.loader.loadAll();
    } catch (err) {
      throw new StoreUnavailableError('RedisStore: failed to preload Lua scripts', { cause: err });
    }
    this.loaded = true;
  }

  private async runConsume(
    script: 'consumeSliding' | 'consumeFixed',
    usageKey: string,
    reservationKey: string,
    window: RateWindow,
    weight: number,
    nowMs: number,
    ttlMs: number,
  ): Promise<{ allowed: boolean; current: number; remaining: number; retryAfterMs: number }> {
    let result: unknown;
    try {
      result = await this.loader.run(
        script,
        [usageKey, reservationKey],
        [
          String(window.windowMs),
          String(window.maxWeight),
          String(weight),
          this.timeArg(nowMs),
          String(Math.max(1, ttlMs)),
        ],
      );
    } catch (err) {
      throw new StoreUnavailableError(`RedisStore: ${script} failed`, { cause: err });
    }
    if (!Array.isArray(result)) {
      throw new StoreUnavailableError(`RedisStore: malformed ${script} response`);
    }
    const [allowedRaw, currentRaw, remainingRaw, retryRaw] = result as [
      number,
      number,
      number,
      number,
    ];
    return {
      allowed: Number(allowedRaw) === 1,
      current: Number(currentRaw),
      remaining: Number(remainingRaw),
      retryAfterMs: Number(retryRaw),
    };
  }

  private async directHSet(key: string, fields: readonly string[]): Promise<void> {
    const r = this.client as unknown as { hset?: (k: string, ...args: string[]) => Promise<number> };
    if (typeof r.hset !== 'function') return;
    await r.hset(key, ...fields);
  }

  private usageKey(provider: ProviderId, scope: ScopeKey, windowId: string): string {
    return `${this.keyPrefix}{${provider}:${scope}}:${windowId}:usage`;
  }

  private banKey(provider: ProviderId, scope: ScopeKey): string {
    return `${this.keyPrefix}{${provider}:${scope}}:ban`;
  }

  private reservationKey(provider: ProviderId, scope: ScopeKey, id: string): string {
    return `${this.keyPrefix}{${provider}:${scope}}:res:${id}`;
  }

  private nextReservationId(): string {
    this.reservationSeq += 1;
    return `red-${Date.now().toString(36)}-${this.reservationSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private timeArg(nowMs: number): string {
    return this.useServerTime ? '-1' : String(nowMs);
  }
}

function scriptForAlgorithm(algo: RateWindow['algorithm']): 'consumeSliding' | 'consumeFixed' {
  if (algo === 'fixed-window') return 'consumeFixed';
  if (algo === 'sliding-window-counter') return 'consumeSliding';
  throw new ConfigurationError(`RedisStore: algorithm ${algo} not supported by Redis backend`);
}

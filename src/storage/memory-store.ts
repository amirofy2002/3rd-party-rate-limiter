import { ConfigurationError } from '../errors.js';
import type { ProviderId, RateWindow, Reservation, ScopeKey } from '../types.js';
import type {
  ConsumeRequest,
  ConsumeResult,
  PerWindowOutcome,
  RateLimitStore,
  ReconcileRequest,
  RefundRequest,
  ReserveRequest,
} from './store.interface.js';

interface FixedWindowState {
  kind: 'fixed-window';
  windowStartMs: number;
  count: number;
}

interface SlidingWindowState {
  kind: 'sliding-window-counter';
  currentWindowStartMs: number;
  currentCount: number;
  previousCount: number;
}

interface TokenBucketState {
  kind: 'token-bucket';
  tokens: number;
  lastRefillMs: number;
}

type WindowState = FixedWindowState | SlidingWindowState | TokenBucketState;

interface StoredReservation extends Reservation {
  /** Windows the reservation actually consumed against (kept for refund). */
  windowSpecs: readonly RateWindow[];
  /** When false, the reservation has already been refunded/expired. */
  active: boolean;
}

/** Default reservation TTL when caller omits one. */
const DEFAULT_TTL_MS = 30_000;

/**
 * In-process `RateLimitStore`.
 *
 * - Per-scope async mutex serializes multi-window operations.
 * - All-or-nothing consume: proposed state computed for every window; either
 *   every window is committed or none.
 * - Reservations expire on their TTL; expired ones release their weight back
 *   to the relevant windows lazily during `cleanup()` and `getUsage()`.
 */
export class MemoryStore implements RateLimitStore {
  private readonly windowStates = new Map<string, WindowState>();
  private readonly bans = new Map<string, number>();
  private readonly reservations = new Map<string, StoredReservation>();
  private readonly scopeLocks = new Map<string, Promise<unknown>>();
  private reservationSeq = 0;

  public async consume(req: ConsumeRequest): Promise<ConsumeResult> {
    validateConsume(req);
    if (req.weight === 0) {
      return {
        allowed: true,
        perWindow: req.windows.map((w) => {
          const current = this.peekUsageInternal(req.provider, req.scope, w, req.nowMs);
          return {
            windowId: w.id,
            current,
            remaining: Math.max(0, w.maxWeight - current),
          };
        }),
      };
    }
    return this.withScopeLock(req.provider, req.scope, () => {
      this.expireDueReservations(req.nowMs);

      // Compute proposed deltas per window.
      const proposed: Array<{ window: RateWindow; nextState: WindowState }> = [];
      const denied: PerWindowOutcome[] = [];
      let denialRetryAfter: number | undefined;
      let limitingWindowId: string | undefined;

      for (const w of req.windows) {
        const key = stateKey(req.provider, req.scope, w.id);
        const cur = this.windowStates.get(key);
        const result = tryConsumeWindow(w, cur, req.weight, req.nowMs);
        if (!result.ok) {
          denied.push({
            windowId: w.id,
            current: result.currentAfterDeny,
            remaining: Math.max(0, w.maxWeight - result.currentAfterDeny),
          });
          if (denialRetryAfter === undefined || result.retryAfterMs > denialRetryAfter) {
            denialRetryAfter = result.retryAfterMs;
            limitingWindowId = w.id;
          }
        } else {
          proposed.push({ window: w, nextState: result.nextState });
        }
      }

      if (denied.length > 0) {
        // No commit. Return per-window snapshot for visibility.
        const perWindow: PerWindowOutcome[] = req.windows.map((w) => {
          const matched = denied.find((d) => d.windowId === w.id);
          if (matched) return matched;
          const current = this.peekUsageInternal(req.provider, req.scope, w, req.nowMs);
          return {
            windowId: w.id,
            current,
            remaining: Math.max(0, w.maxWeight - current),
          };
        });
        const denyResult: ConsumeResult = { allowed: false, perWindow };
        if (denialRetryAfter !== undefined) denyResult.retryAfterMs = denialRetryAfter;
        if (limitingWindowId !== undefined) denyResult.limitingWindowId = limitingWindowId;
        return denyResult;
      }

      // Commit.
      const reservationId = req.reservationId ?? this.nextReservationId();
      const ttl = req.ttlMs ?? DEFAULT_TTL_MS;
      for (const { window: w, nextState } of proposed) {
        this.windowStates.set(stateKey(req.provider, req.scope, w.id), nextState);
      }
      const reservation: StoredReservation = {
        id: reservationId,
        provider: req.provider,
        scope: req.scope,
        windowIds: proposed.map((p) => p.window.id),
        windowSpecs: proposed.map((p) => p.window),
        weight: req.weight,
        expiresAtMs: req.nowMs + ttl,
        active: true,
      };
      this.reservations.set(reservationId, reservation);

      const perWindow: PerWindowOutcome[] = proposed.map(({ window: w, nextState }) => {
        const used = currentUsage(nextState, w, req.nowMs);
        return {
          windowId: w.id,
          current: used,
          remaining: Math.max(0, w.maxWeight - used),
        };
      });
      return { allowed: true, reservationId, perWindow };
    });
  }

  public async getUsage(args: {
    provider: ProviderId;
    scope: ScopeKey;
    window: RateWindow;
    nowMs: number;
  }): Promise<number> {
    return this.withScopeLock(args.provider, args.scope, () => {
      this.expireDueReservations(args.nowMs);
      return this.peekUsageInternal(args.provider, args.scope, args.window, args.nowMs);
    });
  }

  public async refund(req: RefundRequest): Promise<void> {
    return this.withScopeLock(req.provider, req.scope, () => {
      const res = this.reservations.get(req.reservationId);
      if (!res || !res.active) return;
      if (res.provider !== req.provider || res.scope !== req.scope) return;
      this.releaseReservationWeight(res, req.nowMs);
    });
  }

  public async reconcile(req: ReconcileRequest): Promise<void> {
    const { observation, windows, nowMs } = req;
    if (!observation.authoritative && observation.usedByWindow) {
      // Non-authoritative observations are advisory; for memory store we only
      // adjust upward to be conservative.
    }
    return this.withScopeLock(observation.provider, observation.scope, () => {
      for (const w of windows) {
        const reported = observation.usedByWindow[w.id];
        if (reported === undefined) continue;
        const key = stateKey(observation.provider, observation.scope, w.id);
        const cur = this.windowStates.get(key);
        const localUsage = cur ? currentUsage(cur, w, nowMs) : 0;
        if (reported > localUsage) {
          this.windowStates.set(key, reconcileWindow(w, cur, reported, nowMs));
        } else if (observation.authoritative && reported < localUsage) {
          this.windowStates.set(key, reconcileWindow(w, cur, reported, nowMs));
        }
      }
      if (observation.banUntilMs !== undefined && observation.banUntilMs > nowMs) {
        this.bans.set(banKey(observation.provider, observation.scope), observation.banUntilMs);
      }
    });
  }

  public async setBan(args: {
    provider: ProviderId;
    scope: ScopeKey;
    untilMs: number;
    nowMs: number;
  }): Promise<void> {
    this.bans.set(banKey(args.provider, args.scope), args.untilMs);
    await Promise.resolve();
  }

  public async getBan(args: {
    provider: ProviderId;
    scope: ScopeKey;
    nowMs: number;
  }): Promise<number | null> {
    const key = banKey(args.provider, args.scope);
    const until = this.bans.get(key);
    await Promise.resolve();
    if (until === undefined) return null;
    if (until <= args.nowMs) {
      this.bans.delete(key);
      return null;
    }
    return until;
  }

  public async clearBan(args: { provider: ProviderId; scope: ScopeKey }): Promise<void> {
    this.bans.delete(banKey(args.provider, args.scope));
    await Promise.resolve();
  }

  public async reserve(req: ReserveRequest): Promise<Reservation> {
    return this.withScopeLock(req.provider, req.scope, () => {
      const id = this.nextReservationId();
      const reservation: StoredReservation = {
        id,
        provider: req.provider,
        scope: req.scope,
        windowIds: req.windowIds,
        windowSpecs: [],
        weight: req.weight,
        expiresAtMs: req.nowMs + req.ttlMs,
        active: true,
      };
      this.reservations.set(id, reservation);
      return reservation;
    });
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

  public async cleanup(nowMs: number): Promise<void> {
    this.expireDueReservations(nowMs);
    // Drop window states that have become irrelevant.
    for (const [key, state] of this.windowStates) {
      if (isWindowStateStale(state, nowMs)) {
        this.windowStates.delete(key);
      }
    }
    for (const [key, until] of this.bans) {
      if (until <= nowMs) this.bans.delete(key);
    }
    await Promise.resolve();
  }

  /** Test/debug — number of stored window state entries. */
  public _debugWindowStateCount(): number {
    return this.windowStates.size;
  }

  /** Test/debug — number of active reservations. */
  public _debugActiveReservationCount(): number {
    let n = 0;
    for (const r of this.reservations.values()) {
      if (r.active) n++;
    }
    return n;
  }

  private peekUsageInternal(
    provider: ProviderId,
    scope: ScopeKey,
    window: RateWindow,
    nowMs: number,
  ): number {
    const state = this.windowStates.get(stateKey(provider, scope, window.id));
    if (!state) return 0;
    return currentUsage(state, window, nowMs);
  }

  private expireDueReservations(nowMs: number): void {
    for (const res of this.reservations.values()) {
      if (!res.active) continue;
      if (res.expiresAtMs <= nowMs) {
        this.releaseReservationWeight(res, nowMs);
      }
    }
  }

  private releaseReservationWeight(res: StoredReservation, nowMs: number): void {
    for (const w of res.windowSpecs) {
      const key = stateKey(res.provider, res.scope, w.id);
      const cur = this.windowStates.get(key);
      if (!cur) continue;
      const updated = refundFromWindow(w, cur, res.weight, nowMs);
      this.windowStates.set(key, updated);
    }
    res.active = false;
  }

  private nextReservationId(): string {
    this.reservationSeq += 1;
    return `mem-${this.reservationSeq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private async withScopeLock<T>(
    provider: ProviderId,
    scope: ScopeKey,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    const key = `${provider}::${scope}`;
    const prev = this.scopeLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = prev.then(() => gate);
    this.scopeLocks.set(key, next);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.scopeLocks.get(key) === next) {
        this.scopeLocks.delete(key);
      }
    }
  }
}

function stateKey(provider: ProviderId, scope: ScopeKey, windowId: string): string {
  return `${provider}::${scope}::${windowId}`;
}

function banKey(provider: ProviderId, scope: ScopeKey): string {
  return `${provider}::${scope}`;
}

function validateConsume(req: ConsumeRequest): void {
  if (req.weight < 0) {
    throw new ConfigurationError('weight must be non-negative', { provider: req.provider, scope: req.scope });
  }
  if (!req.windows || req.windows.length === 0) {
    throw new ConfigurationError('windows must be non-empty', { provider: req.provider, scope: req.scope });
  }
}

interface AcceptResult {
  ok: true;
  nextState: WindowState;
}

interface DenyResult {
  ok: false;
  retryAfterMs: number;
  currentAfterDeny: number;
}

function tryConsumeWindow(
  w: RateWindow,
  state: WindowState | undefined,
  weight: number,
  nowMs: number,
): AcceptResult | DenyResult {
  switch (w.algorithm) {
    case 'fixed-window':
      return tryConsumeFixed(w, state as FixedWindowState | undefined, weight, nowMs);
    case 'sliding-window-counter':
      return tryConsumeSliding(w, state as SlidingWindowState | undefined, weight, nowMs);
    case 'token-bucket':
      return tryConsumeTokenBucket(w, state as TokenBucketState | undefined, weight, nowMs);
  }
}

function tryConsumeFixed(
  w: RateWindow,
  state: FixedWindowState | undefined,
  weight: number,
  nowMs: number,
): AcceptResult | DenyResult {
  const ws = state && state.windowStartMs + w.windowMs > nowMs
    ? state
    : { kind: 'fixed-window' as const, windowStartMs: nowMs - (nowMs % w.windowMs), count: 0 };
  const next = ws.count + weight;
  if (next > w.maxWeight) {
    const retryAfterMs = Math.max(1, ws.windowStartMs + w.windowMs - nowMs);
    return { ok: false, retryAfterMs, currentAfterDeny: ws.count };
  }
  return {
    ok: true,
    nextState: { kind: 'fixed-window', windowStartMs: ws.windowStartMs, count: next },
  };
}

function tryConsumeSliding(
  w: RateWindow,
  state: SlidingWindowState | undefined,
  weight: number,
  nowMs: number,
): AcceptResult | DenyResult {
  const advanced = advanceSliding(state, w, nowMs);
  const elapsedInWindow = nowMs - advanced.currentWindowStartMs;
  const overlap = Math.max(0, 1 - elapsedInWindow / w.windowMs);
  const estimatedUsage = advanced.previousCount * overlap + advanced.currentCount;
  if (estimatedUsage + weight > w.maxWeight) {
    const retryAfterMs = Math.max(1, w.windowMs - elapsedInWindow);
    return { ok: false, retryAfterMs, currentAfterDeny: Math.ceil(estimatedUsage) };
  }
  return {
    ok: true,
    nextState: {
      kind: 'sliding-window-counter',
      currentWindowStartMs: advanced.currentWindowStartMs,
      currentCount: advanced.currentCount + weight,
      previousCount: advanced.previousCount,
    },
  };
}

function advanceSliding(
  state: SlidingWindowState | undefined,
  w: RateWindow,
  nowMs: number,
): SlidingWindowState {
  if (!state) {
    return {
      kind: 'sliding-window-counter',
      currentWindowStartMs: nowMs - (nowMs % w.windowMs),
      currentCount: 0,
      previousCount: 0,
    };
  }
  const elapsed = nowMs - state.currentWindowStartMs;
  if (elapsed < w.windowMs) return state;
  if (elapsed < 2 * w.windowMs) {
    return {
      kind: 'sliding-window-counter',
      currentWindowStartMs: state.currentWindowStartMs + w.windowMs,
      currentCount: 0,
      previousCount: state.currentCount,
    };
  }
  return {
    kind: 'sliding-window-counter',
    currentWindowStartMs: nowMs - (nowMs % w.windowMs),
    currentCount: 0,
    previousCount: 0,
  };
}

function tryConsumeTokenBucket(
  w: RateWindow,
  state: TokenBucketState | undefined,
  weight: number,
  nowMs: number,
): AcceptResult | DenyResult {
  // Treat maxWeight as bucket capacity, refill rate = maxWeight / windowMs per ms.
  const refillRate = w.maxWeight / w.windowMs;
  const cur = state ?? { kind: 'token-bucket' as const, tokens: w.maxWeight, lastRefillMs: nowMs };
  const elapsed = Math.max(0, nowMs - cur.lastRefillMs);
  const tokens = Math.min(w.maxWeight, cur.tokens + elapsed * refillRate);
  if (tokens < weight) {
    const deficit = weight - tokens;
    const retryAfterMs = Math.max(1, Math.ceil(deficit / refillRate));
    return { ok: false, retryAfterMs, currentAfterDeny: Math.ceil(w.maxWeight - tokens) };
  }
  return {
    ok: true,
    nextState: { kind: 'token-bucket', tokens: tokens - weight, lastRefillMs: nowMs },
  };
}

function refundFromWindow(
  w: RateWindow,
  state: WindowState,
  weight: number,
  nowMs: number,
): WindowState {
  switch (w.algorithm) {
    case 'fixed-window': {
      const s = state as FixedWindowState;
      const count = Math.max(0, s.count - weight);
      return { kind: 'fixed-window', windowStartMs: s.windowStartMs, count };
    }
    case 'sliding-window-counter': {
      const s = advanceSliding(state as SlidingWindowState, w, nowMs);
      let curr = s.currentCount;
      let prev = s.previousCount;
      const fromCurr = Math.min(curr, weight);
      curr -= fromCurr;
      const remaining = weight - fromCurr;
      prev = Math.max(0, prev - remaining);
      return {
        kind: 'sliding-window-counter',
        currentWindowStartMs: s.currentWindowStartMs,
        currentCount: curr,
        previousCount: prev,
      };
    }
    case 'token-bucket': {
      const s = state as TokenBucketState;
      return {
        kind: 'token-bucket',
        tokens: Math.min(w.maxWeight, s.tokens + weight),
        lastRefillMs: nowMs,
      };
    }
  }
}

function currentUsage(state: WindowState, w: RateWindow, nowMs: number): number {
  switch (w.algorithm) {
    case 'fixed-window': {
      const s = state as FixedWindowState;
      if (s.windowStartMs + w.windowMs <= nowMs) return 0;
      return s.count;
    }
    case 'sliding-window-counter': {
      const advanced = advanceSliding(state as SlidingWindowState, w, nowMs);
      const elapsedInWindow = nowMs - advanced.currentWindowStartMs;
      const overlap = Math.max(0, 1 - elapsedInWindow / w.windowMs);
      return Math.round(advanced.previousCount * overlap + advanced.currentCount);
    }
    case 'token-bucket': {
      const s = state as TokenBucketState;
      const refillRate = w.maxWeight / w.windowMs;
      const elapsed = Math.max(0, nowMs - s.lastRefillMs);
      const tokens = Math.min(w.maxWeight, s.tokens + elapsed * refillRate);
      return Math.max(0, w.maxWeight - tokens);
    }
  }
}

function reconcileWindow(
  w: RateWindow,
  state: WindowState | undefined,
  reportedUsage: number,
  nowMs: number,
): WindowState {
  const clamped = Math.max(0, Math.min(w.maxWeight, reportedUsage));
  switch (w.algorithm) {
    case 'fixed-window': {
      const windowStart =
        (state && state.kind === 'fixed-window' && state.windowStartMs + w.windowMs > nowMs
          ? state.windowStartMs
          : nowMs - (nowMs % w.windowMs));
      return { kind: 'fixed-window', windowStartMs: windowStart, count: clamped };
    }
    case 'sliding-window-counter': {
      const advanced = advanceSliding(state?.kind === 'sliding-window-counter' ? state : undefined, w, nowMs);
      return {
        kind: 'sliding-window-counter',
        currentWindowStartMs: advanced.currentWindowStartMs,
        currentCount: clamped,
        previousCount: 0,
      };
    }
    case 'token-bucket': {
      return {
        kind: 'token-bucket',
        tokens: Math.max(0, w.maxWeight - clamped),
        lastRefillMs: nowMs,
      };
    }
  }
}

function isWindowStateStale(state: WindowState, nowMs: number): boolean {
  switch (state.kind) {
    case 'fixed-window':
      return state.count === 0 || nowMs - state.windowStartMs > 60_000;
    case 'sliding-window-counter':
      return (
        state.currentCount === 0 &&
        state.previousCount === 0
      ) || nowMs - state.currentWindowStartMs > 120_000;
    case 'token-bucket':
      return nowMs - state.lastRefillMs > 60_000;
  }
}

import type { AlgorithmRegistry } from '../algorithms/registry.js';
import { StoreUnavailableError } from '../errors.js';
import type {
  PerWindowOutcome,
  RateLimitStore,
} from '../storage/store.interface.js';
import type {
  Clock,
  ClockTimer,
  ProviderId,
  RateWindow,
  Reservation,
  ScopeKey,
  UsageObservation,
} from '../types.js';
import type { EventBus } from './events.js';

export interface RateLimiterOptionsCore {
  store: RateLimitStore;
  algorithms: AlgorithmRegistry;
  events: EventBus;
  clock: Clock;
  /** Fraction of `maxWeight` that triggers a `limit:near` event. Default 0.8. */
  nearLimitThreshold?: number;
}

export interface ReserveCall {
  provider: ProviderId;
  scope: ScopeKey;
  weight: number;
  windows: readonly RateWindow[];
  ttlMs?: number;
  endpoint?: string;
  requestId?: string;
}

export type ReserveOutcome =
  | {
      allowed: true;
      reservation: Reservation;
      perWindow: readonly PerWindowOutcome[];
    }
  | {
      allowed: false;
      retryAfterMs: number;
      limitingWindowId: string | undefined;
      perWindow: readonly PerWindowOutcome[];
    };

const DEFAULT_NEAR_LIMIT = 0.8;

/**
 * Rate-limit coordinator.
 *
 * Delegates atomicity to the `RateLimitStore` — never iterates per-window
 * here. The algorithm registry is held so future code (and reconciliation)
 * can ask algorithms for retry estimates without re-doing math in the store.
 */
export class RateLimiter {
  private readonly store: RateLimitStore;
  // Retained for future use (retry estimates, externally-visible algorithm metadata).
  private readonly algorithms: AlgorithmRegistry;
  private readonly events: EventBus;
  private readonly clock: Clock;
  private readonly nearLimit: number;
  private readonly banTimers = new Map<string, { handle: ClockTimer; untilMs: number }>();

  public constructor(opts: RateLimiterOptionsCore) {
    this.store = opts.store;
    this.algorithms = opts.algorithms;
    this.events = opts.events;
    this.clock = opts.clock;
    this.nearLimit = opts.nearLimitThreshold ?? DEFAULT_NEAR_LIMIT;
    // Touch to avoid "unused" complaints until task 15/20 wire it through.
    void this.algorithms;
  }

  public async reserve(req: ReserveCall): Promise<ReserveOutcome> {
    if (req.weight === 0) {
      // No store interaction. Synthesize a no-op outcome.
      const usage = await this.peekPerWindow(req);
      return {
        allowed: true,
        reservation: {
          id: 'noop',
          provider: req.provider,
          scope: req.scope,
          windowIds: req.windows.map((w) => w.id),
          weight: 0,
          expiresAtMs: this.clock.now(),
        },
        perWindow: usage,
      };
    }

    let result;
    try {
      const consumeRequest = {
        provider: req.provider,
        scope: req.scope,
        weight: req.weight,
        windows: req.windows,
        nowMs: this.clock.now(),
        ...(req.ttlMs !== undefined ? { ttlMs: req.ttlMs } : {}),
      };
      result = await this.store.consume(consumeRequest);
    } catch (err) {
      this.events.emit('store:error', {
        name: 'store:error',
        tsMs: this.clock.now(),
        provider: req.provider,
        scope: req.scope,
        ...(req.endpoint !== undefined ? { endpoint: req.endpoint } : {}),
        ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
        error: err instanceof Error ? err : new Error(String(err)),
      });
      if (err instanceof StoreUnavailableError) throw err;
      throw new StoreUnavailableError('store.consume failed', {
        provider: req.provider,
        scope: req.scope,
        ...(req.endpoint !== undefined ? { endpoint: req.endpoint } : {}),
        ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
        cause: err,
      });
    }

    if (!result.allowed) {
      this.events.emit('limit:exceeded', {
        name: 'limit:exceeded',
        tsMs: this.clock.now(),
        provider: req.provider,
        scope: req.scope,
        ...(req.endpoint !== undefined ? { endpoint: req.endpoint } : {}),
        ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
        weight: req.weight,
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
      });
      return {
        allowed: false,
        retryAfterMs: result.retryAfterMs ?? 0,
        limitingWindowId: result.limitingWindowId,
        perWindow: result.perWindow,
      };
    }

    // Allowed. Emit reserved + optional near-limit signal.
    this.events.emit('request:reserved', {
      name: 'request:reserved',
      tsMs: this.clock.now(),
      provider: req.provider,
      scope: req.scope,
      ...(req.endpoint !== undefined ? { endpoint: req.endpoint } : {}),
      ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
      weight: req.weight,
    });

    for (const window of req.windows) {
      const outcome = result.perWindow.find((p) => p.windowId === window.id);
      if (!outcome) continue;
      const ratio = window.maxWeight === 0 ? 1 : outcome.current / window.maxWeight;
      if (ratio >= this.nearLimit) {
        this.events.emit('limit:near', {
          name: 'limit:near',
          tsMs: this.clock.now(),
          provider: req.provider,
          scope: req.scope,
          ...(req.endpoint !== undefined ? { endpoint: req.endpoint } : {}),
          ...(req.requestId !== undefined ? { requestId: req.requestId } : {}),
          weight: req.weight,
          data: {
            windowId: window.id,
            current: outcome.current,
            remaining: outcome.remaining,
            maxWeight: window.maxWeight,
            ratio,
          },
        });
      }
    }

    const reservation: Reservation = {
      id: result.reservationId ?? 'unknown',
      provider: req.provider,
      scope: req.scope,
      windowIds: req.windows.map((w) => w.id),
      weight: req.weight,
      expiresAtMs: this.clock.now() + (req.ttlMs ?? 30_000),
    };

    return { allowed: true, reservation, perWindow: result.perWindow };
  }

  public async refund(reservation: Reservation): Promise<void> {
    if (reservation.id === 'noop') return;
    try {
      await this.store.refund({
        provider: reservation.provider,
        scope: reservation.scope,
        reservationId: reservation.id,
        nowMs: this.clock.now(),
      });
    } catch (err) {
      this.events.emit('store:error', {
        name: 'store:error',
        tsMs: this.clock.now(),
        provider: reservation.provider,
        scope: reservation.scope,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw new StoreUnavailableError('store.refund failed', {
        provider: reservation.provider,
        scope: reservation.scope,
        cause: err,
      });
    }
  }

  public async reconcileFromProvider(
    observation: UsageObservation,
    windows: readonly RateWindow[],
  ): Promise<void> {
    try {
      await this.store.reconcile({
        observation,
        windows,
        nowMs: this.clock.now(),
      });
    } catch (err) {
      this.events.emit('store:error', {
        name: 'store:error',
        tsMs: this.clock.now(),
        provider: observation.provider,
        scope: observation.scope,
        error: err instanceof Error ? err : new Error(String(err)),
      });
      throw new StoreUnavailableError('store.reconcile failed', {
        provider: observation.provider,
        scope: observation.scope,
        cause: err,
      });
    }
    this.events.emit('usage:reconciled', {
      name: 'usage:reconciled',
      tsMs: this.clock.now(),
      provider: observation.provider,
      scope: observation.scope,
      data: { usedByWindow: observation.usedByWindow, authoritative: observation.authoritative },
    });
    if (observation.banUntilMs !== undefined && observation.banUntilMs > this.clock.now()) {
      this.events.emit('ban:detected', {
        name: 'ban:detected',
        tsMs: this.clock.now(),
        provider: observation.provider,
        scope: observation.scope,
        data: { untilMs: observation.banUntilMs },
      });
    }
  }

  public async checkBan(provider: ProviderId, scope: ScopeKey): Promise<number | null> {
    return this.store.getBan({ provider, scope, nowMs: this.clock.now() });
  }

  public async setBan(provider: ProviderId, scope: ScopeKey, untilMs: number): Promise<void> {
    await this.store.setBan({ provider, scope, untilMs, nowMs: this.clock.now() });
    this.scheduleBanClear(provider, scope, untilMs);
    this.events.emit('ban:detected', {
      name: 'ban:detected',
      tsMs: this.clock.now(),
      provider,
      scope,
      data: { untilMs },
    });
  }

  public async clearBan(provider: ProviderId, scope: ScopeKey): Promise<void> {
    await this.store.clearBan({ provider, scope });
    this.cancelBanTimer(provider, scope);
    this.events.emit('ban:cleared', {
      name: 'ban:cleared',
      tsMs: this.clock.now(),
      provider,
      scope,
    });
  }

  private scheduleBanClear(provider: ProviderId, scope: ScopeKey, untilMs: number): void {
    const key = `${provider}::${scope}`;
    const existing = this.banTimers.get(key);
    if (existing) {
      // Re-ban: keep the timer if it already covers the new untilMs;
      // otherwise replace with the later one (extend ban).
      if (existing.untilMs >= untilMs) return;
      this.clock.clearTimeout(existing.handle);
    }
    const delay = Math.max(1, untilMs - this.clock.now());
    const handle = this.clock.setTimeout(() => {
      const current = this.banTimers.get(key);
      if (!current || current.handle !== handle) return;
      this.banTimers.delete(key);
      void this.store
        .clearBan({ provider, scope })
        .catch(() => undefined)
        .finally(() => {
          this.events.emit('ban:cleared', {
            name: 'ban:cleared',
            tsMs: this.clock.now(),
            provider,
            scope,
          });
        });
    }, delay);
    this.banTimers.set(key, { handle, untilMs });
  }

  private cancelBanTimer(provider: ProviderId, scope: ScopeKey): void {
    const key = `${provider}::${scope}`;
    const existing = this.banTimers.get(key);
    if (!existing) return;
    this.clock.clearTimeout(existing.handle);
    this.banTimers.delete(key);
  }

  private async peekPerWindow(req: ReserveCall): Promise<PerWindowOutcome[]> {
    const out: PerWindowOutcome[] = [];
    for (const window of req.windows) {
      const current = await this.store.getUsage({
        provider: req.provider,
        scope: req.scope,
        window,
        nowMs: this.clock.now(),
      });
      out.push({
        windowId: window.id,
        current,
        remaining: Math.max(0, window.maxWeight - current),
      });
    }
    return out;
  }
}

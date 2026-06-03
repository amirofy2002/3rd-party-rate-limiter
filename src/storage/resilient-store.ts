import type { EventBus } from '../core/events.js';
import { StoreUnavailableError } from '../errors.js';
import type {
  Clock,
  ProviderId,
  RateWindow,
  RedisFailureMode,
  Reservation,
  ScopeKey,
} from '../types.js';
import { MemoryStore } from './memory-store.js';
import type {
  ConsumeRequest,
  ConsumeResult,
  RateLimitStore,
  ReconcileRequest,
  RefundRequest,
  ReserveRequest,
} from './store.interface.js';

export interface ResilientStoreOptions {
  /** Primary store (typically `RedisStore`). */
  primary: RateLimitStore;
  /** Behavior when the primary store fails. */
  mode: RedisFailureMode;
  /** Pre-built fallback (defaults to a fresh `MemoryStore`). */
  fallback?: RateLimitStore;
  /** Health-check interval in ms while in fallback mode. Default 5_000. */
  healthCheckIntervalMs?: number;
  /** Consecutive successful pings needed before switching back. Default 3. */
  recoveryThreshold?: number;
  /** Event bus for `store:error` / `store:fallback:*` notifications. */
  events: EventBus;
  /** Clock used for health-check scheduling. */
  clock: Clock;
}

/**
 * Wraps a primary `RateLimitStore` with one of three failure policies:
 *
 * - `failClosed` (production default): rethrow `StoreUnavailableError` so the
 *   scheduler rejects or queues the request. Safest under partial outages.
 * - `failOpen`: log the failure and let the request through unprotected.
 *   Risks provider bans during sustained outages.
 * - `fallbackToMemory`: degrade to an in-process memory store, emit
 *   `store:fallback:on`, and probe the primary until it returns.
 *
 * The fallback path is intended for short outages where global protection
 * is less important than continued availability. Once the primary recovers
 * (`recoveryThreshold` consecutive pings) we switch back and emit
 * `store:fallback:off`.
 */
export class ResilientStore implements RateLimitStore {
  private readonly primary: RateLimitStore;
  private readonly fallback: RateLimitStore;
  private readonly mode: RedisFailureMode;
  private readonly healthCheckIntervalMs: number;
  private readonly recoveryThreshold: number;
  private readonly events: EventBus;
  private readonly clock: Clock;
  private inFallback = false;
  private consecutiveSuccesses = 0;
  private healthTimer: unknown;

  public constructor(opts: ResilientStoreOptions) {
    this.primary = opts.primary;
    this.fallback = opts.fallback ?? new MemoryStore();
    this.mode = opts.mode;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 5_000;
    this.recoveryThreshold = opts.recoveryThreshold ?? 3;
    this.events = opts.events;
    this.clock = opts.clock;
  }

  /** Test/debug — whether the resilient store is currently routing to fallback. */
  public _debugInFallback(): boolean {
    return this.inFallback;
  }

  public async consume(req: ConsumeRequest): Promise<ConsumeResult> {
    return this.callPrimary(
      () => this.primary.consume(req),
      () => this.fallback.consume(req),
      () => this.openAllowed(req),
    );
  }

  public async getUsage(args: {
    provider: ProviderId;
    scope: ScopeKey;
    window: RateWindow;
    nowMs: number;
  }): Promise<number> {
    return this.callPrimary(
      () => this.primary.getUsage(args),
      () => this.fallback.getUsage(args),
      () => Promise.resolve(0),
    );
  }

  public async refund(req: RefundRequest): Promise<void> {
    return this.callPrimary(
      () => this.primary.refund(req),
      () => this.fallback.refund(req),
      () => Promise.resolve(),
    );
  }

  public async reconcile(req: ReconcileRequest): Promise<void> {
    return this.callPrimary(
      () => this.primary.reconcile(req),
      () => this.fallback.reconcile(req),
      () => Promise.resolve(),
    );
  }

  public async setBan(args: {
    provider: ProviderId;
    scope: ScopeKey;
    untilMs: number;
    nowMs: number;
  }): Promise<void> {
    return this.callPrimary(
      () => this.primary.setBan(args),
      () => this.fallback.setBan(args),
      () => Promise.resolve(),
    );
  }

  public async getBan(args: {
    provider: ProviderId;
    scope: ScopeKey;
    nowMs: number;
  }): Promise<number | null> {
    return this.callPrimary(
      () => this.primary.getBan(args),
      () => this.fallback.getBan(args),
      () => Promise.resolve(null),
    );
  }

  public async clearBan(args: { provider: ProviderId; scope: ScopeKey }): Promise<void> {
    return this.callPrimary(
      () => this.primary.clearBan(args),
      () => this.fallback.clearBan(args),
      () => Promise.resolve(),
    );
  }

  public async reserve(req: ReserveRequest): Promise<Reservation> {
    return this.callPrimary(
      () => this.primary.reserve(req),
      () => this.fallback.reserve(req),
      () =>
        Promise.resolve({
          id: 'failopen-reservation',
          provider: req.provider,
          scope: req.scope,
          windowIds: req.windowIds,
          weight: req.weight,
          expiresAtMs: req.nowMs + req.ttlMs,
        }),
    );
  }

  public async releaseReservation(args: {
    provider: ProviderId;
    scope: ScopeKey;
    reservationId: string;
    nowMs: number;
  }): Promise<void> {
    return this.callPrimary(
      () => this.primary.releaseReservation(args),
      () => this.fallback.releaseReservation(args),
      () => Promise.resolve(),
    );
  }

  public async ping(): Promise<boolean> {
    try {
      const fn = (this.primary as { ping?: () => Promise<boolean> }).ping;
      if (!fn) return true;
      return await fn.call(this.primary);
    } catch {
      return false;
    }
  }

  private async callPrimary<T>(
    primaryCall: () => Promise<T>,
    fallbackCall: () => Promise<T>,
    openCall: () => Promise<T>,
  ): Promise<T> {
    if (this.inFallback && this.mode === 'fallbackToMemory') {
      return fallbackCall();
    }
    try {
      const result = await primaryCall();
      if (this.inFallback) {
        // Should not happen during fallback routing, but if somehow yes,
        // count the success.
        this.recordPingSuccess();
      }
      return result;
    } catch (err) {
      this.emitStoreError(err);
      switch (this.mode) {
        case 'failClosed':
          if (err instanceof StoreUnavailableError) throw err;
          throw new StoreUnavailableError('primary store unavailable', { cause: err });
        case 'failOpen':
          return openCall();
        case 'fallbackToMemory':
          this.enterFallback();
          return fallbackCall();
      }
    }
  }

  private emitStoreError(err: unknown): void {
    this.events.emit('store:error', {
      name: 'store:error',
      tsMs: this.clock.now(),
      error: err instanceof Error ? err : new Error(String(err)),
    });
  }

  private enterFallback(): void {
    if (this.inFallback) return;
    this.inFallback = true;
    this.consecutiveSuccesses = 0;
    this.events.emit('store:error', {
      name: 'store:error',
      tsMs: this.clock.now(),
      data: { transitionedTo: 'fallback' },
    });
    this.scheduleHealthCheck();
  }

  private leaveFallback(): void {
    if (!this.inFallback) return;
    this.inFallback = false;
    this.consecutiveSuccesses = 0;
    if (this.healthTimer !== undefined) {
      this.clock.clearTimeout(this.healthTimer);
      this.healthTimer = undefined;
    }
    this.events.emit('store:error', {
      name: 'store:error',
      tsMs: this.clock.now(),
      data: { transitionedTo: 'primary' },
    });
  }

  private scheduleHealthCheck(): void {
    if (!this.inFallback) return;
    this.healthTimer = this.clock.setTimeout(() => {
      void this.runHealthCheck();
    }, this.healthCheckIntervalMs);
  }

  private async runHealthCheck(): Promise<void> {
    try {
      const ok = await this.ping();
      if (ok) {
        this.recordPingSuccess();
      } else {
        this.consecutiveSuccesses = 0;
      }
    } catch {
      this.consecutiveSuccesses = 0;
    }
    if (this.inFallback) this.scheduleHealthCheck();
  }

  private recordPingSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses >= this.recoveryThreshold) {
      this.leaveFallback();
    }
  }

  private openAllowed(req: ConsumeRequest): Promise<ConsumeResult> {
    return Promise.resolve({
      allowed: true,
      reservationId: 'failopen',
      perWindow: req.windows.map((w) => ({
        windowId: w.id,
        current: 0,
        remaining: w.maxWeight,
      })),
    });
  }
}

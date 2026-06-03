import type { ProviderAdapter } from '../adapters/adapter.interface.js';
import {
  BannedError,
  ProviderExecutionError,
  QueueFullError,
  RateLimitError,
  RequestTimeoutError,
} from '../errors.js';
import type { PriorityQueue } from '../queue/priority-queue.js';
import type { RetryPolicy } from '../retry/retry-policy.js';
import type {
  Clock,
  LimiterStats,
  OverflowPolicy,
  ProviderId,
  RateWindow,
  RequestStrategy,
  Reservation,
  RetryConfig,
  ScheduledRequest,
  ScopeKey,
} from '../types.js';
import type { EventBus } from './events.js';
import type { RateLimiter } from './rate-limiter.js';

export interface NormalizedRequest<T> {
  /** Caller-assigned (or generated) request id. */
  requestId: string;
  provider: ProviderId;
  scope: ScopeKey;
  endpoint: string;
  weight: number;
  windows: readonly RateWindow[];
  priority: number;
  strategy: RequestStrategy;
  timeoutMs: number | undefined;
  retry: RetryConfig;
  execute: () => Promise<T> | T;
  /** Optional hook to derive a `ResponseLike` shape for reconciliation. */
  parseResponseFromResult?: (result: T) => unknown;
}

export interface SchedulerOptions {
  limiter: RateLimiter;
  queue: PriorityQueue<QueuedEntry>;
  retry: RetryPolicy;
  adapter: ProviderAdapter;
  events: EventBus;
  clock: Clock;
  maxConcurrent: number;
  overflowPolicy: OverflowPolicy;
  defaultStrategy: RequestStrategy;
  maxQueueSize?: number;
  /** When true, an `execute()` failure refunds the reservation. */
  refundOnExecuteError?: boolean;
  /** When true, a request that times out after reservation refunds it. */
  refundOnTimeout?: boolean;
}

/** Internal queue entry. */
export interface QueuedEntry {
  request: NormalizedRequest<unknown>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
  enqueuedAt: number;
  /** Timer handle for queue-level timeout (cleared on dequeue). */
  timeoutHandle?: unknown;
  /** Number of retry attempts already performed against the provider. */
  attempts: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Decision engine.
 *
 * Owns:
 * - `submit()` flow for `reject` / `delay` / `queue` strategies.
 * - The drain loop that pulls work off the queue as capacity opens.
 * - Concurrency cap on user `execute()` functions.
 * - Retry orchestration via `RetryPolicy` and `ProviderAdapter`.
 *
 * Does NOT own:
 * - Rate-limit math (delegated to `RateLimiter` → store + algorithms).
 * - Provider header parsing (delegated to `ProviderAdapter`).
 * - HTTP transport (caller owns `execute()`).
 */
export class Scheduler {
  private readonly limiter: RateLimiter;
  private readonly queue: PriorityQueue<QueuedEntry>;
  private readonly retry: RetryPolicy;
  private readonly adapter: ProviderAdapter;
  private readonly events: EventBus;
  private readonly clock: Clock;
  private readonly maxConcurrent: number;
  private readonly overflowPolicy: OverflowPolicy;
  private readonly defaultStrategy: RequestStrategy;
  private readonly maxQueueSize: number;
  private readonly refundOnExecuteError: boolean;
  private readonly refundOnTimeout: boolean;

  private inFlight = 0;
  private drainScheduled = false;
  private drainTimer: unknown;
  private requestSeq = 0;
  private totals = {
    received: 0,
    executed: 0,
    rejected: 0,
    retries: 0,
    overflows: 0,
  };

  public constructor(opts: SchedulerOptions) {
    this.limiter = opts.limiter;
    this.queue = opts.queue;
    this.retry = opts.retry;
    this.adapter = opts.adapter;
    this.events = opts.events;
    this.clock = opts.clock;
    this.maxConcurrent = Math.max(1, opts.maxConcurrent);
    this.overflowPolicy = opts.overflowPolicy;
    this.defaultStrategy = opts.defaultStrategy;
    this.maxQueueSize = opts.maxQueueSize ?? Number.POSITIVE_INFINITY;
    this.refundOnExecuteError = opts.refundOnExecuteError ?? false;
    this.refundOnTimeout = opts.refundOnTimeout ?? true;
  }

  public stats(): LimiterStats {
    return {
      queueDepth: this.queue.size(),
      totalReceived: this.totals.received,
      totalExecuted: this.totals.executed,
      totalRejected: this.totals.rejected,
      totalRetries: this.totals.retries,
      totalOverflows: this.totals.overflows,
      remainingByWindow: {},
    };
  }

  public async submit<T>(req: NormalizedRequest<T>): Promise<T> {
    this.totals.received += 1;
    this.events.emit('request:received', {
      name: 'request:received',
      tsMs: this.clock.now(),
      provider: req.provider,
      scope: req.scope,
      endpoint: req.endpoint,
      requestId: req.requestId,
      weight: req.weight,
    });

    return this.runRequest(req);
  }

  public async drain(opts: { rejectPending?: boolean } = {}): Promise<void> {
    if (opts.rejectPending) {
      const pending: QueuedEntry[] = [];
      for (const item of this.queue.snapshot()) pending.push(item.payload);
      for (const entry of pending) {
        this.queue.remove(entry.request.requestId);
        entry.reject(
          new RateLimitError('drained', {
            provider: entry.request.provider,
            scope: entry.request.scope,
            endpoint: entry.request.endpoint,
            requestId: entry.request.requestId,
          }),
        );
      }
    }
    while (this.queue.size() > 0 || this.inFlight > 0) {
      await this.clock.sleep(1);
    }
  }

  private async runRequest<T>(req: NormalizedRequest<T>): Promise<T> {
    const startedAt = this.clock.now();
    const deadline = req.timeoutMs ? startedAt + req.timeoutMs : undefined;
    for (;;) {
      if (deadline !== undefined && this.clock.now() >= deadline) {
        this.totals.rejected += 1;
        throw new RequestTimeoutError('timed out before execution', {
          provider: req.provider,
          scope: req.scope,
          endpoint: req.endpoint,
          requestId: req.requestId,
        });
      }
      const banUntil = await this.limiter.checkBan(req.provider, req.scope);
      if (banUntil !== null) {
        const waitMs = Math.max(0, banUntil - this.clock.now());
        if (req.strategy === 'reject') {
          this.totals.rejected += 1;
          throw new BannedError('scope is banned', {
            provider: req.provider,
            scope: req.scope,
            endpoint: req.endpoint,
            requestId: req.requestId,
            retryAfterMs: waitMs,
          });
        }
        if (req.strategy === 'delay') {
          await this.sleepCappedByDeadline(waitMs, deadline);
          continue;
        }
        // queue
        return this.enqueueAndWait(req, deadline);
      }
      const reservation = await this.limiter.reserve({
        provider: req.provider,
        scope: req.scope,
        weight: req.weight,
        windows: req.windows,
        endpoint: req.endpoint,
        requestId: req.requestId,
        ...(req.timeoutMs !== undefined ? { ttlMs: req.timeoutMs } : {}),
      });

      if (!reservation.allowed) {
        if (req.strategy === 'reject') {
          this.totals.rejected += 1;
          this.events.emit('request:rejected', {
            name: 'request:rejected',
            tsMs: this.clock.now(),
            provider: req.provider,
            scope: req.scope,
            endpoint: req.endpoint,
            requestId: req.requestId,
            retryAfterMs: reservation.retryAfterMs,
          });
          throw new RateLimitError('rate limit exceeded', {
            provider: req.provider,
            scope: req.scope,
            endpoint: req.endpoint,
            requestId: req.requestId,
            retryAfterMs: reservation.retryAfterMs,
          });
        }
        if (req.strategy === 'delay') {
          await this.sleepCappedByDeadline(reservation.retryAfterMs, deadline);
          continue;
        }
        // queue
        return this.enqueueAndWait(req, deadline);
      }
      return this.runExecuteWithRetries(req, reservation.reservation, deadline);
    }
  }

  private async enqueueAndWait<T>(
    req: NormalizedRequest<T>,
    deadline: number | undefined,
  ): Promise<T> {
    this.applyOverflowPolicy(req);
    return new Promise<T>((resolve, reject) => {
      const entry: QueuedEntry = {
        request: req as NormalizedRequest<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
        enqueuedAt: this.clock.now(),
        attempts: 0,
      };
      if (deadline !== undefined) {
        entry.timeoutHandle = this.clock.setTimeout(() => {
          if (this.queue.remove(req.requestId)) {
            this.totals.rejected += 1;
            this.events.emit('request:timeout', {
              name: 'request:timeout',
              tsMs: this.clock.now(),
              provider: req.provider,
              scope: req.scope,
              endpoint: req.endpoint,
              requestId: req.requestId,
            });
            entry.reject(
              new RequestTimeoutError('queue wait exceeded timeout', {
                provider: req.provider,
                scope: req.scope,
                endpoint: req.endpoint,
                requestId: req.requestId,
              }),
            );
          }
        }, Math.max(0, deadline - this.clock.now()));
      }
      this.queue.enqueue({
        id: req.requestId,
        basePriority: req.priority,
        payload: entry,
        nowMs: this.clock.now(),
      });
      this.events.emit('request:queued', {
        name: 'request:queued',
        tsMs: this.clock.now(),
        provider: req.provider,
        scope: req.scope,
        endpoint: req.endpoint,
        requestId: req.requestId,
        weight: req.weight,
        data: { queueDepth: this.queue.size() },
      });
      this.scheduleDrain(1);
    });
  }

  private applyOverflowPolicy<T>(req: NormalizedRequest<T>): void {
    if (this.queue.size() < this.maxQueueSize) return;
    this.totals.overflows += 1;
    this.events.emit('queue:overflow', {
      name: 'queue:overflow',
      tsMs: this.clock.now(),
      provider: req.provider,
      scope: req.scope,
      endpoint: req.endpoint,
      requestId: req.requestId,
      data: { policy: this.overflowPolicy },
    });
    if (this.overflowPolicy === 'reject-new') {
      throw new QueueFullError('queue is full', {
        provider: req.provider,
        scope: req.scope,
        endpoint: req.endpoint,
        requestId: req.requestId,
      });
    }
    if (this.overflowPolicy === 'drop-lowest-priority') {
      const lowest = this.queue.findLowest(this.clock.now());
      if (lowest) {
        this.queue.remove(lowest.id);
        const evicted = lowest.payload;
        evicted.reject(
          new QueueFullError('evicted by drop-lowest-priority overflow', {
            provider: evicted.request.provider,
            scope: evicted.request.scope,
            endpoint: evicted.request.endpoint,
            requestId: evicted.request.requestId,
          }),
        );
      }
    } else {
      // drop-oldest — find lowest enqueueSeq.
      let oldest: QueuedEntry | undefined;
      let oldestSeq = Number.POSITIVE_INFINITY;
      for (const item of this.queue.snapshot()) {
        if (item.enqueueSeq < oldestSeq) {
          oldestSeq = item.enqueueSeq;
          oldest = item.payload;
        }
      }
      if (oldest) {
        this.queue.remove(oldest.request.requestId);
        oldest.reject(
          new QueueFullError('evicted by drop-oldest overflow', {
            provider: oldest.request.provider,
            scope: oldest.request.scope,
            endpoint: oldest.request.endpoint,
            requestId: oldest.request.requestId,
          }),
        );
      }
    }
  }

  private async runExecuteWithRetries<T>(
    req: NormalizedRequest<T>,
    reservation: Reservation,
    deadline: number | undefined,
  ): Promise<T> {
    // Acquire concurrency slot.
    await this.acquireSlot();
    let currentReservation: Reservation | undefined = reservation;
    try {
      let attempt = 0;
      let lastError: unknown;
      for (;;) {
        attempt += 1;
        try {
          const result = await this.executeWithTimeout(req, deadline);
          await this.tryReconcileFromResult(req, result);
          this.totals.executed += 1;
          this.events.emit('request:executed', {
            name: 'request:executed',
            tsMs: this.clock.now(),
            provider: req.provider,
            scope: req.scope,
            endpoint: req.endpoint,
            requestId: req.requestId,
            weight: req.weight,
          });
          return result;
        } catch (err) {
          lastError = err;
          if (err instanceof RequestTimeoutError) {
            this.totals.rejected += 1;
            if (this.refundOnTimeout && currentReservation) {
              await this.safeRefund(currentReservation);
              currentReservation = undefined;
            }
            throw err;
          }
          const observation = this.tryParseFromError(err);
          if (observation.banUntilMs !== undefined && observation.banUntilMs > this.clock.now()) {
            await this.limiter.setBan(req.provider, req.scope, observation.banUntilMs);
          }
          const kind = this.adapter.classifyError(err);
          const decision = this.retry.decide(kind, attempt, req.retry, observation);
          if (!decision.retry) {
            if (this.refundOnExecuteError && currentReservation) {
              await this.safeRefund(currentReservation);
              currentReservation = undefined;
            }
            this.totals.rejected += 1;
            throw new ProviderExecutionError('execute() failed', {
              provider: req.provider,
              scope: req.scope,
              endpoint: req.endpoint,
              requestId: req.requestId,
              cause: err,
            });
          }
          this.totals.retries += 1;
          this.events.emit('request:retry', {
            name: 'request:retry',
            tsMs: this.clock.now(),
            provider: req.provider,
            scope: req.scope,
            endpoint: req.endpoint,
            requestId: req.requestId,
            ...(decision.delayMs ? { retryAfterMs: decision.delayMs } : {}),
            data: { reason: decision.reason, attempt },
          });
          await this.sleepCappedByDeadline(decision.delayMs, deadline);
          if (deadline !== undefined && this.clock.now() >= deadline) {
            this.totals.rejected += 1;
            throw new RequestTimeoutError('timed out during retry backoff', {
              provider: req.provider,
              scope: req.scope,
              endpoint: req.endpoint,
              requestId: req.requestId,
              cause: lastError,
            });
          }
        }
      }
    } finally {
      this.releaseSlot();
      this.scheduleDrain(1);
    }
  }

  private async executeWithTimeout<T>(
    req: NormalizedRequest<T>,
    deadline: number | undefined,
  ): Promise<T> {
    const exec = Promise.resolve().then(() => req.execute());
    if (deadline === undefined) return exec;
    const remaining = Math.max(0, deadline - this.clock.now());
    let timeoutTimer: unknown;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutTimer = this.clock.setTimeout(() => {
        reject(
          new RequestTimeoutError('execute() exceeded timeout', {
            provider: req.provider,
            scope: req.scope,
            endpoint: req.endpoint,
            requestId: req.requestId,
          }),
        );
      }, remaining);
    });
    try {
      return (await Promise.race([exec, timeoutPromise])) as T;
    } finally {
      this.clock.clearTimeout(timeoutTimer);
    }
  }

  private async tryReconcileFromResult<T>(req: NormalizedRequest<T>, result: T): Promise<void> {
    if (!req.parseResponseFromResult) return;
    let response: unknown;
    try {
      response = req.parseResponseFromResult(result);
    } catch {
      return;
    }
    if (!response || typeof response !== 'object') return;
    const obs = this.adapter.parseResponse(response as Parameters<ProviderAdapter['parseResponse']>[0]);
    if (!obs.usage && obs.banUntilMs === undefined) return;
    if (obs.usage) {
      await this.limiter.reconcileFromProvider(
        {
          provider: req.provider,
          scope: req.scope,
          usedByWindow: Object.fromEntries(obs.usage.map((u) => [u.windowId, u.observedWeight])),
          authoritative: obs.usage.every((u) => u.authoritative),
        },
        req.windows,
      );
    }
    if (obs.banUntilMs !== undefined && obs.banUntilMs > this.clock.now()) {
      await this.limiter.setBan(req.provider, req.scope, obs.banUntilMs);
    }
  }

  private tryParseFromError(err: unknown): ReturnType<ProviderAdapter['parseResponse']> {
    if (err && typeof err === 'object') {
      const maybe = err as { response?: { headers?: Record<string, string | string[]>; status?: number } };
      if (maybe.response) {
        const responseLike = maybe.response;
        return this.adapter.parseResponse(responseLike);
      }
    }
    return {};
  }

  private async safeRefund(reservation: Reservation): Promise<void> {
    try {
      await this.limiter.refund(reservation);
    } catch {
      // Swallow refund failures — the underlying store error has already been emitted.
    }
  }

  private scheduleDrain(delayMs: number): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    this.drainTimer = this.clock.setTimeout(() => {
      this.drainTimer = undefined;
      this.drainScheduled = false;
      void this.drainOnce();
    }, Math.max(0, delayMs));
  }

  private async drainOnce(): Promise<void> {
    while (this.queue.size() > 0 && this.inFlight < this.maxConcurrent) {
      const head = this.queue.peek(this.clock.now());
      if (!head) break;
      const entry = head.payload;
      const banUntil = await this.limiter.checkBan(entry.request.provider, entry.request.scope);
      if (banUntil !== null) {
        const wait = Math.max(1, banUntil - this.clock.now());
        this.scheduleDrain(wait);
        break;
      }
      const reservation = await this.limiter.reserve({
        provider: entry.request.provider,
        scope: entry.request.scope,
        weight: entry.request.weight,
        windows: entry.request.windows,
        endpoint: entry.request.endpoint,
        requestId: entry.request.requestId,
        ...(entry.request.timeoutMs !== undefined ? { ttlMs: entry.request.timeoutMs } : {}),
      });
      if (!reservation.allowed) {
        const wait = Math.max(1, reservation.retryAfterMs);
        this.scheduleDrain(wait);
        break;
      }
      // Dequeue and run.
      this.queue.dequeue(this.clock.now());
      if (entry.timeoutHandle !== undefined) this.clock.clearTimeout(entry.timeoutHandle);
      this.events.emit('request:dequeued', {
        name: 'request:dequeued',
        tsMs: this.clock.now(),
        provider: entry.request.provider,
        scope: entry.request.scope,
        endpoint: entry.request.endpoint,
        requestId: entry.request.requestId,
      });
      const deadline = entry.request.timeoutMs
        ? entry.enqueuedAt + entry.request.timeoutMs
        : undefined;
      // Run async; do not await — drain can continue serving other entries.
      void this.runExecuteWithRetries(entry.request, reservation.reservation, deadline)
        .then((value) => entry.resolve(value))
        .catch((err) => entry.reject(err));
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (this.inFlight < this.maxConcurrent) {
          this.inFlight += 1;
          resolve();
        } else {
          this.clock.setTimeout(check, 5);
        }
      };
      check();
    });
  }

  private releaseSlot(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  private async sleepCappedByDeadline(
    ms: number,
    deadline: number | undefined,
  ): Promise<void> {
    if (ms <= 0) return;
    const sleepMs = deadline === undefined ? ms : Math.min(ms, Math.max(0, deadline - this.clock.now()));
    if (sleepMs <= 0) return;
    await this.clock.sleep(sleepMs);
  }

  /** Helper for clients to mint a unique request id. */
  public nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${Date.now().toString(36)}-${this.requestSeq.toString(36)}`;
  }

  public toScheduledRequest<T>(
    raw: ScheduledRequest<T>,
    options: {
      defaultPriority: number;
      defaultRetry: RetryConfig;
    },
  ): NormalizedRequest<T> {
    const weight = raw.weight ?? this.adapter.resolveWeight(raw.endpoint, raw.meta);
    const scope = this.adapter.resolveScope(raw as ScheduledRequest<unknown>);
    const norm: NormalizedRequest<T> = {
      requestId: this.nextRequestId(),
      provider: this.adapter.id,
      scope,
      endpoint: raw.endpoint,
      weight,
      windows: this.adapter.getConfig().defaultWindows,
      priority: raw.priority ?? options.defaultPriority,
      strategy: raw.strategy ?? this.defaultStrategy,
      timeoutMs: raw.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      retry: raw.retry ?? options.defaultRetry,
      execute: raw.execute,
    };
    if (raw.parseResponseFromResult) norm.parseResponseFromResult = raw.parseResponseFromResult;
    return norm;
  }
}

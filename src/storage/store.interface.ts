import type {
  ProviderId,
  RateWindow,
  Reservation,
  ScopeKey,
  UsageObservation,
} from '../types.js';

/**
 * Per-window outcome returned by `consume()`.
 */
export interface PerWindowOutcome {
  /** Window id (matches `RateWindow.id`). */
  windowId: string;
  /** Current accumulated weight in the window after consume. */
  current: number;
  /** Remaining capacity in the window after consume. May be 0. */
  remaining: number;
}

/**
 * Result of a `consume()` call.
 *
 * `allowed: true` means capacity was atomically reserved across every window
 * listed in the request. `allowed: false` means no window was consumed —
 * implementations must not partially commit.
 */
export interface ConsumeResult {
  /** Whether all windows accepted the weight. */
  allowed: boolean;
  /** Reservation id created when `allowed`. Undefined when denied. */
  reservationId?: string;
  /** Per-window snapshot after the call (denied state when `allowed === false`). */
  perWindow: readonly PerWindowOutcome[];
  /** Suggested wait until capacity may become available (only when denied). */
  retryAfterMs?: number;
  /** Window id that triggered the denial, when known. */
  limitingWindowId?: string;
}

/**
 * Request body for `consume()`.
 *
 * `nowMs` is taken from the injected `Clock` so behavior is deterministic
 * under fake timers (memory store). The Redis store uses its own server time.
 */
export interface ConsumeRequest {
  provider: ProviderId;
  scope: ScopeKey;
  weight: number;
  windows: readonly RateWindow[];
  nowMs: number;
  /** Optional reservation id to attach (e.g. for retry of a previously-issued one). */
  reservationId?: string;
  /** Reservation TTL in ms. Defaults to implementation choice. */
  ttlMs?: number;
}

/** Request body for `refund()` — release capacity by reservation. */
export interface RefundRequest {
  provider: ProviderId;
  scope: ScopeKey;
  reservationId: string;
  nowMs: number;
}

/** Request body for `reserve()` — explicitly create a reservation without consume math. */
export interface ReserveRequest {
  provider: ProviderId;
  scope: ScopeKey;
  weight: number;
  windowIds: readonly string[];
  nowMs: number;
  ttlMs: number;
}

/** Request body for `reconcile()` — apply a provider-reported observation. */
export interface ReconcileRequest {
  observation: UsageObservation;
  windows: readonly RateWindow[];
  nowMs: number;
}

/**
 * Storage boundary between local and distributed execution.
 *
 * Implementations must be atomic across multi-window operations. Memory and
 * Redis modes share scheduler behavior, so the contract test suite under
 * `test/storage/contract.ts` must pass for every implementation.
 */
export interface RateLimitStore {
  /** Atomic multi-window consume. All-or-nothing. */
  consume(req: ConsumeRequest): Promise<ConsumeResult>;

  /** Read current usage in a single window. */
  getUsage(args: {
    provider: ProviderId;
    scope: ScopeKey;
    window: RateWindow;
    nowMs: number;
  }): Promise<number>;

  /** Refund capacity tied to a reservation id. No-op when expired/unknown. */
  refund(req: RefundRequest): Promise<void>;

  /** Apply a provider-reported observation to reconcile counters. */
  reconcile(req: ReconcileRequest): Promise<void>;

  /** Set ban-until wall-clock time for a scope. */
  setBan(args: {
    provider: ProviderId;
    scope: ScopeKey;
    untilMs: number;
    nowMs: number;
  }): Promise<void>;

  /** Get ban-until ms, or null when not banned (or expired). */
  getBan(args: { provider: ProviderId; scope: ScopeKey; nowMs: number }): Promise<number | null>;

  /** Clear ban for a scope. */
  clearBan(args: { provider: ProviderId; scope: ScopeKey }): Promise<void>;

  /** Explicitly create a reservation without consume math. Used for fixed pre-allocations. */
  reserve(req: ReserveRequest): Promise<Reservation>;

  /** Release a reservation by id (alias for `refund` when the id is known). */
  releaseReservation(args: { provider: ProviderId; scope: ScopeKey; reservationId: string; nowMs: number }): Promise<void>;

  /** Optional periodic cleanup of expired entries (memory implementations). */
  cleanup?(nowMs: number): Promise<void> | void;

  /** Optional health check for distributed stores. Returns true when reachable. */
  ping?(): Promise<boolean>;
}

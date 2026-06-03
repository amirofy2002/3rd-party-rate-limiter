# 10-TASK-rate-limiter-core

## Goal

`RateLimiter` coordinates store + algorithms. Architecture §6.5. Implements all-or-nothing multi-window reservation, refund, reconciliation, ban read/write.

## Dependencies

- `04-TASK-store-interface`
- `05-TASK-memory-store`
- `09-TASK-algorithm-registry`
- `03-TASK-event-bus`

## Logic

### `src/core/rate-limiter.ts`

```ts
class RateLimiter {
  constructor(opts: {
    store: RateLimitStore;
    algorithms: AlgorithmRegistry;
    events: EventBus;
    clock: Clock;
  });

  async reserve(req: ReserveCall): Promise<ReserveOutcome>;
  async refund(reservation: Reservation): Promise<void>;
  async reconcileFromProvider(obs: UsageObservation): Promise<void>;
  async checkBan(scope: ScopeKey): Promise<number | null>;
  async setBan(scope: ScopeKey, untilMs: number): Promise<void>;
}

interface ReserveCall {
  scope: ScopeKey;
  weight: number;
  windows: RateWindow[];
  ttlMs?: number;
}

type ReserveOutcome =
  | { allowed: true; reservation: Reservation; perWindow: PerWindowState[] }
  | { allowed: false; retryAfterMs: number; limitingWindow: string };
```

Behavior:

- `reserve`: delegate to `store.consume` with all windows; on allow emit `request:reserved` + `limit:near` if any window > 80% (configurable threshold).
- Atomicity is the store's job. Limiter does not chain per-window consumes.
- `refund`: store.refund + emit refund event.
- `reconcileFromProvider`: take observed usage from adapter header parse; if observed > local, raise local counters via `store.consume` with diff weight (no execute); emit `usage:reconciled`.
- `checkBan` returns ban time; emits nothing.
- `setBan`: `store.setBan` + emit `ban:detected`.

## Tests

- Reserve passes through to store, returns expected outcome.
- Near-limit event fires at threshold.
- Multi-window deny: returns `retryAfterMs` from the most-limiting window.
- Refund decreases store usage.
- Reconcile upward triggers extra consume.
- Reconcile downward when adapter authoritative: store refund.
- Ban set propagates to subsequent `checkBan`.
- Event handler errors do not break reserve flow (EventBus isolation).

## Edge Cases

- `weight = 0`: short-circuit, do not touch store, return allowed with no reservation.
- Store throws: wrap in `StoreUnavailableError`, emit `store:error`, rethrow.
- Reconcile race: provider header lags one request. Acceptable; design assumes eventual consistency.
- `ttlMs` defaults: `min(request.timeoutMs ?? 30s, maxWindowMs)`.

## Acceptance

Plug into scheduler (task 15). All algorithms work through it.

# 04-TASK-store-interface

## Goal

Define `RateLimitStore` abstraction (architecture §6.7, ADR-003). Storage is the distributed boundary. Interface must be atomic-friendly.

## Dependencies

- `01-TASK-types-and-errors`
- `02-TASK-clock-abstraction`

## Logic

### `src/storage/store.interface.ts`

```ts
interface RateLimitStore {
  // Atomic multi-window consume. All-or-nothing.
  consume(req: ConsumeRequest): Promise<ConsumeResult>;

  // Read-only inspection.
  getUsage(key: ScopeKey, window: RateWindow): Promise<number>;

  // Refund capacity previously consumed (e.g. on failed execute).
  refund(req: RefundRequest): Promise<void>;

  // Ban state shared across instances.
  setBan(key: ScopeKey, untilMs: number): Promise<void>;
  getBan(key: ScopeKey): Promise<number | null>;
  clearBan(key: ScopeKey): Promise<void>;

  // Reservation lifecycle (TTL-bound).
  reserve(req: ReserveRequest): Promise<Reservation>;
  releaseReservation(id: string): Promise<void>;

  // Optional periodic GC hook.
  cleanup?(): Promise<void>;

  // Health check for distributed stores.
  ping?(): Promise<boolean>;
}

interface ConsumeRequest {
  scope: ScopeKey;
  weight: number;
  windows: RateWindow[];
  nowMs: number;            // from injected clock
  reservationId?: string;
  ttlMs?: number;
}

interface ConsumeResult {
  allowed: boolean;
  reservationId?: string;
  perWindow: Array<{ windowId: string; current: number; remaining: number }>;
  retryAfterMs?: number;
}
```

`ScopeKey` is a structured string: `{provider}:{scope}:{windowId?}`.

## Tests

Define a shared **contract test suite** in `test/storage/contract.ts` exporting `runStoreContractTests(factory: () => Store)`. Both memory and Redis stores reuse it.

Contract assertions:

- `consume` succeeds when within limit, returns `allowed: true` + remaining.
- `consume` denies when over limit, `retryAfterMs > 0`.
- Multi-window consume is atomic: if window B denies, window A is not consumed.
- `refund` reduces usage by exact weight.
- `setBan` then `getBan` returns ban time; expired ban returns null.
- Reservation expires after TTL — capacity becomes available again.
- Concurrent consume from 100 callers respects max (no overshoot).

## Edge Cases

- `weight = 0`: short-circuit allow without store interaction.
- `windows = []`: invalid, throw `ConfigurationError`.
- Negative weight: throw.
- Refund more than consumed: clamp at 0, emit `store:error` warning.
- `nowMs` going backwards (clock skew): store uses its own clock (Redis TIME) or trusts caller per implementation.

## Acceptance

Interface stable. Contract suite ready to be reused by 05 (memory) and 23 (Redis).

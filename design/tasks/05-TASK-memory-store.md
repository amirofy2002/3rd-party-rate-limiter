# 05-TASK-memory-store

## Goal

In-process `RateLimitStore` for single-instance use and tests. Architecture §6.7. Fast, deterministic.

## Dependencies

- `02-TASK-clock-abstraction`
- `04-TASK-store-interface`

## Logic

### `src/storage/memory-store.ts`

Data structures:

- `usage: Map<string, WindowState>` keyed by `{scope}:{windowId}`
- `bans: Map<string, number>` keyed by scope, value = `untilMs`
- `reservations: Map<string, Reservation>` keyed by reservationId

`WindowState` depends on algorithm hint stored alongside. Memory store delegates math to algorithm modules (task 07/08). For fixed window: `{ count, windowStart }`. For sliding: ring buffer or sorted events.

Concurrency: single-threaded JS but `consume` is `async` — guard with a per-scope `Mutex` (simple promise chain) so multi-window operations stay atomic against interleaved awaits.

Operations:

- `consume`: take per-scope mutex → for each window, algorithm.tryConsume(state, weight, now) → if all OK, commit all; else rollback computed deltas and return `{allowed:false, retryAfterMs}`.
- `refund`: per window, algorithm.refund(state, weight).
- `setBan/getBan/clearBan`: trivial Map ops, getBan returns null if expired.
- `reserve`: generate ULID id, schedule expiry via injected clock; `releaseReservation` clears timer + refunds.
- `cleanup`: periodic sweep of expired window states and reservations.

## Tests

- Run full contract suite from task 04.
- Mutex correctness: spawn 100 concurrent `consume` calls totaling exactly `maxWeight`; all succeed, exactly one denied at boundary.
- Reservation auto-expires under fake clock.
- `cleanup` removes stale window states for inactive scopes (verify Map size).
- Multi-window rollback on partial fail (window 1 allows, window 2 denies → window 1 not consumed).

## Edge Cases

- Long-lived process, many distinct scopes: memory growth. Cleanup must drop scopes inactive for `> maxWindowMs * 2`.
- Reservation TTL longer than window: must still expire reservation independently.
- Negative system clock jump: window state assumes monotonic. Use `Math.max(now, lastSeenNow)` guard.
- Mutex deadlock impossible because no nested locks (ADR §15).
- `cleanup` running while `consume` in flight: cleanup operates per-scope under same mutex.

## Acceptance

Contract suite green. Bench: 1M consume/sec single-thread target.

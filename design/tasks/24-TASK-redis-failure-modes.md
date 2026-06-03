# 24-TASK-redis-failure-modes

## Goal

Implement `failClosed` / `failOpen` / `fallbackToMemory` behavior when Redis is unreachable. Architecture §13.1.

## Dependencies

- `23-TASK-redis-store`
- `05-TASK-memory-store`
- `15-TASK-scheduler`

## Logic

### `src/storage/resilient-store.ts`

Decorator pattern:

```ts
class ResilientStore implements RateLimitStore {
  constructor(primary: RateLimitStore, opts: {
    mode: 'failClosed' | 'failOpen' | 'fallbackToMemory';
    fallback?: MemoryStore;
    healthCheckIntervalMs?: number;
    events: EventBus;
  });
}
```

Behavior on `consume` failure:

- `failClosed`: rethrow `StoreUnavailableError`. Scheduler converts to reject/queue based on strategy.
- `failOpen`: log + emit `store:error` + return `{allowed: true, perWindow: []}` (caller proceeds without protection).
- `fallbackToMemory`: switch to in-memory store; emit `store:fallback:on`; periodic `ping` on primary; on recovery emit `store:fallback:off` and resume primary.

Health check:

- Run `primary.ping()` every `healthCheckIntervalMs` (default 5s) while in fallback.
- On 3 consecutive successes, switch back.

Scheduler integration:

- `failClosed` + strategy `queue`: items remain in queue, drain retries with backoff until store healthy.
- `failOpen` + `usage:reconciled` on next successful Redis call: aggressive upward reconciliation (we may have overshot).

## Tests

- Simulate Redis down via Toxiproxy: each mode behaves as documented.
- Recovery: after Redis returns, `fallbackToMemory` reverts within `3 * healthCheckInterval`.
- `failClosed` queue: items survive a 10-second Redis outage and drain after recovery.
- Events fire in correct order: `store:error` → `store:fallback:on` → `store:fallback:off`.
- `failOpen` counts requests during outage; after recovery, large `usage:reconciled` event.

## Edge Cases

- Partial Redis failure (some commands succeed, others timeout): treat any error in `consume` as outage.
- Flapping: hysteresis (3-success rule) prevents thrash.
- `failOpen` during sustained outage: may cause provider ban. Document trade-off loudly.
- Multiple `ResilientStore` instances racing on recovery: each independently switches; correctness preserved via Redis-side state.

## Acceptance

Documented matrix of mode × failure × outcome. Production default = `failClosed`.

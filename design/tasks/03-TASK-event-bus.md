# 03-TASK-event-bus

## Goal

Typed EventBus for lifecycle events (architecture §19.1). Synchronous dispatch by default. Handler isolation: a throwing handler must not break the hot path.

## Dependencies

- `01-TASK-types-and-errors`

## Logic

### `src/core/events.ts`

```ts
type LimiterEvent =
  | 'request:received' | 'request:queued' | 'request:dequeued'
  | 'request:reserved' | 'request:executed' | 'request:rejected'
  | 'request:timeout'  | 'request:retry'
  | 'limit:near'       | 'limit:exceeded'
  | 'usage:reconciled' | 'ban:detected'    | 'ban:cleared'
  | 'store:error'      | 'queue:overflow';

interface EventPayloadMap { /* keyed map of event → payload type */ }

interface EventBus {
  on<E extends LimiterEvent>(event: E, handler: (p: EventPayloadMap[E]) => void): Unsubscribe;
  off<E extends LimiterEvent>(event: E, handler: Function): void;
  emit<E extends LimiterEvent>(event: E, payload: EventPayloadMap[E]): void;
}
```

Implementation: backed by `Map<event, Set<handler>>`.

- `emit` iterates handlers in registration order.
- Each handler is wrapped in try/catch; thrown errors logged via injected logger but do not propagate.
- `on` returns `Unsubscribe` function (idempotent).
- Supports a wildcard `*` listener (debug only) for tooling.

## Tests

- Register handler, emit, handler called with correct payload.
- Throwing handler does not prevent later handlers from running.
- Unsubscribe removes handler.
- Double-unsubscribe is no-op.
- Wildcard listener receives all events.
- Listener registered during emit fires on next emit, not current (snapshot semantics).
- Memory leak guard: emit 100k times with 0 listeners stays flat.

## Edge Cases

- Listener mutates listener set during emit: snapshot before iteration.
- Async handler that throws after await: not caught by sync try/catch. Document: handlers should be sync; if async needed, user awaits inside.
- Payload object must not be mutated by handlers — freeze in dev mode (`process.env.NODE_ENV !== 'production'`).
- High-frequency events (`request:received`) must not allocate a fresh payload object when there are zero listeners — early return.

## Acceptance

Used by scheduler, limiter, client. Zero-listener emit cost < 100ns benchmark target.

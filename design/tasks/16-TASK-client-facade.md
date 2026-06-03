# 16-TASK-client-facade

## Goal

`RateLimiterClient` facade + `createLimiter` factory. Architecture §6.1, §16, §17.

## Dependencies

- `15-TASK-scheduler`
- `13-TASK-generic-adapter` (for default)
- `05-TASK-memory-store` (for default)

## Logic

### `src/core/create-limiter.ts`

```ts
function createLimiter(opts: RateLimiterOptions): RateLimiterClient;
```

Steps:

1. Validate `opts` (throw `ConfigurationError` on missing/invalid).
2. Apply defaults from architecture §28.
3. Build registry, store, queue, retry, events, limiter, scheduler.
4. Return client wrapper.

### `src/core/client.ts`

```ts
class RateLimiterClientImpl implements RateLimiterClient {
  schedule<T>(req: ScheduledRequest<T>): Promise<T>;
  wrap<F extends (...a: any[]) => Promise<any>>(endpoint: string, fn: F, opts?: WrapOptions): F;
  on(event, handler): Unsubscribe;
  stats(): LimiterStats;
  drain(): Promise<void>;
  close(): Promise<void>;
}
```

- `schedule`: normalize request, resolve weight via adapter, delegate to scheduler.
- `wrap`: returns a function identical to `fn` but routed through `schedule` with endpoint preset.
- `stats`: aggregate scheduler + queue + store stats.
- `drain`: waits for empty queue + zero in-flight; do not accept new requests after `close()`.
- `close`: cancel pending, release timers, disconnect store.

## Tests

- `schedule` end-to-end: returns user `execute()` result.
- `wrap` preserves arity, return type, `this` binding.
- Result typing: `await schedule<Foo>(...)` is `Foo`, not `unknown`.
- Default options applied when omitted.
- Invalid config throws `ConfigurationError`.
- `close` rejects new requests with `ConfigurationError` or `LimiterClosedError` (consider adding to taxonomy).
- `drain` resolves once all queued + in-flight settle.

## Edge Cases

- User passes `execute` that captures stale closure state on retry: caller's responsibility, but document loudly.
- `wrap` with method on class: `this` binding preserved via arrow inside wrapper.
- `weight` override on request takes precedence over adapter resolution.
- Calling `schedule` after `close`: rejected immediately.
- Re-entrant `schedule` from within an `execute` (recursive call): allowed, but warn against unintended priority inversion.

## Acceptance

Public API matches design §3 (`RateLimiterClient`). Smoke example in `examples/` runs.

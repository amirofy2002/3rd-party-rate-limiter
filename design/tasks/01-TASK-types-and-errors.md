# 01-TASK-types-and-errors

## Goal

Define public TypeScript types and typed error classes. These are the stable contract — every later task imports from here.

## Dependencies

- `00-TASK-repo-scaffold`

## Logic

### `src/types.ts`

Define per design §3 and architecture §6, §16-17:

- `ProviderConfig`, `RateWindow`, `EndpointWeight`, `RequestMeta`
- `ScheduledRequest<T>`, `RequestStrategy = 'reject' | 'queue' | 'delay'`
- `RetryConfig`, `BackoffKind = 'exponential' | 'linear'`
- `RateLimitStore`, `ConsumeResult`, `Reservation`
- `RateLimiterClient`, `LimiterEvent`, `LimiterStats`
- `RateLimiterOptions`, `AgingConfig`, `OverflowPolicy`, `RedisFailureMode`
- `Clock` interface (returns ms; supports `setTimeout`-style scheduling later)
- `MetricsSink`, `Logger`

Each type must have a JSDoc one-liner. No implementation.

### `src/errors.ts`

Per architecture §18. Classes extending `Error`:

- `RateLimiterError` (abstract base): `code`, `provider`, `scope`, `endpoint`, `requestId`, `retryAfterMs?`, `cause?`
- `RateLimitError extends RateLimiterError` (`code: 'RATE_LIMITED'`)
- `QueueFullError` (`code: 'QUEUE_FULL'`)
- `RequestTimeoutError` (`code: 'REQUEST_TIMEOUT'`)
- `BannedError` (`code: 'PROVIDER_BANNED'`)
- `ProviderExecutionError` (`code: 'PROVIDER_EXECUTION_FAILED'`)
- `StoreUnavailableError` (`code: 'STORE_UNAVAILABLE'`)
- `ConfigurationError` (`code: 'INVALID_CONFIG'`)

All use ES `class` with proper `Object.setPrototypeOf(this, new.target.prototype)` for `instanceof` correctness across realms.

## Tests

- `instanceof` works for each error against `RateLimiterError` and `Error`.
- Error `.code` matches expectation.
- Error `.cause` chain preserved through wrapping.
- `JSON.stringify(error)` returns code + scope + provider (toJSON method).
- Type-only tests via `tsd` or `expectType<>` ensuring `ScheduledRequest<T>.execute` returns `Promise<T>`.

## Edge Cases

- `cause` not natively serializable: add explicit `toJSON()`.
- Avoid exposing internal stack frames in user errors when not debug — keep stack but redact deep internals via `Error.captureStackTrace`.
- `BannedError.retryAfterMs` may be `undefined` if provider gives no signal — must not be `0` (falsy bug).
- Type compatibility: do not couple `ScheduledRequest.weight` to a specific number — allow override of adapter-computed weight.

## Acceptance

All types exported from `src/index.ts` via re-export. Type tests and unit tests pass.

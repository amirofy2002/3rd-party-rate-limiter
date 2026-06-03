# 17-TASK-public-exports

## Goal

Surface stable public API via `src/index.ts`. Architecture §23.

## Dependencies

- `16-TASK-client-facade`
- All Phase 1 tasks

## Logic

### `src/index.ts`

```ts
export { createLimiter } from './core/create-limiter';
export { GenericAdapter } from './adapters/generic';
export { MemoryStore } from './storage/memory-store';
export { SlidingWindowCounter, FixedWindow } from './algorithms';
export {
  RateLimitError, QueueFullError, RequestTimeoutError,
  BannedError, ProviderExecutionError, StoreUnavailableError,
  ConfigurationError, RateLimiterError
} from './errors';
export type {
  RateLimiterClient, RateLimiterOptions, ScheduledRequest,
  ProviderAdapter, ProviderConfig, RateWindow, EndpointWeight,
  RateLimitStore, ConsumeResult, Reservation,
  RetryConfig, RequestStrategy, OverflowPolicy, RedisFailureMode,
  LimiterEvent, LimiterStats, Clock,
  MetricsSink, Logger
} from './types';
```

Internal modules (`scheduler`, `priority-queue`, `event-bus`, `retry-policy`) stay non-exported.

`package.json` `exports` map:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "require": "./dist/index.cjs"
    },
    "./redis": {                  // populated by task 23
      "types": "./dist/redis.d.ts",
      "import": "./dist/redis.js",
      "require": "./dist/redis.cjs"
    },
    "./package.json": "./package.json"
  }
}
```

## Tests

- ESM consumer can `import { createLimiter } from '@bitazza/rate-limiter'`.
- CJS consumer can `const { createLimiter } = require(...)`.
- Type-only imports resolve.
- Internal modules (`scheduler.ts`) NOT importable via package name — covered by an `api-extractor` snapshot test or a `tsc` consumer test.
- Tree-shake test: import only `MemoryStore`, bundle does not include `RedisStore`.

## Edge Cases

- Forgetting to add a new file to barrel: caught by API snapshot test.
- Two errors with the same `code` value: linted as a duplicate.
- Adding `./redis` export before task 23 implemented: stub file or omit until then.

## Acceptance

Public API frozen for v1.0 candidate. Snapshot committed under `test/api-snapshot.md`.

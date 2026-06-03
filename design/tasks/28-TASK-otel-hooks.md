# 28-TASK-otel-hooks

## Goal

Optional OpenTelemetry tracing integration. Architecture §25 Phase 4. Open question §27 — implement as opt-in.

## Dependencies

- `15-TASK-scheduler`
- `16-TASK-client-facade`
- `21-TASK-metrics-sink`

## Logic

### `src/observability/otel.ts` (separate subpath export)

```ts
function instrumentLimiter(limiter: RateLimiterClient, opts?: {
  tracer?: Tracer;        // from @opentelemetry/api
  meter?: Meter;          // from @opentelemetry/api
  serviceName?: string;
}): void;
```

- `@opentelemetry/api` is a **peer dependency** (not bundled).
- Wrap `schedule` in `tracer.startActiveSpan('rate-limiter.schedule', ...)` with attributes: `provider`, `endpoint`, `weight`, `strategy`, `priority`.
- Sub-spans:
  - `rate-limiter.reserve` (store call)
  - `rate-limiter.queue-wait` (start at enqueue, end at dequeue)
  - `rate-limiter.execute` (user function)
- Events on span: `request:queued`, `limit:near`, `ban:detected`, `request:retry`.
- Span ends with `OK` on success, `ERROR` + recorded exception on throw.
- Translate `MetricsSink` calls to OTel `Meter` instruments when meter provided.

Subpath export: `@bitazza/rate-limiter/otel`.

## Tests

- With in-memory OTel exporter: spans emitted with expected names and attributes.
- Queue wait span duration matches enqueue→dequeue delta.
- Without `@opentelemetry/api` installed: import works, instrumenting throws `ConfigurationError` with clear message.
- Span context propagation: if caller has active span, our spans become children.

## Edge Cases

- Async context leaks: ensure span ended in `finally` even on uncaught throw.
- Sampling disabled: zero overhead path (do not start spans if `tracer.startSpan` returns noop).
- Concurrent requests: each gets its own span, no shared mutable state.
- Subpath export resolution issues: covered by task 17 ESM/CJS tests.

## Acceptance

Example `examples/otel.ts` exports traces to Jaeger; doc snippet in README.

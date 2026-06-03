# 21-TASK-metrics-sink

## Goal

Expose Prometheus-style metrics via pluggable `MetricsSink`. Architecture §19.2.

## Dependencies

- `03-TASK-event-bus`
- `15-TASK-scheduler`

## Logic

### `src/observability/metrics.ts`

```ts
interface MetricsSink {
  counter(name: string, labels?: Labels): { inc(value?: number): void };
  gauge(name: string, labels?: Labels): { set(value: number): void; inc(v?: number): void; dec(v?: number): void };
  histogram(name: string, labels?: Labels, buckets?: number[]): { observe(value: number): void };
}

class NoopSink implements MetricsSink { /* default */ }

function bindMetrics(events: EventBus, sink: MetricsSink, opts?: { labels?: Labels }): void;
```

`bindMetrics` subscribes to events and updates counters/histograms per architecture §19.2 list:

- `rate_limiter_requests_total{provider,endpoint,outcome}`
- `rate_limiter_queue_depth{provider}` (gauge sampled on enqueue/dequeue)
- `rate_limiter_queue_wait_ms{provider}` (histogram on dequeue)
- `rate_limiter_execution_duration_ms{provider,endpoint}` (histogram)
- `rate_limiter_capacity_remaining{provider,window}` (gauge from `limit:near` payloads)
- `rate_limiter_bans_total{provider}`
- `rate_limiter_store_errors_total`
- `rate_limiter_retries_total`

Cardinality caps:

- `endpoint` label opt-in via `metrics.labels.endpoint = true`.
- Reject high-cardinality label keys with `ConfigurationError`.

## Tests

- NoopSink does not allocate or throw.
- prom-client adapter (test fixture, not bundled): counters increment on event fire.
- High-cardinality endpoint label disabled by default; opt-in increases vector size as expected.
- Histogram buckets: default `[1, 5, 10, 50, 100, 500, 1000, 5000]` ms.
- Wait time histogram observes correct value (dequeue - enqueue).

## Edge Cases

- Sink throws inside emit handler: caught by EventBus (task 03); metric drop logged at debug.
- Restart: gauges reset to 0; document expectation.
- Multiple `createLimiter` instances sharing one sink: label dimension `instance` recommended.
- Removing `bindMetrics` (unbinding): return `Unbind` function from `bindMetrics` for symmetric cleanup.

## Acceptance

Example `examples/metrics.ts` exposes `/metrics` HTTP endpoint via `prom-client` and a working limiter.

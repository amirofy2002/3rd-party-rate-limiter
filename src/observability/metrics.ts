import type { EventBus } from '../core/events.js';
import { ConfigurationError } from '../errors.js';
import type {
  CounterHandle,
  GaugeHandle,
  HistogramHandle,
  LimiterEvent,
  MetricLabels,
  MetricsSink,
} from '../types.js';

/** Returns true when bound metric collection should be detached. */
export type UnbindMetrics = () => void;

const ALLOWED_LABEL_KEYS = new Set([
  'provider',
  'endpoint',
  'window',
  'outcome',
  'reason',
  'policy',
  'instance',
]);

export interface BindMetricsOptions {
  /** Static labels applied to every emitted metric. */
  labels?: MetricLabels;
  /** When true, `endpoint` is included as a label (opt-in for cardinality). */
  endpointLabel?: boolean;
  /** Default histogram buckets for duration-like measurements. */
  durationBucketsMs?: readonly number[];
}

const DEFAULT_DURATION_BUCKETS = [1, 5, 10, 50, 100, 500, 1_000, 5_000];

const noopCounter: CounterHandle = { inc: () => undefined };
const noopGauge: GaugeHandle = {
  set: () => undefined,
  inc: () => undefined,
  dec: () => undefined,
};
const noopHistogram: HistogramHandle = { observe: () => undefined };

/** A do-nothing sink. Default when none provided. */
export class NoopMetricsSink implements MetricsSink {
  public counter(): CounterHandle {
    return noopCounter;
  }
  public gauge(): GaugeHandle {
    return noopGauge;
  }
  public histogram(): HistogramHandle {
    return noopHistogram;
  }
}

/** Default instance suitable for tests and demos. */
export const noopMetricsSink: MetricsSink = new NoopMetricsSink();

/**
 * Bridge `EventBus` lifecycle events to metric counters/gauges/histograms.
 *
 * Subscriptions are returned as a single `UnbindMetrics` function so callers
 * can detach cleanly. Sink calls are wrapped in try/catch so a misbehaving
 * sink cannot break the hot path.
 */
export function bindMetrics(
  events: EventBus,
  sink: MetricsSink,
  opts: BindMetricsOptions = {},
): UnbindMetrics {
  const staticLabels: MetricLabels = opts.labels ?? {};
  validateLabels(staticLabels);
  const includeEndpoint = opts.endpointLabel === true;
  const buckets = opts.durationBucketsMs ?? DEFAULT_DURATION_BUCKETS;

  const enqueueTimes = new Map<string, number>();

  const labelFor = (e: LimiterEvent, extra: MetricLabels = {}): MetricLabels => {
    const out: Record<string, string> = { ...staticLabels };
    if (e.provider) out['provider'] = e.provider;
    if (includeEndpoint && e.endpoint) out['endpoint'] = e.endpoint;
    for (const [k, v] of Object.entries(extra)) {
      out[k] = v;
    }
    return out;
  };

  const safe = <T>(fn: () => T): T | undefined => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };

  const unsubs: Array<() => void> = [];

  unsubs.push(
    events.on('request:received', (e) => {
      safe(() => sink.counter('rate_limiter_requests_total', labelFor(e, { outcome: 'received' })).inc(1));
    }),
  );
  unsubs.push(
    events.on('request:queued', (e) => {
      if (e.requestId) enqueueTimes.set(e.requestId, e.tsMs);
      const depth =
        typeof e.data === 'object' && e.data && 'queueDepth' in e.data
          ? Number(e.data['queueDepth'])
          : undefined;
      if (depth !== undefined) {
        safe(() => sink.gauge('rate_limiter_queue_depth', labelFor(e)).set(depth));
      }
    }),
  );
  unsubs.push(
    events.on('request:dequeued', (e) => {
      if (e.requestId) {
        const enqueuedAt = enqueueTimes.get(e.requestId);
        if (enqueuedAt !== undefined) {
          const waited = Math.max(0, e.tsMs - enqueuedAt);
          safe(() =>
            sink
              .histogram('rate_limiter_queue_wait_ms', labelFor(e), buckets)
              .observe(waited),
          );
          enqueueTimes.delete(e.requestId);
        }
      }
    }),
  );
  unsubs.push(
    events.on('request:executed', (e) => {
      safe(() => sink.counter('rate_limiter_requests_total', labelFor(e, { outcome: 'executed' })).inc(1));
    }),
  );
  unsubs.push(
    events.on('request:rejected', (e) => {
      safe(() => sink.counter('rate_limiter_requests_total', labelFor(e, { outcome: 'rejected' })).inc(1));
    }),
  );
  unsubs.push(
    events.on('request:timeout', (e) => {
      safe(() => sink.counter('rate_limiter_requests_total', labelFor(e, { outcome: 'timeout' })).inc(1));
    }),
  );
  unsubs.push(
    events.on('request:retry', (e) => {
      safe(() => sink.counter('rate_limiter_retries_total', labelFor(e)).inc(1));
    }),
  );
  unsubs.push(
    events.on('limit:near', (e) => {
      const data = (e.data ?? {}) as Record<string, unknown>;
      const windowId = typeof data['windowId'] === 'string' ? data['windowId'] : undefined;
      const remaining = typeof data['remaining'] === 'number' ? data['remaining'] : undefined;
      if (windowId !== undefined && remaining !== undefined) {
        safe(() =>
          sink
            .gauge('rate_limiter_capacity_remaining', labelFor(e, { window: windowId }))
            .set(remaining),
        );
      }
    }),
  );
  unsubs.push(
    events.on('ban:detected', (e) => {
      safe(() => sink.counter('rate_limiter_bans_total', labelFor(e)).inc(1));
    }),
  );
  unsubs.push(
    events.on('store:error', (e) => {
      safe(() => sink.counter('rate_limiter_store_errors_total', labelFor(e)).inc(1));
    }),
  );
  unsubs.push(
    events.on('queue:overflow', (e) => {
      const data = (e.data ?? {}) as Record<string, unknown>;
      const policy = typeof data['policy'] === 'string' ? data['policy'] : 'unknown';
      safe(() =>
        sink.counter('rate_limiter_overflow_total', labelFor(e, { policy })).inc(1),
      );
    }),
  );

  return () => {
    for (const u of unsubs) u();
    enqueueTimes.clear();
  };
}

function validateLabels(labels: MetricLabels): void {
  for (const key of Object.keys(labels)) {
    if (!ALLOWED_LABEL_KEYS.has(key) && key !== 'instance') {
      throw new ConfigurationError(`metric label not allowed (high-cardinality risk): ${key}`);
    }
  }
}

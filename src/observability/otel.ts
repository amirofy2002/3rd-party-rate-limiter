import { ConfigurationError } from '../errors.js';
import type { LimiterEvent, RateLimiterClient, ScheduledRequest } from '../types.js';

/**
 * Subset of the `@opentelemetry/api` surface we depend on. Defining it here
 * keeps the package free of an OpenTelemetry runtime dependency until the
 * user opts in.
 */
export interface OtelSpan {
  setAttribute(key: string, value: string | number | boolean): void;
  setAttributes(attrs: Record<string, string | number | boolean>): void;
  addEvent(name: string, attrs?: Record<string, string | number | boolean>): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: Error | { name: string; message: string }): void;
  end(): void;
}

export interface OtelTracer {
  startActiveSpan<T>(
    name: string,
    options: { attributes?: Record<string, string | number | boolean> },
    fn: (span: OtelSpan) => T,
  ): T;
  startSpan?(name: string): OtelSpan;
}

export interface InstrumentLimiterOptions {
  tracer: OtelTracer;
  serviceName?: string;
}

const SPAN_OK = 1;
const SPAN_ERROR = 2;

/**
 * Wrap a `RateLimiterClient` so every `schedule()` call is traced.
 *
 * This is opt-in. The user supplies their own `Tracer` from
 * `@opentelemetry/api`; the package itself does not bring OTel in.
 *
 * Mutates `client.schedule` in place so existing references continue to
 * work. Lifecycle events are forwarded as span events.
 */
export function instrumentLimiter(
  client: RateLimiterClient,
  opts: InstrumentLimiterOptions,
): void {
  if (!opts || !opts.tracer || typeof opts.tracer.startActiveSpan !== 'function') {
    throw new ConfigurationError(
      'instrumentLimiter: an OpenTelemetry Tracer with startActiveSpan() is required',
    );
  }
  const tracer = opts.tracer;
  const originalSchedule = client.schedule.bind(client);
  const eventsBySpan = new WeakMap<OtelSpan, () => void>();

  const traced = <T>(req: ScheduledRequest<T>): Promise<T> => {
    return tracer.startActiveSpan(
      'rate-limiter.schedule',
      {
        attributes: filterAttrs({
          'rate_limiter.endpoint': req.endpoint,
          'rate_limiter.weight': req.weight,
          'rate_limiter.strategy': req.strategy,
          'rate_limiter.priority': req.priority,
          'rate_limiter.service_name': opts.serviceName,
        }),
      },
      async (span: OtelSpan): Promise<T> => {
        const unsub = subscribeEvents(client, span);
        eventsBySpan.set(span, unsub);
        try {
          const result = await originalSchedule(req);
          span.setStatus({ code: SPAN_OK });
          return result;
        } catch (err) {
          span.setStatus({ code: SPAN_ERROR, message: errorMessage(err) });
          if (err instanceof Error) span.recordException(err);
          throw err;
        } finally {
          unsub();
          eventsBySpan.delete(span);
          span.end();
        }
      },
    );
  };
  client.schedule = traced;
}

function subscribeEvents(client: RateLimiterClient, span: OtelSpan): () => void {
  const unsubs: Array<() => void> = [];
  const wire = (event: Parameters<RateLimiterClient['on']>[0]): void => {
    unsubs.push(
      client.on(event, (payload: LimiterEvent) => {
        span.addEvent(event, eventAttrs(payload));
      }),
    );
  };
  wire('request:queued');
  wire('request:dequeued');
  wire('request:retry');
  wire('limit:near');
  wire('ban:detected');
  wire('store:error');
  return () => {
    for (const u of unsubs) u();
  };
}

function eventAttrs(payload: LimiterEvent): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (payload.provider) out['provider'] = payload.provider;
  if (payload.scope) out['scope'] = payload.scope;
  if (payload.endpoint) out['endpoint'] = payload.endpoint;
  if (payload.requestId) out['request_id'] = payload.requestId;
  if (payload.weight !== undefined) out['weight'] = payload.weight;
  if (payload.retryAfterMs !== undefined) out['retry_after_ms'] = payload.retryAfterMs;
  return out;
}

function filterAttrs(
  attrs: Record<string, string | number | boolean | undefined>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

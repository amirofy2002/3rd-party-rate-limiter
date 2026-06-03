/** OpenTelemetry entrypoint. Bring your own `@opentelemetry/api` tracer. */
export { instrumentLimiter } from './observability/otel.js';
export type {
  InstrumentLimiterOptions,
  OtelSpan,
  OtelTracer,
} from './observability/otel.js';

export const VERSION = '0.0.1';

// Factory and client facade.
export { createLimiter } from './core/create-limiter.js';

// Adapters.
export { GenericAdapter } from './adapters/generic.js';
export type {
  GenericAdapterOptions,
  GenericScopeStrategy,
  GenericUsageHeader,
} from './adapters/generic.js';
export { BinanceAdapter } from './adapters/binance.js';
export type { BinanceAdapterOptions, BinanceProfile } from './adapters/binance.js';
export type {
  ProviderAdapter,
  ProviderErrorKind,
  ProviderObservation,
  ProviderUsageObservation,
  ResponseLike,
} from './adapters/adapter.interface.js';

// Storage.
export { MemoryStore } from './storage/memory-store.js';

// Algorithms.
export { fixedWindowAlgorithm } from './algorithms/fixed-window.js';
export type { FixedWindowState } from './algorithms/fixed-window.js';
export { slidingWindowCounterAlgorithm } from './algorithms/sliding-window-counter.js';
export type { SlidingWindowState } from './algorithms/sliding-window-counter.js';
export { AlgorithmRegistry, createDefaultRegistry, DEFAULT_ALGORITHM } from './algorithms/registry.js';
export type {
  AlgorithmConsumeResult,
  RateAlgorithm,
} from './algorithms/algorithm.interface.js';

// Clock.
export { SystemClock, systemClock } from './core/clock.js';

// Observability.
export { bindMetrics, NoopMetricsSink, noopMetricsSink } from './observability/metrics.js';
export type { BindMetricsOptions, UnbindMetrics } from './observability/metrics.js';
export type {
  CounterHandle,
  GaugeHandle,
  HistogramHandle,
  MetricLabels,
} from './types.js';

// Errors.
export {
  BannedError,
  ConfigurationError,
  ProviderExecutionError,
  QueueFullError,
  RateLimitError,
  RateLimiterError,
  RequestTimeoutError,
  StoreUnavailableError,
} from './errors.js';
export type { RateLimiterErrorCode, RateLimiterErrorFields, RateLimiterErrorJSON } from './errors.js';

// Public types from `types.ts` (storage types are re-exported through it).
export type {
  AgingConfig,
  AlgorithmKind,
  BackoffKind,
  Clock,
  ClockTimer,
  ConsumeRequest,
  ConsumeResult,
  EndpointWeight,
  LimiterEvent,
  LimiterEventName,
  LimiterStats,
  Logger,
  MetricsSink,
  OverflowPolicy,
  PerWindowOutcome,
  ProviderConfig,
  ProviderId,
  RateLimitStore,
  RateLimiterClient,
  RateLimiterOptions,
  RateWindow,
  ReconcileRequest,
  RedisFailureMode,
  RefundRequest,
  RequestId,
  RequestMeta,
  RequestStrategy,
  Reservation,
  ReserveRequest,
  RetryConfig,
  ScheduledRequest,
  ScopeKey,
  ScopeKind,
  UsageObservation,
} from './types.js';

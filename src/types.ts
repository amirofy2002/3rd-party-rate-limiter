/**
 * Public types for the rate-limit and request scheduling library.
 *
 * Stable contract surface — every layer (adapters, storage, scheduler,
 * algorithms, client) imports from here. Implementation lives elsewhere.
 */

/** Logical namespace identifying a provider (e.g. `'binance'`). */
export type ProviderId = string;

/** Identifier of a scope dimension (provider / account / endpoint / ip / custom). */
export type ScopeKind = 'provider' | 'account' | 'endpoint' | 'ip' | 'custom';

/** A composed scope key — opaque string built from scope dimensions. */
export type ScopeKey = string;

/** A request identifier — unique per scheduling submission. */
export type RequestId = string;

/** Algorithm key identifying a rate-limit accounting strategy. */
export type AlgorithmKind = 'fixed-window' | 'sliding-window-counter' | 'token-bucket';

/** One rate-limit window applied to a scope. */
export interface RateWindow {
  /** Stable id for this window within a provider (e.g. `'1m'`). */
  id: string;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum cumulative weight allowed within the window. */
  maxWeight: number;
  /** Algorithm used to measure usage inside the window. */
  algorithm: AlgorithmKind;
}

/** Per-endpoint weight resolution input. */
export interface EndpointWeight {
  /** Logical endpoint or operation (provider-specific). */
  endpoint: string;
  /** Numeric weight cost for the endpoint. */
  weight: number;
  /** Optional list of window ids the endpoint counts against. */
  windowIds?: readonly string[];
}

/** Per-request metadata supplied by the caller. */
export interface RequestMeta {
  /** Optional override scope key (e.g. account id). */
  account?: string;
  /** Optional caller-supplied tags. Avoid high-cardinality values for metrics. */
  tags?: Readonly<Record<string, string>>;
  /** Free-form metadata forwarded to adapters for weight resolution. */
  payload?: unknown;
}

/** How the scheduler treats a request that cannot execute immediately. */
export type RequestStrategy = 'reject' | 'delay' | 'queue';

/** Backoff curve for retry attempts. */
export type BackoffKind = 'exponential' | 'linear';

/** Retry configuration for a scheduled request. */
export interface RetryConfig {
  /** Maximum number of additional attempts (0 disables retry). */
  maxAttempts: number;
  /** Backoff curve. Defaults to `'exponential'` in implementations. */
  backoff?: BackoffKind;
  /** Base delay between attempts in milliseconds. */
  baseMs?: number;
  /** Maximum delay between attempts in milliseconds. */
  maxMs?: number;
  /** When true, randomize delay within `[0, computed]`. */
  jitter?: boolean;
  /** When true, respect provider `Retry-After` over computed backoff. */
  respectRetryAfter?: boolean;
}

/** A request submitted to the limiter. */
export interface ScheduledRequest<T> {
  /** Logical endpoint or operation identifier. */
  endpoint: string;
  /** Optional explicit weight override (otherwise resolved by adapter). */
  weight?: number;
  /** Integer priority `0..100`. Higher executes sooner. Defaults to 50. */
  priority?: number;
  /** Strategy for unavailable capacity. */
  strategy?: RequestStrategy;
  /** Maximum total time the request may spend in the limiter, in ms. */
  timeoutMs?: number;
  /** Retry configuration. */
  retry?: RetryConfig;
  /** Optional per-request metadata forwarded to adapter and observability. */
  meta?: RequestMeta;
  /** Caller-supplied function that performs the actual provider call. */
  execute: () => Promise<T>;
  /**
   * Optional hook to extract a `ResponseLike` shape from the result for
   * reconciliation. Return `undefined` to skip.
   */
  parseResponseFromResult?: (result: T) => unknown;
}

/** A capacity reservation held against a store. */
export interface Reservation {
  /** Reservation identifier (store-scoped). */
  id: string;
  /** Provider id. */
  provider: ProviderId;
  /** Scope key the reservation belongs to. */
  scope: ScopeKey;
  /** Window ids the reservation consumed against. */
  windowIds: readonly string[];
  /** Weight consumed. */
  weight: number;
  /** Wall-clock expiration time in ms. After this the reservation is invalid. */
  expiresAtMs: number;
}

/** Provider-reported usage observation parsed from a response. */
export interface UsageObservation {
  /** Provider id. */
  provider: ProviderId;
  /** Scope key the observation applies to. */
  scope: ScopeKey;
  /** Per-window usage as reported by the provider, keyed by window id. */
  usedByWindow: Readonly<Record<string, number>>;
  /** Whether the adapter treats this observation as authoritative. */
  authoritative: boolean;
  /** Optional cooldown / ban hint extracted from the provider response. */
  banUntilMs?: number;
}

// `RateLimitStore` and its request/result types live in `storage/store.interface.ts`.
// They are re-exported from the package barrel.
import type {
  ConsumeRequest,
  ConsumeResult,
  PerWindowOutcome,
  RateLimitStore,
  ReconcileRequest,
  RefundRequest,
  ReserveRequest,
} from './storage/store.interface.js';

export type {
  ConsumeRequest,
  ConsumeResult,
  PerWindowOutcome,
  RateLimitStore,
  ReconcileRequest,
  RefundRequest,
  ReserveRequest,
};

/** Aging configuration to prevent low-priority starvation. */
export interface AgingConfig {
  /** Wait interval after which effective priority increases by `step`, in ms. */
  intervalMs: number;
  /** Priority boost added per `intervalMs`. */
  step: number;
  /** Maximum cumulative boost. */
  maxBoost: number;
}

/** Policy when the queue is full. */
export type OverflowPolicy = 'reject-new' | 'drop-lowest-priority' | 'drop-oldest';

/** Mode for behavior when the backing store is unavailable. */
export type RedisFailureMode = 'failClosed' | 'failOpen' | 'fallbackToMemory';

/** Lifecycle events emitted by the limiter. */
export type LimiterEventName =
  | 'request:received'
  | 'request:queued'
  | 'request:dequeued'
  | 'request:reserved'
  | 'request:executed'
  | 'request:rejected'
  | 'request:timeout'
  | 'request:retry'
  | 'limit:near'
  | 'limit:exceeded'
  | 'usage:reconciled'
  | 'ban:detected'
  | 'ban:cleared'
  | 'store:error'
  | 'queue:overflow';

/** A typed event payload. Specific fields are populated based on `name`. */
export interface LimiterEvent {
  /** Event name. */
  name: LimiterEventName;
  /** Wall-clock timestamp in ms. */
  tsMs: number;
  /** Provider id when relevant. */
  provider?: ProviderId;
  /** Scope key when relevant. */
  scope?: ScopeKey;
  /** Endpoint when relevant. */
  endpoint?: string;
  /** Request id when relevant. */
  requestId?: RequestId;
  /** Weight involved when relevant. */
  weight?: number;
  /** Suggested retry-after in ms when relevant. */
  retryAfterMs?: number;
  /** Free-form structured data (must be JSON-safe). */
  data?: Readonly<Record<string, unknown>>;
  /** Underlying error reference when relevant. */
  error?: Error;
}

/** Aggregate statistics snapshot. */
export interface LimiterStats {
  /** Queue depth at snapshot time. */
  queueDepth: number;
  /** Total requests received since start. */
  totalReceived: number;
  /** Total requests executed. */
  totalExecuted: number;
  /** Total requests rejected. */
  totalRejected: number;
  /** Total retries scheduled. */
  totalRetries: number;
  /** Total queue overflows. */
  totalOverflows: number;
  /** Per-window remaining capacity at snapshot time. */
  remainingByWindow: Readonly<Record<string, number>>;
}

/**
 * Time source used by scheduler and algorithms. Injected so behavior is
 * deterministic under fake timers. Never call `Date.now()` directly in core.
 */
export interface Clock {
  /** Wall-clock time in ms. */
  now(): number;
  /** Monotonic time in ms (suitable for measuring elapsed durations). */
  monotonic(): number;
  /** Schedule a callback after `ms`. Returns a handle for cancellation. */
  setTimeout(handler: () => void, ms: number): ClockTimer;
  /** Cancel a previously scheduled callback. */
  clearTimeout(handle: ClockTimer): void;
  /** Resolve after `ms` of monotonic time. Rejects with `AbortError` if signal aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Opaque timer handle returned by `Clock.setTimeout`. */
export type ClockTimer = unknown;

/** Labels passed to metrics sinks. Bounded cardinality is the caller's responsibility. */
export type MetricLabels = Readonly<Record<string, string>>;

/** Counter handle returned by `MetricsSink.counter()`. */
export interface CounterHandle {
  inc(value?: number): void;
}

/** Gauge handle returned by `MetricsSink.gauge()`. */
export interface GaugeHandle {
  set(value: number): void;
  inc(value?: number): void;
  dec(value?: number): void;
}

/** Histogram handle returned by `MetricsSink.histogram()`. */
export interface HistogramHandle {
  observe(value: number): void;
}

/**
 * Sink for metrics emission. Implementations must be non-throwing.
 *
 * Adapters typically forward to `prom-client`, OpenTelemetry, or similar.
 * The default sink does nothing.
 */
export interface MetricsSink {
  counter(name: string, labels?: MetricLabels): CounterHandle;
  gauge(name: string, labels?: MetricLabels): GaugeHandle;
  histogram(name: string, labels?: MetricLabels, buckets?: readonly number[]): HistogramHandle;
}

/** Structured logger surface. */
export interface Logger {
  debug(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

/** Resolved provider configuration for a scope. */
export interface ProviderConfig {
  /** Provider id. */
  id: ProviderId;
  /** Default windows applied when no endpoint-specific override exists. */
  defaultWindows: readonly RateWindow[];
  /** Per-endpoint weight table (optional; adapter may resolve dynamically). */
  endpointWeights?: Readonly<Record<string, EndpointWeight>>;
}

/** Top-level options for `createLimiter`. */
export interface RateLimiterOptions {
  /** Provider adapter instance — see `ProviderAdapter` in `adapters/`. */
  provider: unknown;
  /** Store implementation. Defaults to in-memory in `createLimiter`. */
  store?: RateLimitStore;
  /** Clock implementation. Defaults to real time. */
  clock?: Clock;
  /** Default scheduling strategy. */
  defaultStrategy?: RequestStrategy;
  /** Maximum queue size. */
  maxQueueSize?: number;
  /** Maximum aggregated weight queued. */
  maxQueueWeight?: number;
  /** Maximum number of `execute()` functions running concurrently. */
  maxConcurrentExecutions?: number;
  /** Aging configuration. */
  aging?: AgingConfig;
  /** Overflow policy when queue is full. */
  overflowPolicy?: OverflowPolicy;
  /** Behavior when the backing store fails. */
  redisFailureMode?: RedisFailureMode;
  /** Metrics sink. */
  metrics?: MetricsSink;
  /** Logger. */
  logger?: Logger;
}

/** Public facade returned by `createLimiter`. */
export interface RateLimiterClient {
  /** Submit a request for scheduling. Resolves with the `execute()` result. */
  schedule<T>(request: ScheduledRequest<T>): Promise<T>;
  /** Wrap an async function so each call is scheduled. */
  wrap<Args extends readonly unknown[], R>(
    endpoint: string,
    fn: (...args: Args) => Promise<R>,
    defaults?: Omit<ScheduledRequest<R>, 'endpoint' | 'execute'>,
  ): (...args: Args) => Promise<R>;
  /** Subscribe to lifecycle events. */
  on(event: LimiterEventName, handler: (e: LimiterEvent) => void): () => void;
  /** Get a stats snapshot. */
  stats(): LimiterStats;
  /** Drain queued work, optionally rejecting pending requests. */
  drain(opts?: { rejectPending?: boolean }): Promise<void>;
  /**
   * Apply a provider-reported usage observation to the store. Use this when
   * you have a response object out-of-band and want the library to update
   * its local counters explicitly.
   */
  reconcile(scope: ScopeKey, response: unknown): Promise<void>;
}

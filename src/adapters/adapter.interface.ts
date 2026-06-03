import type {
  ProviderConfig,
  ProviderId,
  RequestMeta,
  ScheduledRequest,
  ScopeKey,
} from '../types.js';

/** Minimal response shape consumed by adapters (transport-agnostic). */
export interface ResponseLike {
  /** HTTP status code if available. */
  status?: number;
  /** Headers as a record. Values may be `string` or `string[]` (Node fetch quirk). */
  headers?: Record<string, string | string[] | undefined>;
  /** Parsed body if available. Adapters must not assume any shape. */
  body?: unknown;
}

/** Per-window observation parsed from provider feedback. */
export interface ProviderUsageObservation {
  windowId: string;
  observedWeight: number;
  /** When true, this value overrides local tracking even when lower. */
  authoritative: boolean;
}

/** Aggregate observation parsed from a single provider response. */
export interface ProviderObservation {
  usage?: readonly ProviderUsageObservation[];
  /** Wall-clock ms until ban/cooldown ends, if signalled. */
  banUntilMs?: number;
  /** Suggested wait until next attempt, from `Retry-After` or equivalent. */
  retryAfterMs?: number;
}

/** Classification of an error returned by the user's `execute()` function. */
export type ProviderErrorKind = 'rate-limited' | 'banned' | 'transient' | 'permanent' | 'unknown';

/**
 * Provider knowledge — endpoint weights, header parsing, ban detection.
 *
 * Stateless. Configuration comes from the constructor. Adapters are the
 * only layer allowed to know about provider-specific header names (e.g.
 * `X-MBX-USED-WEIGHT-1M`) or status codes.
 */
export interface ProviderAdapter {
  /** Stable provider id (e.g. `'binance'`). Used as the namespace for store keys. */
  readonly id: ProviderId;

  /** Canonical configuration: windows, default endpoint weights. */
  getConfig(): ProviderConfig;

  /**
   * Resolve the weight for an endpoint. `meta` may carry request payload so
   * batch operations can scale their cost (e.g. Binance batch orders).
   */
  resolveWeight(endpoint: string, meta?: RequestMeta): number;

  /** Compose a `ScopeKey` for a scheduled request (provider + scope dimensions). */
  resolveScope(req: ScheduledRequest<unknown>): ScopeKey;

  /** Parse provider feedback. Implementations must normalize header casing internally. */
  parseResponse(resp: ResponseLike): ProviderObservation;

  /** Classify an error thrown by the user's `execute()` function. */
  classifyError(err: unknown): ProviderErrorKind;
}

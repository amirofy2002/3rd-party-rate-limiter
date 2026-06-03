import { ConfigurationError } from '../errors.js';
import type {
  EndpointWeight,
  ProviderConfig,
  ProviderId,
  RateWindow,
  RequestMeta,
  ScheduledRequest,
  ScopeKey,
} from '../types.js';
import type {
  ProviderAdapter,
  ProviderErrorKind,
  ProviderObservation,
  ResponseLike,
} from './adapter.interface.js';

export type GenericScopeStrategy =
  | 'provider'
  | 'account'
  | 'endpoint'
  | ((req: ScheduledRequest<unknown>) => string);

export interface GenericUsageHeader {
  /** Header name (case-insensitive). */
  name: string;
  /** Window id this header corresponds to. */
  windowId: string;
  /** When true, the parsed value overrides local tracking even if lower. */
  authoritative?: boolean;
}

export interface GenericAdapterOptions {
  /** Stable provider id used as namespace for store keys (e.g. `'binance'`). */
  id: ProviderId;
  /** Default windows applied to every request. */
  windows: readonly RateWindow[];
  /**
   * Endpoint table. Map endpoint → weight (`number`) or full `EndpointWeight`.
   * Lookups are exact-match in v1.
   */
  endpoints?: Readonly<Record<string, EndpointWeight | number>>;
  /** Weight used when `endpoints` has no entry. If omitted, unknown endpoints throw. */
  defaultWeight?: number;
  /** Scope composition strategy. Default `'provider'`. */
  scopeStrategy?: GenericScopeStrategy;
  /** Cooldown to apply when the provider signals rate-limit/ban without `Retry-After`. */
  banCooldownMs?: number;
  /** Header name to read `Retry-After` from. Default `'retry-after'`. */
  retryAfterHeader?: string;
  /** Per-window usage headers to parse. */
  usageHeaders?: readonly GenericUsageHeader[];
  /** Status codes that indicate rate limiting / ban. Default `[429, 418, 503]`. */
  rateLimitedStatuses?: readonly number[];
}

const DEFAULT_RATE_LIMITED_STATUSES = [429, 418, 503] as const;
const DEFAULT_RETRY_AFTER_HEADER = 'retry-after';
const DEFAULT_BAN_COOLDOWN_MS = 60_000;

/**
 * Config-driven adapter suitable for any provider whose limits are
 * described by static windows and per-endpoint weights. For providers with
 * more complex rules (e.g. Binance batch orders, weight-by-symbol)
 * subclass or write a dedicated adapter.
 */
export class GenericAdapter implements ProviderAdapter {
  public readonly id: ProviderId;
  private readonly windows: readonly RateWindow[];
  private readonly endpoints: Readonly<Record<string, EndpointWeight>>;
  private readonly defaultWeight: number | undefined;
  private readonly scopeStrategy: GenericScopeStrategy;
  private readonly banCooldownMs: number;
  private readonly retryAfterHeader: string;
  private readonly usageHeaders: readonly GenericUsageHeader[];
  private readonly rateLimitedStatuses: readonly number[];

  public constructor(opts: GenericAdapterOptions) {
    if (!opts.id) throw new ConfigurationError('GenericAdapter: id is required');
    if (!opts.windows || opts.windows.length === 0) {
      throw new ConfigurationError('GenericAdapter: windows must be non-empty');
    }
    const seenIds = new Set<string>();
    for (const w of opts.windows) {
      if (seenIds.has(w.id)) {
        throw new ConfigurationError(`duplicate window id: ${w.id}`);
      }
      seenIds.add(w.id);
    }
    const endpoints: Record<string, EndpointWeight> = {};
    if (opts.endpoints) {
      for (const [endpoint, spec] of Object.entries(opts.endpoints)) {
        if (endpoint in endpoints) {
          throw new ConfigurationError(`duplicate endpoint: ${endpoint}`);
        }
        endpoints[endpoint] =
          typeof spec === 'number' ? { endpoint, weight: spec } : { ...spec, endpoint };
      }
    }
    this.id = opts.id;
    this.windows = opts.windows;
    this.endpoints = endpoints;
    if (opts.defaultWeight !== undefined) this.defaultWeight = opts.defaultWeight;
    this.scopeStrategy = opts.scopeStrategy ?? 'provider';
    this.banCooldownMs = opts.banCooldownMs ?? DEFAULT_BAN_COOLDOWN_MS;
    this.retryAfterHeader = (opts.retryAfterHeader ?? DEFAULT_RETRY_AFTER_HEADER).toLowerCase();
    this.usageHeaders = opts.usageHeaders ?? [];
    this.rateLimitedStatuses = opts.rateLimitedStatuses ?? DEFAULT_RATE_LIMITED_STATUSES;
  }

  public getConfig(): ProviderConfig {
    const endpointWeights: Record<string, EndpointWeight> = {};
    for (const [k, v] of Object.entries(this.endpoints)) endpointWeights[k] = v;
    return {
      id: this.id,
      defaultWindows: this.windows,
      endpointWeights,
    };
  }

  public resolveWeight(endpoint: string, _meta?: RequestMeta): number {
    const entry = this.endpoints[endpoint];
    if (entry) return entry.weight;
    if (this.defaultWeight !== undefined) return this.defaultWeight;
    throw new ConfigurationError(`unknown endpoint and no defaultWeight: ${endpoint}`, {
      provider: this.id,
      endpoint,
    });
  }

  public resolveScope(req: ScheduledRequest<unknown>): ScopeKey {
    const strat = this.scopeStrategy;
    if (typeof strat === 'function') return `${this.id}:${strat(req)}`;
    switch (strat) {
      case 'account':
        return `${this.id}:account:${req.meta?.account ?? 'default'}`;
      case 'endpoint':
        return `${this.id}:endpoint:${req.endpoint}`;
      case 'provider':
      default:
        return `${this.id}:default`;
    }
  }

  public parseResponse(resp: ResponseLike): ProviderObservation {
    const normalizedHeaders = normalizeHeaders(resp.headers);
    const obs: ProviderObservation = {};

    const usage: { windowId: string; observedWeight: number; authoritative: boolean }[] = [];
    for (const cfg of this.usageHeaders) {
      const value = normalizedHeaders[cfg.name.toLowerCase()];
      if (value === undefined) continue;
      const num = parseUnsignedInt(firstValue(value));
      if (num === undefined) continue;
      usage.push({
        windowId: cfg.windowId,
        observedWeight: num,
        authoritative: cfg.authoritative === true,
      });
    }
    if (usage.length > 0) obs.usage = usage;

    if (resp.status !== undefined && this.rateLimitedStatuses.includes(resp.status)) {
      const retryAfter = parseRetryAfter(firstValue(normalizedHeaders[this.retryAfterHeader]));
      obs.retryAfterMs = retryAfter ?? this.banCooldownMs;
      obs.banUntilMs = Date.now() + obs.retryAfterMs;
    } else {
      const retryAfter = parseRetryAfter(firstValue(normalizedHeaders[this.retryAfterHeader]));
      if (retryAfter !== undefined) obs.retryAfterMs = retryAfter;
    }

    return obs;
  }

  public classifyError(err: unknown): ProviderErrorKind {
    const status = extractStatus(err);
    if (status === undefined) return 'unknown';
    if (this.rateLimitedStatuses.includes(status)) {
      if (status === 418) return 'banned';
      return 'rate-limited';
    }
    if (status >= 500) return 'transient';
    if (status >= 400) return 'permanent';
    return 'unknown';
  }
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (!headers) return out;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = value;
  }
  return out;
}

function firstValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseUnsignedInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return undefined;
  return Math.floor(num);
}

function parseRetryAfter(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // Seconds form (positive integer).
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.max(0, Math.round(seconds * 1_000));
  }
  // HTTP-date form.
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - Date.now());
}

function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as Record<string, unknown>;
  if (typeof e['status'] === 'number') return e['status'];
  const resp = e['response'];
  if (resp && typeof resp === 'object' && resp !== null) {
    const r = resp as Record<string, unknown>;
    if (typeof r['status'] === 'number') return r['status'];
  }
  return undefined;
}

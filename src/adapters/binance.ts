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
import bundledWeights from './binance-weights.json' with { type: 'json' };

export type BinanceProfile = 'spot' | 'futures' | 'margin';

export interface BinanceAdapterOptions {
  /** Profile selector. Only `'spot'` is supported in v1. */
  profile?: BinanceProfile;
  /** Endpoint → weight override table. Keys use `'METHOD /path'` form. */
  endpointWeights?: Readonly<Record<string, number>>;
  /** Override windows. */
  windows?: readonly RateWindow[];
  /** Cooldown when the provider returns 418 (IP-ban). Default 3 minutes. */
  banCooldownMs?: number;
  /** Warn when the bundled weight snapshot is older than this in ms. */
  staleSnapshotMs?: number;
  /** Default weight for endpoints not in the table. Throws if unset and missing. */
  defaultWeight?: number;
}

const DEFAULT_WINDOWS: readonly RateWindow[] = [
  { id: '1m', windowMs: 60_000, maxWeight: 1_200, algorithm: 'sliding-window-counter' },
];
const DEFAULT_BAN_COOLDOWN_MS = 180_000;
const RATE_LIMITED_STATUSES = [429, 418] as const;

const SNAPSHOT_DATE = (bundledWeights as { _meta: { snapshotDate: string } })._meta.snapshotDate;
const SNAPSHOT_WEIGHTS = (bundledWeights as { weights: Record<string, number> }).weights;

/** Binance Spot REST adapter. */
export class BinanceAdapter implements ProviderAdapter {
  public readonly id: ProviderId = 'binance';
  private readonly windows: readonly RateWindow[];
  private readonly endpointWeights: Readonly<Record<string, EndpointWeight>>;
  private readonly banCooldownMs: number;
  private readonly defaultWeight: number | undefined;

  public constructor(opts: BinanceAdapterOptions = {}) {
    const profile = opts.profile ?? 'spot';
    if (profile !== 'spot') {
      throw new ConfigurationError(
        `BinanceAdapter: profile "${profile}" not implemented in v1 — only "spot" is supported.`,
      );
    }
    this.windows = opts.windows ?? DEFAULT_WINDOWS;
    const merged: Record<string, EndpointWeight> = {};
    for (const [key, weight] of Object.entries(SNAPSHOT_WEIGHTS)) {
      merged[key] = { endpoint: key, weight };
    }
    if (opts.endpointWeights) {
      for (const [key, weight] of Object.entries(opts.endpointWeights)) {
        merged[key] = { endpoint: key, weight };
      }
    }
    this.endpointWeights = merged;
    this.banCooldownMs = opts.banCooldownMs ?? DEFAULT_BAN_COOLDOWN_MS;
    if (opts.defaultWeight !== undefined) this.defaultWeight = opts.defaultWeight;
  }

  public getConfig(): ProviderConfig {
    return { id: this.id, defaultWindows: this.windows, endpointWeights: this.endpointWeights };
  }

  public resolveWeight(endpoint: string, meta?: RequestMeta): number {
    // Batch order: per-order weight = 1 (documented Binance behavior).
    if (endpoint.includes('/api/v3/batchOrders')) {
      const payload = meta?.payload as { batchSize?: number } | undefined;
      const size = payload?.batchSize ?? 1;
      return Math.max(1, size);
    }
    const entry = this.endpointWeights[endpoint];
    if (entry) return entry.weight;
    if (this.defaultWeight !== undefined) return this.defaultWeight;
    throw new ConfigurationError(`unknown Binance endpoint and no defaultWeight: ${endpoint}`, {
      provider: this.id,
      endpoint,
    });
  }

  public resolveScope(req: ScheduledRequest<unknown>): ScopeKey {
    const account = req.meta?.account ?? 'default';
    return `${this.id}:${account}`;
  }

  public parseResponse(resp: ResponseLike): ProviderObservation {
    const headers = normalizeHeaders(resp.headers);
    const obs: ProviderObservation = {};
    const usage: { windowId: string; observedWeight: number; authoritative: boolean }[] = [];
    for (const [name, raw] of Object.entries(headers)) {
      const windowId = matchUsedWeightHeader(name);
      if (!windowId) continue;
      const num = parseInt10(firstValue(raw));
      if (num === undefined) continue;
      usage.push({ windowId, observedWeight: num, authoritative: true });
    }
    if (usage.length > 0) obs.usage = usage;

    if (resp.status !== undefined && (RATE_LIMITED_STATUSES as readonly number[]).includes(resp.status)) {
      const retryAfter = parseRetryAfter(firstValue(headers['retry-after']));
      const cooldown = resp.status === 418 ? this.banCooldownMs : retryAfter ?? this.banCooldownMs;
      const retryMs = retryAfter ?? cooldown;
      obs.retryAfterMs = retryMs;
      obs.banUntilMs = Date.now() + cooldown;
    }
    return obs;
  }

  public classifyError(err: unknown): ProviderErrorKind {
    const status = extractStatus(err);
    if (status === undefined) return 'unknown';
    if (status === 418) return 'banned';
    if (status === 429) return 'rate-limited';
    if (status >= 500) return 'transient';
    if (status >= 400) return 'permanent';
    return 'unknown';
  }

  /** Snapshot date the bundled weight table was captured. */
  public static snapshotDate(): string {
    return SNAPSHOT_DATE;
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
  return Array.isArray(value) ? value[0] : value;
}

function parseInt10(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

function parseRetryAfter(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    return Math.max(0, Math.round(seconds * 1_000));
  }
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return undefined;
  return Math.max(0, parsed - Date.now());
}

function matchUsedWeightHeader(name: string): string | undefined {
  // Matches `x-mbx-used-weight-1m`, `x-mbx-used-weight-1h`, plain `x-mbx-used-weight`.
  if (!name.startsWith('x-mbx-used-weight')) return undefined;
  if (name === 'x-mbx-used-weight') return '1m';
  const suffix = name.slice('x-mbx-used-weight-'.length);
  return suffix.length > 0 ? suffix : '1m';
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

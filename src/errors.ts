import type { ProviderId, RequestId, ScopeKey } from './types.js';

/** Stable error code strings. Part of the public contract. */
export type RateLimiterErrorCode =
  | 'RATE_LIMITED'
  | 'QUEUE_FULL'
  | 'REQUEST_TIMEOUT'
  | 'PROVIDER_BANNED'
  | 'PROVIDER_EXECUTION_FAILED'
  | 'STORE_UNAVAILABLE'
  | 'INVALID_CONFIG';

/** Shared fields carried by every limiter error. */
export interface RateLimiterErrorFields {
  provider?: ProviderId;
  scope?: ScopeKey;
  endpoint?: string;
  requestId?: RequestId;
  retryAfterMs?: number;
  cause?: unknown;
}

/** Plain-object shape returned by `toJSON()`. */
export interface RateLimiterErrorJSON extends RateLimiterErrorFields {
  name: string;
  code: RateLimiterErrorCode;
  message: string;
}

/**
 * Abstract base for all errors thrown by the limiter.
 *
 * Subclasses set a stable `code`. Prototype is restored explicitly so
 * `instanceof` survives transpilation and cross-realm boundaries.
 */
export abstract class RateLimiterError extends Error {
  public abstract readonly code: RateLimiterErrorCode;
  public readonly provider?: ProviderId;
  public readonly scope?: ScopeKey;
  public readonly endpoint?: string;
  public readonly requestId?: RequestId;
  public readonly retryAfterMs?: number;
  public override readonly cause?: unknown;

  protected constructor(message: string, fields: RateLimiterErrorFields = {}) {
    super(message);
    this.name = new.target.name;
    if (fields.provider !== undefined) this.provider = fields.provider;
    if (fields.scope !== undefined) this.scope = fields.scope;
    if (fields.endpoint !== undefined) this.endpoint = fields.endpoint;
    if (fields.requestId !== undefined) this.requestId = fields.requestId;
    if (fields.retryAfterMs !== undefined) this.retryAfterMs = fields.retryAfterMs;
    if (fields.cause !== undefined) this.cause = fields.cause;
    Object.setPrototypeOf(this, new.target.prototype);
    if (typeof Error.captureStackTrace === 'function') {
      Error.captureStackTrace(this, new.target);
    }
  }

  public toJSON(): RateLimiterErrorJSON {
    const out: RateLimiterErrorJSON = {
      name: this.name,
      code: this.code,
      message: this.message,
    };
    if (this.provider !== undefined) out.provider = this.provider;
    if (this.scope !== undefined) out.scope = this.scope;
    if (this.endpoint !== undefined) out.endpoint = this.endpoint;
    if (this.requestId !== undefined) out.requestId = this.requestId;
    if (this.retryAfterMs !== undefined) out.retryAfterMs = this.retryAfterMs;
    if (this.cause !== undefined) out.cause = serializeCause(this.cause);
    return out;
  }
}

function serializeCause(cause: unknown): unknown {
  if (cause instanceof RateLimiterError) return cause.toJSON();
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message };
  }
  return cause;
}

/** Capacity was unavailable and the strategy was `reject` (or delay/queue timed out). */
export class RateLimitError extends RateLimiterError {
  public readonly code = 'RATE_LIMITED';
  public constructor(message = 'rate limit exceeded', fields: RateLimiterErrorFields = {}) {
    super(message, fields);
  }
}

/** Request could not be enqueued (queue full + reject-new overflow policy). */
export class QueueFullError extends RateLimiterError {
  public readonly code = 'QUEUE_FULL';
  public constructor(message = 'queue is full', fields: RateLimiterErrorFields = {}) {
    super(message, fields);
  }
}

/** Request exceeded its configured timeout while waiting or executing. */
export class RequestTimeoutError extends RateLimiterError {
  public readonly code = 'REQUEST_TIMEOUT';
  public constructor(message = 'request timed out', fields: RateLimiterErrorFields = {}) {
    super(message, fields);
  }
}

/** Provider or scope is under an active ban / cooldown. */
export class BannedError extends RateLimiterError {
  public readonly code = 'PROVIDER_BANNED';
  public constructor(message = 'provider is banned', fields: RateLimiterErrorFields = {}) {
    super(message, fields);
  }
}

/** User-supplied `execute()` threw or rejected. */
export class ProviderExecutionError extends RateLimiterError {
  public readonly code = 'PROVIDER_EXECUTION_FAILED';
  public constructor(
    message = 'provider execute() failed',
    fields: RateLimiterErrorFields = {},
  ) {
    super(message, fields);
  }
}

/** Backing store (e.g. Redis) is unavailable. */
export class StoreUnavailableError extends RateLimiterError {
  public readonly code = 'STORE_UNAVAILABLE';
  public constructor(
    message = 'rate limit store unavailable',
    fields: RateLimiterErrorFields = {},
  ) {
    super(message, fields);
  }
}

/** Configuration validation failed at construction time. */
export class ConfigurationError extends RateLimiterError {
  public readonly code = 'INVALID_CONFIG';
  public constructor(message = 'invalid configuration', fields: RateLimiterErrorFields = {}) {
    super(message, fields);
  }
}

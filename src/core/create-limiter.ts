import type { ProviderAdapter } from '../adapters/adapter.interface.js';
import { createDefaultRegistry } from '../algorithms/registry.js';
import { ConfigurationError } from '../errors.js';
import { PriorityQueue } from '../queue/priority-queue.js';
import { RetryPolicy } from '../retry/retry-policy.js';
import { MemoryStore } from '../storage/memory-store.js';
import type {
  AgingConfig,
  LimiterEvent,
  LimiterEventName,
  LimiterStats,
  OverflowPolicy,
  RateLimiterClient,
  RateLimiterOptions,
  RateLimitStore,
  RequestStrategy,
  RetryConfig,
  ScheduledRequest,
} from '../types.js';
import { systemClock } from './clock.js';
import { EventBus } from './events.js';
import { RateLimiter } from './rate-limiter.js';
import { Scheduler, type QueuedEntry } from './scheduler.js';

const DEFAULT_AGING: AgingConfig = { intervalMs: 5_000, step: 1, maxBoost: 25 };
const DEFAULT_RETRY: RetryConfig = { maxAttempts: 0 };
const DEFAULT_STRATEGY: RequestStrategy = 'queue';
const DEFAULT_PRIORITY = 50;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const DEFAULT_MAX_CONCURRENT = 32;
const DEFAULT_OVERFLOW: OverflowPolicy = 'reject-new';

/**
 * Wire up the full limiter graph and return the public client facade.
 *
 * Defaults applied here mirror architecture §28: sliding-window-counter,
 * in-memory store, queue strategy, `reject-new` overflow, base aging,
 * `failClosed` Redis behavior (no-op for memory store).
 */
export function createLimiter(opts: RateLimiterOptions): RateLimiterClient {
  if (!opts || !opts.provider) {
    throw new ConfigurationError('createLimiter: `provider` is required');
  }
  if (!isProviderAdapter(opts.provider)) {
    throw new ConfigurationError('createLimiter: `provider` must implement ProviderAdapter');
  }

  const adapter = opts.provider;
  const events = new EventBus(opts.logger);
  const clock = opts.clock ?? systemClock;
  const store: RateLimitStore = opts.store ?? new MemoryStore();
  const algorithms = createDefaultRegistry();
  const aging = opts.aging ?? DEFAULT_AGING;
  const maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;
  const queue = new PriorityQueue<QueuedEntry>({ aging, maxSize: maxQueueSize });
  const limiter = new RateLimiter({ store, algorithms, events, clock });
  const scheduler = new Scheduler({
    limiter,
    queue,
    retry: new RetryPolicy(),
    adapter,
    events,
    clock,
    maxConcurrent: opts.maxConcurrentExecutions ?? DEFAULT_MAX_CONCURRENT,
    overflowPolicy: opts.overflowPolicy ?? DEFAULT_OVERFLOW,
    defaultStrategy: opts.defaultStrategy ?? DEFAULT_STRATEGY,
    maxQueueSize,
  });

  let closed = false;

  const client: RateLimiterClient = {
    async schedule<T>(req: ScheduledRequest<T>): Promise<T> {
      if (closed) {
        throw new ConfigurationError('limiter has been closed');
      }
      validateScheduled(req);
      const normalized = scheduler.toScheduledRequest(req, {
        defaultPriority: DEFAULT_PRIORITY,
        defaultRetry: opts.maxQueueSize !== undefined ? DEFAULT_RETRY : DEFAULT_RETRY,
      });
      return scheduler.submit(normalized);
    },

    wrap<Args extends readonly unknown[], R>(
      endpoint: string,
      fn: (...args: Args) => Promise<R>,
      defaults?: Omit<ScheduledRequest<R>, 'endpoint' | 'execute'>,
    ): (...args: Args) => Promise<R> {
      return function wrapped(this: unknown, ...args: Args): Promise<R> {
        // eslint-disable-next-line @typescript-eslint/no-this-alias
        const thisRef: unknown = this;
        const callArgs = [...args] as unknown as unknown[];
        const request: ScheduledRequest<R> = {
          endpoint,
          ...(defaults ?? {}),
          execute: () => (fn as unknown as (...a: unknown[]) => Promise<R>).apply(thisRef, callArgs),
        };
        return client.schedule(request);
      };
    },

    on(event: LimiterEventName, handler: (e: LimiterEvent) => void) {
      return events.on(event, handler);
    },

    stats(): LimiterStats {
      const base = scheduler.stats();
      return {
        ...base,
        queueDepth: queue.size(),
      };
    },

    async drain(drainOpts: { rejectPending?: boolean } = {}): Promise<void> {
      await scheduler.drain(drainOpts);
      closed = true;
    },

    async reconcile(scope, response) {
      const obs = adapter.parseResponse(response as Parameters<typeof adapter.parseResponse>[0]);
      const windows = adapter.getConfig().defaultWindows;
      if (obs.usage && obs.usage.length > 0) {
        await limiter.reconcileFromProvider(
          {
            provider: adapter.id,
            scope,
            usedByWindow: Object.fromEntries(obs.usage.map((u) => [u.windowId, u.observedWeight])),
            authoritative: obs.usage.every((u) => u.authoritative),
          },
          windows,
        );
      }
      if (obs.banUntilMs !== undefined && obs.banUntilMs > clock.now()) {
        await limiter.setBan(adapter.id, scope, obs.banUntilMs);
      }
    },
  };

  return client;
}

function isProviderAdapter(x: unknown): x is ProviderAdapter {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o['id'] === 'string' &&
    typeof o['getConfig'] === 'function' &&
    typeof o['resolveWeight'] === 'function' &&
    typeof o['resolveScope'] === 'function' &&
    typeof o['parseResponse'] === 'function' &&
    typeof o['classifyError'] === 'function'
  );
}

function validateScheduled<T>(req: ScheduledRequest<T>): void {
  if (!req || typeof req !== 'object') {
    throw new ConfigurationError('schedule: request must be an object');
  }
  if (typeof req.endpoint !== 'string' || req.endpoint.length === 0) {
    throw new ConfigurationError('schedule: endpoint is required');
  }
  if (typeof req.execute !== 'function') {
    throw new ConfigurationError('schedule: execute() function is required');
  }
}

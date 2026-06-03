# NPM Library Design — Distributed Rate Limit & Request Scheduling Manager

## Problem Context

Many third-party providers apply strict rate limiting policies. For example, Binance assigns a **weight** to each API endpoint.

Example:

* `GET /balance` → weight = `1`
* `POST /order` → weight = `5`

Binance may define a limit such as:

* Maximum total weight: `100`
* Time window: `1 minute`

If the accumulated request weight exceeds the allowed threshold, the client may be temporarily banned (for example, for 3 minutes).

The library must help applications avoid reaching the maximum threshold while still allowing efficient request execution.

---

## Goal

Design a reusable NPM package that:

* Tracks weighted API usage per provider
* Prevents hitting provider rate limits
* Supports configurable window-based policies
* Decides whether to:
  * reject requests immediately
  * delay them
  * queue them for later execution
* Works for multiple providers and multiple rate-limit strategies

---

## Example Scenario

Provider: Binance

Configuration:

```ts
{
  windowMs: 60_000,
  maxWeight: 100
}
```

Endpoints:

```ts
{
  "/balance": 1,
  "/order": 5
}
```

If the current consumed weight is `98` and a new request with weight `5` arrives:

* the library should detect that executing it would exceed the limit
* then decide:
  * reject immediately if low priority
  * or queue it until the next window becomes available

---

## Expected Features

### Core Features

* Weighted request tracking
* Sliding window or fixed window rate limiting
* Queue-based scheduling
* Priority handling
* Retry support
* Backpressure handling
* Burst protection
* Cooldown handling after provider ban/rate-limit response

---

## Queue Behavior

### 1. Reject Strategy

Reject the request immediately when executing it would exceed the limit.

Example use case: low-priority analytics requests

### 2. Queue Strategy

Push requests into an internal queue and execute them later when enough capacity becomes available.

Example use case: critical trading operations, balance synchronization

---

## 1. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                      RateLimiterClient                       │
│  (public API: schedule(), execute(), wrap())                 │
└────────────┬─────────────────────────────────────────────────┘
             │
   ┌─────────▼──────────┐
   │   Provider Adapter │  (Binance, Coinbase, custom...)
   │  - endpoint→weight │
   │  - parseHeaders()  │  (read X-MBX-USED-WEIGHT, Retry-After)
   │  - banDetector()   │
   └─────────┬──────────┘
             │
   ┌─────────▼──────────┐      ┌─────────────────────┐
   │     Scheduler      │◄────►│   PriorityQueue     │
   │  (decision engine) │      │  (heap, FIFO tie)   │
   └─────────┬──────────┘      └─────────────────────┘
             │
   ┌─────────▼──────────┐      ┌─────────────────────┐
   │   RateLimiter      │◄────►│   Storage Backend   │
   │  (algorithm core)  │      │  Memory │ Redis     │
   └─────────┬──────────┘      └─────────────────────┘
             │
   ┌─────────▼──────────┐
   │   EventBus         │  (metrics, hooks, observability)
   └────────────────────┘
```

Layers decouple. Swap storage = no algorithm change. Swap algorithm = no adapter change.

---

## 2. Recommended Algorithms

| Algo | Fit | Verdict |
|------|-----|---------|
| Fixed window | Binance-style (weight reset every minute) | ✅ Primary |
| Sliding window log | Strict fairness, no burst at boundary | ✅ Secondary |
| Token bucket | Smooth burst, constant refill | ✅ For burst-tolerant providers |
| Leaky bucket | Output shaping, queue-as-bucket | Niche, skip v1 |

**Default = sliding window counter** (hybrid). Best accuracy/cost ratio. Avoid "double-burst" pitfall of fixed window at boundary.

Distributed mode → Redis Lua script (atomic check-and-consume). Single round trip.

---

## 3. Core Interfaces

```ts
// Provider definition
interface ProviderConfig {
  name: string;
  windows: RateWindow[];
  endpoints: Record<string, EndpointWeight>;
  banCooldownMs?: number;
}

interface RateWindow {
  id: string;              // "1m", "10s"
  windowMs: number;
  maxWeight: number;
  algorithm?: 'fixed' | 'sliding' | 'token-bucket';
}

interface EndpointWeight {
  weight: number | ((req: RequestMeta) => number);
  windows?: string[];      // which windows apply
}

// Request submission
interface ScheduledRequest<T> {
  endpoint: string;
  weight?: number;
  priority?: number;       // higher = sooner
  strategy?: 'reject' | 'queue' | 'delay';
  timeoutMs?: number;
  retry?: RetryConfig;
  execute: () => Promise<T>;
  meta?: Record<string, unknown>;
}

interface RetryConfig {
  maxAttempts: number;
  backoff: 'exponential' | 'linear';
  baseMs: number;
  respectRetryAfter?: boolean;
}

// Storage abstraction
interface RateLimitStore {
  consume(key: string, weight: number, window: RateWindow): Promise<ConsumeResult>;
  getUsage(key: string, window: RateWindow): Promise<number>;
  refund(key: string, weight: number, window: RateWindow): Promise<void>;
  setBan(key: string, untilMs: number): Promise<void>;
  getBan(key: string): Promise<number | null>;
}

interface ConsumeResult {
  allowed: boolean;
  current: number;
  remaining: number;
  retryAfterMs?: number;
}

// Public client
interface RateLimiterClient {
  schedule<T>(req: ScheduledRequest<T>): Promise<T>;
  wrap<F extends (...a:any)=>Promise<any>>(endpoint: string, fn: F): F;
  on(event: LimiterEvent, handler: Handler): void;
  stats(): LimiterStats;
  drain(): Promise<void>;
}

type LimiterEvent =
  | 'request:queued' | 'request:executed' | 'request:rejected'
  | 'request:retry'  | 'limit:near'       | 'limit:exceeded'
  | 'ban:detected'   | 'ban:cleared';
```

---

## 4. Folder Structure

```
src/
├── core/
│   ├── client.ts              # RateLimiterClient impl
│   ├── scheduler.ts           # decision engine
│   ├── queue.ts               # priority queue (binary heap)
│   └── events.ts              # typed EventBus
├── algorithms/
│   ├── fixed-window.ts
│   ├── sliding-window.ts
│   ├── token-bucket.ts
│   └── index.ts
├── storage/
│   ├── memory-store.ts
│   ├── redis-store.ts         # ioredis, Lua scripts
│   └── store.interface.ts
├── adapters/
│   ├── binance.ts
│   ├── coinbase.ts
│   ├── generic.ts
│   └── adapter.interface.ts
├── retry/
│   ├── backoff.ts
│   └── policy.ts
├── observability/
│   ├── metrics.ts             # Prometheus-style counters
│   └── logger.ts
├── types.ts
├── errors.ts                  # RateLimitError, BannedError, QueueFullError
└── index.ts                   # public exports
test/
  unit/ ...
  integration/ ...             # redis via testcontainers
benchmarks/
examples/
  binance.ts
  multi-provider.ts
  distributed.ts
```

---

## 5. Internal Workflow

**Request lifecycle:**

```
schedule(req)
   │
   ▼
[1] resolve weight via adapter
   │
   ▼
[2] check ban state ──── banned? ──► wait OR reject (per strategy)
   │ no
   ▼
[3] atomic consume(key, weight, windows[])
   │
   ├─ allowed ──────────────► [4] execute() ──► parseHeaders ──► refund/adjust if mismatch
   │                                │
   │                                └─ 429/418? ──► setBan, retry per policy
   │
   └─ denied
        │
        ├─ strategy=reject ──► throw RateLimitError
        ├─ strategy=delay  ──► sleep(retryAfterMs), retry from [2]
        └─ strategy=queue  ──► push to PriorityQueue, await slot
                                     │
                                     ▼
                              Scheduler drains queue
                              on window tick + capacity
```

**Scheduler drain loop:**
- Wakes on: capacity tick, request completion, ban cleared
- Peeks highest-priority queued item
- If fits → consume + execute
- Else → recompute next available time, sleep till then

---

## 6. Edge Cases & Pitfalls

| Case | Mitigation |
|------|-----------|
| Header says actual usage > our count | `parseHeaders` → reconcile via store, trust server |
| Clock skew across nodes | Use Redis `TIME` cmd, not local `Date.now()` |
| Queue grows unbounded | `maxQueueSize` config → reject oldest/lowest-prio |
| Starvation of low-prio | Aging: priority + (now - enqueuedAt) * agingFactor |
| Priority inversion | Bound priority levels, no nested locks |
| Process crash mid-flight | Store reservation TTL = req timeout; auto-refund |
| Burst at fixed-window boundary | Default to sliding window |
| Retry storm after ban lifts | Jittered backoff, shared ban state in Redis |
| Weight depends on response (e.g. list size) | Pessimistic pre-consume + post-refund |
| Multiple windows on same endpoint | Consume all-or-nothing; rollback on partial fail |
| 429 without Retry-After | Exponential backoff with cap |
| Long-lived process leak | Periodic GC of expired counters in memory store |

---

## 7. Scalability

**Single process:** in-memory, O(log n) queue, ~1M req/s ceiling. Sufficient for most.

**Multi-instance (horizontal):**
- Redis store mandatory
- Atomic Lua script for consume:
  ```lua
  -- sliding window consume
  local key, window, max, weight, now = KEYS[1], tonumber(ARGV[1]),
                                          tonumber(ARGV[2]), tonumber(ARGV[3]),
                                          tonumber(ARGV[4])
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  local used = tonumber(redis.call('ZSCORE', key, 'sum') or '0')
  if used + weight > max then
    return {0, used, max - used}
  end
  redis.call('ZADD', key, now, now..':'..weight)
  redis.call('HINCRBY', key..':meta', 'sum', weight)
  redis.call('PEXPIRE', key, window)
  return {1, used + weight, max - used - weight}
  ```
- Queue: local per-instance (low coordination cost) OR Redis Streams (global ordering, higher latency)
- Recommend **local queue + global counter** — best tradeoff

**Pitfalls in distributed mode:**
- Redis as SPOF → recommend Redis Sentinel/Cluster
- Network partition → "fail-open" vs "fail-closed" config knob
- Hot key on popular endpoint → hash-slot tagging

---

## 8. Example API Usage

```ts
import { createLimiter, BinanceAdapter, RedisStore } from '@bitazza/rate-limiter';

const limiter = createLimiter({
  adapter: new BinanceAdapter(),
  store: new RedisStore({ url: process.env.REDIS_URL }),
  defaultStrategy: 'queue',
  maxQueueSize: 10_000,
});

// 1. Simple wrap
const getBalance = limiter.wrap('/api/v3/account', async () => {
  return fetch('https://api.binance.com/api/v3/account', { headers });
});

await getBalance();   // auto-tracked

// 2. Explicit schedule
const order = await limiter.schedule({
  endpoint: '/api/v3/order',
  priority: 10,
  strategy: 'queue',
  timeoutMs: 5_000,
  retry: { maxAttempts: 3, backoff: 'exponential', baseMs: 200, respectRetryAfter: true },
  execute: () => placeOrder(payload),
});

// 3. Low-prio analytics — reject if full
await limiter.schedule({
  endpoint: '/api/v3/klines',
  priority: 1,
  strategy: 'reject',
  execute: fetchKlines,
}).catch(err => {
  if (err.code === 'RATE_LIMITED') metrics.skip();
});

// 4. Events
limiter.on('limit:near', ({ usage, max, window }) => {
  log.warn(`${usage}/${max} on ${window}`);
});

limiter.on('ban:detected', ({ until }) => alert(`banned till ${new Date(until)}`));
```

---

## 9. Testing Strategy

| Layer | Approach |
|-------|----------|
| Algorithms | Pure unit, mock clock (`@sinonjs/fake-timers`), property-based via `fast-check` |
| Store (memory) | Unit + concurrency tests (Promise.all bursts) |
| Store (Redis) | `testcontainers` Redis, integration suite |
| Scheduler | Deterministic clock, scripted scenarios |
| Adapters | Replay recorded provider responses (nock) |
| End-to-end | Run against Binance testnet behind feature flag |
| Load | k6 / autocannon, measure p99 latency + throughput |
| Fault injection | Toxiproxy for Redis (latency, drop, partition) |
| Memory | Long-run soak, heap snapshots, leak detector |

Target: >90% line coverage, 100% on algorithm core.

---

## 10. v1 vs Future

**v1 (MVP, ship fast):**
- Fixed + sliding window algorithms
- Memory store + Redis store
- Generic + Binance adapter
- Reject / queue / delay strategies
- Priority queue with aging
- Retry with exponential backoff + Retry-After
- Event hooks (typed)
- Basic Prometheus metrics
- TypeScript types, ESM + CJS dual build

**v2+:**
- Token bucket + leaky bucket
- More adapters (Coinbase, Kraken, OKX, Bybit)
- Distributed queue (Redis Streams) for cross-node ordering
- Persistent queue (survives restart)
- Adaptive rate limit (learn from 429 patterns, ML-ish)
- Circuit breaker integration
- gRPC/HTTP sidecar mode (language-agnostic)
- OpenTelemetry tracing
- Web dashboard (queue depth, usage graphs)
- Rate-limit "borrowing" between providers
- Plugin system for custom strategies

---

## Key Design Decisions

1. **Storage is the abstraction boundary** — algorithm + scheduler stay pure; distributed-ness is one swap.
2. **Pessimistic consume + refund** beats optimistic post-check — never overshoot.
3. **Adapter parses provider response** — trust server's actual count (`X-MBX-USED-WEIGHT-1M`) over local guess.
4. **Local queue, global counter** — minimize cross-node chatter while keeping correctness.
5. **Strategy is per-request, not per-client** — same library handles trading (queue) and analytics (reject).

# rate-limiter

Distributed rate-limit and request scheduling manager for third-party APIs.

Track weighted API usage (e.g. Binance `X-MBX-USED-WEIGHT`), prevent threshold breaches, schedule requests via **reject / delay / queue** strategies. Single-process (memory) or horizontally scaled (Redis).

> **Status:** Pre-implementation. API below reflects design in `design/02-architecture.md`. Phase 1 (core local lib) in progress. See `design/tasks/STATUS.md`.

---

## Why

Third-party APIs (Binance, Coinbase, etc.) ban clients that breach weight/rate limits. Naive retry loops make it worse. This lib:

- Tracks weight per endpoint, per window, across processes
- Pessimistically reserves capacity **before** the call (no overshoot)
- Reconciles upward from provider response headers
- Decides per-request: reject / delay / queue with priority + aging
- Handles ban cooldown, retry with `Retry-After`, backoff with jitter

---

## Install

```bash
npm install @bitazza/rate-limiter
# or
pnpm add @bitazza/rate-limiter
# or
yarn add @bitazza/rate-limiter
```

Redis mode also needs:

```bash
npm install ioredis
```

**Requirements:** Node.js ≥ 18, TypeScript ≥ 5 (types ship in the package). ESM + CJS dual build.

---

## Quick Start — single process (memory)

```ts
import { createLimiter, GenericAdapter, MemoryStore } from '@bitazza/rate-limiter';

const limiter = createLimiter({
  provider: {
    name: 'binance',
    windows: [{ id: '1m', windowMs: 60_000, maxWeight: 1200, algorithm: 'sliding' }],
    endpoints: {
      '/api/v3/account': { weight: 10 },
      '/api/v3/order':   { weight: 1  },
      '/api/v3/klines':  { weight: 2  },
    },
  },
  adapter: new GenericAdapter(),
  store: new MemoryStore(),
  defaultStrategy: 'queue',
  maxQueueSize: 10_000,
});

const account = await limiter.schedule({
  endpoint: '/api/v3/account',
  execute: () => fetch('https://api.binance.com/api/v3/account', { headers }).then(r => r.json()),
});
```

---

## Setup — distributed (Redis)

Swap `MemoryStore` → `RedisStore`. Same scheduler, same algorithms, atomic counters in Redis Lua.

```ts
import { createLimiter, BinanceAdapter, RedisStore } from '@bitazza/rate-limiter';
import Redis from 'ioredis';

const limiter = createLimiter({
  adapter: new BinanceAdapter(),                       // knows weights + header names
  store: new RedisStore({
    client: new Redis(process.env.REDIS_URL!),
    keyPrefix: 'rl:binance:',
    failMode: 'closed',                                // 'open' = allow on Redis outage
  }),
  defaultStrategy: 'queue',
  maxQueueSize: 10_000,
  banCooldownMs: 180_000,                              // 3 min
});
```

Every process shares one global counter. Local priority queue stays per-process (low coordination cost).

---

## Usage patterns

### 1. Wrap an existing function

```ts
const getBalance = limiter.wrap('/api/v3/account', async () => {
  const r = await fetch('https://api.binance.com/api/v3/account', { headers });
  return r.json();
});

await getBalance();   // auto-tracked, auto-scheduled
```

### 2. Schedule with priority + retry — critical path

```ts
const order = await limiter.schedule({
  endpoint: '/api/v3/order',
  priority: 10,                                        // higher = sooner
  strategy: 'queue',
  timeoutMs: 5_000,
  retry: {
    maxAttempts: 3,
    backoff: 'exponential',
    baseMs: 200,
    respectRetryAfter: true,
  },
  execute: () => placeOrder(payload),
});
```

### 3. Low-priority — reject when full

```ts
await limiter.schedule({
  endpoint: '/api/v3/klines',
  priority: 1,
  strategy: 'reject',
  execute: fetchKlines,
}).catch(err => {
  if (err.code === 'RATE_LIMITED') metrics.skip();
});
```

### 4. Delay strategy — sleep until slot opens

```ts
await limiter.schedule({
  endpoint: '/api/v3/depth',
  strategy: 'delay',                                   // sleep retryAfterMs, then retry
  execute: fetchDepth,
});
```

### 5. Dynamic weight (depends on request shape)

```ts
const limiter = createLimiter({
  provider: {
    name: 'binance',
    windows: [{ id: '1m', windowMs: 60_000, maxWeight: 1200 }],
    endpoints: {
      '/api/v3/klines': {
        weight: req => (req.meta?.limit && (req.meta.limit as number) > 500 ? 5 : 1),
      },
    },
  },
  // ...
});
```

### 6. Events / observability

```ts
limiter.on('limit:near',     ({ usage, max, window }) => log.warn(`${usage}/${max} ${window}`));
limiter.on('limit:exceeded', ({ endpoint, window })   => log.error(`exceeded ${endpoint} ${window}`));
limiter.on('ban:detected',   ({ until })              => alert(`banned till ${new Date(until)}`));
limiter.on('ban:cleared',    ()                       => log.info('ban cleared'));
limiter.on('request:queued', ({ endpoint, depth })    => metrics.gauge('queue.depth', depth));
limiter.on('request:retry',  ({ attempt, delayMs })   => log.info(`retry #${attempt} in ${delayMs}ms`));

const s = limiter.stats();
// { queueDepth, inflight, usage: {'1m': 47}, banUntil?: number }
```

### 7. Graceful shutdown

```ts
process.on('SIGTERM', async () => {
  await limiter.drain();                               // finish queued, refuse new
  process.exit(0);
});
```

---

## Typed errors

```ts
import {
  RateLimitError,    // strategy=reject and no capacity
  BannedError,       // provider returned 429/418
  QueueFullError,    // maxQueueSize hit
  TimeoutError,      // timeoutMs elapsed in queue
} from '@bitazza/rate-limiter';

try {
  await limiter.schedule({ /* ... */ });
} catch (e) {
  if (e instanceof BannedError)    return retryLater(e.untilMs);
  if (e instanceof QueueFullError) return drop();
  throw e;
}
```

---

## Configuration reference (v1)

| Option              | Default      | Notes                                            |
|---------------------|--------------|--------------------------------------------------|
| `defaultStrategy`   | `'queue'`    | `'reject' \| 'delay' \| 'queue'`                 |
| `maxQueueSize`      | `10_000`     | Reject oldest/lowest-priority when full          |
| `agingFactorMs`     | `1_000`      | Priority boost per second waiting (anti-starve)  |
| `banCooldownMs`     | `180_000`    | Initial ban TTL when adapter detects 429/418     |
| `reservationTtlMs`  | `30_000`     | Auto-refund on process crash                     |
| `failMode` (Redis)  | `'closed'`   | `'open'` = allow on Redis outage                 |

Algorithm default: **sliding window counter** (Binance-friendly, no boundary double-burst).

---

## Roadmap

- **Phase 1** — client, memory store, fixed/sliding window, scheduler (reject/delay/queue), priority queue, generic adapter
- **Phase 2** — Binance adapter, retry/backoff, ban detection, header reconciliation, metrics/events
- **Phase 3** — Redis store, Lua atomic consume, multi-window all-or-nothing, fail-open/closed
- **Phase 4** — load tests, fault injection (Toxiproxy), OTel hooks, release tooling
- **v2+** — token bucket, more adapters (Coinbase/Kraken/OKX), persistent queue, adaptive limits, dashboard

---

## Design docs

Authoritative spec lives in `design/`. Read in order:

- `design/00-request.md` — original requirements
- `design/01-design.md` — condensed design summary
- `design/02-architecture.md` — full architectural spec (component model, ADRs, defaults) — **wins on conflict**
- `design/tasks/STATUS.md` — implementation task tracker

---

## License

TBD.

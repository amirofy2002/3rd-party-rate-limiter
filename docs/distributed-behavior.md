# Distributed Behavior

## Storage model

The library separates rate-limit accounting from request scheduling. Storage
is the only abstraction that knows whether the deployment is single-process
(`MemoryStore`) or horizontally scaled (`RedisStore`). Schedulers and
algorithms talk to the `RateLimitStore` interface and never to Redis directly.

## Key shape

Redis keys are hash-tagged so every key for one scope lives on the same
Cluster slot:

- `rl:{provider:scope}:{windowId}:usage` — per-window counters
- `rl:{provider:scope}:ban` — string holding `untilMs`
- `rl:{provider:scope}:res:{id}` — reservation hash with PX TTL

## Atomicity

- Single-window `consume` is fully atomic via a single Lua script.
- Multi-window `consume` is *best-effort* in v1: scripts run sequentially with
  client-side rollback on the first denial. A unified `consume_multi` Lua is
  on the v2 roadmap.

## Failure modes (`ResilientStore`)

| Mode               | Behavior on store error                                                |
|--------------------|------------------------------------------------------------------------|
| `failClosed`       | Rethrow `StoreUnavailableError`. Scheduler rejects or queues.          |
| `failOpen`         | Allow the request without protection. Risks provider bans.            |
| `fallbackToMemory` | Route to in-process memory store, probe primary, switch back on recovery (3 consecutive successes). |

Production default: `failClosed`.

## Health checks

`ResilientStore` invokes `primary.ping()` every `healthCheckIntervalMs`
(default 5s) while in fallback. The store moves back to primary after
`recoveryThreshold` consecutive successful pings (default 3) to avoid
thrash.

## Ban propagation

`setBan` writes a PX-expiring string to the shared store. All scheduler
instances honour it through `getBan`. The local `RateLimiter` also schedules
a clock timer to emit `ban:cleared` when the ban TTL elapses; this is a
local convenience signal — the authoritative state is in the store.

## Integration test suite

The suite under `test/integration/` covers:

1. Atomic multi-window with 8 simulated clients
2. Ban propagation across instances
3. Reservation TTL expiry
4. `NOSCRIPT` recovery
5. Redis Cluster hash-tag routing
6. Sentinel failover
7. Toxiproxy network partition
8. Lua determinism across Redis versions

Run with:

```bash
pnpm test:integration
```

Tests are skipped when Docker / testcontainers is unavailable.

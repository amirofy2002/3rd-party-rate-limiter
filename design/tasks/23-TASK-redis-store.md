# 23-TASK-redis-store

## Goal

`RedisStore` implementing `RateLimitStore` over Redis using Lua scripts. Architecture §6.7, §11, §12.

## Dependencies

- `04-TASK-store-interface`
- `22-TASK-redis-lua-scripts`

## Logic

### `src/storage/redis-store.ts`

```ts
class RedisStore implements RateLimitStore {
  constructor(opts: RedisStoreOptions);
}

interface RedisStoreOptions {
  client?: Redis;                   // bring-your-own ioredis client
  url?: string;                     // or connection URL
  keyPrefix?: string;               // default 'rl:'
  scripts?: ScriptLoader;           // injectable for tests
  useServerTime?: boolean;          // default true → uses Redis TIME
  banKeyTtlExtraMs?: number;        // default 0
}
```

Methods delegate to scripts from task 22:

- `consume` → `EVALSHA consume_multi`.
- `refund` → `EVALSHA refund`.
- `setBan` → `EVALSHA set_ban` (or plain `SET ... PX ... XX-less`).
- `getBan` → `GET banKey`; null if missing or expired.
- `clearBan` → `DEL banKey`.
- `reserve` → script with TTL; returns generated id (ULID) computed client-side passed as ARGV.
- `releaseReservation` → script that refunds + deletes.
- `ping` → `PING`.

Connection lifecycle:

- If `client` provided: do not own it; do not disconnect on `close`.
- If `url` provided: own internally; disconnect on `close`.

Resilience:

- Wrap calls in `tryCatch`; on connection error, throw `StoreUnavailableError` with cause.
- Auto-reconnect via ioredis; `ping` exposed for health checks.

## Tests

Reuse store contract suite (task 04) against Redis via testcontainers.

Additional Redis-specific tests:

- `useServerTime: true` survives 5-minute simulated client clock drift.
- Reconnect after Redis restart: store recovers, next consume works.
- Concurrent multi-window consume across 8 parallel clients respects max.
- Disabled cluster mode + provided cluster URL: warns, still functions.

## Edge Cases

- Redis Cluster + non-hash-tagged keys: detect at construction (`info cluster`) and throw if conflict.
- Pipelining: not used for single Lua calls (each call is one round trip).
- Large `ttlMs` (hours): clamp via option `maxReservationTtlMs`.
- Replication lag: documented limitation; do not read from replicas for `consume` paths.
- BYO client without `EVALSHA` permission: detect at first call, fallback to `EVAL`, warn.

## Acceptance

Drop-in replacement for `MemoryStore`. Contract tests green. Integration suite (task 25) covers multi-node correctness.

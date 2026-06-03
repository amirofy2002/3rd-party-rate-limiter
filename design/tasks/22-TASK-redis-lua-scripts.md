# 22-TASK-redis-lua-scripts

## Goal

Atomic Redis Lua scripts for consume / refund / ban / reservation operations. Architecture §12.

## Dependencies

- `04-TASK-store-interface`
- `06-TASK-algorithm-interface` (mirrored in Lua per algorithm)

## Logic

### `src/storage/redis-scripts.ts`

Export scripts as JS strings + SHA preload helper.

Scripts:

#### `consume.lua` (sliding window counter)

Inputs: `KEYS[1] = usage_key`, `ARGV = [windowMs, maxWeight, weight, nowMs, reservationId?, ttlMs?]`.

Logic (per architecture §12 + algorithm §08):

```lua
local cur_start = tonumber(redis.call('HGET', KEYS[1], 'cur_start') or '0')
local cur_count = tonumber(redis.call('HGET', KEYS[1], 'cur_count') or '0')
local prev_count = tonumber(redis.call('HGET', KEYS[1], 'prev_count') or '0')
-- roll windows based on now vs cur_start
-- compute effective usage
-- if effective + weight <= max → update fields + optionally write reservation
-- return {allowed, current, remaining, retryAfterMs}
```

Use Redis `TIME` if `nowMs` not provided (architecture §12).

#### `consume_multi.lua`

Wrap multiple windows in single script. All-or-nothing: simulate all, then either commit all or none.

#### `refund.lua`

Subtract weight from current window count (clamp at 0).

#### `set_ban.lua`

`SET banKey untilMs PX (untilMs - now)`.

#### `expire_reservation.lua`

Triggered by polled cleanup or pubsub: refund weights, delete reservation hash.

Key naming: `rl:{provider}:{scope}:{windowId}:usage`, `rl:{provider}:{scope}:ban`, `rl:{provider}:{scope}:res:{id}`. Hash tag `{provider}:{scope}` for Redis Cluster.

### `src/storage/lua-loader.ts`

- Load all scripts at startup via `SCRIPT LOAD`; cache SHAs.
- `EVALSHA` with fallback to `EVAL` on `NOSCRIPT` errors (transient after Redis restart).

## Tests

Run against ephemeral Redis via `testcontainers`:

- consume within limit: returns allowed=1, remaining decreases.
- consume over limit: allowed=0, retryAfterMs > 0.
- consume_multi: window A allows, window B denies → window A NOT consumed.
- Reservation written under TTL: expires automatically; refund happens via cleanup loop OR Lua-side TTL hook.
- Refund clamp at 0.
- Ban set + read: returns untilMs while live, nil after expiry.
- `NOSCRIPT` recovery: flush scripts, next call still works.
- Concurrent 1000 EVALSHA calls from 10 parallel clients: no overshoot.

## Edge Cases

- Script size: keep each script < 1KB for clean Redis logs.
- Floating-point in Lua: use `tonumber()`, avoid integer overflow with `redis.call('HINCRBYFLOAT', ...)` only if needed.
- Cluster mode: all keys for one script must share hash tag — assert at script call site.
- Redis 6 vs 7: prefer commands available in 6.x.
- Time source: `redis.call('TIME')` returns `{secs, micros}`; convert to ms via `s*1000 + math.floor(micros/1000)`.

## Acceptance

Scripts pass concurrency + atomicity tests. SHAs pinned in source.

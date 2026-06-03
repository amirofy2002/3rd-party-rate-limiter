/**
 * Lua scripts for the Redis-backed rate-limit store.
 *
 * Each script is intentionally kept small and atomic. Multi-window operations
 * are merged into a single script so the "all-or-nothing" reservation
 * contract holds without client-side coordination.
 *
 * Keys are namespaced as:
 *   rl:{provider}:{scope}:{windowId}:usage   — hash (per-window state)
 *   rl:{provider}:{scope}:ban                — string holding ban until-ms
 *   rl:{provider}:{scope}:res:{id}           — hash holding reservation metadata
 *
 * The `{provider}:{scope}` hash tag keeps related keys on the same Redis
 * Cluster slot so a single EVAL touches one shard.
 */

/** Per-window consume + reservation write for the sliding-window-counter algorithm. */
export const CONSUME_SLIDING_LUA = `
-- KEYS[1] usage key
-- KEYS[2] reservation key
-- ARGV[1] windowMs
-- ARGV[2] maxWeight
-- ARGV[3] weight
-- ARGV[4] nowMs (-1 = use server TIME)
-- ARGV[5] reservationTtlMs

local windowMs = tonumber(ARGV[1])
local maxWeight = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
local ttlMs = tonumber(ARGV[5])

if nowMs < 0 then
  local t = redis.call('TIME')
  nowMs = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
end

local curStartRaw = redis.call('HGET', KEYS[1], 'cur_start')
local curCountRaw = redis.call('HGET', KEYS[1], 'cur_count')
local prevCountRaw = redis.call('HGET', KEYS[1], 'prev_count')
local cur_start = curStartRaw and tonumber(curStartRaw) or (nowMs - (nowMs % windowMs))
local cur_count = curCountRaw and tonumber(curCountRaw) or 0
local prev_count = prevCountRaw and tonumber(prevCountRaw) or 0

local elapsed = nowMs - cur_start
if elapsed >= 2 * windowMs then
  cur_start = nowMs - (nowMs % windowMs)
  cur_count = 0
  prev_count = 0
elseif elapsed >= windowMs then
  cur_start = cur_start + windowMs
  prev_count = cur_count
  cur_count = 0
end

local elapsedInCurrent = nowMs - cur_start
local overlap = 1 - (elapsedInCurrent / windowMs)
if overlap < 0 then overlap = 0 end
local usage = prev_count * overlap + cur_count

if weight > maxWeight then
  return { 0, math.floor(usage + 0.5), math.max(0, maxWeight - math.floor(usage + 0.5)), -1 }
end

if usage + weight > maxWeight + 0.000001 then
  local allowance = maxWeight - cur_count - weight
  local retry
  if prev_count <= 0 then
    retry = math.max(1, cur_start + windowMs - nowMs)
  elseif allowance < 0 then
    retry = math.max(1, cur_start + windowMs - nowMs)
  else
    local allowedOverlap = allowance / prev_count
    local required = (1 - allowedOverlap) * windowMs - elapsedInCurrent
    if required < 1 then required = 1 end
    retry = math.ceil(required)
  end
  return { 0, math.floor(usage + 0.5), math.max(0, maxWeight - math.floor(usage + 0.5)), retry }
end

cur_count = cur_count + weight
redis.call('HSET', KEYS[1], 'cur_start', cur_start, 'cur_count', cur_count, 'prev_count', prev_count)
redis.call('PEXPIRE', KEYS[1], windowMs * 4)

if KEYS[2] ~= '' and KEYS[2] ~= nil then
  redis.call('HSET', KEYS[2], 'weight', weight, 'windowKey', KEYS[1])
  redis.call('PEXPIRE', KEYS[2], ttlMs)
end

local newUsage = prev_count * overlap + cur_count
return { 1, math.floor(newUsage + 0.5), math.max(0, maxWeight - math.floor(newUsage + 0.5)), 0 }
`;

/** Fixed-window consume (mirrors the in-memory algorithm). */
export const CONSUME_FIXED_LUA = `
-- KEYS[1] usage key (hash)
-- KEYS[2] reservation key
-- ARGV[1] windowMs
-- ARGV[2] maxWeight
-- ARGV[3] weight
-- ARGV[4] nowMs (-1 = TIME)
-- ARGV[5] reservationTtlMs

local windowMs = tonumber(ARGV[1])
local maxWeight = tonumber(ARGV[2])
local weight = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
local ttlMs = tonumber(ARGV[5])

if nowMs < 0 then
  local t = redis.call('TIME')
  nowMs = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
end

local startRaw = redis.call('HGET', KEYS[1], 'start')
local countRaw = redis.call('HGET', KEYS[1], 'count')
local start = startRaw and tonumber(startRaw) or (nowMs - (nowMs % windowMs))
local count = countRaw and tonumber(countRaw) or 0

if (nowMs - start) >= windowMs then
  start = nowMs - (nowMs % windowMs)
  count = 0
end

if weight > maxWeight then
  return { 0, count, math.max(0, maxWeight - count), -1 }
end

if count + weight > maxWeight then
  local retry = math.max(1, start + windowMs - nowMs)
  return { 0, count, math.max(0, maxWeight - count), retry }
end

count = count + weight
redis.call('HSET', KEYS[1], 'start', start, 'count', count)
redis.call('PEXPIRE', KEYS[1], windowMs * 2)

if KEYS[2] ~= '' and KEYS[2] ~= nil then
  redis.call('HSET', KEYS[2], 'weight', weight, 'windowKey', KEYS[1])
  redis.call('PEXPIRE', KEYS[2], ttlMs)
end

return { 1, count, math.max(0, maxWeight - count), 0 }
`;

/** Refund a previously-issued reservation. Returns 1 when applied, 0 otherwise. */
export const REFUND_LUA = `
-- KEYS[1] reservation key
local weight = tonumber(redis.call('HGET', KEYS[1], 'weight') or '0')
local windowKey = redis.call('HGET', KEYS[1], 'windowKey')
if not windowKey or weight <= 0 then
  redis.call('DEL', KEYS[1])
  return 0
end
local algo = redis.call('HGET', windowKey, 'cur_count')
if algo ~= false then
  -- sliding-window-counter: subtract from cur_count then prev_count.
  local cur = tonumber(redis.call('HGET', windowKey, 'cur_count') or '0')
  local fromCur = math.min(cur, weight)
  local remaining = weight - fromCur
  local prev = tonumber(redis.call('HGET', windowKey, 'prev_count') or '0')
  redis.call('HSET', windowKey,
    'cur_count', cur - fromCur,
    'prev_count', math.max(0, prev - remaining))
else
  -- fixed-window: subtract from count.
  local count = tonumber(redis.call('HGET', windowKey, 'count') or '0')
  redis.call('HSET', windowKey, 'count', math.max(0, count - weight))
end
redis.call('DEL', KEYS[1])
return 1
`;

/** Set a ban with millisecond precision. */
export const SET_BAN_LUA = `
-- KEYS[1] ban key
-- ARGV[1] untilMs
-- ARGV[2] nowMs (-1 = TIME)
local nowMs = tonumber(ARGV[2])
if nowMs < 0 then
  local t = redis.call('TIME')
  nowMs = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
end
local untilMs = tonumber(ARGV[1])
if untilMs <= nowMs then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('SET', KEYS[1], untilMs, 'PX', untilMs - nowMs)
return 1
`;

/** Returns ban-until ms or nil. */
export const GET_BAN_LUA = `
-- KEYS[1] ban key
-- ARGV[1] nowMs (-1 = TIME)
local nowMs = tonumber(ARGV[1])
if nowMs < 0 then
  local t = redis.call('TIME')
  nowMs = (tonumber(t[1]) * 1000) + math.floor(tonumber(t[2]) / 1000)
end
local v = redis.call('GET', KEYS[1])
if not v then return nil end
local untilMs = tonumber(v)
if not untilMs or untilMs <= nowMs then
  redis.call('DEL', KEYS[1])
  return nil
end
return untilMs
`;

/** Bundle for `lua-loader.ts` to ingest. */
export const ALL_SCRIPTS = {
  consumeSliding: CONSUME_SLIDING_LUA,
  consumeFixed: CONSUME_FIXED_LUA,
  refund: REFUND_LUA,
  setBan: SET_BAN_LUA,
  getBan: GET_BAN_LUA,
} as const;

export type ScriptName = keyof typeof ALL_SCRIPTS;

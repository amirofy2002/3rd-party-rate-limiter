# 19-TASK-ban-detection-and-cooldown

## Goal

End-to-end ban lifecycle: detect from provider response, set shared ban state, pause queue draining for affected scope, clear automatically. Architecture §13.2.

## Dependencies

- `10-TASK-rate-limiter-core`
- `15-TASK-scheduler`
- `18-TASK-binance-adapter` (or `13-TASK-generic-adapter`)

## Logic

Wire-up across existing components (no new module strictly required, but add `src/core/ban-coordinator.ts` if logic grows):

1. Scheduler `runExecute` catches error → `adapter.parseResponse` + `adapter.classifyError`.
2. If `banned` or `rate-limited` with `banUntilMs`: `limiter.setBan(scope, untilMs)` + emit `ban:detected`.
3. Scheduler's drain loop skips items whose scope is currently banned. Items remain in queue (do not drop).
4. A single per-scope timer is set via `clock.setTimeout(untilMs - now)`; on fire: `store.clearBan(scope)` + emit `ban:cleared` + trigger drain.
5. New `schedule` calls during ban respect strategy: `reject` → `BannedError`; `delay` → wait until ban end; `queue` → enqueue.

## Tests

- Trigger 418 via mock adapter → ban set, subsequent reject-strategy requests fail with `BannedError`.
- Queued requests during ban: not executed until ban clears, then drained.
- `ban:detected` and `ban:cleared` events fire exactly once per ban window.
- Multiple instances (with Redis store, deferred to phase 3): ban set by instance A is honored by instance B before re-attempting.
- Re-ban during cooldown: extend `untilMs` to latest value.
- Jittered restart: 100 simulated clients all observe ban, only ~`1 + maxConcurrent` retry simultaneously after clear (jitter from retry policy).

## Edge Cases

- Provider returns 429 with `Retry-After: 0` → treat as transient retry, not a ban.
- Ban end timer fires after process restart: store TTL handles this (memory store: lost; Redis: persisted).
- Clock skew between local timer and store TTL: prefer store-time on check.
- Scope-level ban vs global provider ban: adapter decides scope key. Document that account-level bans should use account scope, IP bans should use IP scope.

## Acceptance

Scenario test: 1000 requests against fake provider that bans for 500ms on overshoot → library never exceeds + drains 100% within bounded time.

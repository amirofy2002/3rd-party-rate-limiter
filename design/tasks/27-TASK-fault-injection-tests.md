# 27-TASK-fault-injection-tests

## Goal

Verify behavior under provider misbehavior, Redis turbulence, crash simulation. Architecture §22.4.

## Dependencies

- `19-TASK-ban-detection-and-cooldown`
- `24-TASK-redis-failure-modes`
- `25-TASK-redis-integration-tests`

## Logic

### `test/fault/` directory

Scenarios:

1. **Redis latency:** Toxiproxy adds 200ms latency. Throughput drops; correctness preserved; no false bans.
2. **Redis intermittent drops:** Toxiproxy drops 30% of packets. `failClosed` rejects appropriately; no overshoot.
3. **Provider 429 without `Retry-After`:** retry policy uses exponential backoff with jitter; no synchronized retry storm (assert max 10% of clients retry in any 100ms window after ban clears).
4. **Provider 418 ban:** ban set, queue paused, drain resumes after cooldown.
5. **Process crash:** simulate by killing the test instance mid-flight (or canceling reservations without release). Verify reservation TTL releases capacity.
6. **Slow `execute()`:** user function hangs past `timeoutMs`. Verify `RequestTimeoutError`, reservation refunded if configured.
7. **Header mismatch:** provider reports usage = local + 50. Verify upward reconciliation, no overshoot on next request.
8. **Clock jump backward:** advance fake clock by -10s. Verify algorithms do not reset, do not overshoot.
9. **Event handler throws:** verify scheduler continues, error logged.
10. **Queue saturation:** push 11k requests at 10k cap with `reject-new`. Verify exactly 1k rejected with `QueueFullError`.

## Tests

Each scenario as `describe` with assertions. Use `@sinonjs/fake-timers` for clock fault scenarios; Toxiproxy for network.

## Edge Cases

- Toxiproxy not installed locally: scenarios skipped with warning, required in CI.
- Worker crashes leave dangling reservations: covered by scenario 5; verify TTL fires.
- Mock provider should be deterministic, not real Binance.
- Some scenarios are slow (10s+); mark `@slow`, exclude from default `pnpm test`.

## Acceptance

All 10 scenarios green. Documented in `docs/failure-modes.md`.

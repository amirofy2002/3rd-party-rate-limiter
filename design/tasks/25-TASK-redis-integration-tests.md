# 25-TASK-redis-integration-tests

## Goal

Multi-instance correctness, atomicity under load, ban propagation. Architecture §22.2.

## Dependencies

- `23-TASK-redis-store`
- `24-TASK-redis-failure-modes`
- `19-TASK-ban-detection-and-cooldown`

## Logic

### `test/integration/redis-*.test.ts`

Use `testcontainers` to launch ephemeral Redis 7.

Scenarios:

1. **Atomic multi-window:** 8 parallel processes (simulated via worker_threads or just 8 client instances), each issuing 1000 consume calls. Assert total successful weight ≤ `maxWeight` for the window.
2. **Ban propagation:** Instance A receives 418, calls `setBan`. Instance B's next `consume` sees ban via `checkBan` (within 50ms p99).
3. **Reservation expiry:** Instance crashes (simulated by not calling `releaseReservation`); capacity reclaimed after TTL.
4. **`NOSCRIPT` recovery:** flush scripts via `SCRIPT FLUSH` mid-test, ensure auto-reload.
5. **Cluster mode:** launch Redis cluster (3 masters), verify hash-tagged keys land on same slot, operations succeed.
6. **Failover (Sentinel):** primary master killed; client reconnects; consume continues.
7. **Network partition (Toxiproxy):** packet drop for 5s; `failClosed` rejects; `fallbackToMemory` switches; both modes reconcile on heal.
8. **Lua determinism:** same script across versions returns identical structure.

## Tests

The above ARE the tests. Each scenario is a `describe` block with assertions and cleanup.

Verification commands:

- `pnpm test:integration` runs full suite (CI flagged).
- Coverage report excludes Redis container setup boilerplate.

## Edge Cases

- CI without Docker: integration tests skipped via `vitest.skipIf(!hasDocker)`.
- Slow CI: increase test timeouts to 60s for cluster/sentinel scenarios.
- Resource leaks: ensure containers torn down even on test failure (`afterAll` with `--bail` safe).
- Flaky network timing: retry assertions with bounded backoff (max 3 attempts) for "within X ms" claims.

## Acceptance

All scenarios green on CI. Documented in `docs/distributed-behavior.md` (created here).

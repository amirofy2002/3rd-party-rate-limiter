# Failure Modes

The fault-injection suite at `test/fault/` documents how the library behaves
under common failure scenarios. Each scenario is reproduced as a Vitest
test using `FakeClock` (and Toxiproxy where network faults matter).

| # | Scenario                                  | Behavior                                                                                         |
|---|-------------------------------------------|--------------------------------------------------------------------------------------------------|
| 1 | Redis latency 200ms                       | Throughput drops; correctness preserved; no false bans.                                          |
| 2 | Redis intermittent drops (30%)            | `failClosed` rejects appropriately; no overshoot.                                                |
| 3 | Provider 429 without `Retry-After`        | Exponential backoff with jitter; retries succeed once capacity returns.                          |
| 4 | Provider 418 ban                          | Ban set, queue paused, drain resumes after cooldown.                                             |
| 5 | Process crash mid-reservation             | Reservation TTL releases capacity automatically.                                                 |
| 6 | Slow `execute()` exceeds `timeoutMs`      | `RequestTimeoutError`; reservation refunded if `refundOnTimeout`.                               |
| 7 | Provider header mismatch (local < remote) | Upward reconciliation; subsequent reserve sees correct usage.                                    |
| 8 | Clock jump backward                       | Algorithms clamp `now` to `currentStart`; no reset, no overshoot.                                |
| 9 | Event handler throws                      | Scheduler continues; handler error logged via `Logger.error`.                                    |
| 10 | Queue saturation                         | `reject-new` rejects the overflow with `QueueFullError`; `drop-oldest`/`drop-lowest-priority` evict accordingly. |

Network-level scenarios (1, 2) require Toxiproxy and are gated on
`RUN_REDIS_FAULT=1`. Local scenarios run as part of `pnpm test`.

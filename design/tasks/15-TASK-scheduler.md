# 15-TASK-scheduler

## Goal

Decision engine. Implements reject/delay/queue strategies, drains queue on capacity availability, applies retries, respects bans, enforces concurrency cap. Architecture §6.3, §8, §9, §15.

## Dependencies

- `02-TASK-clock-abstraction`
- `03-TASK-event-bus`
- `10-TASK-rate-limiter-core`
- `11-TASK-priority-queue`
- `12-TASK-adapter-interface`
- `14-TASK-retry-policy`

## Logic

### `src/core/scheduler.ts`

```ts
class Scheduler {
  constructor(opts: {
    limiter: RateLimiter;
    queue: PriorityQueue<QueuedRequest>;
    retry: RetryPolicy;
    adapter: ProviderAdapter;
    events: EventBus;
    clock: Clock;
    maxConcurrent: number;
    overflowPolicy: OverflowPolicy;
    redisFailureMode: RedisFailureMode;
    defaultStrategy: RequestStrategy;
    nearLimitThreshold?: number;     // default 0.8
  });

  submit<T>(req: NormalizedRequest<T>): Promise<T>;
  drain(): Promise<void>;     // resolves when queue empty + no in-flight
  stats(): SchedulerStats;
}
```

Submit flow per architecture §8:

```
1. emit request:received
2. ban = await limiter.checkBan(scope)
   if banned:
     strategy=reject → throw BannedError
     strategy=delay  → clock.sleep(until ban end), retry
     strategy=queue  → enqueue, return promise
3. outcome = await limiter.reserve(scope, weight, windows)
   if allowed:
     await runExecute(req, reservation)
   else:
     strategy=reject → throw RateLimitError(retryAfterMs)
     strategy=delay  → clock.sleep(retryAfterMs), retry from 2
     strategy=queue  → enqueue with overflow check
```

`runExecute`:

- Acquire concurrency slot (counting semaphore).
- Race user `execute()` against `clock.sleep(timeoutMs)`.
- On success: `adapter.parseResponse` → `limiter.reconcileFromProvider`; emit `request:executed`.
- On error: `adapter.classifyError`; if rate-limited/banned, `limiter.setBan` from observation; retry policy decides; on terminal failure throw `ProviderExecutionError` (or refund per config).
- Release concurrency slot in finally.

Drain loop:

- Triggered on: request completion, capacity tick (poll on `min(retryAfterMs)`), ban cleared event, new enqueue.
- Peek queue, attempt reserve, execute or re-sleep.
- Single drain coroutine (no parallel drains) to keep ordering.

Overflow handling on enqueue:

- If `queue.size >= maxQueueSize`, apply `overflowPolicy`:
  - `reject-new`: throw `QueueFullError`
  - `drop-oldest`: remove FIFO oldest, reject its promise with `QueueFullError`
  - `drop-lowest-priority`: remove min-priority item, reject

## Tests

- Reject strategy denies immediately when over limit.
- Delay strategy waits and retries under fake clock.
- Queue strategy queues, drains on capacity tick.
- Concurrency cap respected: 100 immediate-allowed requests with `maxConcurrent=10` → only 10 in flight at any moment.
- Ban set mid-flight: queued items wait for ban end.
- Timeout: request waits in queue past `timeoutMs` → rejected with `RequestTimeoutError`.
- Retry on 429: respects `Retry-After`, eventually succeeds after ban lifts.
- Overflow `reject-new`: 11th item to a 10-cap queue rejected.
- Aging promotes starved low-priority items.

## Edge Cases

- `execute()` returns synchronously (not a promise) — coerce via `Promise.resolve()`.
- `execute()` throws synchronously: treat same as rejected promise.
- Timeout fires while reservation already consumed: refund per ADR-001 if `refundOnTimeout`.
- Drain loop wakes spuriously: no-op gracefully.
- Multiple scopes drain independently: separate per-scope queues OR single queue with scope-aware peek. v1: single queue, scope-aware peek (skip items whose scope is banned).
- `redisFailureMode = failClosed` + store throws: reject immediately.
- `redisFailureMode = fallbackToMemory`: switch store ref atomically, emit `store:error` + `store:fallback`.

## Acceptance

Deterministic under fake clock. All strategies + retry + drain pass integration test scenarios.

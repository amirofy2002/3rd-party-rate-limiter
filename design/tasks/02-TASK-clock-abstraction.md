# 02-TASK-clock-abstraction

## Goal

Inject-able `Clock` so scheduler and algorithms are deterministic under fake timers. Architecture §6.3, §15: never call `Date.now()` directly in core.

## Dependencies

- `01-TASK-types-and-errors`

## Logic

### `src/core/clock.ts`

```ts
interface Clock {
  now(): number;                // wall-clock ms (Date.now-compatible)
  monotonic(): number;          // monotonic ms for elapsed-time math
  setTimeout(fn: () => void, ms: number): ClockTimer;
  clearTimeout(t: ClockTimer): void;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

interface ClockTimer { /* opaque */ }
```

Implementations:

- `SystemClock` (default): `Date.now()`, `performance.now()` for monotonic, native `setTimeout`.
- `FakeClock` (test util in `test/util/fake-clock.ts`): manually advance time, drains pending timers in order, supports `tick(ms)`.

`sleep()` must:

- Resolve after `ms` of monotonic time.
- Reject with `AbortError` if signal aborts.
- Clean up timer on abort.

## Tests

- `SystemClock.now()` close to `Date.now()` within 1 ms.
- `SystemClock.monotonic()` strictly non-decreasing across rapid calls.
- `SystemClock.sleep(50)` resolves after >= 45ms (CI jitter tolerance).
- `SystemClock.sleep(1000, abortedSignal)` rejects immediately with AbortError.
- `FakeClock.tick(100)` advances `now()` by 100 and fires queued timers up to that time in FIFO order.
- `FakeClock` timers fire in chronological order even when scheduled out of order.

## Edge Cases

- Monotonic clock must not be used for window math that crosses process restarts (wall-clock is source of truth there).
- Aborting a `sleep` that already fired must be a no-op.
- Setting a timer with `ms <= 0` fires on next microtask (not synchronously) to preserve async semantics.
- `FakeClock` must not call real `setTimeout` — pure logical clock.

## Acceptance

`Clock` injected through `RateLimiterOptions.clock`. Default is `SystemClock`. All tests pass with fake clock.

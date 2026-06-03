# 08-TASK-sliding-window-algorithm

## Goal

Sliding-window counter (default per design §2). Smoother than fixed window, cheaper than log. Architecture §6.6.

## Dependencies

- `06-TASK-algorithm-interface`

## Logic

### `src/algorithms/sliding-window-counter.ts`

Hybrid algorithm: tracks current window count + previous window count, interpolates.

State: `{ currentStart: number; currentCount: number; previousCount: number }`.

```
function effectiveUsage(state, window, now) {
  rollIfNeeded(state, window, now);
  const elapsedInCurrent = now - state.currentStart;
  const overlapRatio = 1 - elapsedInCurrent / window.windowMs;
  return state.previousCount * overlapRatio + state.currentCount;
}

function rollIfNeeded(state, window, now) {
  const elapsed = now - state.currentStart;
  if (elapsed >= 2 * window.windowMs) {
    state.previousCount = 0;
    state.currentCount = 0;
    state.currentStart = floorToWindow(now, window.windowMs);
  } else if (elapsed >= window.windowMs) {
    state.previousCount = state.currentCount;
    state.currentCount = 0;
    state.currentStart += window.windowMs;
  }
}

tryConsume(state, weight, window, now):
  rollIfNeeded(...)
  usage = effectiveUsage(...)
  if (usage + weight > window.maxWeight) deny
  else state.currentCount += weight; allow
```

`refund`: subtract from `currentCount`.

`estimateRetryAfter`: solve for time when `effectiveUsage + weight <= max` — linear shrinkage of `previousCount * overlapRatio`.

## Tests

- At t=0.5*window: usage = 0.5*prev + curr. Verify with hand-computed cases.
- No double-burst at window boundary: 100 at t=59s, then attempt 100 at t=60s denied because `0.98 * 100 + 100 > 100`.
- Property-based: usage is monotonically smooth across boundary (no step jump).
- Refund correctness across roll: refunding in next window only affects `currentCount`.
- Skip-multiple-windows case: idle for 5 windows → both counts zeroed.

## Edge Cases

- `previousCount * overlapRatio` is fractional. Round? Decision: keep as float, compare against integer max with `<=`. Document.
- Boundary jitter: tiny floating-point error near max. Tolerate via epsilon `<= max + 1e-9`.
- `now < currentStart` (clock jump back): clamp `now = max(now, currentStart)`.
- Very large weight after long idle: still bounded by `maxWeight`.
- `estimateRetryAfter` for `weight > maxWeight`: return Infinity.

## Acceptance

Contract tests + smoothness property green. Default algorithm in registry (task 09).

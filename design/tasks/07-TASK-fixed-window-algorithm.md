# 07-TASK-fixed-window-algorithm

## Goal

Fixed-window counter. Matches providers that publish reset-based quotas (e.g. Binance per-minute weight).

## Dependencies

- `06-TASK-algorithm-interface`

## Logic

### `src/algorithms/fixed-window.ts`

State: `{ count: number; windowStartMs: number }`.

`tryConsume(state, weight, window, now)`:

```
if (now - state.windowStartMs >= window.windowMs) {
  state.count = 0;
  state.windowStartMs = floorToWindow(now, window.windowMs);
}
if (state.count + weight > window.maxWeight) {
  return { allowed: false, current: state.count,
           remaining: window.maxWeight - state.count,
           retryAfterMs: state.windowStartMs + window.windowMs - now };
}
state.count += weight;
return { allowed: true, current: state.count,
         remaining: window.maxWeight - state.count, retryAfterMs: 0 };
```

`floorToWindow` ensures synchronized boundaries across nodes.

`refund`: `state.count = max(0, state.count - weight)`.

`estimateRetryAfter`: time until window reset.

## Tests

- Within window: sequential consume up to max succeeds, one more denied.
- Window boundary crossed: counter resets to 0, full max available.
- Refund decreases count, never below 0.
- `floorToWindow` aligns to wall-clock boundaries (e.g. minute boundaries for 60s windows).
- Property-based (`fast-check`): for any sequence of (consume, refund, tick) ops, `0 <= count <= maxWeight`.

## Edge Cases

- **Burst at boundary**: 100 weight at t=59s, another 100 at t=60s = 200 in 1s real time. Documented limitation of fixed window; users wanting smoother should pick sliding.
- Very short windows (< 100ms): floor math still correct.
- `weight > maxWeight`: deny with `retryAfterMs: Infinity` (per task 06).
- Clock skew backward: do not reset if `now < windowStartMs` — keep current state.

## Acceptance

Contract conformance tests pass. Documented burst behavior in code comment.

# 06-TASK-algorithm-interface

## Goal

Define common algorithm contract. Architecture §6.6.

## Dependencies

- `01-TASK-types-and-errors`
- `02-TASK-clock-abstraction`

## Logic

### `src/algorithms/algorithm.interface.ts`

```ts
interface RateAlgorithm<State = unknown> {
  readonly name: 'fixed' | 'sliding' | 'token-bucket';

  init(window: RateWindow, nowMs: number): State;

  tryConsume(
    state: State,
    weight: number,
    window: RateWindow,
    nowMs: number
  ): AlgorithmConsumeResult;

  refund(state: State, weight: number, window: RateWindow, nowMs: number): void;

  getUsage(state: State, window: RateWindow, nowMs: number): number;

  estimateRetryAfter(state: State, weight: number, window: RateWindow, nowMs: number): number;

  cleanup?(state: State, window: RateWindow, nowMs: number): void;
}

interface AlgorithmConsumeResult {
  allowed: boolean;
  current: number;
  remaining: number;
  retryAfterMs: number;
}
```

Algorithm modules are **pure**: no I/O, no time-dependent side effects except via `nowMs` parameter. State is passed in by the store.

## Tests

- Type-level: every algorithm impl satisfies interface.
- No algorithm imports from `storage/`, `core/`, or `adapters/` (enforce via lint rule or arch test).

## Edge Cases

- `weight > maxWeight`: cannot ever fit. Must return `allowed: false`, `retryAfterMs: Infinity`. Caller (limiter) translates to `ConfigurationError`.
- `weight = 0`: always allowed, no state change.

## Acceptance

Interface published. Algorithms 07, 08 implement it.

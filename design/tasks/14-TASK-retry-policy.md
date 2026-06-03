# 14-TASK-retry-policy

## Goal

Retry orchestration with exponential/linear backoff, jitter, max attempts, `Retry-After` honoring. Architecture §6.3, §13.2.

## Dependencies

- `01-TASK-types-and-errors`
- `02-TASK-clock-abstraction`

## Logic

### `src/retry/backoff.ts`

```ts
function nextDelay(opts: {
  attempt: number;          // 1-indexed
  baseMs: number;
  maxMs: number;
  kind: 'exponential' | 'linear';
  jitter: boolean;
  random?: () => number;    // injectable for tests
}): number;
```

- exponential: `base * 2^(attempt-1)`, capped at `maxMs`.
- linear: `base * attempt`, capped.
- jitter (full jitter): `random() * delay`.

### `src/retry/retry-policy.ts`

```ts
class RetryPolicy {
  shouldRetry(err: unknown, attempt: number, cfg: RetryConfig): boolean;
  computeDelay(err: unknown, attempt: number, cfg: RetryConfig, observation?: ProviderObservation): number;
}
```

Rules:

- Honor `cfg.respectRetryAfter`: if observation has `retryAfterMs`, use `max(retryAfterMs, computedBackoff)`.
- Never retry past `maxAttempts`.
- Do not retry `permanent` errors (400 family except 408/429).
- Always retry `rate-limited` and `transient` if attempts remain.

## Tests

- Exponential growth: `100, 200, 400, 800` capped at `maxMs`.
- Linear growth: `100, 200, 300`.
- Jitter bounded: `0 <= jittered <= delay`.
- `respectRetryAfter`: when header says 5s but backoff says 1s, returned delay >= 5s.
- `shouldRetry` returns false on `permanent` error class.
- Determinism: with seeded `random`, identical outputs across runs.

## Edge Cases

- `maxAttempts = 0`: never retry.
- `attempt > maxAttempts`: `shouldRetry` returns false even before checking error class.
- `Retry-After` of hours: cap at `maxMs` if configured, else honor — document this risk.
- Retry storm after ban lifts: jitter mandatory when `kind = exponential` and many clients share the ban.

## Acceptance

Scheduler (task 15) wires this in. No direct timer ownership — scheduler uses `clock.sleep`.

# 09-TASK-algorithm-registry

## Goal

Lookup `RateAlgorithm` by name. Allow user-registered custom algorithms (extensibility, architecture §4).

## Dependencies

- `06-TASK-algorithm-interface`
- `07-TASK-fixed-window-algorithm`
- `08-TASK-sliding-window-algorithm`

## Logic

### `src/algorithms/registry.ts`

```ts
class AlgorithmRegistry {
  private map = new Map<string, RateAlgorithm>();
  register(algo: RateAlgorithm): void;
  get(name: string): RateAlgorithm;        // throws ConfigurationError if unknown
  has(name: string): boolean;
  list(): string[];
}

export function createDefaultRegistry(): AlgorithmRegistry {
  const r = new AlgorithmRegistry();
  r.register(new SlidingWindowCounter());
  r.register(new FixedWindow());
  return r;
}
```

Default selection rule: if `RateWindow.algorithm` unset, use `'sliding'`.

## Tests

- `get('sliding')` returns instance.
- `get('unknown')` throws `ConfigurationError` with code.
- Custom algo registered, then resolvable via `get`.
- Duplicate register: throws (avoid silent override) unless `{ override: true }`.

## Edge Cases

- Token bucket not registered in v1 — `get('token-bucket')` throws clear error pointing at v2 roadmap.
- Registry is per-`createLimiter` call to avoid global state across multiple clients in same process.

## Acceptance

Used by `RateLimiter` (task 10) to dispatch per-window algorithm.

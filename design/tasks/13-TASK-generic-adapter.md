# 13-TASK-generic-adapter

## Goal

Config-driven adapter for any provider without writing custom code. Architecture §6.2, examples folder.

## Dependencies

- `12-TASK-adapter-interface`

## Logic

### `src/adapters/generic.ts`

```ts
class GenericAdapter implements ProviderAdapter {
  constructor(opts: GenericAdapterOptions);
}

interface GenericAdapterOptions {
  name: string;
  windows: RateWindow[];
  endpoints: Record<string, EndpointWeight | number>;
  defaultWeight?: number;
  scopeStrategy?: 'provider' | 'account' | 'endpoint' | ((req) => string);
  banCooldownMs?: number;
  retryAfterHeader?: string;         // default 'retry-after'
  usageHeader?: { name: string; windowId: string }[];
  rateLimitedStatuses?: number[];    // default [429, 418, 503]
}
```

`resolveWeight`: lookup endpoint key, support exact match in v1, fall back to `defaultWeight` or throw.

`parseResponse`:

- If status in `rateLimitedStatuses`, return `{ banUntilMs: now + cooldown, retryAfterMs: <header> }`.
- For each configured usage header, parse number → observation.

`classifyError`: HTTP-shaped errors only. Inspect `.status` or `.response.status`. Default unknown.

## Tests

- Construct with Binance-style config, resolve known endpoint weight.
- Unknown endpoint: throw or fall back per config.
- Header parsing: numeric value extracted correctly.
- `Retry-After` as seconds vs HTTP-date: support both.
- 429 → `banned` classification with cooldown.
- Custom `scopeStrategy` function called with request.

## Edge Cases

- Header missing: observation omitted (do not assume 0).
- `Retry-After` malformed: ignore, fall back to default cooldown.
- HTTP-date in the past: clamp to `retryAfterMs >= 0`.
- Endpoint match collisions when multiple configs in same map: throw `ConfigurationError` at construction.

## Acceptance

Used in tests and examples. Sufficient for any provider whose limits are header-described.

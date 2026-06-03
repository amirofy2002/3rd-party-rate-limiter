# 12-TASK-adapter-interface

## Goal

Define `ProviderAdapter` interface. Adapter owns all provider-specific knowledge (architecture §6.2). No HTTP transport here.

## Dependencies

- `01-TASK-types-and-errors`

## Logic

### `src/adapters/adapter.interface.ts`

```ts
interface ProviderAdapter {
  readonly name: string;

  // Returns canonical config: windows, default endpoint weights, ban cooldown.
  getConfig(): ProviderConfig;

  // Resolve weight for an endpoint. May depend on method/payload (e.g. batch size).
  resolveWeight(endpoint: string, meta?: RequestMeta): number;

  // Map endpoint to scope key extensions (e.g. per-account).
  resolveScope(req: ScheduledRequest<any>): ScopeKey;

  // Inspect provider response (headers + status) and produce observations.
  parseResponse(resp: ResponseLike): ProviderObservation;

  // Decide which errors mean "I am rate limited / banned".
  classifyError(err: unknown): ProviderErrorKind;
}

interface ResponseLike {
  status?: number;
  headers?: Record<string, string | string[]>;
  body?: unknown;
}

interface ProviderObservation {
  usage?: Array<{ windowId: string; observedWeight: number; authoritative: boolean }>;
  banUntilMs?: number;
  retryAfterMs?: number;
}

type ProviderErrorKind = 'rate-limited' | 'banned' | 'transient' | 'permanent' | 'unknown';
```

Adapters are stateless; configuration injected via constructor.

## Tests

- Interface conformance: all methods implementable as pure functions.
- Type checks: `parseResponse` accepts both array-valued and string-valued headers (Node `fetch` quirk).

## Edge Cases

- Endpoint with templated path (`/orders/:id`): v1 supports exact match only. Adapter may normalize via own matcher (open question, architecture §27).
- Response headers may be lowercased or mixed-case. Adapter must normalize internally.
- `resolveWeight` may need request body (e.g. Binance batch order weight = N * orderWeight). Pass through `meta`.

## Acceptance

Stable contract. Generic (task 13) and Binance (task 18) implement it.

# 18-TASK-binance-adapter

## Goal

First-party `BinanceAdapter`. Encodes Binance Spot REST weights, headers, ban behavior. Architecture §6.2.

## Dependencies

- `12-TASK-adapter-interface`

## Logic

### `src/adapters/binance.ts`

```ts
class BinanceAdapter implements ProviderAdapter {
  constructor(opts?: BinanceAdapterOptions);
}

interface BinanceAdapterOptions {
  profile?: 'spot' | 'futures' | 'margin';     // v1: 'spot' only; others throw
  endpointWeights?: Record<string, number>;    // override defaults
  windows?: RateWindow[];                       // override defaults
  banCooldownMs?: number;                       // default 180_000 (3 min)
}
```

Defaults:

- Windows: `[{ id: '1m', windowMs: 60_000, maxWeight: 1200, algorithm: 'sliding' }]` (current Binance spot REST limit).
- Endpoint weights: bundled JSON map for known endpoints (`/api/v3/account` = 20, `/api/v3/order` = 1 GET / 1 POST, `/api/v3/exchangeInfo` = 20, etc.). Source: Binance docs as of build date; **commit a `binance-weights.json` snapshot with date + URL in header comment**.

`resolveWeight`:

- Exact endpoint match against bundled map.
- For batch order endpoint (`/api/v3/batchOrders`), `meta.batchSize * 1` (document this).
- Fallback to user override or `defaultWeight` if provided.

`parseResponse`:

- Read `x-mbx-used-weight-1m` → observation `{ windowId: '1m', observedWeight: N, authoritative: true }`.
- Read `retry-after` (seconds) on 429/418.
- Status `429`: rate-limited. Status `418`: banned, set ban for `banCooldownMs`.

`classifyError`: 429 → rate-limited, 418 → banned, 5xx → transient, 4xx → permanent.

`resolveScope`: `binance:{accountKey ?? 'default'}`.

## Tests

- Known endpoints resolve to documented weights.
- Unknown endpoint → fall back or throw per option.
- Header parsing: `x-mbx-used-weight-1m: 1199` → observation reads 1199 for `1m` window.
- 418 response → observation has `banUntilMs ≈ now + 180_000`.
- Batch order weight scales linearly with batch size.

## Edge Cases

- Header name case variations: normalize to lowercase before lookup.
- Missing `retry-after` on 429: fall back to adapter cooldown.
- Binance changes weight: user override + warn if our snapshot is stale (option `warnOnStaleWeights: true` with bundled date).
- Multiple weight headers (`x-mbx-used-weight` without suffix): map to default `1m` window.

## Acceptance

Real Binance testnet integration in `examples/binance.ts` runs against testnet without 418.

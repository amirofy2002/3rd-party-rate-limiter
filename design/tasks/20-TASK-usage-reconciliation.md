# 20-TASK-usage-reconciliation

## Goal

Reconcile local usage estimates with provider-reported usage (e.g. `X-MBX-USED-WEIGHT-1M`). Architecture §13.4, ADR-004.

## Dependencies

- `10-TASK-rate-limiter-core` (`reconcileFromProvider`)
- `15-TASK-scheduler`
- `18-TASK-binance-adapter`

## Logic

After successful `execute`:

```
obs = adapter.parseResponse(response)
if obs.usage:
  for { windowId, observedWeight, authoritative } of obs.usage:
    local = await limiter.getUsage(scope, windowId)
    diff = observedWeight - local
    if diff > 0:
      await store.consume({ scope, weight: diff, windows: [window], skipDeny: true })
      emit usage:reconciled { direction: 'up', diff }
    else if diff < 0 and authoritative:
      await store.refund({ scope, weight: -diff, windows: [window] })
      emit usage:reconciled { direction: 'down', diff: -diff }
```

`skipDeny: true` is a new `ConsumeRequest` flag that forces consume regardless of cap (only used for reconciliation). Store implements it; algorithms must accept being pushed past max temporarily — they emit `limit:exceeded` and rely on caller to back off.

## Tests

- Local usage 100, provider says 150 → reconcile up by 50; subsequent reserve sees 150.
- Local usage 150, provider says 100, authoritative=true → reconcile down by 50.
- Non-authoritative downward observation: ignored.
- `usage:reconciled` event fires with direction + diff.
- Concurrent reconcile races: last-writer-wins is acceptable (eventual consistency).
- `limit:exceeded` fires when reconciliation pushes past max.

## Edge Cases

- Provider header for window not configured locally: log warning, ignore (do not auto-create windows).
- Diff is 0: no-op, no event.
- Adapter reports usage for a future window boundary (clock skew): clamp to current window.
- Reconciliation happens after refund-on-failure: do refund first, then reconcile (otherwise refund cancels accurate provider count).
- Authoritative flag misuse: bias toward upward reconciliation always; downward requires explicit authoritative=true.

## Acceptance

Soak test: 10k requests against mock provider that drifts ±5% in reported usage → library tracks within ±1% of provider truth.

# 11-TASK-priority-queue

## Goal

Priority queue with aging, FIFO tie-break, removal on cancel/timeout. Architecture §6.4, §10.

## Dependencies

- `01-TASK-types-and-errors`
- `02-TASK-clock-abstraction`

## Logic

### `src/queue/priority-queue.ts`

Binary heap keyed by `(effectivePriority, enqueueSeq)`.

Item shape:

```ts
interface QueueItem<T> {
  id: string;
  basePriority: number;       // 0-100
  enqueuedAt: number;
  enqueueSeq: number;         // monotonic for FIFO
  payload: T;
  cancelled: boolean;
}
```

Effective priority via aging (architecture §10):

```
effective = basePriority
          + min(floor((now - enqueuedAt) / aging.intervalMs) * aging.step, aging.maxBoost)
```

Operations:

- `enqueue(item)`: O(log n) heap insert.
- `peek(nowMs)`: returns head without removing; reorders if aging changed priorities (lazy: recompute top item's effective priority each peek, sift down if changed).
- `dequeue(nowMs)`: returns + removes head.
- `remove(id)`: mark cancelled; lazy removal on next peek/dequeue.
- `size()`: count of non-cancelled items.
- `snapshot()`: read-only iterator for stats.

Bounded by `maxSize`. Overflow handled by caller (scheduler) per `OverflowPolicy`.

## Tests

- Higher priority dequeued first.
- Same priority: FIFO via `enqueueSeq`.
- Aging: low-priority item enqueued at t=0 surpasses high-priority enqueued at t=large.
- Cancel: removed item skipped, `size()` decreases.
- Insert 10k items, dequeue all → ordered correctly.
- Property test: dequeue sequence respects `(effective_priority desc, enqueueSeq asc)`.
- Aging cap: `maxBoost` prevents unbounded promotion.

## Edge Cases

- All items same priority: pure FIFO.
- Empty queue peek/dequeue: returns `undefined`.
- Aging interval 0 or negative: validate at config time.
- Cancelled item is queue head: peek skips and sifts.
- Heap shape after many cancels (lots of tombstones): periodic compaction when `cancelled_count / size > 0.5`.

## Acceptance

Bench: 1M enqueue+dequeue ops/sec on single core.

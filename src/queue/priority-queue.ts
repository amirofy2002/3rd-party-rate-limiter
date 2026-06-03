import { ConfigurationError } from '../errors.js';
import type { AgingConfig } from '../types.js';

export interface QueueItem<T> {
  /** Stable item id (used for cancellation). */
  id: string;
  /** Base integer priority 0..100. Higher executes sooner. */
  basePriority: number;
  /** Wall-clock or monotonic ms when the item was enqueued. */
  enqueuedAt: number;
  /** Monotonic sequence assigned at enqueue; breaks ties FIFO. */
  enqueueSeq: number;
  /** Caller-supplied payload. */
  payload: T;
  /** Lazy tombstone — true means the item has been cancelled. */
  cancelled: boolean;
}

const DEFAULT_AGING: AgingConfig = { intervalMs: 5_000, step: 1, maxBoost: 25 };

function validateAging(aging: AgingConfig): void {
  if (aging.intervalMs <= 0) {
    throw new ConfigurationError('aging.intervalMs must be > 0');
  }
  if (aging.step < 0) {
    throw new ConfigurationError('aging.step must be >= 0');
  }
  if (aging.maxBoost < 0) {
    throw new ConfigurationError('aging.maxBoost must be >= 0');
  }
}

/** Aged effective priority for a single item. */
export function effectivePriority<T>(item: QueueItem<T>, aging: AgingConfig, nowMs: number): number {
  const elapsed = Math.max(0, nowMs - item.enqueuedAt);
  const boost = Math.min(
    aging.maxBoost,
    Math.floor(elapsed / aging.intervalMs) * aging.step,
  );
  return item.basePriority + boost;
}

/**
 * Binary-heap priority queue with aging.
 *
 * Ordering: `(effectivePriority desc, enqueueSeq asc)`.
 *
 * Effective priority depends on `nowMs`, so the heap key shifts with time.
 * On `peek(now)` and `dequeue(now)` we re-evaluate the root and sift down
 * when its key drops below another node. Aging keeps cycles bounded since
 * boost caps at `aging.maxBoost`.
 *
 * Cancellation is lazy — `remove(id)` flips a tombstone and the next
 * peek/dequeue skips it. The heap is compacted automatically when more
 * than half of the entries are tombstones.
 */
export class PriorityQueue<T> {
  private readonly aging: AgingConfig;
  private readonly maxSize: number;
  private heap: Array<QueueItem<T>> = [];
  private byId: Map<string, QueueItem<T>> = new Map();
  private cancelledCount = 0;
  private seq = 0;

  public constructor(opts: { aging?: AgingConfig; maxSize?: number } = {}) {
    const aging = opts.aging ?? DEFAULT_AGING;
    validateAging(aging);
    this.aging = aging;
    this.maxSize = opts.maxSize ?? Number.POSITIVE_INFINITY;
  }

  /** Number of non-cancelled items currently queued. */
  public size(): number {
    return this.heap.length - this.cancelledCount;
  }

  /** Total heap entries including tombstones (mostly for diagnostics). */
  public _rawSize(): number {
    return this.heap.length;
  }

  /** Returns true when adding one more item would exceed `maxSize`. */
  public isFull(): boolean {
    return this.size() >= this.maxSize;
  }

  /**
   * Add a fresh item. Returns the assigned `enqueueSeq` so callers may use
   * it as a stable tie-breaker reference.
   *
   * Caller must check `isFull()` first if a bounded queue is required —
   * `enqueue` does not enforce it (overflow policy belongs to the scheduler).
   */
  public enqueue(
    args: { id: string; basePriority: number; payload: T; nowMs: number },
  ): QueueItem<T> {
    if (this.byId.has(args.id)) {
      throw new ConfigurationError(`duplicate queue id: ${args.id}`);
    }
    const item: QueueItem<T> = {
      id: args.id,
      basePriority: args.basePriority,
      enqueuedAt: args.nowMs,
      enqueueSeq: this.seq++,
      payload: args.payload,
      cancelled: false,
    };
    this.heap.push(item);
    this.byId.set(item.id, item);
    this.siftUp(this.heap.length - 1, args.nowMs);
    return item;
  }

  /** Inspect the next-to-execute item without removing it. */
  public peek(nowMs: number): QueueItem<T> | undefined {
    this.dropCancelledTop(nowMs);
    if (this.heap.length === 0) return undefined;
    return this.heap[0];
  }

  /** Remove and return the next-to-execute item. */
  public dequeue(nowMs: number): QueueItem<T> | undefined {
    this.dropCancelledTop(nowMs);
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0]!;
    this.removeRoot(nowMs);
    this.byId.delete(top.id);
    this.maybeCompact();
    return top;
  }

  /** Mark an item as cancelled. Returns true when found and not already cancelled. */
  public remove(id: string): boolean {
    const item = this.byId.get(id);
    if (!item || item.cancelled) return false;
    item.cancelled = true;
    this.cancelledCount += 1;
    this.maybeCompact();
    return true;
  }

  /** Read-only iterator over non-cancelled items in arbitrary order. */
  public *snapshot(): IterableIterator<QueueItem<T>> {
    for (const item of this.heap) {
      if (!item.cancelled) yield item;
    }
  }

  /** Lowest enqueueSeq currently in the heap (oldest), undefined when empty. */
  public oldestSeq(): number | undefined {
    let min: number | undefined;
    for (const item of this.heap) {
      if (item.cancelled) continue;
      if (min === undefined || item.enqueueSeq < min) min = item.enqueueSeq;
    }
    return min;
  }

  /**
   * Find the non-cancelled item with the lowest effective priority — useful
   * for `drop-lowest-priority` overflow policies.
   */
  public findLowest(nowMs: number): QueueItem<T> | undefined {
    let worst: QueueItem<T> | undefined;
    let worstKey: { p: number; seq: number } | undefined;
    for (const item of this.heap) {
      if (item.cancelled) continue;
      const p = effectivePriority(item, this.aging, nowMs);
      if (!worstKey || p < worstKey.p || (p === worstKey.p && item.enqueueSeq > worstKey.seq)) {
        worst = item;
        worstKey = { p, seq: item.enqueueSeq };
      }
    }
    return worst;
  }

  private dropCancelledTop(nowMs: number): void {
    while (this.heap.length > 0 && this.heap[0]!.cancelled) {
      this.removeRoot(nowMs);
      this.cancelledCount = Math.max(0, this.cancelledCount - 1);
    }
    // Root effective priority might be stale; re-sift down once.
    if (this.heap.length > 1) this.siftDown(0, nowMs);
  }

  private removeRoot(nowMs: number): void {
    if (this.heap.length === 0) return;
    const last = this.heap.pop()!;
    if (this.heap.length === 0) return;
    this.heap[0] = last;
    this.siftDown(0, nowMs);
  }

  private siftUp(idx: number, nowMs: number): void {
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.lessThan(idx, parent, nowMs)) {
        this.swap(idx, parent);
        idx = parent;
      } else {
        break;
      }
    }
  }

  private siftDown(idx: number, nowMs: number): void {
    const n = this.heap.length;
    for (;;) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let smallest = idx;
      if (left < n && this.lessThan(left, smallest, nowMs)) smallest = left;
      if (right < n && this.lessThan(right, smallest, nowMs)) smallest = right;
      if (smallest === idx) break;
      this.swap(idx, smallest);
      idx = smallest;
    }
  }

  /**
   * Heap key comparator. The heap is a min-heap of pairs
   * `(-effectivePriority, enqueueSeq)` so that the highest-priority,
   * earliest-enqueued item floats to the top.
   *
   * Cancelled items are ranked maximally so they sink to the bottom and get
   * skipped without disturbing real items.
   */
  private lessThan(a: number, b: number, nowMs: number): boolean {
    const ia = this.heap[a]!;
    const ib = this.heap[b]!;
    if (ia.cancelled && !ib.cancelled) return false;
    if (!ia.cancelled && ib.cancelled) return true;
    const pa = ia.cancelled ? -Infinity : effectivePriority(ia, this.aging, nowMs);
    const pb = ib.cancelled ? -Infinity : effectivePriority(ib, this.aging, nowMs);
    if (pa !== pb) return pa > pb;
    return ia.enqueueSeq < ib.enqueueSeq;
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = tmp;
  }

  private maybeCompact(): void {
    if (this.heap.length === 0) return;
    if (this.cancelledCount / this.heap.length < 0.5) return;
    this.heap = this.heap.filter((i) => !i.cancelled);
    this.cancelledCount = 0;
    // Rebuild heap order based on stable ordering at compaction time.
    for (let i = (this.heap.length >> 1) - 1; i >= 0; i--) {
      this.siftDown(i, 0);
    }
  }
}

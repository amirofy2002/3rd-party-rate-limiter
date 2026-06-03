import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PriorityQueue, effectivePriority } from '../../src/queue/priority-queue.js';
import { ConfigurationError } from '../../src/errors.js';

describe('PriorityQueue', () => {
  it('higher priority dequeued first', () => {
    const q = new PriorityQueue<string>();
    q.enqueue({ id: 'a', basePriority: 10, payload: 'a', nowMs: 0 });
    q.enqueue({ id: 'b', basePriority: 50, payload: 'b', nowMs: 0 });
    q.enqueue({ id: 'c', basePriority: 30, payload: 'c', nowMs: 0 });
    expect(q.dequeue(0)?.payload).toBe('b');
    expect(q.dequeue(0)?.payload).toBe('c');
    expect(q.dequeue(0)?.payload).toBe('a');
  });

  it('same priority is FIFO by enqueue order', () => {
    const q = new PriorityQueue<number>();
    for (let i = 0; i < 5; i++) {
      q.enqueue({ id: String(i), basePriority: 50, payload: i, nowMs: 0 });
    }
    const out: number[] = [];
    while (q.size() > 0) {
      out.push(q.dequeue(0)!.payload);
    }
    expect(out).toEqual([0, 1, 2, 3, 4]);
  });

  it('aging promotes long-waiting low-priority items', () => {
    const q = new PriorityQueue<string>({
      aging: { intervalMs: 1_000, step: 2, maxBoost: 100 },
    });
    q.enqueue({ id: 'old-low', basePriority: 10, payload: 'old-low', nowMs: 0 });
    q.enqueue({ id: 'new-high', basePriority: 50, payload: 'new-high', nowMs: 100_000 });
    // After 100 seconds the old item has accumulated +200 boost (capped at 100), → 110.
    expect(q.dequeue(100_000)?.payload).toBe('old-low');
  });

  it('aging cap respects maxBoost', () => {
    const aging = { intervalMs: 1_000, step: 1, maxBoost: 5 };
    const q = new PriorityQueue<string>({ aging });
    const item = q.enqueue({ id: 'a', basePriority: 10, payload: 'a', nowMs: 0 });
    expect(effectivePriority(item, aging, 1_000_000)).toBe(15);
  });

  it('cancel removes item: skipped on dequeue, size reflects', () => {
    const q = new PriorityQueue<string>();
    q.enqueue({ id: 'a', basePriority: 10, payload: 'a', nowMs: 0 });
    q.enqueue({ id: 'b', basePriority: 50, payload: 'b', nowMs: 0 });
    q.enqueue({ id: 'c', basePriority: 30, payload: 'c', nowMs: 0 });
    expect(q.size()).toBe(3);
    expect(q.remove('b')).toBe(true);
    expect(q.size()).toBe(2);
    const order: string[] = [];
    while (q.size() > 0) order.push(q.dequeue(0)!.payload);
    expect(order).toEqual(['c', 'a']);
  });

  it('double remove returns false', () => {
    const q = new PriorityQueue<string>();
    q.enqueue({ id: 'a', basePriority: 10, payload: 'a', nowMs: 0 });
    expect(q.remove('a')).toBe(true);
    expect(q.remove('a')).toBe(false);
  });

  it('empty queue peek/dequeue returns undefined', () => {
    const q = new PriorityQueue<string>();
    expect(q.peek(0)).toBeUndefined();
    expect(q.dequeue(0)).toBeUndefined();
  });

  it('bulk insert 10k, dequeue all in priority-then-FIFO order', () => {
    const q = new PriorityQueue<{ p: number; seq: number }>();
    const total = 10_000;
    for (let i = 0; i < total; i++) {
      const p = (i * 7) % 100;
      q.enqueue({ id: String(i), basePriority: p, payload: { p, seq: i }, nowMs: 0 });
    }
    let last = q.dequeue(0)!.payload;
    while (q.size() > 0) {
      const next = q.dequeue(0)!.payload;
      expect(next.p).toBeLessThanOrEqual(last.p);
      if (next.p === last.p) expect(next.seq).toBeGreaterThan(last.seq);
      last = next;
    }
  });

  it('property: dequeue order respects (effective priority desc, seq asc)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            basePriority: fc.integer({ min: 0, max: 100 }),
            enqueueDelay: fc.integer({ min: 0, max: 5_000 }),
          }),
          { minLength: 1, maxLength: 50 },
        ),
        (items) => {
          const aging = { intervalMs: 1_000, step: 1, maxBoost: 50 };
          const q = new PriorityQueue<number>({ aging });
          let now = 0;
          const enqueued: Array<{ id: string; basePriority: number; nowMs: number; seq: number }> = [];
          items.forEach((it, idx) => {
            now += it.enqueueDelay;
            q.enqueue({ id: String(idx), basePriority: it.basePriority, payload: idx, nowMs: now });
            enqueued.push({ id: String(idx), basePriority: it.basePriority, nowMs: now, seq: idx });
          });
          const drainAt = now + 1_000;
          const ordered: string[] = [];
          while (q.size() > 0) {
            ordered.push(q.dequeue(drainAt)!.id);
          }
          const expectedSorted = enqueued.slice().sort((a, b) => {
            const pa = a.basePriority + Math.min(aging.maxBoost, Math.floor((drainAt - a.nowMs) / aging.intervalMs) * aging.step);
            const pb = b.basePriority + Math.min(aging.maxBoost, Math.floor((drainAt - b.nowMs) / aging.intervalMs) * aging.step);
            if (pa !== pb) return pb - pa;
            return a.seq - b.seq;
          });
          expect(ordered).toEqual(expectedSorted.map((e) => e.id));
        },
      ),
      { numRuns: 80 },
    );
  });

  it('compaction reduces raw size when over half are cancelled', () => {
    const q = new PriorityQueue<string>();
    for (let i = 0; i < 10; i++) {
      q.enqueue({ id: String(i), basePriority: 50, payload: String(i), nowMs: 0 });
    }
    for (let i = 0; i < 6; i++) q.remove(String(i));
    expect(q.size()).toBe(4);
    // Force compaction check.
    q.dequeue(0);
    expect(q._rawSize()).toBeLessThanOrEqual(4);
  });

  it('aging config validation rejects bad values', () => {
    expect(() => new PriorityQueue({ aging: { intervalMs: 0, step: 1, maxBoost: 10 } })).toThrow(
      ConfigurationError,
    );
    expect(() => new PriorityQueue({ aging: { intervalMs: 100, step: -1, maxBoost: 10 } })).toThrow(
      ConfigurationError,
    );
  });

  it('isFull respects maxSize', () => {
    const q = new PriorityQueue<string>({ maxSize: 2 });
    q.enqueue({ id: 'a', basePriority: 10, payload: 'a', nowMs: 0 });
    q.enqueue({ id: 'b', basePriority: 10, payload: 'b', nowMs: 0 });
    expect(q.isFull()).toBe(true);
  });

  it('findLowest returns lowest effective priority item', () => {
    const q = new PriorityQueue<string>();
    q.enqueue({ id: 'a', basePriority: 10, payload: 'a', nowMs: 0 });
    q.enqueue({ id: 'b', basePriority: 50, payload: 'b', nowMs: 0 });
    q.enqueue({ id: 'c', basePriority: 30, payload: 'c', nowMs: 0 });
    expect(q.findLowest(0)?.id).toBe('a');
  });
});

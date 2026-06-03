import type { Clock, ClockTimer } from '../../src/types.js';

interface FakeTimer {
  id: number;
  fireAtMs: number;
  seq: number;
  handler: () => void;
  cancelled: boolean;
}

/**
 * Logical clock for tests. Never calls real `setTimeout`.
 *
 * - `tick(ms)` advances the clock and fires due timers in chronological,
 *   FIFO-on-tie order.
 * - `sleep()` is awaited by the production code; resolve it by advancing
 *   the clock past its target time.
 */
export class FakeClock implements Clock {
  private wallMs: number;
  private monoMs = 0;
  private timers: FakeTimer[] = [];
  private nextId = 1;
  private seq = 0;

  public constructor(startWallMs = 0) {
    this.wallMs = startWallMs;
  }

  public now(): number {
    return this.wallMs;
  }

  public monotonic(): number {
    return this.monoMs;
  }

  public setTimeout(handler: () => void, ms: number): ClockTimer {
    const timer: FakeTimer = {
      id: this.nextId++,
      fireAtMs: this.monoMs + Math.max(0, ms),
      seq: this.seq++,
      handler,
      cancelled: false,
    };
    this.timers.push(timer);
    return timer;
  }

  public clearTimeout(handle: ClockTimer): void {
    const timer = handle as FakeTimer | undefined;
    if (timer) timer.cancelled = true;
  }

  public sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const handle = this.setTimeout(() => {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = signal
        ? () => {
            this.clearTimeout(handle);
            signal.removeEventListener('abort', onAbort!);
            reject(abortError(signal));
          }
        : undefined;
      if (onAbort && signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** Advance the clock by `ms` and fire all due timers in chronological order. */
  public tick(ms: number): void {
    if (ms < 0) throw new Error('tick must be non-negative');
    const target = this.monoMs + ms;
    for (;;) {
      const next = this.takeNextDue(target);
      if (!next) break;
      const delta = next.fireAtMs - this.monoMs;
      this.monoMs = next.fireAtMs;
      this.wallMs += delta;
      next.handler();
    }
    if (this.monoMs < target) {
      const delta = target - this.monoMs;
      this.monoMs = target;
      this.wallMs += delta;
    }
  }

  /** Number of pending (not cancelled) timers. */
  public pendingTimers(): number {
    return this.timers.filter((t) => !t.cancelled).length;
  }

  private takeNextDue(targetMs: number): FakeTimer | undefined {
    let bestIdx = -1;
    let best: FakeTimer | undefined;
    for (let i = 0; i < this.timers.length; i++) {
      const t = this.timers[i]!;
      if (t.cancelled) continue;
      if (t.fireAtMs > targetMs) continue;
      if (
        !best ||
        t.fireAtMs < best.fireAtMs ||
        (t.fireAtMs === best.fireAtMs && t.seq < best.seq)
      ) {
        best = t;
        bestIdx = i;
      }
    }
    if (best) {
      this.timers.splice(bestIdx, 1);
      return best;
    }
    return undefined;
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

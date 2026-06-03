import { performance } from 'node:perf_hooks';
import type { Clock, ClockTimer } from '../types.js';

/** Real-world clock. Uses `Date.now()`, `performance.now()`, and native timers. */
export class SystemClock implements Clock {
  public now(): number {
    return Date.now();
  }

  public monotonic(): number {
    return performance.now();
  }

  public setTimeout(handler: () => void, ms: number): ClockTimer {
    return setTimeout(handler, Math.max(0, ms));
  }

  public clearTimeout(handle: ClockTimer): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  public sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError(signal));
        return;
      }
      const timer = setTimeout(() => {
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(0, ms));
      const onAbort = signal
        ? () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort!);
            reject(abortError(signal));
          }
        : undefined;
      if (onAbort && signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/** Default singleton instance. */
export const systemClock: Clock = new SystemClock();

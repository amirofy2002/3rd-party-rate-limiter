import type { LimiterEvent, LimiterEventName, Logger } from '../types.js';

/** Mapping from event name to payload type. */
export interface EventPayloadMap {
  'request:received': LimiterEvent;
  'request:queued': LimiterEvent;
  'request:dequeued': LimiterEvent;
  'request:reserved': LimiterEvent;
  'request:executed': LimiterEvent;
  'request:rejected': LimiterEvent;
  'request:timeout': LimiterEvent;
  'request:retry': LimiterEvent;
  'limit:near': LimiterEvent;
  'limit:exceeded': LimiterEvent;
  'usage:reconciled': LimiterEvent;
  'ban:detected': LimiterEvent;
  'ban:cleared': LimiterEvent;
  'store:error': LimiterEvent;
  'queue:overflow': LimiterEvent;
}

/** Unsubscribe handle returned by `on()`. Idempotent. */
export type Unsubscribe = () => void;

/** Wildcard listener — receives every emission. */
export type WildcardListener = (event: LimiterEventName, payload: LimiterEvent) => void;

const FREEZE_PAYLOADS = process.env['NODE_ENV'] !== 'production';

/**
 * Typed event bus with synchronous dispatch and per-handler isolation.
 *
 * - Handlers iterate in registration order.
 * - Throwing handlers are caught and logged; the hot path is not broken.
 * - `on` returns an idempotent unsubscribe function.
 * - Wildcard `*` listeners observe every event (debug/tooling use only).
 * - Listeners registered during emit fire on the next emit, not the current.
 */
export class EventBus {
  private readonly listeners = new Map<LimiterEventName, Set<(payload: LimiterEvent) => void>>();
  private readonly wildcard = new Set<WildcardListener>();
  private readonly logger: Logger | undefined;

  public constructor(logger?: Logger) {
    this.logger = logger;
  }

  public on<E extends LimiterEventName>(
    event: E,
    handler: (payload: EventPayloadMap[E]) => void,
  ): Unsubscribe {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler as (payload: LimiterEvent) => void);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const cur = this.listeners.get(event);
      cur?.delete(handler as (payload: LimiterEvent) => void);
      if (cur && cur.size === 0) this.listeners.delete(event);
    };
  }

  public off<E extends LimiterEventName>(
    event: E,
    handler: (payload: EventPayloadMap[E]) => void,
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    set.delete(handler as (payload: LimiterEvent) => void);
    if (set.size === 0) this.listeners.delete(event);
  }

  /** Register a wildcard listener. Returns an idempotent unsubscribe. */
  public onAny(handler: WildcardListener): Unsubscribe {
    this.wildcard.add(handler);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.wildcard.delete(handler);
    };
  }

  public emit<E extends LimiterEventName>(event: E, payload: EventPayloadMap[E]): void {
    const set = this.listeners.get(event);
    const hasWildcards = this.wildcard.size > 0;
    if (!set && !hasWildcards) return;

    if (FREEZE_PAYLOADS) {
      try {
        Object.freeze(payload);
      } catch {
        // ignore non-extensible payloads
      }
    }

    if (set) {
      // Snapshot to give "register during emit fires on next emit" semantics.
      const snapshot = Array.from(set);
      for (const handler of snapshot) {
        try {
          handler(payload);
        } catch (err) {
          this.logger?.error('event handler threw', {
            event,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    if (hasWildcards) {
      const wildSnapshot = Array.from(this.wildcard);
      for (const handler of wildSnapshot) {
        try {
          handler(event, payload);
        } catch (err) {
          this.logger?.error('wildcard event handler threw', {
            event,
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  /** Test/debug helper — current listener count for an event. */
  public listenerCount(event: LimiterEventName): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /** Remove all listeners. */
  public removeAll(): void {
    this.listeners.clear();
    this.wildcard.clear();
  }
}

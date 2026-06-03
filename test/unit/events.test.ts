import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/events.js';
import type { LimiterEvent, Logger } from '../../src/types.js';

const makePayload = (overrides: Partial<LimiterEvent> = {}): LimiterEvent => ({
  name: 'request:received',
  tsMs: 0,
  ...overrides,
});

describe('EventBus', () => {
  it('emits to a registered handler with correct payload', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    bus.on('request:received', handler);
    const payload = makePayload({ tsMs: 1 });
    bus.emit('request:received', payload);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(payload);
  });

  it('throwing handler does not prevent later handlers', () => {
    const errorFn = vi.fn();
    const logger: Logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: errorFn,
    };
    const bus = new EventBus(logger);
    const a = vi.fn(() => {
      throw new Error('boom');
    });
    const b = vi.fn();
    bus.on('request:received', a);
    bus.on('request:received', b);
    bus.emit('request:received', makePayload());
    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(errorFn).toHaveBeenCalledWith(
      'event handler threw',
      expect.objectContaining({ event: 'request:received' }),
    );
  });

  it('unsubscribe removes handler', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.on('request:received', handler);
    off();
    bus.emit('request:received', makePayload());
    expect(handler).not.toHaveBeenCalled();
  });

  it('double-unsubscribe is a no-op', () => {
    const bus = new EventBus();
    const handler = vi.fn();
    const off = bus.on('request:received', handler);
    off();
    expect(() => off()).not.toThrow();
    bus.emit('request:received', makePayload());
    expect(handler).not.toHaveBeenCalled();
  });

  it('wildcard listener receives every event', () => {
    const bus = new EventBus();
    const wild = vi.fn();
    bus.onAny(wild);
    bus.emit('request:received', makePayload({ name: 'request:received' }));
    bus.emit('limit:near', makePayload({ name: 'limit:near' }));
    expect(wild).toHaveBeenCalledTimes(2);
    expect(wild).toHaveBeenNthCalledWith(1, 'request:received', expect.objectContaining({ name: 'request:received' }));
    expect(wild).toHaveBeenNthCalledWith(2, 'limit:near', expect.objectContaining({ name: 'limit:near' }));
  });

  it('listener registered during emit fires on next emit, not current', () => {
    const bus = new EventBus();
    const late = vi.fn();
    bus.on('request:received', () => {
      bus.on('request:received', late);
    });
    bus.emit('request:received', makePayload());
    expect(late).not.toHaveBeenCalled();
    bus.emit('request:received', makePayload());
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('zero listeners: emit is cheap and does not throw', () => {
    const bus = new EventBus();
    for (let i = 0; i < 100_000; i++) {
      bus.emit('request:received', makePayload());
    }
    expect(bus.listenerCount('request:received')).toBe(0);
  });

  it('listenerCount reflects registered handlers', () => {
    const bus = new EventBus();
    expect(bus.listenerCount('request:queued')).toBe(0);
    const off1 = bus.on('request:queued', () => undefined);
    const off2 = bus.on('request:queued', () => undefined);
    expect(bus.listenerCount('request:queued')).toBe(2);
    off1();
    expect(bus.listenerCount('request:queued')).toBe(1);
    off2();
    expect(bus.listenerCount('request:queued')).toBe(0);
  });

  it('off() removes a specific handler', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.on('request:received', a);
    bus.on('request:received', b);
    bus.off('request:received', a);
    bus.emit('request:received', makePayload());
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('removeAll clears every listener', () => {
    const bus = new EventBus();
    const a = vi.fn();
    const wild = vi.fn();
    bus.on('request:received', a);
    bus.onAny(wild);
    bus.removeAll();
    bus.emit('request:received', makePayload());
    expect(a).not.toHaveBeenCalled();
    expect(wild).not.toHaveBeenCalled();
  });
});

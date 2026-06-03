import { describe, expect, it } from 'vitest';
import { GenericAdapter } from '../../src/adapters/generic.js';
import { createLimiter } from '../../src/core/create-limiter.js';
import { ConfigurationError } from '../../src/errors.js';
import { instrumentLimiter, type OtelSpan, type OtelTracer } from '../../src/observability/otel.js';
import type { RateWindow } from '../../src/types.js';

const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 5, algorithm: 'fixed-window' };

interface RecordedSpan {
  name: string;
  attributes: Record<string, string | number | boolean>;
  events: Array<{ name: string; attrs?: Record<string, string | number | boolean> }>;
  status?: { code: number; message?: string };
  exception?: unknown;
  ended: boolean;
}

function makeTracer(): { tracer: OtelTracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: OtelTracer = {
    startActiveSpan(name, options, fn) {
      const rec: RecordedSpan = {
        name,
        attributes: { ...(options.attributes ?? {}) },
        events: [],
        ended: false,
      };
      const span: OtelSpan = {
        setAttribute(k, v) {
          rec.attributes[k] = v;
        },
        setAttributes(attrs) {
          Object.assign(rec.attributes, attrs);
        },
        addEvent(eventName, attrs) {
          rec.events.push({ name: eventName, ...(attrs ? { attrs } : {}) });
        },
        setStatus(status) {
          rec.status = status;
        },
        recordException(error) {
          rec.exception = error;
        },
        end() {
          rec.ended = true;
        },
      };
      spans.push(rec);
      return fn(span);
    },
  };
  return { tracer, spans };
}

describe('instrumentLimiter', () => {
  it('starts a span per schedule call with descriptive attributes', async () => {
    const limiter = createLimiter({
      provider: new GenericAdapter({ id: 'p', windows: [W], endpoints: { '/x': 1 } }),
      defaultStrategy: 'reject',
    });
    const { tracer, spans } = makeTracer();
    instrumentLimiter(limiter, { tracer, serviceName: 'svc-1' });
    await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve('ok') });
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('rate-limiter.schedule');
    expect(span.attributes['rate_limiter.endpoint']).toBe('/x');
    expect(span.attributes['rate_limiter.service_name']).toBe('svc-1');
    expect(span.status?.code).toBe(1);
    expect(span.ended).toBe(true);
  });

  it('records exceptions on schedule failure', async () => {
    const limiter = createLimiter({
      provider: new GenericAdapter({ id: 'p', windows: [W], endpoints: { '/x': 1 } }),
      defaultStrategy: 'reject',
    });
    const { tracer, spans } = makeTracer();
    instrumentLimiter(limiter, { tracer });
    const boom = new Error('boom');
    await expect(
      limiter.schedule({ endpoint: '/x', execute: () => Promise.reject(boom) }),
    ).rejects.toThrow();
    const span = spans[0]!;
    expect(span.status?.code).toBe(2);
    expect(span.exception).toBeDefined();
    expect(span.ended).toBe(true);
  });

  it('throws ConfigurationError when tracer is missing', () => {
    const limiter = createLimiter({
      provider: new GenericAdapter({ id: 'p', windows: [W], endpoints: { '/x': 1 } }),
    });
    expect(() =>
      instrumentLimiter(limiter, { tracer: undefined as unknown as OtelTracer }),
    ).toThrow(ConfigurationError);
  });

  it('forwards lifecycle events as span events', async () => {
    const limiter = createLimiter({
      provider: new GenericAdapter({ id: 'p', windows: [W], endpoints: { '/x': 1 } }),
      defaultStrategy: 'reject',
    });
    const { tracer, spans } = makeTracer();
    instrumentLimiter(limiter, { tracer });
    // Fill the window so the next request triggers limit:near.
    for (let i = 0; i < 4; i++) {
      await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(null) });
    }
    await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve(null) });
    const lastSpan = spans[spans.length - 1]!;
    const eventNames = lastSpan.events.map((e) => e.name);
    expect(eventNames).toContain('limit:near');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { GenericAdapter } from '../../src/adapters/generic.js';
import { createLimiter } from '../../src/core/create-limiter.js';
import { EventBus } from '../../src/core/events.js';
import { bindMetrics, NoopMetricsSink } from '../../src/observability/metrics.js';
import type { CounterHandle, GaugeHandle, HistogramHandle, LimiterEvent, MetricLabels, MetricsSink } from '../../src/types.js';
import { ConfigurationError } from '../../src/errors.js';
import type { RateWindow } from '../../src/types.js';

interface CounterCall { name: string; labels?: MetricLabels; value: number; }
interface GaugeCall { name: string; labels?: MetricLabels; value: number; }
interface HistogramCall { name: string; labels?: MetricLabels; value: number; }

class RecordingSink implements MetricsSink {
  public counters: CounterCall[] = [];
  public gauges: GaugeCall[] = [];
  public histograms: HistogramCall[] = [];

  public counter(name: string, labels?: MetricLabels): CounterHandle {
    return {
      inc: (value = 1) => {
        this.counters.push({ name, ...(labels ? { labels } : {}), value });
      },
    };
  }
  public gauge(name: string, labels?: MetricLabels): GaugeHandle {
    return {
      set: (value) => this.gauges.push({ name, ...(labels ? { labels } : {}), value }),
      inc: (value = 1) => this.gauges.push({ name, ...(labels ? { labels } : {}), value }),
      dec: (value = 1) => this.gauges.push({ name, ...(labels ? { labels } : {}), value: -value }),
    };
  }
  public histogram(name: string, labels?: MetricLabels): HistogramHandle {
    return {
      observe: (value) => this.histograms.push({ name, ...(labels ? { labels } : {}), value }),
    };
  }
}

const W: RateWindow = { id: '1m', windowMs: 60_000, maxWeight: 100, algorithm: 'fixed-window' };
const makeAdapter = () => new GenericAdapter({ id: 'p', windows: [W], endpoints: { '/x': 1 } });

describe('NoopMetricsSink', () => {
  it('all handles are no-ops and never throw', () => {
    const sink = new NoopMetricsSink();
    expect(() => sink.counter('x').inc()).not.toThrow();
    expect(() => sink.gauge('x').set(1)).not.toThrow();
    expect(() => sink.histogram('x').observe(1)).not.toThrow();
  });
});

describe('bindMetrics', () => {
  let events: EventBus;
  let sink: RecordingSink;

  beforeEach(() => {
    events = new EventBus();
    sink = new RecordingSink();
  });

  it('increments rate_limiter_requests_total on lifecycle events', async () => {
    bindMetrics(events, sink);
    const limiter = createLimiter({ provider: makeAdapter(), defaultStrategy: 'reject' });
    // Hook our recording bus to the limiter via re-emit.
    limiter.on('request:received', (e: LimiterEvent) => events.emit('request:received', e));
    limiter.on('request:executed', (e: LimiterEvent) => events.emit('request:executed', e));
    await limiter.schedule({ endpoint: '/x', execute: () => Promise.resolve('ok') });
    const outcomes = sink.counters.filter((c) => c.name === 'rate_limiter_requests_total');
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
  });

  it('observes queue wait ms on dequeue', () => {
    bindMetrics(events, sink);
    events.emit('request:queued', {
      name: 'request:queued',
      tsMs: 1_000,
      provider: 'p',
      requestId: 'r1',
      data: { queueDepth: 5 },
    });
    events.emit('request:dequeued', {
      name: 'request:dequeued',
      tsMs: 1_750,
      provider: 'p',
      requestId: 'r1',
    });
    const wait = sink.histograms.find((h) => h.name === 'rate_limiter_queue_wait_ms');
    expect(wait?.value).toBe(750);
  });

  it('sets capacity_remaining gauge on limit:near with window data', () => {
    bindMetrics(events, sink);
    events.emit('limit:near', {
      name: 'limit:near',
      tsMs: 0,
      provider: 'p',
      data: { windowId: '1m', remaining: 5 },
    });
    const gauge = sink.gauges.find((g) => g.name === 'rate_limiter_capacity_remaining');
    expect(gauge?.value).toBe(5);
    expect(gauge?.labels?.['window']).toBe('1m');
  });

  it('counts bans and store errors', () => {
    bindMetrics(events, sink);
    events.emit('ban:detected', { name: 'ban:detected', tsMs: 0, provider: 'p' });
    events.emit('store:error', { name: 'store:error', tsMs: 0, provider: 'p' });
    expect(sink.counters.find((c) => c.name === 'rate_limiter_bans_total')).toBeDefined();
    expect(sink.counters.find((c) => c.name === 'rate_limiter_store_errors_total')).toBeDefined();
  });

  it('rejects disallowed label keys at configure time', () => {
    expect(() => bindMetrics(events, sink, { labels: { account: 'acct-1' } })).toThrow(
      ConfigurationError,
    );
  });

  it('unbind() detaches subscriptions', () => {
    const unbind = bindMetrics(events, sink);
    unbind();
    events.emit('request:received', { name: 'request:received', tsMs: 0, provider: 'p' });
    expect(sink.counters).toHaveLength(0);
  });

  it('endpoint label opt-in only', () => {
    bindMetrics(events, sink);
    events.emit('request:received', {
      name: 'request:received',
      tsMs: 0,
      provider: 'p',
      endpoint: '/x',
    });
    expect(sink.counters[0]?.labels?.['endpoint']).toBeUndefined();

    events = new EventBus();
    sink = new RecordingSink();
    bindMetrics(events, sink, { endpointLabel: true });
    events.emit('request:received', {
      name: 'request:received',
      tsMs: 0,
      provider: 'p',
      endpoint: '/x',
    });
    expect(sink.counters[0]?.labels?.['endpoint']).toBe('/x');
  });

  it('sink that throws does not break the event bus', () => {
    const badSink: MetricsSink = {
      counter: () => ({ inc: () => { throw new Error('bad'); } }),
      gauge: () => ({ set: () => undefined, inc: () => undefined, dec: () => undefined }),
      histogram: () => ({ observe: () => undefined }),
    };
    bindMetrics(events, badSink);
    expect(() =>
      events.emit('request:received', { name: 'request:received', tsMs: 0, provider: 'p' }),
    ).not.toThrow();
  });
});

import { describe, expectTypeOf, it } from 'vitest';
import type {
  RateLimiterClient,
  RateLimiterOptions,
  ScheduledRequest,
} from '../../src/types.js';

describe('public types', () => {
  it('ScheduledRequest.execute returns Promise<T>', () => {
    type R = ScheduledRequest<{ x: number }>;
    expectTypeOf<R['execute']>().returns.toEqualTypeOf<Promise<{ x: number }>>();
  });

  it('weight is optional override', () => {
    expectTypeOf<ScheduledRequest<unknown>['weight']>().toEqualTypeOf<number | undefined>();
  });

  it('client.schedule preserves the execute() result type', () => {
    type Schedule = RateLimiterClient['schedule'];
    expectTypeOf<ReturnType<Schedule<string>>>().toEqualTypeOf<Promise<string>>();
  });

  it('RateLimiterOptions.maxQueueSize is optional number', () => {
    expectTypeOf<RateLimiterOptions['maxQueueSize']>().toEqualTypeOf<number | undefined>();
  });
});

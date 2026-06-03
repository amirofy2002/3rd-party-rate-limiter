/**
 * Real-Redis integration suite (testcontainers + ioredis).
 *
 * Skipped by default. Enable with `RUN_REDIS_INTEGRATION=1` once
 * `testcontainers` and `ioredis` are installed as dev dependencies.
 */
import { describe, it } from 'vitest';

const enabled = process.env['RUN_REDIS_INTEGRATION'] === '1';

describe.skipIf(!enabled)('RedisStore — real Redis integration', () => {
  it.todo('atomic multi-window: 8 parallel clients × 1000 consumes do not overshoot');
  it.todo('ban propagation: instance A setBan → instance B observes within 50ms');
  it.todo('reservation expiry: TTL reclaims capacity after crash simulation');
  it.todo('NOSCRIPT recovery: SCRIPT FLUSH mid-test triggers auto reload');
  it.todo('cluster mode: hash-tagged keys land on same slot');
  it.todo('sentinel failover: client reconnects after primary kill');
  it.todo('Toxiproxy partition: failClosed rejects, fallbackToMemory switches');
  it.todo('Lua script determinism across Redis versions');
});

import { createHash } from 'node:crypto';
import { StoreUnavailableError } from '../errors.js';
import { ALL_SCRIPTS, type ScriptName } from './redis-scripts.js';

/**
 * Minimal subset of `ioredis` we depend on. Defining it here keeps the core
 * package free of an `ioredis` runtime dependency until the user opts in.
 */
export interface RedisLike {
  script(subcommand: 'LOAD', source: string): Promise<string>;
  evalsha(sha: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  // Redis `EVAL` command (server-side Lua execution; nothing to do with JS).
  eval(source: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

interface CachedScript {
  source: string;
  sha: string;
}

/**
 * Loader for Lua scripts. Caches SHAs in-process and falls back to Redis
 * `EVAL` (server-side Lua) when Redis loses scripts (e.g. after a restart
 * or `SCRIPT FLUSH`).
 */
export class LuaLoader {
  private readonly cache = new Map<ScriptName, CachedScript>();
  private loadPromise: Promise<void> | undefined;

  public constructor(private readonly redis: RedisLike) {}

  /** Pre-load every bundled script. Safe to call multiple times. */
  public async loadAll(): Promise<void> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoadAll();
    try {
      await this.loadPromise;
    } catch (err) {
      this.loadPromise = undefined;
      throw err;
    }
  }

  private async doLoadAll(): Promise<void> {
    const entries = Object.entries(ALL_SCRIPTS) as [ScriptName, string][];
    for (const [name, source] of entries) {
      let sha: string;
      try {
        sha = await this.redis.script('LOAD', source);
      } catch (err) {
        throw new StoreUnavailableError(`failed to load Lua script: ${name}`, { cause: err });
      }
      this.cache.set(name, { source, sha });
    }
  }

  /** Run a named script, automatically falling back to Redis EVAL on NOSCRIPT. */
  public async run(
    name: ScriptName,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    const entry = this.cache.get(name);
    if (!entry) {
      const source = ALL_SCRIPTS[name];
      const sha = sha1(source);
      this.cache.set(name, { source, sha });
    }
    const cached = this.cache.get(name)!;
    try {
      return await this.redis.evalsha(cached.sha, keys.length, ...keys, ...args);
    } catch (err) {
      if (isNoScriptError(err)) {
        try {
          const sha = await this.redis.script('LOAD', cached.source);
          this.cache.set(name, { source: cached.source, sha });
          return await this.redis.evalsha(sha, keys.length, ...keys, ...args);
        } catch (innerErr) {
          if (isNoScriptError(innerErr)) {
            return this.evalDirect(cached.source, keys, args);
          }
          throw new StoreUnavailableError('Lua script evalsha failed after reload', { cause: innerErr });
        }
      }
      throw err;
    }
  }

  private evalDirect(
    source: string,
    keys: readonly string[],
    args: readonly (string | number)[],
  ): Promise<unknown> {
    // Server-side Lua execution. The `eval` method name is dictated by the
    // Redis protocol — it is not JavaScript `eval`.
    const r = this.redis as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    return r['eval']!(source, keys.length, ...keys, ...args);
  }

  /** Test/debug — return SHA for a named script. */
  public shaFor(name: ScriptName): string | undefined {
    return this.cache.get(name)?.sha;
  }
}

function isNoScriptError(err: unknown): boolean {
  if (typeof err === 'object' && err !== null) {
    const e = err as { message?: string; code?: string };
    if (e.code === 'NOSCRIPT') return true;
    if (typeof e.message === 'string' && e.message.includes('NOSCRIPT')) return true;
  }
  return false;
}

function sha1(source: string): string {
  return createHash('sha1').update(source).digest('hex');
}

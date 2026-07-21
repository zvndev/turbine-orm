/**
 * turbine-orm: configurable SQL-template cache size (`sqlCacheSize`)
 *
 * Build-only assertions (no DB) exercising the per-table LRU cache bound via
 * the `sqlCacheSize` option: the default 1000-entry behavior, a small explicit
 * bound that evicts, and `sqlCacheSize: 0` disabling caching entirely (mirrors
 * `sqlCache: false`). Observed through the public `cacheStats()` accessor.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
        { name: 'age', field: 'age' },
      ]),
    },
  };
}

describe('sqlCacheSize option', () => {
  it('default caches multiple distinct query shapes', () => {
    const q = makeQuery('users', schema());
    q.buildFindMany({ where: { name: 'a' } } as never);
    q.buildFindMany({ where: { age: 1 } } as never);
    q.buildFindMany({ where: { id: 1 } } as never);
    const stats = q.cacheStats();
    assert.equal(stats.size, 3, 'three distinct shapes should all be retained by default');
  });

  it('sqlCacheSize bounds the number of retained templates (LRU eviction)', () => {
    const q = makeQuery('users', schema(), { sqlCacheSize: 1 });
    // Shape A: miss, cached.
    q.buildFindMany({ where: { name: 'a' } } as never);
    // Shape A again: HIT (still resident, size 1).
    q.buildFindMany({ where: { name: 'a' } } as never);
    assert.equal(q.cacheStats().hits, 1);
    // Shape B: miss, evicts A (bound is 1).
    q.buildFindMany({ where: { age: 1 } } as never);
    // Shape A again: MISS now, since it was evicted.
    q.buildFindMany({ where: { name: 'a' } } as never);
    const stats = q.cacheStats();
    assert.equal(stats.size, 1, 'cache never exceeds its bound');
    assert.equal(stats.hits, 1, 'the evicted shape does not hit on its second appearance');
    assert.equal(stats.misses, 3, 'A(miss) + B(miss) + A-again(miss)');
  });

  it('sqlCacheSize: 0 disables caching (mirrors sqlCache: false)', () => {
    const q = makeQuery('users', schema(), { sqlCacheSize: 0 });
    q.buildFindMany({ where: { name: 'a' } } as never);
    q.buildFindMany({ where: { name: 'a' } } as never);
    const stats = q.cacheStats();
    assert.equal(stats.hits, 0, 'no hits when caching is disabled');
    assert.equal(stats.size, 0, 'nothing is retained when caching is disabled');
  });

  it('sqlCache: false and sqlCacheSize: 0 behave identically', () => {
    const off = makeQuery('users', schema(), { sqlCache: false });
    const zero = makeQuery('users', schema(), { sqlCacheSize: 0 });
    for (const q of [off, zero]) {
      q.buildFindMany({ where: { name: 'a' } } as never);
      q.buildFindMany({ where: { name: 'a' } } as never);
    }
    assert.deepEqual(off.cacheStats().hits, zero.cacheStats().hits);
    assert.deepEqual(off.cacheStats().size, zero.cacheStats().size);
  });

  it('a negative sqlCacheSize is ignored (falls back to caching enabled)', () => {
    const q = makeQuery('users', schema(), { sqlCacheSize: -5 });
    q.buildFindMany({ where: { name: 'a' } } as never);
    q.buildFindMany({ where: { name: 'a' } } as never);
    assert.equal(q.cacheStats().hits, 1, 'negative size does not disable the cache');
  });
});

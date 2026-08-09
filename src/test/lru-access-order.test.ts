/**
 * turbine-orm: the SQL-template LRU skips its access-order reorder below capacity
 *
 * `LRUCache.get` moved the hit entry to the end of the Map on EVERY hit, to
 * maintain access order. The class comment claimed "O(1) eviction", which is
 * true of eviction and false of that reorder: `Map.delete` + `Map.set` leaves a
 * tombstone, and V8 rehashes the whole table once live plus deleted entries
 * reach capacity, so the reorder amortizes to O(capacity). Measured 1,356 ns at
 * the 1,000-entry default against 2.6 ns for a plain `Map.get`, on the hottest
 * lookup in the SQL build.
 *
 * Access order is only ever CONSUMED by eviction, so while the cache is still
 * filling it has no reader and maintaining it is pure cost. These tests pin
 * both halves: contents are unaffected below capacity, and real LRU eviction
 * resumes once the cache is full.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LRUCache } from '../query/utils.js';

/** The cache's live keys, in Map (insertion/access) order. */
function keysOf<K, V>(cache: LRUCache<K, V>): K[] {
  return [...(cache as unknown as { cache: Map<K, V> }).cache.keys()];
}

describe('LRUCache access-order maintenance', () => {
  it('keeps every entry below capacity regardless of access pattern', () => {
    const cache = new LRUCache<string, number>(4);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Read 'a' repeatedly while below capacity: nothing may be evicted, so the
    // reorder cannot change what is present.
    for (let i = 0; i < 10; i++) assert.equal(cache.get('a'), 1);
    assert.equal(cache.size, 3);
    for (const k of ['a', 'b', 'c']) assert.ok(cache.get(k) !== undefined, `${k} must still be cached`);
  });

  it('does not reorder while below capacity (the whole point of the change)', () => {
    const cache = new LRUCache<string, number>(4);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    assert.deepEqual(keysOf(cache), ['a', 'b'], 'insertion order must be untouched below capacity');
  });

  it('bounds the cache at maxSize and evicts on overflow', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4);
    assert.equal(cache.size, 3);
    assert.equal(cache.get('a'), undefined, 'the oldest entry must have been evicted');
    assert.equal(cache.get('d'), 4);
  });

  it('resumes real LRU behaviour once full: a hit survives the next eviction', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    // Full now, so the reorder is live again.
    assert.equal(cache.get('a'), 1);
    cache.set('d', 4);
    assert.equal(cache.get('a'), 1, "'a' was just used, so 'b' should have gone instead");
    assert.equal(cache.get('b'), undefined);
  });

  it('re-setting an existing key still refreshes its position', () => {
    const cache = new LRUCache<string, number>(3);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('a', 9); // set has always reordered, unchanged
    cache.set('d', 4);
    assert.equal(cache.get('a'), 9);
    assert.equal(cache.get('b'), undefined);
  });

  it('a miss returns undefined and touches nothing', () => {
    const cache = new LRUCache<string, number>(2);
    cache.set('a', 1);
    assert.equal(cache.get('zzz'), undefined);
    assert.deepEqual(keysOf(cache), ['a']);
  });
});

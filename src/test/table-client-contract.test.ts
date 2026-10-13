/**
 * turbine-orm: the table accessor contract (`TableClient`, query/table-client.ts).
 *
 * The compile-time half lives in the types: `PowqlInterface implements
 * TableClient`, and a public QueryInterface member that nobody classified
 * fails the build. This file is the run-time half: the classification names
 * real methods on both engines, the replica routing set is exactly its `read`
 * entries, and PowDB answers every deferred-query method with the typed E017
 * instead of `TypeError: ... is not a function`.
 *
 * Run: npx tsx --test src/test/table-client-contract.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { READ_OPERATIONS } from '../client.js';
import { UnsupportedFeatureError } from '../errors.js';
import { PowqlInterface } from '../powql.js';
import { QueryInterface } from '../query/index.js';
import { TABLE_METHODS } from '../query/table-client.js';

const methods = Object.keys(TABLE_METHODS);
const deferred = methods.filter((m) => TABLE_METHODS[m as keyof typeof TABLE_METHODS] === 'deferred');

describe('TableClient: the classification', () => {
  it('classifies a non-trivial set of methods', () => {
    // Anti-vacuous: an empty table would make every loop below pass.
    assert.ok(methods.length >= 30, `expected the full accessor surface, found ${methods.length}`);
    assert.equal(deferred.length, 15, `expected 15 build* methods, found ${deferred.join(', ')}`);
  });

  it('every classified method is a function on QueryInterface and on PowqlInterface', () => {
    for (const [name, proto] of [
      ['QueryInterface', QueryInterface.prototype],
      ['PowqlInterface', PowqlInterface.prototype],
    ] as const) {
      const missing = methods.filter((m) => typeof (proto as unknown as Record<string, unknown>)[m] !== 'function');
      assert.deepEqual(missing, [], `${name} lacks: ${missing.join(', ')}`);
    }
  });

  it('READ_OPERATIONS is exactly the read entries, and the same ten names it always held', () => {
    assert.deepEqual([...READ_OPERATIONS].sort(), [
      'aggregate',
      'count',
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'findManyStream',
      'findManyStreamBatches',
      'findUnique',
      'findUniqueOrThrow',
      'groupBy',
    ]);
    assert.ok(!READ_OPERATIONS.has('explain'), 'explain runs on the primary');
    assert.ok(!READ_OPERATIONS.has('buildFindMany'), 'a deferred query is not a replica read');
  });
});

describe('TableClient: PowDB answers the deferred-query surface', () => {
  const proto = PowqlInterface.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;

  it('every build* method throws UnsupportedFeatureError (E017) naming the method and the alternative', () => {
    for (const name of deferred) {
      assert.throws(
        () => proto[name]!.call(Object.create(proto), {}),
        (err: unknown) => {
          assert.ok(err instanceof UnsupportedFeatureError, `${name} threw ${String(err)}`);
          assert.equal(err.code, 'TURBINE_E017');
          assert.match(err.message, new RegExp(`deferred query \\(${name}\\)`));
          assert.match(err.message, /db\.\$transaction\(async \(tx\) => \.\.\.\)/);
          return true;
        },
      );
    }
  });

  it('cacheStats() reports an empty cache', () => {
    assert.deepEqual(proto.cacheStats!.call(Object.create(proto)), { hits: 0, misses: 0, hitRate: 0, size: 0 });
  });
});

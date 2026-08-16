/**
 * turbine-orm, drift guards for the two hand-maintained lists that must track
 * `QueryInterface`'s READ surface.
 *
 * Both failures these catch are SILENT. Neither throws, neither fails an
 * existing test, and neither is visible to the person who caused it:
 *
 *   1. `READ_OPERATIONS` (client.ts) decides what a read replica may serve. A
 *      read method missing from it keeps working and just runs on the PRIMARY.
 *      The only symptom is a busier primary, in production, on someone else's
 *      deployment.
 *
 *   2. `PowqlInterface` (powql.ts) is a PARALLEL implementation of
 *      QueryInterface's surface, not a subclass, so TypeScript does not require
 *      it to have a method QueryInterface has. A read method missing there is
 *      `undefined` at runtime and the PowDB user gets
 *      `TypeError: ... is not a function` instead of the typed
 *      UnsupportedFeatureError that tells them what to do instead.
 *
 * Both were introduced by adding `findManyStreamBatches` in the streaming
 * batch-yield work, and neither was caught by any gate.
 *
 * The rule below is deliberately MECHANICAL rather than a second copy of the
 * list: a name starting with `find`, or one of count/aggregate/groupBy, is a
 * read. Writes are create/update/delete/upsert and match none of it. A new read
 * method is covered by these tests the day it is written, with no edit here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { READ_OPERATIONS } from '../client.js';
import { PowqlInterface } from '../powql.js';
import { QueryInterface } from '../query/index.js';

/** Public, non-constructor method names on a class prototype. */
function methodNames(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter((name) => {
    if (name === 'constructor' || name.startsWith('_')) return false;
    const desc = Object.getOwnPropertyDescriptor(proto, name);
    // Skip accessors: reading one would invoke the getter on the prototype.
    return typeof desc?.value === 'function';
  });
}

/** The mechanical read-method rule. */
function isReadMethod(name: string): boolean {
  return name.startsWith('find') || name === 'count' || name === 'aggregate' || name === 'groupBy';
}

const QI_READ_METHODS = methodNames(QueryInterface.prototype).filter(isReadMethod).sort();

describe('read-surface drift guards', () => {
  it('finds a non-trivial set of read methods to check', () => {
    // Anti-vacuous: if the reflection above silently returned [], every
    // assertion below would pass while checking nothing. That exact shape of
    // green-but-empty gate has shipped in this repo before.
    assert.ok(
      QI_READ_METHODS.length >= 8,
      `expected QueryInterface to expose several read methods, found ${QI_READ_METHODS.length}: ${QI_READ_METHODS.join(', ')}`,
    );
    // Spot-check that the rule actually recognises known members.
    for (const known of ['findMany', 'findUnique', 'count', 'groupBy']) {
      assert.ok(QI_READ_METHODS.includes(known), `expected ${known} among the detected read methods`);
    }
  });

  it('every QueryInterface read method may be served by a read replica', () => {
    const missing = QI_READ_METHODS.filter((name) => !READ_OPERATIONS.has(name));
    assert.deepEqual(
      missing,
      [],
      `these read methods are absent from READ_OPERATIONS in client.ts, so they run on the PRIMARY ` +
        `even when replicas are configured: ${missing.join(', ')}`,
    );
  });

  it('READ_OPERATIONS names no method that does not exist', () => {
    // The other direction: a renamed or removed method leaves a dead entry
    // behind, which reads as coverage that is not there.
    const all = new Set(methodNames(QueryInterface.prototype));
    const stale = [...READ_OPERATIONS].filter((name) => !all.has(name));
    assert.deepEqual(stale, [], `READ_OPERATIONS lists methods QueryInterface does not have: ${stale.join(', ')}`);
  });

  it('PowqlInterface answers every read method, even if only to refuse it', () => {
    const powqlMethods = new Set(methodNames(PowqlInterface.prototype));
    const missing = QI_READ_METHODS.filter((name) => !powqlMethods.has(name));
    assert.deepEqual(
      missing,
      [],
      `PowDB would throw "TypeError: not a function" instead of a typed UnsupportedFeatureError ` +
        `for: ${missing.join(', ')}. Add a stub that throws UnsupportedFeatureError (E017).`,
    );
  });

  it('the PowDB streaming stubs throw the typed error rather than yielding', async () => {
    const proto = PowqlInterface.prototype as unknown as Record<string, () => AsyncGenerator<unknown>>;
    for (const name of ['findManyStream', 'findManyStreamBatches']) {
      await assert.rejects(
        async () => {
          for await (const _ of proto[name]!.call(Object.create(proto))) {
            assert.fail(`${name} yielded a value on PowDB; it must refuse`);
          }
        },
        (err: unknown) => {
          assert.ok(err instanceof Error, `${name} threw a non-Error`);
          assert.equal((err as { code?: string }).code, 'TURBINE_E017', `${name} threw the wrong code`);
          return true;
        },
        `${name} must throw UnsupportedFeatureError on PowDB`,
      );
    }
  });
});

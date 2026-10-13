/**
 * PowQL generator contract breaks are InvariantError (E020), not E003.
 *
 * Three branches in the PowQL generator cannot be reached by any argument a
 * caller can write: a relation filter arriving at the where compiler without
 * being resolved to a literal list first, a JSON string operator the generator
 * has no spelling for, and a JSON filter that passed validation yet compiled
 * to no condition. Each means the generator and its validators disagree, which
 * is a bug in Turbine and not something to fix in the call, so each is
 * reported as E020 with a stable `invariant` id.
 *
 * The relation-filter site is reached through `buildWhere`, the narrowest
 * entry point: every public method resolves relation filters before it. The
 * two JSON sites are reached through the public `findMany`, after a test-only
 * edit of the shared operator tables that makes the validators and the
 * generator disagree, which is exactly the drift the checks exist to catch.
 *
 * Run: npx tsx --test src/test/powql-invariants.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INVARIANT_REPORT_HINT, InvariantError } from '../errors.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { JSON_FILTER_KEYS, JSON_STRING_OPERATORS } from '../query/filters.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';

// biome-ignore lint/suspicious/noExplicitAny: the cases drive private members and hostile shapes.
type Any = any;

const schema = schemaDefToMetadata(
  defineSchema({
    docs: {
      id: { type: 'serial', primaryKey: true },
      title: { type: 'text', notNull: true },
      meta: { type: 'jsonb' },
    },
    comments: {
      id: { type: 'serial', primaryKey: true },
      docId: { type: 'integer', notNull: true },
    },
  }),
);
// A declared relation, so `comments` is a relation key rather than an unknown column.
schema.tables.docs!.relations.comments = {
  type: 'hasMany',
  name: 'comments',
  from: 'docs',
  to: 'comments',
  foreignKey: 'doc_id',
  referenceKey: 'id',
};

function qi() {
  const pool = {
    capabilities: capabilitiesFromVersion('0.20.0'),
    retryStaleReads: false,
    readonly: false,
    query: () => Promise.resolve({ rows: [], rowCount: 0 }),
  } as unknown as PowdbPool;
  return new PowqlInterface<Record<string, unknown>>(pool, 'docs', schema, [], { warnOnUnlimited: false });
}

/** Assert `fn` throws an InvariantError with this id, the E020 code, and the report hint exactly once. */
function assertInvariant(err: unknown, invariant: string): asserts err is InvariantError {
  assert.ok(err instanceof InvariantError, `expected InvariantError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E020');
  assert.equal(err.invariant, invariant);
  assert.equal(err.message.split(INVARIANT_REPORT_HINT).length - 1, 1, 'the report hint appears exactly once');
  assert.doesNotMatch(err.message, /internal:/i, 'no hand-written "internal:" prefix');
}

describe('PowQL generator contract breaks are InvariantError', () => {
  it('a relation filter reaching buildWhere unresolved is powql-relation-filter-unresolved', () => {
    assert.throws(
      () => (qi() as Any).buildWhere({ comments: { some: { id: 1 } } }, []),
      (err: unknown) => {
        assertInvariant(err, 'powql-relation-filter-unresolved');
        assert.match(err.message, /relation filter "comments" reached buildWhere unresolved/);
        assert.match(err.message, /resolveRelationFilters\(\) must run first/);
        return true;
      },
    );
  });

  it('the public findMany resolves the same relation filter instead of tripping the check', async () => {
    // The guard above is the only thing between a skipped resolve step and a
    // relation key in the emitted filter; the public path never reaches it.
    await assert.doesNotReject(() => qi().findMany({ where: { comments: { some: { id: 1 } } } } as Any));
  });

  it('a JSON string operator the generator has no spelling for is powql-json-operator', async () => {
    const operators = JSON_STRING_OPERATORS as Record<string, (escaped: string) => string>;
    const keys = JSON_FILTER_KEYS as Set<string>;
    operators.stringRegex = (escaped) => escaped;
    keys.add('stringRegex');
    try {
      await assert.rejects(
        () => qi().findMany({ where: { meta: { path: ['title'], stringRegex: 'x' } } } as Any),
        (err: unknown) => {
          assertInvariant(err, 'powql-json-operator');
          assert.match(err.message, /unknown JSON string operator "stringRegex" on "meta"/);
          return true;
        },
      );
    } finally {
      delete operators.stringRegex;
      keys.delete('stringRegex');
    }
    assert.ok(!('stringRegex' in JSON_STRING_OPERATORS), 'the shared table is restored');
    assert.ok(!JSON_FILTER_KEYS.has('stringRegex'), 'the shared key set is restored');
  });

  it('a JSON filter that passes validation but compiles to nothing is powql-json-filter-empty', async () => {
    const keys = JSON_FILTER_KEYS as Set<string>;
    keys.add('stringRegex');
    try {
      await assert.rejects(
        () => qi().findMany({ where: { meta: { path: ['title'], stringRegex: 'x' } } } as Any),
        (err: unknown) => {
          assertInvariant(err, 'powql-json-filter-empty');
          assert.match(err.message, /JSON filter on "meta" compiled to no condition/);
          return true;
        },
      );
    } finally {
      keys.delete('stringRegex');
    }
    assert.ok(!JSON_FILTER_KEYS.has('stringRegex'), 'the shared key set is restored');
  });

  it('with the tables untouched the same filter is refused as an unknown operator (a user error, E003)', async () => {
    await assert.rejects(
      () => qi().findMany({ where: { meta: { path: ['title'], stringRegex: 'x' } } } as Any),
      (err: unknown) => {
        assert.ok(!(err instanceof InvariantError), 'a caller-visible mistake is not an invariant');
        assert.equal((err as { code?: string }).code, 'TURBINE_E003');
        return true;
      },
    );
  });
});

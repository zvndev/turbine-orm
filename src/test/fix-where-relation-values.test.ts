/**
 * A relation filter's quantifier takes a where object. `some: null`,
 * `none: 5`, `every: []` and `is: 'x'` used to compile to no predicate at all,
 * so the filter vanished and the query read (or, in `deleteMany`, wrote) every
 * row. They are E003 now, at every depth, in every where a query compiles
 * (top level, combinators, nested relations, a `with` relation's `where`, a
 * global filter), on the build and on the cache-hit param collect, and on
 * PowDB. `is: null` / `isNot: null` keep their meaning; `some: {}` and
 * `none: {}` still mean "has a related row" / "has none".
 *
 * Live checks are in fix-where-live.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { mysqlDialect } from '../mysql.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import type { QueryInterfaceOptions } from '../query/deferred.js';
import { UNSAFE } from '../query/types.js';
import { relationFilterValueProblem } from '../query/where-compile.js';
import { sqliteDialect } from '../sqlite.js';
import { fixWhereSchema } from './fix-where-engines.js';
import { makeQuery } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only harness calls
type Any = any;

const SCHEMA = fixWhereSchema();

function users(options: QueryInterfaceOptions = {}): Any {
  return makeQuery('fw_users', SCHEMA, { warnOnUnlimited: false, ...options });
}

function refused(run: () => unknown, message: RegExp, label: string): void {
  assert.throws(run, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `${label}: expected ValidationError, got ${String(err)}`);
    assert.match(err.message, message, label);
    return true;
  });
}

/** Wrapper, value, and the words the refusal must contain. */
const BAD_VALUES: [string, unknown, RegExp][] = [
  ['some', null, /`some` takes a where object, got null; `some: \{\}` matches rows with a related row/],
  ['none', null, /`none` takes a where object, got null/],
  ['every', null, /`every` takes a where object, got null/],
  ['some', 5, /`some` takes a where object, got a number/],
  ['none', 'x', /`none` takes a where object, got a string/],
  ['every', [], /`every` takes a where object, got an array/],
  ['some', [{ title: 'p1' }], /`some` takes a where object, got an array/],
  ['every', true, /`every` takes a where object, got a boolean/],
];

describe('relation quantifier values: refused', () => {
  /** Every place a relation filter can sit in a findMany. */
  const positions: [string, (rf: Record<string, unknown>) => Record<string, unknown>][] = [
    ['top level', (rf) => ({ where: { posts: rf } })],
    ['inside AND', (rf) => ({ where: { AND: [{ id: 1 }, { posts: rf }] } })],
    ['inside OR', (rf) => ({ where: { OR: [{ id: 1 }, { posts: rf }] } })],
    ['inside NOT', (rf) => ({ where: { NOT: { posts: rf } } })],
    ['one relation down', (rf) => ({ where: { posts: { some: { author: { is: { posts: rf } } } } } })],
    ['in a with relation where', (rf) => ({ with: { posts: { where: { author: { is: { posts: rf } } } } } })],
  ];
  for (const [wrapper, value, message] of BAD_VALUES) {
    for (const [where, args] of positions) {
      it(`${wrapper}: ${JSON.stringify(value)} ${where}`, () => {
        refused(() => users().buildFindMany(args({ [wrapper]: value })), message, `${wrapper} ${where}`);
      });
    }
  }

  it('is refused on every operation that takes a where', () => {
    const where = { posts: { some: null } };
    const q = users();
    const message = /`some` takes a where object, got null/;
    refused(() => q.buildCount({ where }), message, 'count');
    refused(() => q.buildFindFirst({ where }), message, 'findFirst');
    refused(() => q.buildAggregate({ where, _count: true }), message, 'aggregate');
    refused(() => q.buildGroupBy({ by: ['tenant'], where, _count: true }), message, 'groupBy');
    refused(() => q.buildUpdateMany({ where, data: { name: 'x' } }), message, 'updateMany');
    refused(() => q.buildDeleteMany({ where }), message, 'deleteMany');
    // Under the full-table opt-in too: the where is wrong, not merely empty.
    refused(() => q.buildDeleteMany({ where, allowFullTableScan: UNSAFE }), message, 'deleteMany opt-in');
  });

  it('is refused on the cache-hit path after the same shape was warmed with a where object', () => {
    const q = users();
    q.buildFindMany({ where: { posts: { some: { title: 'p1' } } } });
    q.buildFindMany({ where: { posts: { some: { title: 'p1' } } } });
    refused(() => q.buildFindMany({ where: { posts: { some: null } } }), /got null/, 'after warm');
    // And the warmed shape still works afterwards.
    assert.match(q.buildFindMany({ where: { posts: { some: { title: 'p2' } } } }).sql, /EXISTS/);
  });

  it('is refused on SQLite and MySQL builds too', () => {
    for (const dialect of [sqliteDialect, mysqlDialect]) {
      refused(
        () => users({ dialect }).buildFindMany({ where: { posts: { none: null } } }),
        /`none` takes a where object, got null/,
        dialect.name,
      );
    }
  });

  it('is refused when a global filter returns it, static or function', () => {
    const message = /`some` takes a where object, got null/;
    const asStatic = users({ globalFilters: { fw_users: { posts: { some: null } } } as Any });
    refused(() => asStatic.buildFindMany({ where: { id: 1 } }), message, 'static filter');
    const asFunction = users({ globalFilters: { fw_users: () => ({ posts: { some: null } }) } as Any });
    refused(() => asFunction.buildFindMany({}), message, 'function filter');
  });
});

describe('to-one relation values', () => {
  it('is: null and isNot: null keep their meaning', () => {
    const q = makeQuery('fw_posts', SCHEMA, { warnOnUnlimited: false }) as Any;
    assert.match(q.buildFindMany({ where: { author: { is: null } } }).sql, /NOT EXISTS/);
    assert.match(q.buildFindMany({ where: { author: { isNot: null } } }).sql, /WHERE EXISTS/);
  });

  for (const [wrapper, value, kind] of [
    ['is', 5, 'a number'],
    ['isNot', 'x', 'a string'],
    ['is', [], 'an array'],
    ['isNot', false, 'a boolean'],
  ] as const) {
    it(`${wrapper}: ${JSON.stringify(value)} is refused`, () => {
      const q = makeQuery('fw_posts', SCHEMA, { warnOnUnlimited: false }) as Any;
      refused(
        () => q.buildFindMany({ where: { author: { [wrapper]: value } } }),
        new RegExp(`\`${wrapper}\` takes a where object or null, got ${kind}`),
        wrapper,
      );
    });
  }
});

describe('empty quantifiers are unchanged', () => {
  it('some: {} is "has a related row" and none: {} is "has none"', () => {
    const q = users();
    assert.equal(
      q.buildFindMany({ where: { posts: { some: {} } } }).sql,
      'SELECT "fw_users".* FROM "fw_users" WHERE EXISTS (SELECT 1 FROM "fw_posts" WHERE "fw_posts"."user_id" = "fw_users"."id")',
    );
    assert.equal(
      q.buildFindMany({ where: { posts: { none: {} } } }).sql,
      'SELECT "fw_users".* FROM "fw_users" WHERE NOT EXISTS (SELECT 1 FROM "fw_posts" WHERE "fw_posts"."user_id" = "fw_users"."id")',
    );
  });

  it('the rule itself: what each wrapper accepts', () => {
    assert.equal(relationFilterValueProblem('some', {}), null);
    assert.equal(relationFilterValueProblem('every', { title: 'x' }), null);
    assert.equal(relationFilterValueProblem('is', null), null);
    assert.equal(relationFilterValueProblem('isNot', null), null);
    assert.equal(relationFilterValueProblem('some', undefined), null, 'an absent wrapper is not a problem');
    assert.match(String(relationFilterValueProblem('none', null)), /got null/);
    assert.match(String(relationFilterValueProblem('is', 3)), /got a number/);
  });
});

describe('PowDB: relation quantifier values', () => {
  function powql(): { qi: () => Any; calls: string[] } {
    const calls: string[] = [];
    const pool = {
      capabilities: capabilitiesFromVersion('0.18.0'),
      retryStaleReads: false,
      readonly: false,
      query(text: string) {
        calls.push(text);
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as PowdbPool;
    return { calls, qi: () => new PowqlInterface(pool, 'fw_users', SCHEMA, [], { warnOnUnlimited: false }) };
  }

  for (const [wrapper, value, message] of BAD_VALUES) {
    it(`${wrapper}: ${JSON.stringify(value)} is refused before any statement runs`, async () => {
      const { qi, calls } = powql();
      await assert.rejects(qi().findMany({ where: { posts: { [wrapper]: value } } }), (err: unknown) => {
        assert.ok(err instanceof ValidationError, String(err));
        assert.match(err.message, message);
        return true;
      });
      assert.deepEqual(calls, [], 'no statement ran');
    });
  }

  it('deleteMany with some: null is refused, even under the full-table opt-in', async () => {
    const { qi, calls } = powql();
    await assert.rejects(
      qi().deleteMany({ where: { posts: { some: null } }, allowFullTableScan: UNSAFE }),
      /`some` takes a where object, got null/,
    );
    assert.deepEqual(calls, []);
  });
});

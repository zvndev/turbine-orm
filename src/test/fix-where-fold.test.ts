/**
 * The mass-mutation guard refuses a `where` that is TRUE for every row, not
 * only one that compiles to nothing. `NOT: { OR: [] }` compiles to
 * `NOT (id = ANY('{}'))` and `{ id: { notIn: [] } }` to `id != ALL('{}')`:
 * each has SQL, so a guard asking "is there a WHERE" let them through, and a
 * `deleteMany` written with them deleted the table. `foldWhere` reads the same
 * events the compiler reads and reports whether the user's where is empty,
 * always true, always false, or depends on the row; the guard refuses the
 * first two. The same rule runs on every SQL dialect and on PowDB.
 *
 * Only the USER's where is folded: a global filter never turns an unguarded
 * mass mutation into an allowed one (it never did).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { UNSAFE } from '../query/types.js';
import { foldWhereFor } from '../query/where-compile.js';
import { sqliteDialect } from '../sqlite.js';
import { fixWhereSchema } from './fix-where-engines.js';
import { makeQuery } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only harness calls
type Any = any;

const SCHEMA = fixWhereSchema();

/** [table, where, fold]. */
const FOLDS: [string, Record<string, unknown>, 'empty' | 'true' | 'false' | 'row'][] = [
  ['fw_users', {}, 'empty'],
  ['fw_users', { id: undefined }, 'empty'],
  ['fw_users', { AND: [] }, 'empty'],
  ['fw_users', { NOT: {} }, 'empty'],
  ['fw_users', { NOT: { OR: [] } }, 'true'],
  ['fw_users', { OR: [] }, 'false'],
  ['fw_users', { id: { in: [] } }, 'false'],
  ['fw_users', { id: { notIn: [] } }, 'true'],
  ['fw_users', { name: { notIn: [] } }, 'true'],
  ['fw_users', { id: { not: { in: [] } } }, 'true'],
  ['fw_users', { id: { not: { notIn: [] } } }, 'false'],
  ['fw_users', { id: { notIn: [], gt: 5 } }, 'row'],
  ['fw_users', { NOT: { id: { in: [] } } }, 'true'],
  ['fw_users', { NOT: { NOT: { OR: [] } } }, 'false'],
  ['fw_users', { NOT: [{ OR: [] }] }, 'true'],
  ['fw_users', { NOT: [{ OR: [] }, { id: 2 }] }, 'row'],
  ['fw_users', { OR: [{ NOT: { OR: [] } }, { id: 1 }] }, 'true'],
  ['fw_users', { AND: [{ NOT: { OR: [] } }, { id: 1 }] }, 'row'],
  ['fw_users', { AND: [{ OR: [] }, { id: 1 }] }, 'false'],
  // A branch that applies no condition is TRUE for every row, so the OR is TRUE.
  ['fw_users', { OR: [{}, { id: 1 }] }, 'true'],
  ['fw_users', { NOT: { OR: [{}, { id: 1 }] } }, 'false'],
  ['fw_users', { id: 1 }, 'row'],
  ['fw_users', { score: { not: null } }, 'row'],
  ['fw_users', { data: { not: { equals: { a: 1 } } } }, 'row'],
  ['fw_users', { posts: { some: {} } }, 'row'],
  ['fw_users', { posts: { none: {} } }, 'row'],
  ['fw_users', { posts: { some: { OR: [] } } }, 'false'],
  ['fw_users', { posts: { none: { OR: [] } } }, 'true'],
  ['fw_users', { posts: { every: {} } }, 'empty'],
  ['fw_users', { posts: { every: { NOT: { OR: [] } } } }, 'true'],
  ['fw_users', { posts: { every: { OR: [] } } }, 'row'],
  ['fw_posts', { author: { is: { OR: [] } } }, 'false'],
  ['fw_posts', { author: { isNot: { OR: [] } } }, 'true'],
  ['fw_posts', { author: { is: null } }, 'row'],
  ['fw_posts', { author: { is: { posts: { none: { id: { in: [] } } } } } }, 'row'],
];

describe('foldWhere', () => {
  for (const [table, where, fold] of FOLDS) {
    it(`${table} ${JSON.stringify(where)} is ${fold}`, () => {
      assert.equal(foldWhereFor(SCHEMA.tables, table, where), fold);
    });
  }

  it('an always-false or row-dependent where compiles exactly as before (the fold adds no SQL)', () => {
    const q = makeQuery('fw_users', SCHEMA, { warnOnUnlimited: false }) as Any;
    const empty = q.buildDeleteMany({ where: { OR: [] } });
    assert.equal(empty.sql, 'DELETE FROM "fw_users" WHERE "id" = ANY($1)');
    assert.deepEqual(empty.params, [[]]);
    const mixed = q.buildDeleteMany({ where: { id: 1, name: { notIn: [] } } });
    assert.equal(mixed.sql, 'DELETE FROM "fw_users" WHERE "id" = $1 AND "name" != ALL($2)');
    assert.deepEqual(mixed.params, [1, []]);
  });
});

const ALWAYS_TRUE: Record<string, unknown>[] = [
  { NOT: { OR: [] } },
  { id: { notIn: [] } },
  { NOT: { id: { in: [] } } },
  { OR: [{ NOT: { OR: [] } }, { id: 1 }] },
  { posts: { none: { OR: [] } } },
  { posts: { every: { NOT: { OR: [] } } } },
];

const GUARD = /refused: the `where` clause is empty or always true .*allowFullTableScan: UNSAFE/;

function refused(run: () => unknown, label: string): void {
  assert.throws(run, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `${label}: expected ValidationError, got ${String(err)}`);
    assert.match(err.message, GUARD, label);
    return true;
  });
}

describe('mass-mutation guard: always-true wheres', () => {
  const dialects: [string, Dialect | undefined][] = [
    ['postgresql', undefined],
    ['sqlite', sqliteDialect],
    ['mysql', mysqlDialect],
    ['mssql', mssqlDialect],
  ];
  for (const [name, dialect] of dialects) {
    for (const where of ALWAYS_TRUE) {
      it(`${name}: ${JSON.stringify(where)} is refused on every mutation`, () => {
        const q = makeQuery('fw_users', SCHEMA, { warnOnUnlimited: false, ...(dialect ? { dialect } : {}) }) as Any;
        refused(() => q.buildUpdateMany({ where, data: { name: 'x' } }), `${name} updateMany`);
        refused(() => q.buildDeleteMany({ where }), `${name} deleteMany`);
        refused(() => q.buildUpdate({ where, data: { name: 'x' } }), `${name} update`);
        refused(() => q.buildDelete({ where }), `${name} delete`);
      });
    }
  }

  it('the message names the operation and table', () => {
    const q = makeQuery('fw_users', SCHEMA, { warnOnUnlimited: false }) as Any;
    assert.throws(() => q.buildDeleteMany({ where: { id: { notIn: [] } } }), /^.*deleteMany on "fw_users" refused/);
  });

  it('allowFullTableScan: UNSAFE lets the bulk statements through unchanged', () => {
    const q = makeQuery('fw_users', SCHEMA, { warnOnUnlimited: false }) as Any;
    const d = q.buildDeleteMany({ where: { id: { notIn: [] } }, allowFullTableScan: UNSAFE });
    assert.equal(d.sql, 'DELETE FROM "fw_users" WHERE "id" != ALL($1)');
    const u = q.buildUpdateMany({ where: { NOT: { OR: [] } }, data: { name: 'x' }, allowFullTableScan: UNSAFE });
    assert.match(u.sql, /^UPDATE "fw_users" SET "name" = \$1 WHERE NOT \("id" = ANY\(\$2\)\)/);
  });

  it('a global filter does not make an always-true user where acceptable', () => {
    const q = makeQuery('fw_users', SCHEMA, {
      warnOnUnlimited: false,
      globalFilters: { fw_users: { tenant: 1 } } as Any,
    }) as Any;
    refused(() => q.buildDeleteMany({ where: { NOT: { OR: [] } } }), 'with a global filter');
  });

  it('reads are not guarded: count and findMany still accept an always-true where', () => {
    const q = makeQuery('fw_users', SCHEMA, { warnOnUnlimited: false }) as Any;
    assert.match(q.buildCount({ where: { id: { notIn: [] } } }).sql, /WHERE "id" != ALL\(\$1\)/);
    assert.match(q.buildFindMany({ where: { NOT: { OR: [] } } }).sql, /WHERE NOT \("id" = ANY\(\$1\)\)/);
  });
});

describe('PowDB: mass-mutation guard', () => {
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

  for (const where of ALWAYS_TRUE) {
    it(`${JSON.stringify(where)} is refused before any write runs`, async () => {
      const { qi, calls } = powql();
      for (const [op, args] of [
        ['updateMany', { where, data: { name: 'x' } }],
        ['deleteMany', { where }],
        ['update', { where, data: { name: 'x' } }],
        ['delete', { where }],
      ] as const) {
        await assert.rejects(qi()[op](args), (err: unknown) => {
          assert.ok(err instanceof ValidationError, `${op}: ${String(err)}`);
          assert.match(err.message, GUARD, op);
          return true;
        });
      }
      // A relation filter is resolved by reading the child table first; the
      // refusal comes before anything is written.
      const writes = calls.filter((c) => /\b(update|delete)\b/.test(c));
      assert.deepEqual(writes, [], 'no write ran');
    });
  }

  it('allowFullTableScan: UNSAFE runs the bulk statement', async () => {
    const { qi, calls } = powql();
    await qi().deleteMany({ where: { id: { notIn: [] } }, allowFullTableScan: UNSAFE });
    assert.equal(calls.length > 0, true, 'the delete ran');
  });
});

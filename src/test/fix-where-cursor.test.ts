/**
 * `cursor` names the row a page starts after. A cursor that names no row used
 * to be read as "no cursor": `cursor: null` and `cursor: {}` returned the first
 * page, ordered WITHOUT the tiebreaker every later page used, so a pager
 * written as `cursor: last ? { id: last.id } : {}` skipped rows at the first
 * boundary. They are E003 now, as are a cursor whose every field is
 * `undefined` (it would restart the walk forever), NULL on a NOT NULL column
 * (no row holds it), and a filter operator where a value belongs.
 *
 * Also pinned: a `findFirst` with an `offset` is a page and gets the
 * tiebreaker, an order by vector distance gets none (it would defeat the KNN
 * index), and the prisma-compat adapter passes a non-object or all-undefined
 * cursor through to the same refusals. Live walks are in
 * fix-where-live.test.ts.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { type CompatTurbineClient, createPrismaCompatClient } from '../prisma-compat.js';
import { col } from '../query/column-ref.js';
import { hasCursor } from '../query/normalize-args.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { fixWhereSchema } from './fix-where-engines.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only harness calls
type Any = any;

const SCHEMA = fixWhereSchema();
const users = (): Any => makeQuery('fw_users', SCHEMA, { warnOnUnlimited: false });

function refused(run: () => unknown, message: RegExp, label: string): void {
  assert.throws(run, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `${label}: expected ValidationError, got ${String(err)}`);
    assert.match(err.message, message, label);
    return true;
  });
}

const NOT_AN_OBJECT = /`cursor` takes an object naming the row to page after .*received /;
const NAMES_NO_ROW = /`cursor: \{\}` names no row\. Leave `cursor` out for the first page/;
const ALL_UNDEFINED = /every field of `cursor` was undefined, so the page would restart at the first row/;
const NOT_NULL = /Invalid `cursor` field "(id|name)" on table "fw_users": null\. "\1" is NOT NULL/;
const NOT_A_VALUE = /A cursor value is the value the last row holds in "id" .*To filter rows, use `where`/;

/** Cursor shapes that name no row, with the refusal each gets. */
const BAD_CURSORS: [string, unknown, RegExp][] = [
  ['null', null, NOT_AN_OBJECT],
  ['a number', 5, NOT_AN_OBJECT],
  ['a string', 'x', NOT_AN_OBJECT],
  ['an array', [], NOT_AN_OBJECT],
  ['{}', {}, NAMES_NO_ROW],
  ['every field undefined', { id: undefined }, ALL_UNDEFINED],
  ['null on the primary key', { id: null }, NOT_NULL],
  ['null on a NOT NULL column', { name: null, id: 1 }, NOT_NULL],
  ['a filter operator', { id: { gt: 5 } }, NOT_A_VALUE],
  ['a column reference', { id: col('id') }, NOT_A_VALUE],
  ['an array value', { id: [1] }, NOT_A_VALUE],
];

describe('cursor: shapes that name no row are refused', () => {
  for (const [label, cursor, message] of BAD_CURSORS) {
    it(label, () => {
      refused(() => users().buildFindMany({ cursor, orderBy: { id: 'asc' }, limit: 2 }), message, label);
    });
  }

  it('the refusal names the operation and table', () => {
    refused(() => users().buildFindMany({ cursor: null, limit: 2 }), /^.*findMany on "fw_users" refused/, 'null');
  });

  it('accepted: a bare value, an equals wrapper, and NULL on a nullable column', () => {
    const bare = users().buildFindMany({ cursor: { id: 5 }, orderBy: { id: 'asc' }, limit: 2 });
    const wrapped = users().buildFindMany({ cursor: { id: { equals: 5 } }, orderBy: { id: 'asc' }, limit: 2 });
    assert.equal(wrapped.sql, bare.sql);
    assert.deepEqual(wrapped.params, bare.params);
    assert.equal(bare.sql, 'SELECT "fw_users".* FROM "fw_users" WHERE "fw_users"."id" > $1 ORDER BY "id" ASC LIMIT $2');
    const nullable = users().buildFindMany({ cursor: { score: null, id: 2 }, orderBy: { score: 'asc' }, limit: 2 });
    assert.match(nullable.sql, /WHERE \("fw_users"\."score" IS NULL AND "fw_users"\."id" > \$1\)/);
  });

  it('hasCursor: only a plain object with a defined value is a cursor', () => {
    assert.equal(hasCursor({ id: 1 }), true);
    assert.equal(hasCursor({ id: undefined, name: 'a' }), true);
    for (const value of [undefined, null, {}, { id: undefined }, [], 5]) assert.equal(hasCursor(value), false);
  });
});

describe('page order', () => {
  it('the first page is ordered the way the cursor pages are', () => {
    const first = users().buildFindMany({ orderBy: { score: 'asc' }, limit: 2 });
    assert.equal(first.sql, 'SELECT "fw_users".* FROM "fw_users" ORDER BY "score" ASC, "id" ASC LIMIT $1');
    const next = users().buildFindMany({ orderBy: { score: 'asc' }, limit: 2, cursor: { id: 2 } });
    // PostgreSQL sorts NULL last ascending, so the written-out placement is the same order.
    assert.match(next.sql, /ORDER BY "score" ASC NULLS LAST, "id" ASC LIMIT \$2$/);
  });

  it('findFirst with an offset is a page and gets the tiebreaker; without one it does not', () => {
    const paged = users().buildFindFirst({ orderBy: { tenant: 'asc' }, offset: 1 });
    assert.equal(paged.sql, 'SELECT "fw_users".* FROM "fw_users" ORDER BY "tenant" ASC, "id" ASC LIMIT $1 OFFSET $2');
    const first = users().buildFindFirst({ orderBy: { tenant: 'asc' } });
    assert.equal(first.sql, 'SELECT "fw_users".* FROM "fw_users" ORDER BY "tenant" ASC LIMIT $1');
  });

  it('an order by vector distance gets no tiebreaker, alone or after a column', () => {
    const items = mockTable('items', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'tenant', field: 'tenant', pgType: 'int4' },
      { name: 'embedding', field: 'embedding', pgType: 'vector' },
    ]);
    const q = makeQuery('items', { enums: {}, tables: { items } } as SchemaMetadata, { warnOnUnlimited: false }) as Any;
    const distance = { distance: { to: [1, 2, 3], metric: 'l2' } };
    const knn = q.buildFindMany({ orderBy: { embedding: distance }, limit: 5 });
    assert.doesNotMatch(knn.sql, /"id" ASC/, knn.sql);
    assert.match(knn.sql, /<->/);
    const mixed = q.buildFindMany({ orderBy: [{ tenant: 'asc' }, { embedding: distance }], limit: 5 });
    assert.doesNotMatch(mixed.sql, /"id" ASC/, mixed.sql);
  });
});

describe('PowDB: cursor', () => {
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

  for (const [label, cursor, message] of BAD_CURSORS) {
    it(`${label} is refused`, async () => {
      const { qi, calls } = powql();
      await assert.rejects(qi().findMany({ cursor, orderBy: { id: 'asc' }, limit: 2 }), (err: unknown) => {
        assert.ok(err instanceof ValidationError, String(err));
        assert.match(err.message, message);
        return true;
      });
      assert.deepEqual(calls, []);
    });
  }

  it('findFirst with an offset gets the tiebreaker; without one it does not', async () => {
    const { qi, calls } = powql();
    await qi().findFirst({ orderBy: { tenant: 'asc' }, offset: 1 });
    await qi().findFirst({ orderBy: { tenant: 'asc' } });
    assert.match(calls[0] ?? '', /order \.tenant asc, \.id asc limit \$1 offset \$2/);
    assert.match(calls[1] ?? '', /order \.tenant asc limit \$1 \{/);
  });
});

describe('prisma-compat: cursor', () => {
  function compat(): Any {
    const posts = mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
    ]);
    posts.uniqueColumns = [['id']];
    const schema: SchemaMetadata = { enums: {}, tables: { posts } };
    const map: PrismaCompatMap = {
      enums: {},
      models: {
        Post: {
          table: 'posts',
          accessor: 'posts',
          fields: { id: 'id', title: 'title' },
          relations: {},
          compoundUniques: {},
        },
      },
    };
    const db = {
      schema,
      table: (name: string) => makeQuery(name, schema, { warnOnUnlimited: false }) as Any,
      $transaction: (() => {
        throw new Error('no execution path');
      }) as Any,
    } as unknown as CompatTurbineClient;
    return createPrismaCompatClient(db as unknown as TurbineClient, map);
  }

  /** Build the SQL a lazy delegate call would run, without executing it. */
  function build(promise: unknown): { sql: string; params: unknown[] } {
    const deferred = (promise as Any)[Object.getOwnPropertySymbols(promise as object)[0] as symbol];
    return deferred.build();
  }

  for (const [label, cursor, message] of [
    ['null', null, NOT_AN_OBJECT],
    ['every field undefined', { id: undefined }, ALL_UNDEFINED],
  ] as const) {
    it(`${label} is refused, not read as the first page`, () => {
      assert.throws(
        () => build(compat().Post.findMany({ cursor, take: 2 })),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, String(err));
          assert.match(err.message, message);
          return true;
        },
      );
    });
  }

  it('a defined cursor still pages inclusively from the named row', () => {
    const { sql, params } = build(compat().Post.findMany({ cursor: { id: 7 }, take: 2 }));
    assert.match(sql, /"posts"\."id" >= /);
    assert.deepEqual(params, [7, 2]);
  });
});

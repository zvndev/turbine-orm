/**
 * A `Date` compared with a `date` column binds its UTC date part
 * (`YYYY-MM-DD`) on every SQL engine, the value the write path stores. It used
 * to be rewritten on PostgreSQL only, so on SQLite the operand went out as a
 * full ISO timestamp and `birthday: someDate` matched nothing against a column
 * holding `2000-02-29`, and on MySQL a Date with a time of day never equalled
 * its own day.
 *
 * A zone-less `timestamp` keeps the rewrite on PostgreSQL only (MySQL reads a
 * zone-less literal in the session time zone), and `utcTimestamps: false`
 * turns both off, as on the write path.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { QueryInterfaceOptions } from '../query/deferred.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { HAVE_NODE_SQLITE } from './fix-where-engines.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: build-only harness calls
type Any = any;

/** `birthday` as `dateType` (introspected SQLite spells it `DATE`), `at` a zone-less timestamp. */
function schema(dateType = 'date'): SchemaMetadata {
  const t = mockTable('fw_events', [
    { name: 'id', field: 'id', pgType: 'int4' },
    { name: 'birthday', field: 'birthday', pgType: dateType },
    { name: 'at', field: 'at', pgType: 'timestamp' },
  ]);
  for (const c of t.columns) if (c.name !== 'id') c.nullable = true;
  return { enums: {}, tables: { fw_events: t } };
}

function events(dialect: Dialect | undefined, options: QueryInterfaceOptions = {}, dateType = 'date'): Any {
  return makeQuery('fw_events', schema(dateType), {
    warnOnUnlimited: false,
    ...(dialect ? { dialect } : {}),
    ...options,
  });
}

const LATE = new Date('1999-12-31T23:59:59.999Z');
const LEAP = new Date('2000-02-29T00:00:00.000Z');

const DIALECTS: [string, Dialect | undefined][] = [
  ['postgresql', undefined],
  ['sqlite', sqliteDialect],
  ['mysql', mysqlDialect],
  ['mssql', mssqlDialect],
];

describe('a Date against a date column binds its UTC date part', () => {
  for (const [name, dialect] of DIALECTS) {
    it(`${name}: equality, operators and lists, on the build and on a cache hit`, () => {
      const q = events(dialect);
      assert.deepEqual(q.buildFindMany({ where: { birthday: LATE } }).params, ['1999-12-31']);
      // Same shape again: the cache-hit collect rewrites the same way.
      assert.deepEqual(q.buildFindMany({ where: { birthday: LEAP } }).params, ['2000-02-29']);
      assert.deepEqual(q.buildFindMany({ where: { birthday: { lt: LATE } } }).params, ['1999-12-31']);
      // Engines differ in how a list binds (an array, a JSON array, one param each).
      const list = (q.buildFindMany({ where: { birthday: { in: [LATE, LEAP] } } }).params as unknown[]).flatMap((p) =>
        typeof p === 'string' && p.startsWith('[') ? JSON.parse(p) : p,
      );
      assert.deepEqual(list, ['1999-12-31', '2000-02-29']);
    });
  }

  it('the introspected SQLite spelling DATE is a date column', () => {
    const q = events(sqliteDialect, {}, 'DATE');
    assert.deepEqual(q.buildFindMany({ where: { birthday: LATE } }).params, ['1999-12-31']);
  });

  it('a string operand is bound as written', () => {
    const q = events(sqliteDialect);
    assert.deepEqual(q.buildFindMany({ where: { birthday: '2000-02-29' } }).params, ['2000-02-29']);
  });
});

describe('what keeps its old binding', () => {
  it('a zone-less timestamp is rewritten on PostgreSQL only', () => {
    assert.deepEqual(events(undefined).buildFindMany({ where: { at: LATE } }).params, ['1999-12-31 23:59:59.999']);
    for (const dialect of [sqliteDialect, mysqlDialect, mssqlDialect]) {
      const [bound] = events(dialect).buildFindMany({ where: { at: LATE } }).params;
      assert.ok(bound instanceof Date, `${dialect.name}: expected the Date itself, got ${String(bound)}`);
    }
  });

  it('utcTimestamps: false leaves a Date on a date column alone, on every engine', () => {
    for (const [name, dialect] of DIALECTS) {
      const [bound] = events(dialect, { utcTimestamps: false }).buildFindMany({ where: { birthday: LATE } }).params;
      assert.ok(bound instanceof Date, `${name}: expected the Date itself, got ${String(bound)}`);
    }
  });
});

const { it: sqliteIt } = skipGate(!HAVE_NODE_SQLITE, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

describe('SQLite live: a Date finds the row holding its day', () => {
  sqliteIt('equality and in-lists match the stored YYYY-MM-DD text', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { turbineSqlite } = await import('../sqlite.js');
    const raw = new DatabaseSync(':memory:');
    raw.exec('CREATE TABLE fw_events (id INTEGER PRIMARY KEY, birthday DATE, at TEXT)');
    raw.exec("INSERT INTO fw_events (id, birthday) VALUES (1, '2000-02-29'), (2, '1999-12-31'), (3, NULL)");
    const db = turbineSqlite(raw, schema('DATE'), { warnOnUnlimited: false } as never);
    try {
      const ids = async (where: Record<string, unknown>): Promise<number[]> =>
        ((await db.table('fw_events').findMany({ where, orderBy: { id: 'asc' } })) as { id: number }[]).map((r) =>
          Number(r.id),
        );
      assert.deepEqual(await ids({ birthday: LEAP }), [1]);
      assert.deepEqual(await ids({ birthday: LATE }), [2]);
      assert.deepEqual(await ids({ birthday: { in: [LATE, LEAP] } }), [1, 2]);
      assert.deepEqual(await ids({ birthday: { not: LEAP } }), [2]);
    } finally {
      await db.disconnect();
    }
  });
});

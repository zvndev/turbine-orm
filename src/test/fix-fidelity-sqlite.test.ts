/**
 * SQLite value fidelity: the values a schema declares come back as the
 * declared JS type on every read path (top level, `with` under each relation
 * strategy, write returns, groupBy keys), the same values PostgreSQL returns.
 *
 * Tables are built by Turbine's own DDL (`schemaToSQL`), which stores a boolean
 * as INTEGER and a json column as TEXT, so the declared type lives only in the
 * schema metadata. That is the case the driver's declared-type check cannot see.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe } from 'node:test';
import type { TurbineClient } from '../client.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { skipGate } from './helpers.js';

const hasSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();
const {
  it: sqliteIt,
  before: sqliteBefore,
  after: sqliteAfter,
} = skipGate(!hasSqlite, 'requires node:sqlite (Node >= 22.5)');

/**
 * Decoding a column the schema declares needs the driver to name each result
 * column's origin (`StatementSync.columns()`). Older Node 22 builds lack it, and
 * there every path keeps the stored form, as the engine documents.
 */
const reportsOrigin = (() => {
  try {
    const sqlite = createRequire(process.cwd())('node:sqlite') as { StatementSync?: { prototype?: object } };
    return typeof (sqlite.StatementSync?.prototype as { columns?: unknown } | undefined)?.columns === 'function';
  } catch {
    return false;
  }
})();
const decodeIt = (name: string, fn: () => Promise<void>) =>
  reportsOrigin ? sqliteIt(name, fn) : sqliteIt(name, { skip: 'node:sqlite here has no StatementSync.columns()' }, fn);

const DEF = defineSchema({
  ff_teams: {
    id: { type: 'integer', primaryKey: true },
    name: { type: 'text', notNull: true },
  },
  ff_members: {
    id: { type: 'integer', primaryKey: true },
    teamId: { type: 'integer', notNull: true, references: 'ff_teams.id' },
    active: { type: 'boolean', notNull: true },
    prefs: { type: 'json' },
    points: { type: 'integer', notNull: true },
    label: { type: 'text' },
    ratio: { type: 'double' },
    amount: { type: 'numeric' },
  },
} as never);
const SCHEMA = schemaDefToMetadata(DEF);

// biome-ignore lint/suspicious/noExplicitAny: tables are driven by name, with no generated types
type Db = TurbineClient & Record<string, any>;

describe('sqlite value fidelity (schema-declared types)', () => {
  let db: Db;
  // biome-ignore lint/suspicious/noExplicitAny: tables are driven by name, with no generated types
  const tbl = (name: string): any => db.table(name);

  sqliteBefore(async () => {
    const { turbineSqlite } = await import('../sqlite.js');
    const { sqliteDialect } = await import('../sqlite.js');
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec(sql: string): void };
    };
    const raw = new DatabaseSync(':memory:');
    for (const sql of schemaToSQL(DEF, { dialect: sqliteDialect })) raw.exec(sql);
    db = turbineSqlite(raw as never, SCHEMA, { warnOnUnlimited: false }) as Db;
    await tbl('ff_teams').createMany({ data: [{ id: 1, name: 'a' }] });
    await tbl('ff_members').createMany({
      data: [
        { id: 1, teamId: 1, active: true, prefs: { theme: 'dark', tags: ['x'] }, points: 75, label: 'one' },
        { id: 2, teamId: 1, active: false, prefs: [1, 2], points: 10, label: null },
        { id: 3, teamId: 1, active: true, prefs: null, points: 3, label: 'three' },
      ],
    });
  });
  sqliteAfter(async () => {
    await db?.disconnect();
  });

  const expected = [
    { id: 1, active: true, prefs: { theme: 'dark', tags: ['x'] } },
    { id: 2, active: false, prefs: [1, 2] },
    { id: 3, active: true, prefs: null },
  ];

  decodeIt('a top-level read returns booleans and parsed JSON', async () => {
    const rows = await db
      .table('ff_members')
      .findMany({ select: { id: true, active: true, prefs: true }, orderBy: { id: 'asc' } });
    assert.deepEqual(rows, expected);
  });

  for (const strategy of ['join', 'batched', 'flatten'] as const) {
    decodeIt(`a nested read (${strategy}) returns the same values as the top-level read`, async () => {
      const teams = await tbl('ff_teams').findMany({
        relationLoadStrategy: strategy,
        jsonEncoding: 'object',
        with: { ffMembers: { select: { id: true, active: true, prefs: true }, orderBy: { id: 'asc' } } },
      });
      assert.deepEqual(teams[0].ffMembers, expected);
    });
  }

  decodeIt('a to-one nested read under flatten decodes like the top-level read', async () => {
    const members = await tbl('ff_members').findMany({
      relationLoadStrategy: 'flatten',
      jsonEncoding: 'object',
      orderBy: { id: 'asc' },
      select: { id: true, active: true },
      with: { ffTeam: true },
    });
    assert.deepEqual(
      members.map((m: { id: number; active: boolean }) => [m.id, m.active]),
      [
        [1, true],
        [2, false],
        [3, true],
      ],
    );
  });

  // `json_object` renders a REAL with 15 significant digits on the SQLite
  // that Node 22 and 24 bundle, so 0.1 + 0.2 came back 0.3 through a join.
  sqliteIt('a REAL or NUMERIC value reads back the same through a join as at the top level', async () => {
    const values = [
      [0.1 + 0.2, '12345678901234567890.123456789'],
      [-1 / 3, '100'],
      [Number.POSITIVE_INFINITY, '-7.5'],
      [1e-300, null],
    ] as const;
    for (const [i, [ratio, amount]] of values.entries()) {
      await tbl('ff_members').update({ where: { id: i + 1 > 3 ? 3 : i + 1 }, data: { ratio, amount } });
      const top = await tbl('ff_members').findUnique({
        where: { id: i + 1 > 3 ? 3 : i + 1 },
        select: { ratio: true, amount: true },
      });
      const [team] = await tbl('ff_teams').findMany({
        relationLoadStrategy: 'join',
        jsonEncoding: 'object',
        with: { ffMembers: { where: { id: i + 1 > 3 ? 3 : i + 1 }, select: { ratio: true, amount: true } } },
      });
      assert.deepEqual(team.ffMembers, [top], `value ${String(ratio)} / ${String(amount)}`);
      assert.equal(top.ratio, ratio);
    }
  });

  decodeIt('a write returns booleans and parsed JSON', async () => {
    const created = await tbl('ff_members').create({
      data: { id: 9, teamId: 1, active: false, prefs: { k: [true, null] }, points: 1, label: null },
    });
    assert.equal(created.active, false);
    assert.deepEqual(created.prefs, { k: [true, null] });
    const updated = await tbl('ff_members').update({ where: { id: 9 }, data: { active: true } });
    assert.equal(updated.active, true);
    await tbl('ff_members').delete({ where: { id: 9 } });
  });

  decodeIt('a groupBy key on a boolean column is a boolean', async () => {
    const groups = await tbl('ff_members').groupBy({ by: ['active'], _count: true, orderBy: { active: 'asc' } });
    assert.deepEqual(
      groups.map((g: { active: unknown; _count: number }) => [g.active, g._count]),
      [
        [false, 1],
        [true, 2],
      ],
    );
  });

  decodeIt('a raw query over a declared column decodes it too', async () => {
    const rows = await db.raw`SELECT "active", "prefs" FROM "ff_members" WHERE "id" = ${1}`;
    assert.deepEqual(rows, [{ active: true, prefs: { theme: 'dark', tags: ['x'] } }]);
  });

  sqliteIt('an integer divide truncates like PostgreSQL (75 / 2 = 37)', async () => {
    const row = await tbl('ff_members').update({ where: { id: 1 }, data: { points: { divide: 2 } } });
    assert.equal(row.points, 37);
    const raw = await db.raw`SELECT typeof("points") AS t FROM "ff_members" WHERE "id" = ${1}`;
    assert.deepEqual(raw, [{ t: 'integer' }]);
  });

  sqliteIt('an integral number written to a text column is stored as "3", not "3.0"', async () => {
    await tbl('ff_members').update({ where: { id: 3 }, data: { label: 3 as never } });
    const row = await tbl('ff_members').findUnique({ where: { id: 3 }, select: { label: true } });
    assert.equal(row.label, '3');
  });

  sqliteIt('-0 and fractional numbers still bind as REAL', async () => {
    const raw =
      await db.raw`SELECT typeof(${-0}) AS a, typeof(${1.5}) AS b, typeof(${2 ** 60}) AS c, typeof(${7}) AS d`;
    assert.deepEqual(raw, [{ a: 'real', b: 'real', c: 'real', d: 'integer' }]);
  });
});

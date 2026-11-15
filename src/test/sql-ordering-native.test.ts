import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { postgresDialect } from '../dialect.js';
import {
  compile,
  cte,
  identifier,
  type SqlDialect,
  type SqlResult,
  selectFrom,
  sql,
  table,
  union,
  unionAll,
  withCtes,
} from '../sql.js';
import { skipGate } from './helpers.js';

const require = createRequire(import.meta.url);
const sqlite = (() => {
  try {
    return require('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it: sqliteIt } = skipGate(!sqlite, 'requires node:sqlite (Node >= 22.5)');
const { it: postgresIt } = skipGate(!process.env.DATABASE_URL, 'requires DATABASE_URL');
type Execute = (query: { sql: string; params: unknown[] }) => Promise<Record<string, unknown>[]>;

async function verify(execute: Execute, dialect: SqlDialect) {
  const physical = 'sql_order_"items';
  const id = 'id"key';
  const hostile = "x'); DROP TABLE sql_order_effects; --";
  await execute(
    compile(sql`CREATE TEMP TABLE ${identifier(physical)} (${identifier(id)} INTEGER, label TEXT)`, dialect),
  );
  await execute(
    compile(sql`CREATE TEMP TABLE sql_order_children (parent_id INTEGER, rank INTEGER, title TEXT)`, dialect),
  );
  await execute(compile(sql`CREATE TEMP TABLE sql_order_effects (id INTEGER, label TEXT)`, dialect));
  // Deliberately unsorted insertion, tied labels and child rows test both keys.
  for (const [n, label] of [
    [2, 'tied'],
    [3, 'tied'],
    [1, hostile],
  ] as const) {
    await execute(compile(sql`INSERT INTO ${identifier(physical)} VALUES (${n}, ${label})`, dialect));
  }
  for (const [parent, rank, title] of [
    [1, 1, 'a'],
    [3, 1, 'c'],
    [1, 2, 'b'],
  ] as const) {
    await execute(compile(sql`INSERT INTO sql_order_children VALUES (${parent}, ${rank}, ${title})`, dialect));
  }
  const t = table<{ 'id"key': number; label: string }>()(physical, 't');
  const p = table<{ parent_id: number; rank: number; title: string }>()('sql_order_children', 'p');
  const on = sql`${t.column(id)} = ${p.column('parent_id')}`;
  const base = selectFrom(t);
  const joined = base
    .leftJoin(p, on)
    .orderBy({ column: t.column(id), direction: 'desc' })
    .orderBy({ column: p.column('rank'), direction: 'desc' })
    .select({ id: t.column(id), title: p.column('title') });
  const joinedRows: SqlResult<typeof joined>[] = [
    { id: 3, title: 'c' },
    { id: 2, title: null },
    { id: 1, title: 'b' },
    { id: 1, title: 'a' },
  ];
  assert.deepEqual(await execute(compile(joined, dialect)), joinedRows);
  const ascending = base
    .orderBy({ column: t.column('label'), direction: 'asc' }, { column: t.column(id), direction: 'desc' })
    .select({ id: t.column(id), label: t.column('label') });
  assert.deepEqual(await execute(compile(ascending, dialect)), [
    { id: 3, label: 'tied' },
    { id: 2, label: 'tied' },
    { id: 1, label: hostile },
  ]);
  const repeated = sql`${t.column('label')} = ${hostile} OR ${t.column(id)} = ${2}`;
  const chosen = base
    .where(sql`(${repeated}) AND (${repeated})`)
    .orderBy({ column: t.column(id), direction: 'desc' })
    .select({ id: t.column(id), label: t.column('label') });
  const chosenRows = [
    { id: 2, label: 'tied' },
    { id: 1, label: hostile },
  ];
  const built = compile(chosen, dialect);
  assert.deepEqual(built.params, [hostile, 2, hostile, 2]);
  assert.deepEqual(await execute(built), chosenRows);
  const def = cte('ordered_rows', chosen);
  const r = def.ref('r');
  const read = selectFrom(r)
    .orderBy({ column: r.column('id'), direction: 'asc' })
    .select({ id: r.column('id'), label: r.column('label') });
  const complete = withCtes([def], read);
  const expected = [
    { id: 1, label: hostile },
    { id: 2, label: 'tied' },
  ];
  assert.deepEqual(await execute(compile(complete, dialect)), expected);
  const nested = withCtes([cte('outer_rows', chosen)], complete);
  // A wrapper's internal order does not promise the outer query's order.
  assert.deepEqual(await execute(compile(sql`${nested} ORDER BY ${identifier('id')} ASC`, dialect)), expected);
  const all = unionAll(complete, chosen);
  const allBuilt = compile(all, dialect);
  assert.deepEqual(allBuilt.params, [...built.params, ...built.params]);
  assert.deepEqual(await execute(compile(sql`${all} ORDER BY ${identifier('id')} ASC`, dialect)), [
    expected[0],
    expected[0],
    expected[1],
    expected[1],
  ]);
  assert.deepEqual(
    await execute(compile(sql`${union(all, nested)} ORDER BY ${identifier('id')} ASC`, dialect)),
    expected,
  );
  await execute(compile(sql`INSERT INTO sql_order_effects ${all}`, dialect));
  assert.deepEqual(await execute(compile(sql`SELECT id, label FROM sql_order_effects ORDER BY id ASC`, dialect)), [
    expected[0],
    expected[0],
    expected[1],
    expected[1],
  ]);
  const sub = base
    .where(
      sql`${t.column(id)} IN (${selectFrom(p)
        .orderBy({ column: p.column('rank'), direction: 'desc' })
        .select({ id: p.column('parent_id') })})`,
    )
    .orderBy({ column: t.column(id), direction: 'asc' })
    .select({ id: t.column(id) });
  assert.deepEqual(await execute(compile(sub, dialect)), [{ id: 1 }, { id: 3 }]);
  const offset = compile(
    sql`SELECT ${'marker'} AS marker WHERE EXISTS (${all}) AND EXISTS (${chosen}) AND ${7} = ${7}`,
    dialect,
  );
  assert.deepEqual(offset.params, ['marker', ...built.params, ...built.params, ...built.params, 7, 7]);
  assert.deepEqual(await execute(offset), [{ marker: 'marker' }]);
  assert.throws(() => compile(read, dialect), /Unresolved SQL CTE/);
  assert.throws(() => selectFrom(r).orderBy({ column: def.ref('r').column('id'), direction: 'asc' }), /outside.*scope/);
  // Earlier snapshots remain reusable and unordered after all ordered branches.
  const original = compile(base.select({ id: t.column(id) }), dialect);
  assert.doesNotMatch(original.sql, /ORDER BY/);
  assert.deepEqual(original.params, []);
  assert.deepEqual(
    await execute(
      compile(sql`SELECT ${identifier(id)} AS id FROM ${identifier(physical)} ORDER BY ${identifier(id)}`, dialect),
    ),
    [{ id: 1 }, { id: 2 }, { id: 3 }],
  );
}

sqliteIt('native SQLite executes typed ordering across joins, CTEs, nested WITH, sets and subqueries', async () => {
  const db = new sqlite.DatabaseSync(':memory:');
  const dialect = { paramPlaceholder: (i: number) => `:p${i}`, quoteIdentifier: postgresDialect.quoteIdentifier };
  try {
    await verify(async ({ sql: text, params }) => {
      const statement = db.prepare(text);
      return statement
        .all(Object.fromEntries(params.map((value, index) => [`p${index + 1}`, value])))
        .map((row: object) => ({ ...row }));
    }, dialect);
  } finally {
    db.close();
    assert.throws(() => db.prepare('SELECT 1'), /not open|closed/i);
  }
});

postgresIt(
  'native PostgreSQL executes typed ordering with exact repeated effects in an owned transaction',
  async () => {
    const { Client } = require('pg');
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await db.connect();
      await db.query('BEGIN');
      await verify(async ({ sql: text, params }) => (await db.query(text, params)).rows, postgresDialect);
    } finally {
      try {
        await db.query('ROLLBACK');
        assert.deepEqual(
          (await db.query("SELECT tablename FROM pg_tables WHERE tablename LIKE 'sql_order_%'")).rows,
          [],
        );
      } finally {
        await db.end();
      }
    }
  },
);

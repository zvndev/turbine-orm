import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { postgresDialect } from '../dialect.js';
import {
  compile,
  cte,
  except,
  identifier,
  intersect,
  join,
  type SqlDialect,
  type SqlFragment,
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
  const run = (fragment: SqlFragment) => execute(compile(fragment, dialect));
  const hostile = "x'); DROP TABLE sql_distinct_effects; --";
  await run(sql`CREATE TEMP TABLE sql_distinct_left (id INTEGER, label TEXT)`);
  await run(sql`CREATE TEMP TABLE sql_distinct_right (id INTEGER, label TEXT)`);
  await run(sql`CREATE TEMP TABLE sql_distinct_effects (id INTEGER, label TEXT)`);
  for (const [name, rows] of [
    [
      'sql_distinct_left',
      [
        [1, hostile],
        [1, hostile],
        [2, null],
        [2, null],
        [3, 'left'],
        [5, null],
        [6, 'same'],
      ],
    ],
    [
      'sql_distinct_right',
      [
        [1, hostile],
        [1, hostile],
        [2, null],
        [4, 'right'],
        [6, 'different'],
        [8, null],
      ],
    ],
  ] as const) {
    for (const [id, label] of rows) await run(sql`INSERT INTO ${identifier(name)} VALUES (${id}, ${label})`);
  }
  const l = table<{ id: number; label: string | null }>()('sql_distinct_left', 'l');
  const r = table<{ id: number; label: string | null }>()('sql_distinct_right', 'r');
  const repeated = sql`${l.column('id')} > ${0} AND (${l.column('label')} = ${hostile} OR ${true})`;
  const left = selectFrom(l)
    .where(sql`(${repeated}) AND (${repeated})`)
    .orderBy({ column: l.column('id'), direction: 'desc' })
    .select({ id: l.column('id'), label: l.column('label') });
  const right = selectFrom(r)
    .where(sql`${r.column('id')} > ${0}`)
    .orderBy({ column: r.column('id'), direction: 'asc' })
    .select({ id: r.column('id'), label: r.column('label') });
  const shared = [
    { id: 1, label: hostile },
    { id: 2, label: null },
  ];
  const difference = [
    { id: 3, label: 'left' },
    { id: 5, label: null },
    { id: 6, label: 'same' },
  ];
  const leftParams = [0, hostile, true, 0, hostile, true];
  const sorted = (fragment: SqlFragment) => run(sql`${fragment} ORDER BY ${identifier('id')} ASC`);
  for (const [operator, expected] of [
    [intersect, shared],
    [except, difference],
  ] as const) {
    const result = operator(left, right);
    assert.deepEqual(compile(result, dialect).params, [...leftParams, 0]);
    assert.deepEqual(await sorted(result), expected);
    assert.deepEqual(await sorted(operator(result, right)), operator === intersect ? shared : difference);
    const offset = sql`SELECT ${'marker'} AS marker WHERE EXISTS (${result}) AND ${7} = ${7}`;
    assert.deepEqual(compile(offset, dialect).params, ['marker', ...leftParams, 0, 7, 7]);
    assert.deepEqual(await run(offset), [{ marker: 'marker' }]);
    await run(sql`INSERT INTO sql_distinct_effects ${result}`);
    assert.deepEqual(await run(sql`SELECT id, label FROM sql_distinct_effects ORDER BY id`), expected);
    await run(sql`DELETE FROM sql_distinct_effects`);

    const definition = cte('chosen', result);
    const ref = definition.ref('c');
    const read = selectFrom(ref).select({ id: ref.column('id'), label: ref.column('label') });
    const complete = withCtes([definition], read);
    const nested = withCtes([cte('unused', right)], complete);
    assert.deepEqual(await sorted(nested), expected);
    assert.deepEqual(compile(nested, dialect).params, [0, ...leftParams, 0]);
    assert.deepEqual(await sorted(intersect(complete, nested)), expected);
    assert.deepEqual(await sorted(except(complete, nested)), []);
    assert.deepEqual(await sorted(withCtes([definition], operator(read, right))), expected);
    assert.throws(() => compile(operator(read, left), dialect), /Unresolved SQL CTE/);
    assert.throws(() => compile(operator(left, read), dialect), /Unresolved SQL CTE/);
    assert.throws(() => compile(withCtes([cte('other', left)], operator(read, left)), dialect), /Unresolved SQL CTE/);
    assert.throws(
      () => compile(withCtes([definition], withCtes([cte('inner', left)], read)), dialect),
      /Unresolved SQL CTE/,
    );
    const next = cte('next_rows', read);
    const n = next.ref('n');
    assert.throws(
      () =>
        compile(
          withCtes(
            [next, definition],
            operator(selectFrom(n).select({ id: n.column('id'), label: n.column('label') }), left),
          ),
          dialect,
        ),
      /Unresolved SQL CTE/,
    );
    assert.throws(
      () => compile(withCtes([cte('sql_distinct_left', right)], operator(left, right)), dialect),
      /captures an unqualified physical table/,
    );
    for (const fake of [sql`${left}`, {}, { ...left }, Object.create(left), new Proxy(left, {})]) {
      assert.throws(() => operator(fake as typeof left, right), /genuine closed SQL selection/);
      assert.throws(() => operator(left, fake as typeof right), /genuine closed SQL selection/);
    }
  }
  assert.deepEqual(await sorted(except(right, left)), [
    { id: 4, label: 'right' },
    { id: 6, label: 'different' },
    { id: 8, label: null },
  ]);
  const empty = selectFrom(l)
    .where(sql`${l.column('id')} < ${0}`)
    .select({ id: l.column('id'), label: l.column('label') });
  assert.deepEqual(await sorted(intersect(left, empty)), []);
  assert.deepEqual(await sorted(except(empty, left)), []);
  assert.deepEqual(await sorted(intersect(left, left)), [...shared, ...difference]);
  assert.deepEqual(await sorted(except(left, left)), []);
  assert.deepEqual(await sorted(except(left, empty)), [...shared, ...difference]);

  const ids = (...values: number[]) =>
    selectFrom(l)
      .where(sql`${l.column('id')} IN (${join(values)})`)
      .select({ id: l.column('id') });
  const a = ids(1, 2);
  const b = ids(2, 3);
  const c = ids(2);
  assert.deepEqual(await sorted(intersect(union(a, b), c)), [{ id: 2 }]);
  assert.deepEqual(await sorted(union(a, intersect(b, c))), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await sorted(except(a, except(b, c))), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(await sorted(except(except(a, b), c)), [{ id: 1 }]);
  assert.deepEqual(
    await run(
      sql`SELECT id, CAST(COUNT(*) AS INTEGER) AS n FROM (${unionAll(intersect(left, right), intersect(left, right))}) AS grouped GROUP BY id ORDER BY id`,
    ),
    [
      { id: 1, n: 2 },
      { id: 2, n: 2 },
    ],
  );
  // Missing right-side rows remain NULL through the original outer-join projection.
  const outer = selectFrom(l)
    .leftJoin(r, sql`${l.column('id')} = ${r.column('id')}`)
    .select({ id: l.column('id'), label: r.column('label') });
  assert.deepEqual(await sorted(intersect(outer, outer)), [
    { id: 1, label: hostile },
    { id: 2, label: null },
    { id: 3, label: null },
    { id: 5, label: null },
    { id: 6, label: 'different' },
  ]);
  assert.deepEqual(await run(sql`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sql_distinct_left`), [{ n: 7 }]);
  assert.deepEqual(await run(sql`SELECT CAST(COUNT(*) AS INTEGER) AS n FROM sql_distinct_right`), [{ n: 6 }]);
}

sqliteIt(
  'native SQLite executes INTERSECT/EXCEPT duplicates, NULLs, grouping, CTE scopes and repeated effects',
  async () => {
    const db = new sqlite.DatabaseSync(':memory:');
    const dialect = { paramPlaceholder: (i: number) => `:p${i}`, quoteIdentifier: postgresDialect.quoteIdentifier };
    try {
      console.log('SQL set operations SQLite version:', db.prepare('SELECT sqlite_version() AS version').get());
      await verify(
        async ({ sql: text, params }) =>
          db
            .prepare(text)
            .all(
              Object.fromEntries(
                params.map((value, index) => [`p${index + 1}`, typeof value === 'boolean' ? Number(value) : value]),
              ),
            )
            .map((row: object) => ({ ...row })),
        dialect,
      );
    } finally {
      db.close();
      assert.throws(() => db.prepare('SELECT 1'), /not open|closed/i);
    }
  },
);

postgresIt('native PostgreSQL executes INTERSECT/EXCEPT with exact rows and rollback cleanup', async () => {
  const { Client } = require('pg');
  const db = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 10000,
  });
  try {
    await db.connect();
    console.log('SQL set operations PostgreSQL version:', (await db.query('SHOW server_version')).rows);
    await db.query('BEGIN');
    await verify(async ({ sql: text, params }) => (await db.query(text, params)).rows, postgresDialect);
  } finally {
    try {
      await db.query('ROLLBACK');
      assert.deepEqual(
        (await db.query("SELECT tablename FROM pg_tables WHERE tablename LIKE 'sql_distinct_%'")).rows,
        [],
      );
    } finally {
      await db.end();
    }
  }
});

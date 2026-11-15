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
  const physical = 'sql_cte_"values';
  const valueColumn = 'v"x';
  await execute(
    compile(sql`CREATE TEMP TABLE ${identifier(physical)} (id INTEGER, ${identifier(valueColumn)} TEXT)`, dialect),
  );
  await execute(compile(sql`CREATE TEMP TABLE ${identifier('sql_set_effects')} (id INTEGER, value TEXT)`, dialect));
  const hostile = "x'); DROP TABLE sql_set_effects; --";
  for (const [id, value] of [
    [1, hostile],
    [2, null],
    [3, 'other'],
  ] as const) {
    await execute(compile(sql`INSERT INTO ${identifier(physical)} VALUES (${id}, ${value})`, dialect));
  }
  const source = table<{ id: number; 'v"x': string | null }>()(physical, 's');
  const predicate = sql`${source.column('v"x')} = ${hostile} OR ${source.column('id')} = ${2}`;
  const selected = selectFrom(source)
    .where(sql`(${predicate}) AND (${predicate})`)
    .select({ id: source.column('id'), value: source.column('v"x') });
  const first = cte('chosen', selected);
  const a = first.ref('a');
  const second = cte(
    'again',
    selectFrom(a)
      .where(sql`${a.column('id')} > ${0}`)
      .select({ id: a.column('id'), value: a.column('value') }),
  );
  const b = second.ref('b');
  const other = first.ref('other');
  const read = selectFrom(b)
    .innerJoin(other, sql`${b.column('id')} = ${other.column('id')}`)
    .where(sql`${b.column('id')} IN (${selectFrom(a).select({ id: a.column('id') })})`)
    .select({ id: b.column('id'), value: b.column('value') });
  const complete = withCtes([first, second], read);
  const expected: SqlResult<typeof complete>[] = [
    { id: 1, value: hostile },
    { id: 2, value: null },
  ];
  const compiled = compile(complete, dialect);
  assert.deepEqual(compiled.params, [hostile, 2, hostile, 2, 0]);
  assert.deepEqual(await execute(compile(sql`${complete} ORDER BY ${identifier('id')}`, dialect)), expected);
  const nestedBody = withCtes([cte('unused_outer', selected)], complete);
  assert.deepEqual(await execute(compile(sql`${nestedBody} ORDER BY ${identifier('id')}`, dialect)), expected);
  const tripleBody = withCtes([cte('unused_top', selected)], nestedBody);
  assert.deepEqual(await execute(compile(sql`${tripleBody} ORDER BY ${identifier('id')}`, dialect)), expected);
  await execute(compile(sql`CREATE TEMP TABLE capture_items (id INTEGER)`, dialect));
  await execute(compile(sql`INSERT INTO capture_items VALUES (${90})`, dialect));
  const captured = table<{ id: number }>()('capture_items', 'c');
  const physicalRead = selectFrom(captured).select({ id: captured.column('id') });
  const capture = cte('capture_items', selected);
  for (const body of [physicalRead, withCtes([first], physicalRead), unionAll(physicalRead, physicalRead)]) {
    assert.throws(() => compile(withCtes([capture], body), dialect), /captures an unqualified physical table/);
  }
  const qualified = table<{ id: number }>()([dialect === postgresDialect ? 'pg_temp' : 'temp', 'capture_items'], 'q');
  assert.deepEqual(
    await execute(compile(withCtes([capture], selectFrom(qualified).select({ id: qualified.column('id') })), dialect)),
    [{ id: 90 }],
  );
  const set = unionAll(complete, complete);
  const built = compile(set, dialect);
  assert.deepEqual(built.params, [...compiled.params, ...compiled.params]);
  assert.deepEqual(await execute(compile(sql`${set} ORDER BY ${identifier('id')}`, dialect)), [
    expected[0],
    expected[0],
    expected[1],
    expected[1],
  ]);
  assert.deepEqual(
    await execute(compile(sql`${union(set, complete)} ORDER BY ${identifier('id')}`, dialect)),
    expected,
  );
  // A native write proves every repeated operand's parameters reached execution.
  await execute(compile(sql`INSERT INTO ${identifier('sql_set_effects')} ${set}`, dialect));
  assert.deepEqual(
    await execute(compile(sql`SELECT id, value FROM ${identifier('sql_set_effects')} ORDER BY id`, dialect)),
    [expected[0], expected[0], expected[1], expected[1]],
  );
  const offset = compile(sql`SELECT ${'marker'} AS marker WHERE EXISTS (${set}) AND ${7} = ${7}`, dialect);
  assert.deepEqual(offset.params, ['marker', ...compiled.params, ...compiled.params, 7, 7]);
  assert.deepEqual(await execute(offset), [{ marker: 'marker' }]);
  const definition = cte('set_rows', set);
  const r = definition.ref('r');
  assert.deepEqual(
    await execute(
      compile(
        sql`${withCtes([definition], selectFrom(r).select({ id: r.column('id'), value: r.column('value') }))} ORDER BY ${identifier('id')}`,
        dialect,
      ),
    ),
    [expected[0], expected[0], expected[1], expected[1]],
  );
  assert.throws(() => compile(read, dialect), /Unresolved SQL CTE/);
  assert.throws(() => compile(withCtes([second, first], read), dialect), /Unresolved SQL CTE/);
  assert.throws(() => selectFrom(a).where(sql`${source.column('id')} = ${a.column('id')}`), /outside.*scope/);
  assert.throws(
    () => union(complete, selectFrom(b).select({ value: b.column('value'), id: b.column('id') })),
    /ordered projection/,
  );
  assert.deepEqual(await execute(compile(sql`SELECT id FROM ${identifier(physical)} ORDER BY id`, dialect)), [
    { id: 1 },
    { id: 2 },
    { id: 3 },
  ]);
}

sqliteIt('native SQLite executes CTE chains, nested UNION grouping and exact repeated parameter effects', async () => {
  const db = new sqlite.DatabaseSync(':memory:');
  const dialect = { paramPlaceholder: (i: number) => `:p${i}`, quoteIdentifier: postgresDialect.quoteIdentifier };
  try {
    await verify(async ({ sql: text, params }) => {
      const stmt = db.prepare(text);
      const values = Object.fromEntries(params.map((value, index) => [`p${index + 1}`, value]));
      return stmt.all(values).map((row: object) => ({ ...row }));
    }, dialect);
  } finally {
    db.close();
  }
});

postgresIt(
  'native PostgreSQL executes CTE chains, nested UNION grouping and exact repeated parameter effects',
  async () => {
    // Resolve from this root test installation, never a benchmark installation.
    const { Client } = require('pg');
    const db = new Client({ connectionString: process.env.DATABASE_URL });
    try {
      await db.connect();
      await db.query('BEGIN');
      await verify(async ({ sql: text, params }) => (await db.query(text, params)).rows, postgresDialect);
    } finally {
      try {
        await db.query('ROLLBACK');
      } finally {
        await db.end();
      }
    }
  },
);

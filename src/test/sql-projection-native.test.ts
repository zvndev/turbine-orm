import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { TurbineClient } from '../client.js';
import { postgresDialect } from '../dialect.js';
import { compile, identifier, type SqlDialect, type SqlResult, selectFrom, sql, table } from '../sql.js';
import { sqliteDialect, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it: sqliteIt } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');
const { it: postgresIt } = skipGate(!process.env.DATABASE_URL, 'requires DATABASE_URL');

type Executor = {
  rawUnsafe<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    ...params: unknown[]
  ): Promise<T[]>;
};

async function verifyRows(db: Executor, dialect: SqlDialect, temporarySuffix = '') {
  await db.rawUnsafe(
    `CREATE TEMP TABLE sql_projection_users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)${temporarySuffix}`,
  );
  await db.rawUnsafe(
    `CREATE TEMP TABLE sql_projection_posts (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL)${temporarySuffix}`,
  );
  const hostile = "O'Reilly'); DROP TABLE sql_projection_users; --";
  for (const [id, name] of [
    [1, hostile],
    [2, 'childless'],
    [3, 'another'],
  ] as const) {
    const insert = compile(
      sql`INSERT INTO ${identifier('sql_projection_users')} (id, name) VALUES (${id}, ${name})`,
      dialect,
    );
    await db.rawUnsafe(insert.sql, ...insert.params);
  }
  for (const [id, userId, title] of [
    [10, 1, 'first'],
    [11, 1, 'second'],
    [12, 3, hostile],
  ] as const) {
    const insert = compile(
      sql`INSERT INTO ${identifier('sql_projection_posts')} (id, user_id, title) VALUES (${id}, ${userId}, ${title})`,
      dialect,
    );
    await db.rawUnsafe(insert.sql, ...insert.params);
  }
  const u = table<{ id: number; name: string }>()('sql_projection_users', 'u');
  const p = table<{ id: number; user_id: number; title: string }>()('sql_projection_posts', 'p');
  const on = sql`${u.column('id')} = ${p.column('user_id')}`;
  const base = selectFrom(u);
  const query = base
    .leftJoin(p, on)
    .select({ userId: u.column('id'), name: u.column('name'), title: p.column('title') });
  const built = compile(sql`${query} ORDER BY ${identifier('userId')}, ${identifier('title')}`, dialect);
  const rows = await db.rawUnsafe<SqlResult<typeof query>>(built.sql, ...built.params);
  assert.deepEqual(rows, [
    { userId: 1, name: hostile, title: 'first' },
    { userId: 1, name: hostile, title: 'second' },
    { userId: 2, name: 'childless', title: null },
    { userId: 3, name: 'another', title: hostile },
  ]);
  const inner = base
    .innerJoin(p, on)
    .where(sql`${u.column('name')} = ${hostile}`)
    .select({ userId: u.column('id'), title: p.column('title') });
  const compiled = compile(sql`${inner} ORDER BY ${identifier('title')}`, dialect);
  assert.deepEqual(await db.rawUnsafe(compiled.sql, ...compiled.params), [
    { userId: 1, title: 'first' },
    { userId: 1, title: 'second' },
  ]);
  const selectedIds = base.where(sql`${u.column('name')} = ${hostile}`).select({ id: u.column('id') });
  const subquery = selectFrom(p)
    .where(sql`${p.column('user_id')} IN (${selectedIds})`)
    .select({ title: p.column('title') });
  const sub = compile(sql`${subquery} ORDER BY ${identifier('title')}`, dialect);
  assert.deepEqual(await db.rawUnsafe(sub.sql, ...sub.params), [{ title: 'first' }, { title: 'second' }]);
  const count = await db.rawUnsafe<{ n: number }>('SELECT COUNT(*) AS n FROM sql_projection_users');
  // PostgreSQL COUNT is text with a caller-owned/default parser. No decoder is inferred.
  assert.equal(Number(count[0]!.n), 3);
}

sqliteIt('typed projections execute actual SQLite joins, nulls, hostile values and closed subqueries', async () => {
  const db = turbineSqlite(':memory:', { tables: {}, enums: {} });
  try {
    await verifyRows(db, sqliteDialect);
  } finally {
    await db.disconnect();
  }
});

postgresIt('typed projections execute actual PostgreSQL joins and values on one owned transaction', async () => {
  const db = new TurbineClient({ connectionString: process.env.DATABASE_URL }, { tables: {}, enums: {} });
  try {
    await db.$transaction(async (tx) => verifyRows(tx, postgresDialect, ' ON COMMIT DROP'));
    assert.deepEqual(
      await db.rawUnsafe(
        'SELECT tablename FROM pg_tables WHERE tablename IN ($1, $2)',
        'sql_projection_users',
        'sql_projection_posts',
      ),
      [],
    );
  } finally {
    await db.disconnect();
  }
});

it('selection does not inject model policy or runtime decoding', () => {
  const raw = table<{ tenant_id: number; pii: string; payload: { a: number } }>()('records', 'r');
  assert.deepEqual(
    compile(selectFrom(raw).select({ secret: raw.column('pii'), payload: raw.column('payload') }), postgresDialect),
    {
      sql: 'SELECT "r"."pii" AS "secret", "r"."payload" AS "payload" FROM "records" AS "r"',
      params: [],
    },
  );
});

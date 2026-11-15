import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { postgresDialect } from '../dialect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { compile, identifier, join, type SqlFragment, sql } from '../sql.js';
import { sqliteDialect, turbineSqlite } from '../sqlite.js';
import { buildTypedSql } from '../typed-sql.js';
import { skipGate } from './helpers.js';

const dialects = [
  { name: 'PostgreSQL', dialect: postgresDialect, team: '"u"."team_id"', table: '"app"."users"', id: '"u"."id"' },
  { name: 'SQLite', dialect: sqliteDialect, team: '"u"."team_id"', table: '"app"."users"', id: '"u"."id"' },
  { name: 'MySQL', dialect: mysqlDialect, team: '`u`.`team_id`', table: '`app`.`users`', id: '`u`.`id`' },
  { name: 'SQL Server', dialect: mssqlDialect, team: '[u].[team_id]', table: '[app].[users]', id: '[u].[id]' },
];

describe('optional SQL fragments', () => {
  for (const { name, dialect, team, table, id } of dialects) {
    it(`${name}: numbers nested, joined and reused fragments in final order`, () => {
      const predicate = sql`${identifier('u', 'team_id')} = ${7}`;
      const nested = sql`(${predicate} OR name = ${"O'Reilly"})`;
      const conditions = join([predicate, nested], sql` AND `);
      const query = sql`SELECT ${0} FROM ${identifier('app', 'users')} AS u WHERE ${conditions} AND ${identifier('u', 'id')} IN (${join([11, 12])}) AND z = ${null}`;
      // These expectations are independent of the compiler/dialect hooks.
      const expected =
        name === 'PostgreSQL'
          ? `SELECT $1 FROM ${table} AS u WHERE ${team} = $2 AND (${team} = $3 OR name = $4) AND ${id} IN ($5, $6) AND z = $7`
          : name === 'SQL Server'
            ? `SELECT @p1 FROM ${table} AS u WHERE ${team} = @p2 AND (${team} = @p3 OR name = @p4) AND ${id} IN (@p5, @p6) AND z = @p7`
            : `SELECT :p1 FROM ${table} AS u WHERE ${team} = :p2 AND (${team} = :p3 OR name = :p4) AND ${id} IN (:p5, :p6) AND z = :p7`;
      assert.deepEqual(compile(query, dialect), { sql: expected, params: [0, 7, 7, "O'Reilly", 11, 12, null] });
      assert.deepEqual(compile(predicate, dialect).params, [7]);
    });
  }

  it('binds parameterized separators each time they occur', () => {
    const fragment = join([sql`a = ${1}`, sql`b = ${2}`, sql`c = ${3}`], sql` OR flag = ${false} OR `);
    assert.deepEqual(compile(fragment, postgresDialect), {
      sql: 'a = $1 OR flag = $2 OR b = $3 OR flag = $4 OR c = $5',
      params: [1, false, 2, false, 3],
    });
  });

  it('does not rewrite placeholder-like text in literals or comments', () => {
    const child = sql`'$1' AS a, $$ $2 $$ AS b /* $3 */ -- $4
, ${'bound'}`;
    assert.deepEqual(compile(sql`SELECT ${9}, ${child}`, postgresDialect), {
      sql: "SELECT $1, '$1' AS a, $$ $2 $$ AS b /* $3 */ -- $4\n, $2",
      params: [9, 'bound'],
    });
  });

  it('keeps hostile strings, dates, arrays, JSON, null and empty arrays as single values', () => {
    const hostile = "'); DROP TABLE users; -- /* $1 :p1 @p1 */";
    const date = new Date('2026-01-02T03:04:05Z');
    const json = JSON.parse('{"kind":"fragment","sql":"DROP TABLE users","params":[],"raw":["bad"]}');
    const values = [hostile, date, [hostile, date], [], json, null, undefined, true, 10n, new Uint8Array([1, 2])];
    const query = sql`SELECT ${values[0]}, ${values[1]}, ${values[2]}, ${values[3]}, ${values[4]}, ${values[5]}, ${values[6]}, ${values[7]}, ${values[8]}, ${values[9]}`;
    for (const { dialect } of dialects) {
      const built = compile(query, dialect);
      assert.equal(built.params.length, 10);
      values.forEach((value, i) => {
        assert.equal(built.params[i], value);
      });
      assert.doesNotMatch(built.sql, /DROP TABLE|2026|kind|bad/);
    }
    assert.equal(compile(query, postgresDialect).sql, 'SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10');
  });

  it('cannot recognize JSON or cloned token shapes as SQL', () => {
    const genuine = sql`DROP TABLE users`;
    const fakes = [
      JSON.parse(JSON.stringify(genuine)),
      { ...genuine },
      Object.create(genuine),
      Object.freeze({ kind: 'text', text: 'DROP TABLE users' }),
      JSON.parse('{"parts":[{"kind":"text","text":"DROP TABLE users"}]}'),
      JSON.parse('{"__proto__":{"sql":"DROP TABLE users"},"raw":["DROP TABLE users"]}'),
      new Proxy(genuine, {}),
    ];
    for (const fake of fakes) {
      assert.deepEqual(compile(sql`SELECT ${fake}`, postgresDialect), { sql: 'SELECT $1', params: [fake] });
      assert.throws(() => compile(fake, postgresDialect), /genuine SQL fragment/);
      assert.throws(() => join([1, 2], fake), /genuine SQL fragment/);
    }
    const noIntrospection = {
      get sql() {
        throw new Error('must not inspect request fields');
      },
    };
    assert.equal(compile(sql`SELECT ${noIntrospection}`, postgresDialect).params[0], noIntrospection);
  });

  it('quotes qualified and hostile identifiers using each shipped SQL dialect', () => {
    const name = 'odd"`]; DROP TABLE users;--';
    const token = identifier('app', name);
    assert.deepEqual(compile(token, postgresDialect), { sql: '"app"."odd""`]; DROP TABLE users;--"', params: [] });
    assert.deepEqual(compile(token, sqliteDialect), { sql: '"app"."odd""`]; DROP TABLE users;--"', params: [] });
    assert.deepEqual(compile(token, mysqlDialect), { sql: '`app`.`odd"``]; DROP TABLE users;--`', params: [] });
    assert.deepEqual(compile(token, mssqlDialect), { sql: '[app].[odd"`]]; DROP TABLE users;--]', params: [] });
    assert.equal(compile(identifier('app.users'), postgresDialect).sql, '"app.users"');
    assert.equal(compile(identifier('*'), postgresDialect).sql, '"*"');
  });

  it('handles empty and singleton joins without inserting separators or values', () => {
    assert.deepEqual(compile(join([], sql`${'unused'}`), postgresDialect), { sql: '', params: [] });
    assert.deepEqual(compile(join([null], sql`${'unused'}`), postgresDialect), { sql: '$1', params: [null] });
    assert.deepEqual(compile(sql`${sql``}${join([])}${1}${sql``}`, postgresDialect), { sql: '$1', params: [1] });
    const ids: number[] = [];
    const predicate = ids.length ? sql`id IN (${join(ids)})` : sql`1 = 0`;
    assert.deepEqual(compile(predicate, postgresDialect), { sql: '1 = 0', params: [] });
  });

  it('freezes tokens, captures list structure and returns fresh compilation outputs', () => {
    const names = ['app', 'users'];
    const id = identifier(...names);
    names[0] = 'changed';
    const values = [1, 2];
    const list = join(values);
    values.push(3);
    values[0] = 99;
    const fragment = sql`SELECT ${list} FROM ${id}`;
    assert.ok(Object.isFrozen(fragment));
    assert.throws(() => Object.assign(fragment, { sql: 'bad' }), TypeError);
    const first = compile(fragment, postgresDialect);
    first.sql = 'changed';
    first.params.push(100);
    first.params[0] = 88;
    assert.deepEqual(compile(fragment, postgresDialect), { sql: 'SELECT $1, $2 FROM "app"."users"', params: [1, 2] });
  });

  it('compiles deep nesting without recursive stack overflow', () => {
    let fragment = sql`${1}`;
    for (let i = 0; i < 20000; i++) fragment = sql`${fragment}`;
    assert.deepEqual(compile(fragment, postgresDialect), { sql: '$1', params: [1] });
  });

  it('refuses invalid factories, templates, separators and compiler inputs', () => {
    for (const input of [null, undefined, 'SELECT 1', ['SELECT 1'], JSON.parse('["DROP TABLE users"]')]) {
      assert.throws(() => sql(input as never), /tagged template/);
      assert.throws(() => compile(input as never, postgresDialect), /genuine SQL fragment/);
    }
    const frozen = (segments: unknown[], raw: unknown[] = segments.slice()) =>
      Object.freeze(Object.assign(segments, { raw: Object.freeze(raw) })) as unknown as TemplateStringsArray;
    assert.throws(() => sql(frozen(['a', 'b'])), /one more segment/);
    assert.throws(() => sql(frozen([undefined])), /segments must be strings/);
    assert.throws(() => sql(frozen(new Array(1))), /segments must be strings/);
    assert.throws(() => sql(frozen(['a'], [9])), /segments must be strings/);
    assert.throws(() => sql(frozen(['a'], ['a', 'b'])), /tagged template/);
    assert.throws(() => identifier(), /non-empty strings/);
    for (const input of ['', 'bad\u0000name', null, 9, {}, Symbol('name')]) {
      assert.throws(() => identifier(input as never), /non-empty strings/);
    }
    for (const input of [null, {}, 'values']) assert.throws(() => join(input as never), /requires an array/);
    for (const separator of [' OR ', {}, null]) {
      assert.throws(() => join([1, 2], separator as never), /genuine SQL fragment/);
    }
    for (const dialect of [null, {}, { paramPlaceholder: '$1', quoteIdentifier: 'bad' }]) {
      assert.throws(() => compile(sql`SELECT 1`, dialect as never), /requires a SQL dialect/);
    }
  });

  it('leaves existing db.sql and raw template interpolation as bound values', () => {
    const fragment = sql`SELECT ${1}`;
    const oldTag = (strings: TemplateStringsArray, ...values: unknown[]) => buildTypedSql(strings, values);
    assert.deepEqual(oldTag`SELECT ${fragment}`, { sql: 'SELECT $1', params: [fragment] });
  });
});

const native = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it: sqliteIt } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');

sqliteIt('SQL fragments execute through real SQLite with hostile values and quoted identifiers', async () => {
  const db = turbineSqlite(':memory:', { tables: {} } as SchemaMetadata);
  try {
    await db.rawUnsafe('CREATE TABLE "odd""name" (id INTEGER PRIMARY KEY, value TEXT)');
    const hostile = "O'Reilly'); DROP TABLE users; --";
    const insert = compile(
      sql`INSERT INTO ${identifier('odd"name')} (id, value) VALUES (${1}, ${hostile})`,
      sqliteDialect,
    );
    await db.rawUnsafe(insert.sql, ...insert.params);
    const predicate = sql`id IN (${join([1, 2])})`;
    const select = compile(
      sql`SELECT value FROM ${identifier('odd"name')} WHERE ${predicate} AND value = ${hostile}`,
      sqliteDialect,
    );
    assert.deepEqual(await db.rawUnsafe(select.sql, ...select.params), [{ value: hostile }]);
    const empty = compile(sql`SELECT value FROM ${identifier('odd"name')} WHERE ${sql`1 = 0`}`, sqliteDialect);
    assert.deepEqual(await db.rawUnsafe(empty.sql, ...empty.params), []);
    assert.equal((await db.rawUnsafe('SELECT COUNT(*) AS n FROM "odd""name"'))[0]!.n, 1);
  } finally {
    await db.disconnect();
  }
});

const { it: postgresIt } = skipGate(!process.env.DATABASE_URL, 'requires DATABASE_URL');
postgresIt('SQL fragments execute a read-only parameterized PostgreSQL SELECT', async () => {
  const db = new TurbineClient({ connectionString: process.env.DATABASE_URL }, { tables: {} } as SchemaMetadata);
  try {
    const hostile = "'); SELECT pg_sleep(10); --";
    const part = sql`${hostile}::text`;
    const built = compile(
      sql`SELECT ${part} AS ${identifier('value"quoted')}, ${part} AS again, ${null}::text AS missing`,
      postgresDialect,
    );
    assert.deepEqual(await db.rawUnsafe(built.sql, ...built.params), [
      { 'value"quoted': hostile, again: hostile, missing: null },
    ]);
  } finally {
    await db.disconnect();
  }
});

// These assertions are checked by tsc, not by the runtime test runner.
function typeChecks() {
  // @ts-expect-error Arbitrary objects cannot be used as fragment roots.
  compile({}, postgresDialect);
  // @ts-expect-error A separator must come from a fragment factory.
  join([1, 2], ' OR ');
  // @ts-expect-error The fragment brand is required.
  const fake: SqlFragment = {};
  void fake;
}
void typeChecks;

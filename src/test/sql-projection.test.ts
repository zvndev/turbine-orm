import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { compile, identifier, join, type SqlFragment, type SqlResult, selectFrom, sql, table } from '../sql.js';
import { sqliteDialect } from '../sqlite.js';

type User = { id: number; name: string; team_id: number | null };
type Post = { id: number; user_id: number; title: string };
const u = table<User>()('users', 'u');
const p = table<Post>()(['app', 'posts'], 'p');
const predicate = sql`${u.column('id')} = ${p.column('user_id')}`;

describe('typed SQL projections', () => {
  for (const dialect of [postgresDialect, sqliteDialect, mysqlDialect, mssqlDialect]) {
    it(`${dialect.name}: compiles columns, named outputs, joins and repeated nested values`, () => {
      const condition = sql`${p.column('title')} = ${"O'Reilly'); DROP TABLE users; --"}`;
      const query = selectFrom(u)
        .leftJoin(p, predicate)
        .where(sql`${join([condition, sql`(${condition})`], sql` OR `)}`)
        .where(sql`${u.column('id')} > ${0}`)
        .select({ userId: u.column('id'), title: p.column('title'), team: u.column('team_id') });
      const built = compile(query, dialect);
      const q = (name: string) => dialect.quoteIdentifier(name);
      const param = (n: number) => dialect.paramPlaceholder(n);
      assert.equal(
        built.sql,
        `SELECT ${q('u')}.${q('id')} AS ${q('userId')}, ${q('p')}.${q('title')} AS ${q('title')}, ${q('u')}.${q('team_id')} AS ${q('team')} FROM ${q('users')} AS ${q('u')} LEFT JOIN ${q('app')}.${q('posts')} AS ${q('p')} ON (${q('u')}.${q('id')} = ${q('p')}.${q('user_id')}) WHERE (${q('p')}.${q('title')} = ${param(1)} OR (${q('p')}.${q('title')} = ${param(2)})) AND (${q('u')}.${q('id')} > ${param(3)})`,
      );
      assert.deepEqual(built.params, ["O'Reilly'); DROP TABLE users; --", "O'Reilly'); DROP TABLE users; --", 0]);
      assert.doesNotMatch(built.sql, /DROP TABLE|Reilly/);
    });
  }

  it('keeps query branches immutable and closed queries reusable with fresh numbering', () => {
    const base = selectFrom(u);
    const joined = base.innerJoin(p, predicate).select({ title: p.column('title') });
    const own = base.where(sql`${u.column('id')} = ${1}`).select({ id: u.column('id') });
    assert.ok(Object.isFrozen(base));
    assert.ok(Object.isFrozen(u));
    assert.ok(Object.isFrozen(own));
    assert.doesNotMatch(compile(own, postgresDialect).sql, /JOIN/);
    assert.match(compile(joined, postgresDialect).sql, /INNER JOIN/);
    const outer = table<{ id: number }>()('others', 'o');
    const subquery = selectFrom(outer)
      .where(sql`${outer.column('id')} = ${2}`)
      .select({ id: outer.column('id') });
    const final = base
      .where(sql`${u.column('id')} IN (${subquery}) OR ${u.column('id')} IN (${subquery})`)
      .select({ id: u.column('id') });
    const built = compile(sql`SELECT ${9} WHERE EXISTS (${final}) AND EXISTS (${own})`, postgresDialect);
    assert.deepEqual(built.params, [9, 2, 2, 1]);
    assert.match(built.sql, /"o"\."id" = \$2/);
    assert.match(built.sql, /"o"\."id" = \$3/);
    assert.match(built.sql, /"u"\."id" = \$4/);
    assert.deepEqual(compile(own, postgresDialect).params, [1]);
  });

  it('refuses alias collisions and table references from another declaration of the same alias', () => {
    const same = table<User>()('users', 'u');
    const upper = table<Post>()('posts', 'U');
    assert.throws(() => selectFrom(u).innerJoin(same as never, sql`1 = 1`), /Duplicate SQL table alias/);
    assert.throws(() => selectFrom(u).leftJoin(upper, sql`1 = 1`), /Duplicate SQL table alias/);
    assert.throws(() => selectFrom(u).select({ id: same.column('id') }), /outside.*scope/);
    assert.throws(() => selectFrom(u).where(sql`${same.column('id')} = ${1}`), /outside.*scope/);
    assert.throws(() => selectFrom(u).where(predicate), /outside.*scope/);
    assert.throws(() => selectFrom(u).innerJoin(p, sql`${same.column('id')} = ${p.column('id')}`), /outside.*scope/);
  });

  it('checks nested fragments and separators at the declaration point without a recursion limit', () => {
    const outside = table<{ id: number }>()('other', 'x').column('id');
    const separator = sql` OR ${outside} = ${1} OR `;
    const nested = join([sql`1 = 1`, sql`2 = 2`], separator);
    assert.throws(() => selectFrom(u).where(sql`(${nested})`), /outside.*scope/);
    let deep: SqlFragment = outside;
    for (let n = 0; n < 20000; n++) deep = sql`${deep}`;
    assert.throws(() => selectFrom(u).where(deep), /outside.*scope/);
    assert.throws(() => selectFrom(u).where(predicate).leftJoin(p, predicate), /outside.*scope/);
  });

  it('authenticates tables, columns and clauses by private identity', () => {
    const col = u.column('id');
    for (const fake of [{}, { ...u }, Object.create(u), new Proxy(u, {})]) {
      assert.throws(() => selectFrom(fake as typeof u), /genuine SQL table/);
      assert.throws(() => selectFrom(u).innerJoin(fake as typeof p, sql`1 = 1`), /genuine SQL table/);
    }
    for (const fake of [{}, { ...col }, Object.create(col), new Proxy(col, {}), identifier('u', 'id'), sql`1`]) {
      assert.throws(() => selectFrom(u).select({ id: fake as typeof col }), /genuine column/);
    }
    for (const fake of [{}, '1 = 1', null, { ...sql`1 = 1` }]) {
      assert.throws(() => selectFrom(u).where(fake as SqlFragment), /genuine SQL fragment/);
      assert.throws(() => selectFrom(u).leftJoin(p, fake as SqlFragment), /genuine SQL fragment/);
    }
    const copied = { ...col };
    assert.deepEqual(compile(sql`${copied}`, postgresDialect), { sql: '$1', params: [copied] });
  });

  it('validates aliases and named projection shape while physical names retain identifier quoting', () => {
    for (const alias of ['', 'a.b', 'a-b', 'a\u0000b', 'é', 'a'.repeat(64), null, 7]) {
      assert.throws(() => table<User>()('users', alias as never), /SQL aliases/);
    }
    for (const fields of [
      null,
      [],
      {},
      { 'bad-name': u.column('id') },
      { Id: u.column('id'), id: u.column('id') },
      { [Symbol()]: u.column('id') },
      {
        get id() {
          return u.column('id');
        },
      },
    ]) {
      assert.throws(() => selectFrom(u).select(fields as never), TypeError);
    }
    assert.throws(() => table<User>()([], 'u'), /non-empty strings/);
    assert.throws(() => u.column('' as never), /non-empty strings/);
    const quoted = table<{ 'x"y': number }>()(['odd"schema', 'odd.table'], 'q');
    assert.equal(
      compile(selectFrom(quoted).select({ val: quoted.column('x"y') }), postgresDialect).sql,
      'SELECT "q"."x""y" AS "val" FROM "odd""schema"."odd.table" AS "q"',
    );
  });
});

// Checked by strict tsc; none of these intentionally invalid calls execute.
function typeChecks() {
  const query = selectFrom(u)
    .leftJoin(p, predicate)
    .select({ id: u.column('id'), title: p.column('title'), team: u.column('team_id') });
  type Row = SqlResult<typeof query>;
  const ok: Row = { id: 1, title: null, team: null };
  const inner = selectFrom(u)
    .innerJoin(p, predicate)
    .select({ title: p.column('title') });
  const innerOk: SqlResult<typeof inner> = { title: 'x' };
  // @ts-expect-error Inner-joined non-null columns retain their declared value type.
  const innerBad: SqlResult<typeof inner> = { title: null };
  // @ts-expect-error The selected id is a number.
  const wrong: Row = { id: '1', title: null, team: 2 };
  // @ts-expect-error A left-joined column may be null.
  const noNull: { title: string } = ok;
  // @ts-expect-error Unknown column names are not accepted.
  u.column('missing');
  // @ts-expect-error A table outside the query cannot be selected.
  selectFrom(u).select({ title: p.column('title') });
  // @ts-expect-error An alias cannot be joined twice.
  selectFrom(u).innerJoin(u, predicate);
  // @ts-expect-error Raw fragments have no column value declaration.
  selectFrom(u).select({ id: sql`1` });
  // @ts-expect-error A selection is not a caller-selected result type argument.
  const missing: Row = { id: 1, title: null };
  // @ts-expect-error A widened alias loses static scope identity.
  table<User>()('users', 'dynamic' as string);
  void [ok, innerOk, innerBad, wrong, noNull, missing];
}
void typeChecks;

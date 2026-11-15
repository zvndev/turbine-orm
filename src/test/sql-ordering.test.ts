import assert from 'node:assert/strict';
import { it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import {
  compile,
  cte,
  identifier,
  type SqlColumn,
  type SqlOrder,
  type SqlResult,
  type SqlSelect,
  selectFrom,
  sql,
  table,
  unionAll,
  withCtes,
} from '../sql.js';
import { sqliteDialect } from '../sqlite.js';

const u = table<{ id: number; name: string; team: number | null }>()('users', 'u');
const p = table<{ user_id: number; title: string }>()('posts', 'p');
const on = sql`${u.column('id')} = ${p.column('user_id')}`;

for (const dialect of [postgresDialect, sqliteDialect, mysqlDialect, mssqlDialect]) {
  it(`${dialect.name}: ordering quotes genuine columns and emits one clause after predicates`, () => {
    const hostile = "x'); DROP TABLE users; --";
    const repeated = sql`${p.column('title')} = ${hostile}`;
    const query = selectFrom(u)
      .orderBy({ column: u.column('id'), direction: 'desc' })
      .leftJoin(p, on)
      .orderBy({ column: p.column('title'), direction: 'asc' }, { column: u.column('name'), direction: 'desc' })
      .where(sql`(${repeated}) OR (${repeated})`)
      .select({ id: u.column('id'), title: p.column('title') });
    const q = dialect.quoteIdentifier;
    const param = dialect.paramPlaceholder;
    assert.deepEqual(compile(query, dialect), {
      sql: `SELECT ${q('u')}.${q('id')} AS ${q('id')}, ${q('p')}.${q('title')} AS ${q('title')} FROM ${q('users')} AS ${q('u')} LEFT JOIN ${q('posts')} AS ${q('p')} ON (${q('u')}.${q('id')} = ${q('p')}.${q('user_id')}) WHERE ((${q('p')}.${q('title')} = ${param(1)}) OR (${q('p')}.${q('title')} = ${param(2)})) ORDER BY ${q('u')}.${q('id')} DESC, ${q('p')}.${q('title')} ASC, ${q('u')}.${q('name')} DESC`,
      params: [hostile, hostile],
    });
    const unusual = table<{ 'x"`]y': number }>()('odd.table', 'q');
    assert.equal(
      compile(
        selectFrom(unusual)
          .orderBy({ column: unusual.column('x"`]y'), direction: 'asc' })
          .select({ n: unusual.column('x"`]y') }),
        dialect,
      ).sql,
      `SELECT ${q('q')}.${q('x"`]y')} AS ${q('n')} FROM ${q('odd.table')} AS ${q('q')} ORDER BY ${q('q')}.${q('x"`]y')} ASC`,
    );
  });
}

it('ordering snapshots copy descriptors and key arrays without freezing caller values', () => {
  const value = { nested: [1] };
  const base = selectFrom(u).where(sql`${u.column('id')} = ${value}`);
  const fields = { id: u.column('id') };
  const before = compile(base.select(fields), postgresDialect);
  const key: { column: SqlColumn<unknown, 'u'>; direction: 'asc' | 'desc' } = {
    column: u.column('id'),
    direction: 'asc',
  };
  const keys: [SqlOrder<'u'>, ...SqlOrder<'u'>[]] = [key];
  const ordered = base.orderBy(...keys);
  const selected = ordered.select(fields);
  key.column = u.column('name');
  key.direction = 'desc';
  keys.push({ column: u.column('team'), direction: 'desc' });
  const later = ordered.orderBy({ column: u.column('team'), direction: 'desc' });
  assert.ok(Object.isFrozen(ordered));
  assert.ok(Object.isFrozen(selected));
  assert.ok(!Object.isFrozen(key));
  assert.ok(!Object.isFrozen(value));
  assert.deepEqual(before, {
    sql: 'SELECT "u"."id" AS "id" FROM "users" AS "u" WHERE ("u"."id" = $1)',
    params: [value],
  });
  assert.deepEqual(compile(base.select(fields), postgresDialect), before);
  assert.deepEqual(compile(selected, postgresDialect), {
    sql: `${before.sql} ORDER BY "u"."id" ASC`,
    params: [value],
  });
  assert.equal(
    compile(later.select(fields), postgresDialect).sql,
    `${before.sql} ORDER BY "u"."id" ASC, "u"."team" DESC`,
  );
  const repeated = compile(sql`SELECT ${9} WHERE EXISTS (${selected}) OR EXISTS (${selected})`, postgresDialect);
  assert.deepEqual(repeated.params, [9, value, value]);
  assert.strictEqual(repeated.params[1], value);
  assert.match(repeated.sql, /"u"\."id" = \$3/);
});

it('ordering rejects outside and same-alias foreign sources at the declaration point', () => {
  const same = table<{ id: number }>()('different_users', 'u');
  const base = selectFrom(u);
  assert.doesNotThrow(() => base.orderBy({ column: u.column('id'), direction: 'asc' }));
  for (const column of [p.column('title'), same.column('id')]) {
    assert.throws(() => base.orderBy({ column, direction: 'asc' } as never), /outside.*scope/);
  }
  assert.throws(
    () => base.orderBy({ column: p.column('title'), direction: 'desc' } as never).leftJoin(p, on),
    /outside.*scope/,
  );
  assert.doesNotThrow(() => base.leftJoin(p, on).orderBy({ column: p.column('title'), direction: 'asc' }));
});

it('ordering authenticates columns and only accepts explicit own descriptor values', () => {
  const column = u.column('id');
  const base = selectFrom(u);
  for (const fake of [
    {},
    { ...column },
    Object.create(column),
    new Proxy(column, {}),
    identifier('u', 'id'),
    sql`${column}`,
  ]) {
    assert.throws(() => base.orderBy({ column: fake, direction: 'asc' } as never), /genuine column/);
  }
  let reads = 0;
  const accessor = {
    get column() {
      reads++;
      return column;
    },
    direction: 'asc',
  };
  for (const key of [null, undefined, 'id', [], {}, accessor, Object.create({ column, direction: 'asc' })]) {
    assert.throws(() => base.orderBy(key as never), /genuine column/);
  }
  assert.equal(reads, 0);
  assert.throws(() => (base.orderBy as (...keys: SqlOrder<'u'>[]) => unknown)(), /at least one/);
  const caller = { column, direction: 'asc' };
  assert.deepEqual(compile(sql`${caller}`, postgresDialect), { sql: '$1', params: [caller] });
});

it('ordering rejects unchecked directions rather than interpolating SQL or coercing objects', () => {
  const base = selectFrom(u);
  const column = u.column('id');
  for (const direction of [
    '',
    'ASC',
    'ascending',
    'asc NULLS FIRST',
    'desc; DROP TABLE users',
    null,
    undefined,
    1,
    sql`ASC`,
    { toString: () => 'asc' },
  ]) {
    assert.throws(() => base.orderBy({ column, direction } as never), /direction must be asc or desc/);
  }
  assert.throws(
    () =>
      base.orderBy({
        column,
        get direction() {
          throw new Error('must not read getter');
        },
      } as never),
    /direction must be asc or desc/,
  );
  assert.equal(
    compile(base.select({ id: column }), postgresDialect).sql,
    'SELECT "u"."id" AS "id" FROM "users" AS "u"',
  );
});

it('ordered CTE references retain dependency identity, physical capture and nested WITH checks', () => {
  const one = selectFrom(u)
    .orderBy({ column: u.column('id'), direction: 'desc' })
    .select({ id: u.column('id') });
  const def = cte('chosen', one);
  const r = def.ref('r');
  const foreign = def.ref('r');
  assert.throws(() => selectFrom(r).orderBy({ column: foreign.column('id'), direction: 'asc' }), /outside.*scope/);
  const body = selectFrom(r)
    .orderBy({ column: r.column('id'), direction: 'asc' })
    .select({ id: r.column('id') });
  const complete = withCtes([def], body);
  assert.throws(() => compile(body, postgresDialect), /Unresolved SQL CTE/);
  assert.throws(() => compile(withCtes([cte('chosen', one)], body), postgresDialect), /Unresolved SQL CTE/);
  assert.throws(() => compile(withCtes([cte('users', one)], one), postgresDialect), /captures an unqualified/);
  const nested = withCtes([cte('outer_rows', one)], complete);
  assert.match(compile(nested, postgresDialect).sql, /SELECT \* FROM \(WITH/);
  const set = compile(unionAll(nested, complete), postgresDialect);
  assert.match(set.sql, /\) AS "_set" UNION ALL SELECT \* FROM \(WITH/);
});

// These calls are checked by strict tsc, never executed by the runtime suite.
function typeChecks() {
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  const key: SqlOrder<'u'> = { column: u.column('id'), direction: 'desc' };
  const left = selectFrom(u)
    .orderBy(key)
    .leftJoin(p, on)
    .orderBy({ column: p.column('title'), direction: 'asc' });
  const annotated: SqlSelect<'u' | 'p', 'p'> = left;
  const fields = { id: u.column('id'), title: p.column('title'), team: u.column('team') };
  const query = annotated.select(fields);
  const exact: Equal<SqlResult<typeof query>, { id: number; title: string | null; team: number | null }> = true;
  const inner = selectFrom(u)
    .innerJoin(p, on)
    .orderBy({ column: p.column('title'), direction: 'desc' })
    .select(fields);
  const innerExact: Equal<SqlResult<typeof inner>, { id: number; title: string; team: number | null }> = true;
  const c = cte('chosen', query).ref('r');
  const read = selectFrom(c)
    .orderBy({ column: c.column('title'), direction: 'asc' })
    .select({ title: c.column('title') });
  const cteExact: Equal<SqlResult<typeof read>, { title: string | null }> = true;
  // @ts-expect-error Ordering must not erase the left join's nullable scope.
  const erased: SqlSelect<'u' | 'p'> = left;
  // @ts-expect-error Ordering must not narrow a left-joined value to a non-null type.
  const narrowed: { title: string } = {} as SqlResult<typeof query>;
  // @ts-expect-error A column must be joined before ordering by it.
  selectFrom(u).orderBy({ column: p.column('title'), direction: 'asc' });
  // @ts-expect-error An unchecked string cannot choose SQL syntax.
  selectFrom(u).orderBy({ column: u.column('id'), direction: 'asc' as string });
  // @ts-expect-error Directions are explicit lowercase literals.
  selectFrom(u).orderBy({ column: u.column('id'), direction: 'ASC' });
  // @ts-expect-error Raw fragments are not authenticated columns.
  selectFrom(u).orderBy({ column: sql`1`, direction: 'asc' });
  // @ts-expect-error At least one key is required.
  selectFrom(u).orderBy();
  // @ts-expect-error Directions have no default.
  selectFrom(u).orderBy({ column: u.column('id') });
  // @ts-expect-error Ordering cannot change the caller-declared number type.
  const wrong: SqlResult<typeof query> = { id: '1', title: null, team: null };
  void [exact, innerExact, cteExact, erased, narrowed, wrong];
}
void typeChecks;

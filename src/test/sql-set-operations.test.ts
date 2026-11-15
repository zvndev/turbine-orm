import assert from 'node:assert/strict';
import { it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import {
  compile,
  cte,
  except,
  intersect,
  type SqlColumn,
  type SqlResult,
  type SqlSelect,
  selectFrom,
  sql,
  table,
  union,
  unionAll,
  withCtes,
} from '../sql.js';
import { sqliteDialect } from '../sqlite.js';

const t = table<{ id: number; label: string | null }>()('items', 't');
const one = selectFrom(t)
  .where(sql`${t.column('id')} > ${1} AND ${t.column('label')} = ${'two'}`)
  .select({ id: t.column('id'), label: t.column('label') });

for (const [name, operator] of [
  ['INTERSECT', intersect],
  ['EXCEPT', except],
] as const) {
  for (const dialect of [postgresDialect, sqliteDialect, mysqlDialect, mssqlDialect]) {
    it(`${name}: ${dialect.name} compilation preserves operand SQL and repeated parameter order`, () => {
      const branch = compile(one, dialect);
      const right = compile(sql`${one} ${one}`, dialect).sql.slice(branch.sql.length + 1);
      const result = operator(one, one);
      assert.deepEqual(compile(result, dialect), {
        sql: `SELECT * FROM (${branch.sql}) AS ${dialect.quoteIdentifier('_set')} ${name} SELECT * FROM (${right}) AS ${dialect.quoteIdentifier('_set')}`,
        params: [1, 'two', 1, 'two'],
      });
      const repeated = compile(sql`SELECT ${0} WHERE EXISTS (${operator(result, one)}) AND ${9} = ${9}`, dialect);
      assert.deepEqual(repeated.params, [0, 1, 'two', 1, 'two', 1, 'two', 9, 9]);
      assert.ok(repeated.sql.endsWith(`${dialect.paramPlaceholder(8)} = ${dialect.paramPlaceholder(9)}`));
      assert.ok(Object.isFrozen(result));
      assert.deepEqual(compile(one, dialect), branch);
    });
  }

  it(`${name}: ordered aliases and private selection identity are required on both sides`, () => {
    const reversed = selectFrom(t).select({ label: t.column('label'), id: t.column('id') });
    const missing = selectFrom(t).select({ id: t.column('id') });
    const renamed = selectFrom(t).select({ ID: t.column('id'), label: t.column('label') });
    for (const bad of [reversed, missing, renamed]) {
      assert.throws(() => operator(one, bad as never), new RegExp(`${name} requires identical ordered projection`));
      assert.throws(() => operator(bad as typeof one, one), /identical ordered projection/);
    }
    for (const fake of [sql`${one}`, sql``, {}, { ...one }, Object.create(one), new Proxy(one, {}), null]) {
      assert.throws(() => operator(fake as typeof one, one), /genuine closed SQL selection/);
      assert.throws(() => operator(one, fake as typeof one), /genuine closed SQL selection/);
    }
    assert.throws(
      () => selectFrom(t).where(sql`${table<{ id: number }>()('other', 'x').column('id')} = ${1}`),
      /outside.*scope/,
    );
  });

  it(`${name}: closed sets retain CTE visibility, capture protection and independent column scopes`, () => {
    const def = cte('chosen', one);
    const ref = def.ref('r');
    const read = selectFrom(ref).select({ id: ref.column('id'), label: ref.column('label') });
    const complete = withCtes([def], read);
    assert.deepEqual(compile(operator(complete, complete), postgresDialect).params, [1, 'two', 1, 'two']);
    assert.deepEqual(compile(withCtes([def], operator(read, read)), postgresDialect).params, [1, 'two']);
    for (const incomplete of [operator(read, one), operator(one, read)]) {
      assert.throws(() => compile(incomplete, postgresDialect), /Unresolved SQL CTE/);
      assert.throws(() => compile(withCtes([cte('chosen', one)], incomplete), postgresDialect), /Unresolved SQL CTE/);
    }
    const next = cte('next', read);
    const n = next.ref('n');
    const nextRead = selectFrom(n).select({ id: n.column('id'), label: n.column('label') });
    assert.throws(() => compile(withCtes([next, def], operator(nextRead, one)), postgresDialect), /Unresolved SQL CTE/);
    assert.throws(
      () => compile(withCtes([def], operator(withCtes([cte('inner_rows', one)], read), one)), postgresDialect),
      /Unresolved SQL CTE/,
    );
    const capture = cte('items', one);
    assert.throws(
      () => compile(withCtes([capture], operator(one, one)), postgresDialect),
      /captures an unqualified physical table/,
    );
    const outer = table<{ id: number }>()('outer_items', 'o');
    assert.doesNotThrow(() => selectFrom(outer).where(sql`EXISTS (${operator(complete, one)})`));
    assert.throws(
      () => selectFrom(outer).where(sql`${ref.column('id')} IN (${operator(complete, one)})`),
      /outside.*scope/,
    );
    assert.match(
      compile(operator(union(one, one), unionAll(one, one)), postgresDialect).sql,
      new RegExp(`\\) AS "_set" ${name} SELECT`),
    );
  });
}

// Compiled by the existing strict source typecheck; never executed as database code.
function typeControls() {
  const p = table<{ id: 1 | 2; label: 'value' }>()('posts', 'p');
  const joined = selectFrom(t)
    .leftJoin(p, sql`${t.column('id')} = ${p.column('id')}`)
    .select({ id: t.column('id'), label: p.column('label') });
  const narrow = selectFrom(p).select({ id: p.column('id'), label: p.column('label') });
  const text = selectFrom(p).select({ id: p.column('label'), label: p.column('label') });
  const optionalFields: { id: SqlColumn<number, 't'>; label?: SqlColumn<string | null, 't'> } = {
    id: t.column('id'),
    label: t.column('label'),
  };
  const optional = selectFrom(t).select(optionalFields);
  const broadFields: Record<string, SqlColumn<number, 't'>> = { id: t.column('id') };
  const broad = selectFrom(t).select(broadFields);
  for (const operator of [intersect, except]) {
    const result = operator(joined, narrow);
    const nullable: SqlResult<typeof result> = { id: 3, label: null };
    const value: number = nullable.id;
    void value;
    // @ts-expect-error Set operations retain left-join nullability conservatively.
    const required: string = nullable.label;
    void required;
    // @ts-expect-error Required named fields must match.
    operator(one, selectFrom(t).select({ id: t.column('id') }));
    // @ts-expect-error Declared value categories must match.
    operator(one, text);
    // @ts-expect-error Optional projection shapes remain refused.
    operator(optional, optional);
    // @ts-expect-error Broad projection aliases remain refused.
    operator(broad, broad);
    // @ts-expect-error Raw fragments cannot declare a typed projection.
    operator(sql`SELECT 1`, one);
    // @ts-expect-error Raw wrappers discard selection metadata.
    operator(one, sql`${one}`);
  }
  // @ts-expect-error Nullable join scope cannot be erased.
  const erased: SqlSelect<'t' | 'p'> = selectFrom(t).leftJoin(p, sql`TRUE`);
  void erased;
  // @ts-expect-error Optional projections retain their declared nullable value.
  const missing: undefined = (null as unknown as SqlResult<typeof optional>).label;
  void missing;
}
void typeControls;

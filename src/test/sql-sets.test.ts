import assert from 'node:assert/strict';
import { it } from 'node:test';
import { compile, cte, selectFrom, sql, table, union, unionAll, withCtes } from '../sql.js';

const dialect = {
  paramPlaceholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
};
const t = table<{ id: number; name: string }>()('items', 't');
const predicate = sql`${t.column('id')} > ${1} AND ${t.column('name')} = ${'two'}`;
const one = selectFrom(t)
  .where(predicate)
  .select({ id: t.column('id'), name: t.column('name') });

it('UNION and UNION ALL compile closed operands with deterministic repeated offsets', () => {
  const all = unionAll(one, one);
  assert.deepEqual(compile(all, dialect), {
    sql: 'SELECT * FROM (SELECT "t"."id" AS "id", "t"."name" AS "name" FROM "items" AS "t" WHERE ("t"."id" > $1 AND "t"."name" = $2)) AS "_set" UNION ALL SELECT * FROM (SELECT "t"."id" AS "id", "t"."name" AS "name" FROM "items" AS "t" WHERE ("t"."id" > $3 AND "t"."name" = $4)) AS "_set"',
    params: [1, 'two', 1, 'two'],
  });
  const built = compile(sql`SELECT ${'start'} WHERE EXISTS (${union(all, one)}) AND ${'end'} = ${'end'}`, dialect);
  assert.deepEqual(built.params, ['start', 1, 'two', 1, 'two', 1, 'two', 'end', 'end']);
  assert.match(built.sql, /\$8 = \$9/);
  assert.match(built.sql, /\) AS "_set" UNION SELECT/);
  assert.ok(Object.isFrozen(all));
  assert.deepEqual(compile(one, dialect).params, [1, 'two']);
});

it('positional operands require identical ordered aliases and arity', () => {
  const reversed = selectFrom(t).select({ name: t.column('name'), id: t.column('id') });
  const missing = selectFrom(t).select({ id: t.column('id') });
  const renamed = selectFrom(t).select({ ID: t.column('id'), name: t.column('name') });
  for (const operator of [union, unionAll]) {
    assert.throws(() => operator(one, reversed), /identical ordered projection aliases and arity/);
    assert.throws(() => operator(one, missing as never), /identical ordered projection aliases and arity/);
    assert.throws(() => operator(one, renamed as never), /identical ordered projection aliases and arity/);
  }
});

it('sets authenticate both operands and never promote raw wrappers into typed selections', () => {
  for (const fake of [sql`${one}`, sql``, {}, { ...one }, Object.create(one), new Proxy(one, {})]) {
    for (const operator of [union, unionAll]) {
      assert.throws(() => operator(fake as typeof one, one), /genuine closed SQL selection/);
      assert.throws(() => operator(one, fake as typeof one), /genuine closed SQL selection/);
    }
  }
});

it('sets compose inside CTE definitions and complete WITH statements inside operands', () => {
  const def = cte('combined', unionAll(one, one));
  const ref = def.ref('r');
  const complete = withCtes([def], selectFrom(ref).select({ id: ref.column('id'), name: ref.column('name') }));
  assert.deepEqual(compile(union(complete, one), dialect).params, [1, 'two', 1, 'two', 1, 'two']);
  assert.match(compile(union(complete, complete), dialect).sql, /^SELECT \* FROM \(WITH "combined"/);
  assert.throws(
    () => compile(union(selectFrom(ref).select({ id: ref.column('id'), name: ref.column('name') }), one), dialect),
    /Unresolved SQL CTE/,
  );
});

import assert from 'node:assert/strict';
import { it } from 'node:test';
import { compile, cte, identifier, join, selectFrom, sql, table, unionAll, withCtes } from '../sql.js';

const dialect = {
  paramPlaceholder: (index: number) => `$${index}`,
  quoteIdentifier: (name: string) => `"${name.replaceAll('"', '""')}"`,
};
const t = table<{ id: number; name: string }>()('items', 't');
const seed = selectFrom(t)
  .where(sql`${t.column('id')} > ${1}`)
  .select({ id: t.column('id') });
const first = cte('first', seed);
const a = first.ref('a');
const next = cte(
  'next',
  selectFrom(a)
    .where(sql`${a.column('id')} < ${9}`)
    .select({ id: a.column('id') }),
);
const b = next.ref('b');
const body = selectFrom(b).select({ id: b.column('id') });

it('compiles ordered CTE dependencies with complete parameter traversal and reusable references', () => {
  const other = first.ref('other');
  const query = withCtes(
    [first, next],
    selectFrom(b)
      .innerJoin(other, sql`${b.column('id')} = ${other.column('id')} AND ${2} = ${2}`)
      .where(sql`${b.column('id')} IN (${selectFrom(a).select({ id: a.column('id') })})`)
      .select({ id: b.column('id') }),
  );
  const built = compile(sql`SELECT ${0} WHERE EXISTS (${query}) OR EXISTS (${query})`, dialect);
  assert.deepEqual(built.params, [0, 1, 9, 2, 2, 1, 9, 2, 2]);
  assert.match(built.sql, /"first" AS \(SELECT .*\$2.*"next" AS \(SELECT .*\$3/);
  assert.match(built.sql, /"first" AS "other"/);
  assert.match(built.sql, /\$8 = \$9/);
  assert.deepEqual(compile(query, dialect).params, [1, 9, 2, 2]);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(a));
});

it('refuses omitted and forward definitions through complete selections and raw wrappers', () => {
  for (const query of [body, sql`(${body})`, withCtes([next], body), withCtes([next, first], body)]) {
    assert.throws(() => compile(query, dialect), /Unresolved SQL CTE.*omitted, forward or recursive/);
  }
  const impostor = cte('first', seed);
  const read = selectFrom(a).select({ id: a.column('id') });
  assert.throws(() => compile(withCtes([impostor], read), dialect), /Unresolved SQL CTE/);
  assert.doesNotThrow(() => compile(withCtes([first, next], body), dialect));
});

it('nested WITH owns its scope while closed plain subqueries inherit CTE visibility', () => {
  const local = cte('local', seed);
  const l = local.ref('l');
  const capture = withCtes(
    [local],
    selectFrom(l)
      .where(sql`${l.column('id')} IN (${selectFrom(a).select({ id: a.column('id') })})`)
      .select({ id: l.column('id') }),
  );
  const outer = withCtes(
    [first],
    selectFrom(t)
      .where(sql`${t.column('id')} IN (${capture})`)
      .select({ id: t.column('id') }),
  );
  assert.throws(() => compile(outer, dialect), /Unresolved SQL CTE/);
  const nested = withCtes([local], selectFrom(l).select({ id: l.column('id') }));
  assert.deepEqual(
    compile(
      withCtes(
        [first],
        selectFrom(a)
          .where(sql`${a.column('id')} IN (${nested})`)
          .select({ id: a.column('id') }),
      ),
      dialect,
    ).params,
    [1, 1],
  );
});

it('CTE references retain column provenance and cannot correlate free table scopes', () => {
  const sibling = first.ref('a');
  assert.throws(() => selectFrom(a).select({ id: sibling.column('id') }), /outside.*scope/);
  assert.throws(
    () => selectFrom(a).where(sql`${join([sql`TRUE`, sql`TRUE`], sql` OR ${t.column('id')} > ${0} OR `)}`),
    /outside.*scope/,
  );
  assert.throws(() => selectFrom(a).where(sql`${t.column('id')} = ${a.column('id')}`), /outside.*scope/);
  assert.throws(() => a.column('name' as never), /Unknown SQL CTE projection column/);
  assert.throws(() => selectFrom(a).innerJoin(sibling as never, sql`TRUE`), /Duplicate SQL table alias/);
});

it('authenticates definitions, closed bodies and references; rejects malformed arrays and aliases', () => {
  for (const fake of [{}, { ...first }, Object.create(first), new Proxy(first, {})]) {
    assert.throws(() => withCtes([fake as typeof first], body), /genuine SQL CTE definition/);
  }
  for (const fake of [sql`SELECT 1`, identifier('id'), { ...seed }, Object.create(seed), new Proxy(seed, {})]) {
    assert.throws(() => cte('fake', fake as typeof seed), /genuine closed SQL selection/);
    assert.throws(() => withCtes([first], fake as typeof seed), /genuine closed SQL selection/);
  }
  for (const defs of [[], null, {}, new Array(1), [undefined]]) {
    assert.throws(() => withCtes(defs as never, body), TypeError);
  }
  const misleading = [first];
  misleading[Symbol.iterator] = () => [][Symbol.iterator]();
  assert.deepEqual(compile(withCtes(misleading, selectFrom(a).select({ id: a.column('id') })), dialect).params, [1]);
  assert.throws(() => withCtes([first, first], body), /Duplicate SQL CTE name/);
  assert.throws(() => withCtes([first, cte('FIRST', seed)], body), /Duplicate SQL CTE name/);
  assert.throws(() => cte('bad"; --', seed), /SQL aliases/);
  assert.throws(() => first.ref('bad-alias' as never), /SQL aliases/);
  assert.throws(() => selectFrom({ ...a }), /genuine SQL table/);
});

it('retains escaped physical identifiers and only declared projected CTE column names', () => {
  const hostile = table<{ 'value"; --': string }>()(['odd"schema', 'odd.table'], 'h');
  const definition = cte('quoted', selectFrom(hostile).select({ value: hostile.column('value"; --') }));
  const h = definition.ref('h');
  assert.equal(
    compile(withCtes([definition], selectFrom(h).select({ result: h.column('value') })), dialect).sql,
    'WITH "quoted" AS (SELECT "h"."value""; --" AS "value" FROM "odd""schema"."odd.table" AS "h") SELECT "h"."value" AS "result" FROM "quoted" AS "h"',
  );
});

it('refuses physical name capture throughout nested SQL scopes, including unused and forward names', () => {
  const source = table<{ id: number }>()('other_items', 'o');
  const capture = cte('ITEMS', selectFrom(source).select({ id: source.column('id') }));
  const physical = selectFrom(t).select({ id: t.column('id') });
  const nested = withCtes([first], physical);
  for (const query of [
    withCtes([capture], physical),
    withCtes([capture], nested),
    withCtes([capture], unionAll(nested, physical)),
    withCtes([first, capture], body),
    withCtes([cte('items', physical)], physical),
  ])
    assert.throws(() => compile(query, dialect), /captures an unqualified physical table/);
  const qualified = table<{ id: number }>()(['main', 'items'], 'q');
  assert.doesNotThrow(() =>
    compile(withCtes([capture], selectFrom(qualified).select({ id: qualified.column('id') })), dialect),
  );
});

it('wraps a complete WITH body as a derived selection without changing parameter order', () => {
  const inner = withCtes([first], selectFrom(a).select({ id: a.column('id') }));
  const outer = withCtes([cte('unused', seed)], inner);
  const compiled = compile(outer, dialect);
  assert.match(compiled.sql, /SELECT \* FROM \(WITH /);
  assert.deepEqual(compiled.params, [1, 1]);
  assert.deepEqual(compile(withCtes([cte('third', seed)], outer), dialect).params, [1, 1, 1]);
});

#!/usr/bin/env node
// Packed runtime and strict-type smoke with no installed pg or optional peers.
// Run after npm run build: node scripts/check-sql-fragments.mjs [tarball]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'turbine-sql-consumer-'));
const run = (command, args, cwd = directory) =>
  execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

try {
  const tarball = process.argv[2]
    ? resolve(process.argv[2])
    : join(directory, run('npm', ['pack', '--silent', '--pack-destination', directory], root).trim().split('\n').at(-1));
  const installed = join(directory, 'node_modules', 'turbine-orm');
  mkdirSync(installed, { recursive: true });
  run('tar', ['-xzf', tarball, '--strip-components=1', '-C', installed]);
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'turbine-orm');
  assert.equal(manifest.exports['./sql'].import.default, './dist/sql.js');
  assert.equal(manifest.exports['./sql'].require.default, './dist/cjs/sql.js');

  for (const path of ['dist/sql.js', 'dist/cjs/sql.js']) {
    const source = readFileSync(join(installed, path), 'utf8');
    assert.ok(source.length > 0);
    assert.doesNotMatch(source, /\b(?:import|require)\s*\(/);
    assert.doesNotMatch(source, /^\s*import\s/m);
  }

  // A structural dialect also proves this entry can load and typecheck without
  // any Node types, driver packages or other Turbine entry points installed.
  const body = [
    'const quote = String.fromCharCode(34);',
    'const dialect = { paramPlaceholder: i => "$" + i, quoteIdentifier: n => quote + n.split(quote).join(quote + quote) + quote };',
    'const hostile = "x\'); DROP TABLE users; --";',
    'const predicate = sql`${identifier("u", "id")} IN (${join([1, hostile])})`;',
    'const built = compile(sql`SELECT ${false} WHERE ${predicate} OR (${predicate})`, dialect);',
    'assert.deepEqual(built, { sql: \'SELECT $1 WHERE "u"."id" IN ($2, $3) OR ("u"."id" IN ($4, $5))\', params: [false, 1, hostile, 1, hostile] });',
    'assert.deepEqual(compile(sql`SELECT ${JSON.parse(\'{"sql":"DROP TABLE users"}\')}`, dialect).sql, "SELECT $1");',
    'assert.throws(() => compile(JSON.parse("{}"), dialect), /genuine SQL fragment/);',
    'const u = table()("users", "u"); const p = table()("posts", "p");',
    'const on = sql`${u.column("id")} = ${p.column("user_id")}`;',
    'const selected = selectFrom(u).leftJoin(p, on).where(sql`${p.column("title")} = ${hostile}`).select({ id: u.column("id"), title: p.column("title") });',
    'assert.deepEqual(compile(selected, dialect), { sql: \'SELECT "u"."id" AS "id", "p"."title" AS "title" FROM "users" AS "u" LEFT JOIN "posts" AS "p" ON ("u"."id" = "p"."user_id") WHERE ("p"."title" = $1)\', params: [hostile] });',
    'assert.deepEqual(compile(sql`(${selected}) UNION ALL (${selected})`, dialect).params, [hostile, hostile]);',
    'assert.throws(() => selectFrom(u).where(on), /outside.*scope/);',
    'assert.throws(() => selectFrom(u).leftJoin(u, on), /Duplicate SQL table alias/);',
    'assert.throws(() => selectFrom({ ...u }), /genuine SQL table/);',
    'assert.throws(() => selectFrom(u).select({ id: { ...u.column("id") } }), /genuine column/);',

    'const orderBase = selectFrom(u).where(sql`${u.column("id")} > ${0}`);',
    'const orderKey = { column: u.column("id"), direction: "desc" };',
    'const ordered = orderBase.orderBy(orderKey).leftJoin(p, on).orderBy({ column: p.column("title"), direction: "asc" }).select({ id: u.column("id"), title: p.column("title") });',
    'orderKey.direction = "asc"; orderKey.column = u.column("name");',
    'assert.match(compile(ordered, dialect).sql, / ORDER BY "u"\\."id" DESC, "p"\\."title" ASC$/);',
    'assert.deepEqual(compile(sql`SELECT ${9} WHERE EXISTS (${ordered}) OR EXISTS (${ordered})`, dialect).params, [9, 0, 0]);',
    'assert.doesNotMatch(compile(orderBase.select({ id: u.column("id") }), dialect).sql, /ORDER BY/);',
    'assert.throws(() => selectFrom(u).orderBy({ column: p.column("title"), direction: "asc" }), /outside.*scope/);',
    'assert.throws(() => selectFrom(u).orderBy({ column: table()("other_users", "u").column("id"), direction: "asc" }), /outside.*scope/);',
    'assert.throws(() => selectFrom(u).orderBy({ column: { ...u.column("id") }, direction: "asc" }), /genuine column/);',
    'assert.throws(() => selectFrom(u).orderBy({ column: identifier("u", "id"), direction: "asc" }), /genuine column/);',
    'assert.throws(() => selectFrom(u).orderBy({ column: u.column("id"), direction: "desc; DROP TABLE users" }), /direction must be asc or desc/);',
    'const orderedDef = cte("ordered_rows", ordered); const orderedRef = orderedDef.ref("r");',
    'const orderedComplete = withCtes([orderedDef], selectFrom(orderedRef).orderBy({ column: orderedRef.column("id"), direction: "asc" }).select({ id: orderedRef.column("id"), title: orderedRef.column("title") }));',
    'assert.deepEqual(compile(unionAll(orderedComplete, ordered), dialect).params, [0, 0]);',
    'const def = cte("chosen", selected); const ref = def.ref("r");',
    'const read = selectFrom(ref).select({ id: ref.column("id"), title: ref.column("title") });',
    'const complete = withCtes([def], read);',
    'assert.match(compile(withCtes([cte("outer", selected)], complete), dialect).sql, /SELECT \\* FROM \\(WITH /);',
    'assert.throws(() => compile(withCtes([cte("users", selected)], selected), dialect), /captures an unqualified physical table/);',
    'assert.deepEqual(compile(unionAll(complete, complete), dialect).params, [hostile, hostile]);',
    'assert.match(compile(union(complete, selected), dialect).sql, /UNION SELECT/);',
    'assert.throws(() => compile(read, dialect), /Unresolved SQL CTE/);',
    'assert.throws(() => withCtes([{ ...def }], read), /genuine SQL CTE/);',
    'assert.throws(() => union(selected, selectFrom(u).leftJoin(p, on).select({ title: p.column("title"), id: u.column("id") })), /ordered projection/);',
    'assert.throws(() => cte("raw", sql`SELECT 1`), /genuine closed SQL selection/);',
    'for (const [name, op] of [["INTERSECT", intersect], ["EXCEPT", except]]) {',
    ' const result = op(complete, selected);',
    ' assert.match(compile(result, dialect).sql, new RegExp(name + " SELECT"));',
    ' assert.deepEqual(compile(sql`SELECT ${9} WHERE EXISTS (${op(result, selected)}) AND ${7} = ${7}`, dialect).params, [9, hostile, hostile, hostile, 7, 7]);',
    ' assert.ok(Object.isFrozen(result));',
    ' assert.throws(() => op(selected, selectFrom(u).leftJoin(p, on).select({ title: p.column("title"), id: u.column("id") })), /ordered projection/);',
    ' for (const fake of [sql`${selected}`, { ...selected }, Object.create(selected), new Proxy(selected, {})]) {',
    '  assert.throws(() => op(fake, selected), /genuine closed SQL selection/);',
    '  assert.throws(() => op(selected, fake), /genuine closed SQL selection/);',
    ' }',
    ' assert.throws(() => compile(op(read, selected), dialect), /Unresolved SQL CTE/);',
    '}',


  ].join('\n');
  for (const [extension, imports] of [
    ['mjs', 'import assert from "node:assert/strict"; import { sql, identifier, join, compile, table, selectFrom, cte, withCtes, union, unionAll, intersect, except } from "turbine-orm/sql";'],
    ['cjs', 'const assert = require("node:assert/strict"); const { sql, identifier, join, compile, table, selectFrom, cte, withCtes, union, unionAll, intersect, except } = require("turbine-orm/sql");'],
  ]) {
    const path = join(directory, `consumer.${extension}`);
    writeFileSync(path, `${imports}\n${body}\n`);
    run(process.execPath, [path]);
  }

  const crossCopy = join(directory, 'cross-copy.mjs');
  writeFileSync(crossCopy, [
    'import assert from "node:assert/strict"; import { createRequire } from "node:module";',
    'import * as esm from "turbine-orm/sql";',
    'const cjs = createRequire(import.meta.url)("turbine-orm/sql");',
    'for (const [a, b] of [[esm, cjs], [cjs, esm]]) {',
    ' const t = a.table()("users", "u"); const q = a.selectFrom(t).select({ id: t.column("id") }); const d = a.cte("chosen", q);',
    ' assert.throws(() => b.cte("foreign", q), /genuine closed SQL selection/);',
    ' assert.throws(() => b.selectFrom(d.ref("r")), /genuine SQL table/);',
    ' const local = b.table()("users", "u"); const body = b.selectFrom(local).select({ id: local.column("id") });',
    ' assert.throws(() => b.withCtes([d], body), /genuine SQL CTE/);',
    ' assert.throws(() => b.union(body, q), /genuine closed SQL selection/);',
    ' for (const op of [b.intersect, b.except]) {',
    '  assert.throws(() => op(body, q), /genuine closed SQL selection/);',
    '  assert.throws(() => op(q, body), /genuine closed SQL selection/);',
    ' }',
    ' assert.throws(() => b.selectFrom(local).orderBy({ column: t.column("id"), direction: "asc" }), /genuine column/);',
    '}',
  ].join('\n'));
  run(process.execPath, [crossCopy]);

  const typeSource = [
    'import { sql, identifier, join, compile, table, selectFrom, cte, withCtes, union, unionAll, intersect, except, type SqlSelect, type SqlColumn, type SqlResult, type SqlFragment, type SqlDialect, type CompiledSql } from "turbine-orm/sql";',
    'const dialect: SqlDialect = { paramPlaceholder: i => "$" + i, quoteIdentifier: n => n };',
    'const fragment: SqlFragment = sql`SELECT ${join([1, 2])} FROM ${identifier("users")}`;',
    'const compiled: CompiledSql = compile(fragment, dialect);',
    'const text: string = compiled.sql; const params: unknown[] = compiled.params; void text; void params;',
    '// @ts-expect-error A plain object is not a genuine fragment.',
    'compile({}, dialect);',
    '// @ts-expect-error A separator is a fragment, not request text.',
    'join([1, 2], " OR ");',
    'const u = table<{ id: number; name: string; team_id: number | null }>()("users", "u");',
    'const p = table<{ user_id: number; title: string }>()("posts", "p");',
    'const on = sql`${u.column("id")} = ${p.column("user_id")}`;',
    'const query = selectFrom(u).leftJoin(p, on).select({ id: u.column("id"), title: p.column("title"), team: u.column("team_id") });',
    'type Row = SqlResult<typeof query>;',
    'const left = selectFrom(u).leftJoin(p, on);',
    '// @ts-expect-error An annotation cannot erase a left-joined nullable scope.',
    'const erased: SqlSelect<"u" | "p"> = left; void erased;',
    'const annotated: SqlSelect<"u" | "p", "p"> = left;',
    'const fields: { id: SqlColumn<number, "u">; title?: SqlColumn<string, "p"> } = { id: u.column("id"), title: p.column("title") };',
    'const optional = annotated.select(fields);',
    'const present: SqlResult<typeof optional> = { id: 1, title: "actual" }; void present;',
    'const absent: SqlResult<typeof optional> = { id: 1 }; void absent;',
    'const nullable: SqlResult<typeof optional> = { id: 1, title: null }; void nullable;',
    'declare const optionalRow: SqlResult<typeof optional>;',
    'const optionalTitle: string | null | undefined = optionalRow.title; void optionalTitle;',
    '// @ts-expect-error Optional does not mean every present field is undefined.',
    'const undefinedOnly: undefined = optionalRow.title; void undefinedOnly;',

    'type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;',
    'const exact: Equal<Row, { id: number; title: string | null; team: number | null }> = true; void exact;',

    'const orderKey: import("turbine-orm/sql").SqlOrder<"u"> = { column: u.column("id"), direction: "desc" };',
    'const orderedLeft = selectFrom(u).orderBy(orderKey).leftJoin(p, on).orderBy({ column: p.column("title"), direction: "asc" });',
    'const orderedQuery = orderedLeft.select({ id: u.column("id"), title: p.column("title"), team: u.column("team_id") });',
    'const orderedExact: Equal<SqlResult<typeof orderedQuery>, Row> = true; void orderedExact;',
    '// @ts-expect-error Ordering preserves the nullable scope.',
    'const orderErased: SqlSelect<"u" | "p"> = orderedLeft; void orderErased;',
    '// @ts-expect-error Ordering only uses columns already in scope.',
    'selectFrom(u).orderBy({ column: p.column("title"), direction: "asc" });',
    '// @ts-expect-error Unchecked strings cannot select SQL syntax.',
    'selectFrom(u).orderBy({ column: u.column("id"), direction: "asc" as string });',
    '// @ts-expect-error An ordering key is an authenticated column.',
    'selectFrom(u).orderBy({ column: sql`1`, direction: "asc" });',
    'const row: Row = { id: 1, title: null, team: null }; void row;',
    'const inner = selectFrom(u).innerJoin(p, on).select({ title: p.column("title") });',
    'const nonNull: Equal<SqlResult<typeof inner>, { title: string }> = true; void nonNull;',
    'const def = cte("chosen", query); const ref = def.ref("r");',
    'const complete = withCtes([def], selectFrom(ref).select({ id: ref.column("id"), title: ref.column("title"), team: ref.column("team") }));',
    'const combined = unionAll(complete, selectFrom(u).innerJoin(p, on).select({ id: u.column("id"), title: p.column("title"), team: u.column("team_id") }));',
    'const setExact: Equal<SqlResult<typeof combined>, Row> = true; void setExact;',
    'const setNullable: SqlResult<typeof combined> = { id: 1, title: null, team: null }; void setNullable;',
    'const literalA = table<{ value: "a"; n: 1 }>()("a", "la"); const literalB = table<{ value: "b" | null; n: 2 }>()("b", "lb");',
    'const literals = union(selectFrom(literalA).select({ value: literalA.column("value"), n: literalA.column("n") }), selectFrom(literalB).select({ value: literalB.column("value"), n: literalB.column("n") }));',
    'const literalExact: Equal<SqlResult<typeof literals>, { value: "a" | "b" | null; n: 1 | 2 }> = true; void literalExact;',

    'for (const op of [intersect, except]) {',
    ' const result = op(complete, combined);',
    ' const exact: Equal<SqlResult<typeof result>, Row> = true; void exact;',
    ' const literalResult = op(literals, literals);',
    ' const literalExact: Equal<SqlResult<typeof literalResult>, SqlResult<typeof literals>> = true; void literalExact;',
    ' const declaredNull = table<{ value: null; n: 2 }>()("nulls", "n");',
    ' const nullResult = op(literals, selectFrom(declaredNull).select({ value: declaredNull.column("value"), n: declaredNull.column("n") }));',
    ' const nullExact: Equal<SqlResult<typeof nullResult>, SqlResult<typeof literals>> = true; void nullExact;',
    '}',
    'const optionalFields: { id: SqlColumn<number, "u">; title?: SqlColumn<string, "p"> } = { id: u.column("id"), title: p.column("title") };',
    'const optionalQuery = selectFrom(u).leftJoin(p, on).select(optionalFields);',
    'const optionalExact: Equal<SqlResult<typeof optionalQuery>, { id: number; title?: string | null }> = true; void optionalExact;',
    'const optionalResult: SqlResult<typeof optionalQuery> = { id: 1, title: "actual" }; void optionalResult;',
    '// @ts-expect-error Required private scope metadata prevents nullable annotation erasure.',
    'const erasedAdvanced: SqlSelect<"u" | "p"> = selectFrom(u).leftJoin(p, on); void erasedAdvanced;',
    '// @ts-expect-error Missing a projected alias.',
    'union(query, inner);',
    '// @ts-expect-error Raw wrappers have no closed projection metadata.',
    'union(query, sql`${query}`);',
    '// @ts-expect-error CTE column names come from its projection.',
    'ref.column("missing");',
    '// @ts-expect-error Optional output shapes are not fixed set projections.',
    'unionAll(optionalQuery, optionalQuery);',
    'const textId = table<{ id: string }>()("text_ids", "s");',
    '// @ts-expect-error Declared number and string value categories are incompatible.',
    'union(selectFrom(u).select({ id: u.column("id") }), selectFrom(textId).select({ id: textId.column("id") }));',

    '// @ts-expect-error No column with this declared name.',
    'u.column("typo");',
    '// @ts-expect-error A selected column must be in the declared scope.',
    'selectFrom(u).select({ title: p.column("title") });',
    '// @ts-expect-error The joined alias is already in scope.',
    'selectFrom(u).innerJoin(u, on);',
    '// @ts-expect-error Raw fragments have no declared column type.',
    'selectFrom(u).select({ id: sql`1` });',
    '// @ts-expect-error Missing the selected team field.',
    'const missing: Row = { id: 1, title: null }; void missing;',
    '// @ts-expect-error A left-joined value can be null.',
    'const requiredTitle: string = row.title; void requiredTitle;',
    '// @ts-expect-error Inner-joined non-nullable columns do not acquire null.',
    'const badInner: SqlResult<typeof inner> = { title: null }; void badInner;',
  ].join('\n');
  for (const extension of ['mts', 'cts']) writeFileSync(join(directory, `consumer.${extension}`), typeSource);
  writeFileSync(join(directory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, skipLibCheck: false, noEmit: true, types: [] },
    files: ['consumer.mts', 'consumer.cts'],
  }));
  run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', join(directory, 'tsconfig.json')]);
  // Each format must also produce a real compiler failure without suppression.
  for (const extension of ['mts', 'cts']) {
    const negative = join(directory, `negative.${extension}`);
    writeFileSync(negative, 'import { table, selectFrom } from "turbine-orm/sql";\nconst u = table<{ id: number }>()("users", "u");\nconst p = table<{ title: string }>()("posts", "p");\nselectFrom(u).select({ title: p.column("title") });\n');
    const config = join(directory, `negative-${extension}.json`);
    writeFileSync(config, JSON.stringify({ extends: './tsconfig.json', files: [negative] }));
    let failed = false;
    try {
      run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', config]);
    } catch (error) {
      assert.match(error.stdout, /TS2322/);
      assert.match(error.stdout, /SqlColumn<string, "p">/);
      console.log(`Expected strict ${extension} rejection: ${error.stdout.trim()}`);
      failed = true;
    }
    assert.ok(failed, `strict ${extension} negative consumer must fail`);
  }
  const prelude = [
    'import { table, selectFrom, cte, withCtes, union, unionAll, intersect, except, sql, type SqlSelect, type SqlColumn } from "turbine-orm/sql";',
    'const u = table<{ id: number }>()("users", "u");',
    'const p = table<{ id: number; title: string }>()("posts", "p");',
    'const one = selectFrom(u).select({ id: u.column("id") });',
  ].join('\n');
  const negatives = [

    ['order-scope', 'selectFrom(u).orderBy({ column: p.column("title"), direction: "asc" });', /SqlColumn<string, "p">/],
    ['order-direction', 'selectFrom(u).orderBy({ column: u.column("id"), direction: "asc" as string });', /string.*(?:"asc".*"desc"|"desc".*"asc")/],
    ['order-raw', 'selectFrom(u).orderBy({ column: sql`1`, direction: "asc" });', /SqlFragment.*SqlColumn|columnBrand/],
    ['order-nullable', 'const erased: SqlSelect<"u" | "p"> = selectFrom(u).leftJoin(p, sql`TRUE`).orderBy({ column: p.column("title"), direction: "asc" }); void erased;', /"p".*never/],
    ['set-keys', 'union(one, selectFrom(p).select({ title: p.column("title") }));', /__sqlSetError/],
    ['set-values', 'union(one, selectFrom(p).select({ id: p.column("title") }));', /__sqlSetError/],
    ['set-index', 'const fields: Record<string, SqlColumn<number, "u">> = { id: u.column("id") }; const broad = selectFrom(u).select(fields); union(broad, broad);', /__sqlSetError/],
    ['set-optional', 'const fields: { id: SqlColumn<number, "u">; extra?: SqlColumn<number, "u"> } = { id: u.column("id") }; const optional = selectFrom(u).select(fields); unionAll(optional, optional);', /__sqlSetError/],
    ['cte-column', 'const r = cte("chosen", one).ref("r"); r.column("missing");', /"missing".*"id"/],
    ['cte-raw', 'cte("bad", sql`SELECT 1`);', /SqlSelection/],
    ['cte-scope', 'const r = cte("chosen", one).ref("r"); selectFrom(u).select({ id: r.column("id") });', /SqlColumn<number, "r">/],
    ['nullable-erasure', 'const erased: SqlSelect<"u" | "p"> = selectFrom(u).leftJoin(p, sql`TRUE`); void erased;', /"p".*never/],
    ['optional-value', 'const fields: { id: SqlColumn<number, "u">; title?: SqlColumn<string, "p"> } = { id: u.column("id"), title: p.column("title") }; const q = selectFrom(u).leftJoin(p, sql`TRUE`).select(fields); function bad(row: import("turbine-orm/sql").SqlResult<typeof q>): undefined { return row.title; }', /string.*null.*undefined|not assignable to type 'undefined'/],
  ];
  for (const op of ['intersect', 'except']) {
    negatives.push(
      [`${op}-keys`, `${op}(one, selectFrom(p).select({ title: p.column("title") }));`, /__sqlSetError/],
      [`${op}-values`, `${op}(one, selectFrom(p).select({ id: p.column("title") }));`, /__sqlSetError/],
      [`${op}-index`, `const fields: Record<string, SqlColumn<number, "u">> = { id: u.column("id") }; const q = selectFrom(u).select(fields); ${op}(q, q);`, /__sqlSetError/],
      [`${op}-optional`, `const fields: { id: SqlColumn<number, "u">; extra?: SqlColumn<number, "u"> } = { id: u.column("id") }; const q = selectFrom(u).select(fields); ${op}(q, q);`, /__sqlSetError/],
      [`${op}-raw`, `${op}(one, sql\`SELECT 1\`);`, /SqlSelection|resultBrand/],
      [`${op}-nullability`, `const q = selectFrom(u).leftJoin(p, sql\`TRUE\`).select({ id: u.column("id"), title: p.column("title") }); const result = ${op}(q, q); declare const row: import("turbine-orm/sql").SqlResult<typeof result>; const required: string = row.title; void required;`, /null/],
    );
  }
  for (const extension of ['mts', 'cts']) {
    for (const [name, source, diagnostic] of negatives) {
      const path = join(directory, `${name}.${extension}`);
      const config = join(directory, `${name}-${extension}.json`);
      writeFileSync(path, `${prelude}\n${source}\n`);
      writeFileSync(config, JSON.stringify({ extends: './tsconfig.json', files: [path] }));
      let failed = false;
      try {
        run(process.execPath, [join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '--project', config]);
      } catch (error) {
        assert.match(error.stdout, /TS(?:23(?:22|45)|2741)/);
        assert.match(error.stdout, diagnostic);
        assert.doesNotMatch(error.stdout, /TS7006|implicitly has an 'any' type/);
        console.log(`Expected strict ${name} ${extension} rejection: ${error.stdout.trim()}`);
        failed = true;
      }
      assert.ok(failed, `${name} ${extension} must fail with its intended diagnostic`);
    }
  }
  console.log('sql packed consumer: ESM, CJS, strict .mts/.cts types passed without drivers or Node type packages');
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr);
  throw error;
} finally {
  rmSync(directory, { recursive: true, force: true });
}

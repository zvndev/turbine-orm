/**
 * turbine-orm: the `with: { rel: true }` shorthand, and the drift class behind it.
 *
 * `true` is shorthand for `{}`. Six independent walkers cross a `with` tree
 * (SQL build, param collect, cache fingerprint, decode shape, projection
 * resolver, flatten planner) and each one used to re-state the shorthand for
 * itself. Two of those statements disagreed: the build path emitted a relation
 * target's global filter unconditionally while the collect path returned early
 * on `true` and pushed nothing for it, so a value-bearing filter compiled a
 * `$N` no value backed. `relationOptions()` in query/relations.ts is now the
 * single authority.
 *
 * Two guards, deliberately of different KINDS, because either alone is weak:
 *
 *   1. A SOURCE guard. Re-introducing a `spec === true` branch in relations.ts
 *      re-opens the class whether or not any current shape happens to catch it.
 *      Text is a blunt instrument, but it fires the moment the shape returns
 *      rather than waiting for someone to think of the query that exposes it.
 *
 *   2. A BEHAVIOURAL sweep. Every relation cardinality x every option shape x
 *      every nesting position, against a schema where EVERY table carries a
 *      value-bearing global filter, asserting (a) every `$N` the built SQL
 *      references is backed by a collected param and (b) `true` and `{}`
 *      compile byte-identically. This is what actually pins the behaviour, and
 *      it runs on four dialects and both JSON encodings because the bug was in
 *      shared code and affected all of them.
 *
 * No database: both halves read compiled SQL, which is where the mismatch is.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type Dialect, postgresDialect } from '../dialect.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { QueryInterface, type WithClause } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { mockTable } from './helpers.js';

const RELATIONS_SRC = fileURLToPath(new URL('../query/relations.ts', import.meta.url));

describe('`with: { rel: true }`, source guard', () => {
  const source = readFileSync(RELATIONS_SRC, 'utf8');

  it('the fixture is real (guard against a silently empty read)', () => {
    // A guard that greps a file it failed to read passes forever. Pin both that
    // the file is substantial and that the authority it checks for is present.
    assert.ok(source.length > 50_000, `relations.ts read as ${source.length} bytes, expected the real file`);
    assert.match(source, /export function relationOptions\(spec: true \| WithOptions\): WithOptions/);
  });

  it('nothing in relations.ts branches on `spec === true` except the one authority', () => {
    // Lines that TEST the shorthand rather than reading it through
    // relationOptions(). Comments and JSDoc are excluded: they explain the
    // rule, they do not implement it.
    const offenders: string[] = [];
    let inBlockComment = false;
    source.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        return;
      }
      if (trimmed.startsWith('*') || trimmed.startsWith('//')) return;
      // `relationOptions` itself is the sanctioned reading of the shorthand.
      if (/^return spec === true \? EMPTY_WITH_OPTIONS : spec;$/.test(trimmed)) return;
      if (/\bspec\s*[!=]==\s*true\b/.test(line)) offenders.push(`${i + 1}: ${trimmed}`);
    });
    assert.deepEqual(
      offenders,
      [],
      'A `with` walker is reading the `true` shorthand for itself again. Call relationOptions(spec) ' +
        `instead, so every walker reads one shape:\n${offenders.join('\n')}`,
    );
  });

  it('the guard can actually fail (negative control)', () => {
    // The same predicate over a line that SHOULD trip it. Without this, a
    // broken regex would report "no offenders" over any file at all.
    assert.ok(/\bspec\s*[!=]==\s*true\b/.test('  if (spec !== true && spec.where) {'));
    assert.ok(/\bspec\s*[!=]==\s*true\b/.test('  if (spec === true) return;'));
    assert.ok(!/\bspec\s*[!=]==\s*true\b/.test('  const opts = relationOptions(spec);'));
  });
});

// ---------------------------------------------------------------------------
// Behavioural sweep
// ---------------------------------------------------------------------------

/**
 * Every table carries a VALUE-BEARING global filter. A parameterless filter
 * (`deletedAt: null`) binds nothing, so it cannot tell a collect path that
 * pushes the right params from one that pushes none, which is exactly how this
 * bug survived its own test file.
 */
const GLOBAL_FILTERS = {
  users: { tenantId: 'tenant-u' },
  posts: { tenantId: 'tenant-p' },
  tags: { tenantId: 'tenant-t' },
} as const;

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
          tags: {
            type: 'manyToMany',
            name: 'tags',
            from: 'users',
            to: 'tags',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'user_tags', sourceKey: 'user_id', targetKey: 'tag_id' },
          },
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'user_id', field: 'userId' },
          { name: 'title', field: 'title', pgType: 'text' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
        ],
        {
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'posts',
            to: 'users',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
          tags: {
            type: 'manyToMany',
            name: 'tags',
            from: 'posts',
            to: 'tags',
            foreignKey: 'id',
            referenceKey: 'id',
            through: { table: 'post_tags', sourceKey: 'post_id', targetKey: 'tag_id' },
          },
        },
      ),
      tags: mockTable(
        'tags',
        [
          { name: 'id', field: 'id' },
          { name: 'label', field: 'label', pgType: 'text' },
          { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
        ],
        {
          owner: { type: 'belongsTo', name: 'owner', from: 'tags', to: 'users', foreignKey: 'id', referenceKey: 'id' },
        },
      ),
    },
  };
}

/** Option shapes a relation can carry, each combined with the `true` / `{}` pair. */
const OPTION_SHAPES: [label: string, opts: Record<string, unknown>][] = [
  ['bare', {}],
  ['where', { where: { id: 1 } }],
  ['limit', { limit: 3 }],
  ['orderBy', { orderBy: { id: 'desc' } }],
  ['limit+orderBy (wraps)', { limit: 3, orderBy: { id: 'asc' } }],
  ['select', { select: { id: true } }],
  ['where+limit+orderBy', { where: { id: 1 }, limit: 2, orderBy: { id: 'asc' } }],
];

/** Nested `with` trees, so the shorthand is exercised at depth 1, 2 and 3. */
const NESTED: [label: string, tree: Record<string, unknown>][] = [
  ['depth 1', { posts: true }],
  ['depth 1 (m2m)', { tags: true }],
  ['depth 2', { posts: { with: { author: true } } }],
  ['depth 2 (m2m child)', { posts: { with: { tags: true } } }],
  ['depth 2 under a wrapped parent', { posts: { limit: 2, orderBy: { id: 'asc' }, with: { author: true } } }],
  ['depth 3', { posts: { with: { author: { with: { tags: true } } } } }],
  ['depth 3 under wrapped parents', { posts: { limit: 2, with: { author: { with: { posts: { limit: 1 } } } } } }],
  ['siblings', { posts: true, tags: true }],
  ['siblings, one with options', { posts: { where: { id: 1 } }, tags: true }],
  ['_count beside a shorthand relation', { posts: true, _count: { posts: true } }],
];

/**
 * All four engines run the ALIGNMENT sweep. `mssql` was excluded until 0.76.0:
 * its dialect owns the whole relation subquery (`buildRelationSubquery`,
 * `FOR JSON PATH`) and used to return before relations.ts could apply the
 * target's global filter, so a SQL Server relation subquery emitted no filter
 * at all while the collect path still pushed its params, for EVERY spec shape.
 * The consequence was worse than a bind error: the relation surfaced rows the
 * filter is supposed to hide.
 *
 * The fix could not live in `mssql.ts`, because the `RelationSubqueryContext`
 * an override receives carries no `BuilderCtx` and therefore no
 * `globalFilters`. It lives in the `buildWhere` closure relations.ts hands
 * that context, which now ANDs the target filter onto the caller's `where`,
 * so every present and future dialect override inherits it. The
 * characterization block that pinned the broken behaviour is gone and the
 * regression block below took its place.
 */
const DIALECTS: [name: string, dialect: Dialect | undefined][] = [
  ['postgres', undefined],
  ['sqlite', sqliteDialect],
  ['mysql', mysqlDialect],
  ['mssql', mssqlDialect],
];

/**
 * The placeholder pattern is a property of the DIALECT (`$1`, `:p1`, `@p1`),
 * so it is derived from `paramPlaceholder` rather than hardcoded. A hardcoded
 * `/\$(\d+)/` matches nothing on MySQL/SQLite/SQL Server, which would make the
 * alignment check pass vacuously on three of the four engines.
 */
function placeholderPattern(dialect: Dialect | undefined): RegExp {
  const d = dialect ?? postgresDialect;
  const first = d.paramPlaceholder(1);
  assert.match(first, /1$/, `unexpected placeholder shape "${first}"; this helper assumes a trailing index`);
  const prefix = first.slice(0, -1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${prefix}(\\d+)`, 'g');
}

function build(
  table: string,
  withClause: unknown,
  dialect: Dialect | undefined,
  jsonEncoding: 'object' | 'positional',
) {
  const q = new QueryInterface(null as never, table, schema(), undefined, {
    globalFilters: GLOBAL_FILTERS,
    dialect,
    jsonEncoding,
  } as never);
  return q.buildFindMany({ with: withClause as WithClause, limit: 5 } as never);
}

/** Every `$N` the SQL references must be backed by exactly one collected param. */
function assertParamsAligned(sql: string, params: unknown[], context: string, pattern: RegExp): void {
  const referenced = new Set<number>();
  for (const m of sql.matchAll(pattern)) referenced.add(Number(m[1]));
  const max = referenced.size ? Math.max(...referenced) : 0;
  assert.equal(max, params.length, `${context}: SQL references up to $${max} but got ${params.length} params\n${sql}`);
  for (let i = 1; i <= params.length; i++) {
    assert.ok(referenced.has(i), `${context}: param $${i} is never referenced\n${sql}`);
  }
}

/** Replace every `true` leaf in a `with` tree with `{}`, leaving `_count` alone. */
function expandShorthand(tree: unknown): unknown {
  if (tree === true) return {};
  if (!tree || typeof tree !== 'object') return tree;
  return Object.fromEntries(
    Object.entries(tree as Record<string, unknown>).map(([k, v]) => [
      k,
      k === '_count' ? v : k === 'with' ? expandShorthand(v) : v === true ? {} : expandShorthand(v),
    ]),
  );
}

describe('`with: { rel: true }`, behavioural sweep against value-bearing global filters', () => {
  // Not every combination is legal on every dialect (mssql owns its whole
  // relation subquery; mysql inlines pagination). A refusal is a fine outcome:
  // what must never happen is a compiled statement whose params do not line up.
  let compiled = 0;

  for (const [dialectName, dialect] of DIALECTS) {
    for (const jsonEncoding of ['object', 'positional'] as const) {
      // positional is Postgres-only (buildSelectWithRelations refuses it elsewhere).
      if (jsonEncoding === 'positional' && dialectName !== 'postgres') continue;

      for (const [treeLabel, tree] of NESTED) {
        it(`${dialectName}/${jsonEncoding}: ${treeLabel} keeps every placeholder backed`, () => {
          const { sql, params } = build('users', tree, dialect, jsonEncoding);
          compiled++;
          assertParamsAligned(sql, params, `${dialectName}/${jsonEncoding} ${treeLabel}`, placeholderPattern(dialect));
          // Non-vacuous: three tables all carry a filter, so at least the query's
          // own must have bound something.
          assert.ok(params.length > 0, `expected the global filters to bind: ${sql}`);
        });

        it(`${dialectName}/${jsonEncoding}: ${treeLabel} compiles identically with \`true\` expanded to \`{}\``, () => {
          const shorthand = build('users', tree, dialect, jsonEncoding);
          const expanded = build('users', expandShorthand(tree), dialect, jsonEncoding);
          assert.equal(expanded.sql, shorthand.sql, `${dialectName}/${jsonEncoding} ${treeLabel}: SQL diverged`);
          assert.deepEqual(
            expanded.params,
            shorthand.params,
            `${dialectName}/${jsonEncoding} ${treeLabel}: params diverged`,
          );
        });
      }

      for (const [optLabel, opts] of OPTION_SHAPES) {
        for (const rel of ['posts', 'tags'] as const) {
          it(`${dialectName}/${jsonEncoding}: ${rel} { ${optLabel} } keeps every placeholder backed`, () => {
            const { sql, params } = build('users', { [rel]: opts }, dialect, jsonEncoding);
            compiled++;
            assertParamsAligned(
              sql,
              params,
              `${dialectName}/${jsonEncoding} ${rel} ${optLabel}`,
              placeholderPattern(dialect),
            );
          });
        }
      }
    }
  }

  it('the sweep actually compiled statements (anti-vacuous)', () => {
    // Every case above could have been skipped by a bad guard and this suite
    // would still be green. It ran last, so `compiled` is final.
    assert.ok(compiled >= 50, `expected the sweep to compile many statements, it compiled ${compiled}`);
  });
});

describe('SQL Server: relation subqueries carry the target global filter', () => {
  // The inverse of the characterization block this replaced. Until 0.76.0 each
  // of these emitted a subquery with NO target filter and one orphan param per
  // filtered relation target; the assertions below are those two measurements
  // turned around, and they are kept separate from the sweep because the sweep
  // can only see the param count while the missing PREDICATE is the part that
  // leaked rows.
  for (const [label, tree, relations] of [
    ['hasMany, `true`', { posts: true }, 1],
    ['hasMany, options', { posts: { where: { id: 1 }, limit: 3 } }, 1],
    ['manyToMany, `true`', { tags: true }, 1],
    ['manyToMany, options', { tags: { where: { id: 1 }, limit: 3, orderBy: { id: 'asc' } } }, 1],
    ['two relations', { posts: true, tags: true }, 2],
  ] as [string, Record<string, unknown>, number][]) {
    it(`${label}: no orphan params, and the target filter is in the subquery`, () => {
      const { sql, params } = build('users', tree, mssqlDialect, 'object');
      const referenced = new Set<number>();
      for (const m of sql.matchAll(placeholderPattern(mssqlDialect))) referenced.add(Number(m[1]));
      const max = referenced.size ? Math.max(...referenced) : 0;
      assert.equal(params.length - max, 0, `orphan params on SQL Server\n${sql}`);

      // The predicate itself, once per filtered relation target. Counted rather
      // than merely matched: with two relations, one filter reaching one of them
      // is still a leak and a bare `assert.match` would pass.
      const subqueries = sql.slice(sql.indexOf('(SELECT'), sql.indexOf('FROM [users]'));
      const hits = subqueries.match(/\[tenant_id\] = @p\d+/g)?.length ?? 0;
      assert.equal(hits, relations, `expected the target filter on ${relations} relation target(s)\n${sql}`);
    });
  }
});

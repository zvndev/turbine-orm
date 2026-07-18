/**
 * turbine-orm — PII query semantics (Track F, build-only / no DB)
 *
 * The contract (from `ColumnMetadata.pii`'s JSDoc, which is normative): a
 * PII-tagged column is EXCLUDED from default projections. It comes back only
 * when it is named explicitly in `select`, or when the query passes
 * `includePii: true` (which opts in at the top level AND every nested `with`
 * level). Untagged schemas behave byte-identically to before.
 *
 * These build-only tests assert the generated SQL and the write read-policy
 * without a database:
 *   - default findMany / findUnique omit the PII column from the SELECT list;
 *   - `select` naming it returns exactly it (explicitness IS the opt-in);
 *   - `includePii` returns everything (`SELECT t.*`);
 *   - relation subqueries (join strategy) + the batched loader's child fetch
 *     apply the same exclusion, and `includePii` reaches nested levels;
 *   - a lateral pick ORDER BY over a PII column stays allowed and never widens
 *     the projection;
 *   - write RETURNING/reselect rows drop PII fields (writes accept no opt-in);
 *   - `where` / `orderBy` on a PII column are allowed (the reference is explicit);
 *   - `includePii` participates in the SQL-cache fingerprint (double-compile);
 *   - an untagged schema emits byte-identical SQL to a control.
 *
 * Run: npx tsx --test src/test/pii-query.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadRelationsBatched, type RelationLoadContext } from '../query/batched-loader.js';
import type { QueryInterface } from '../query/index.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Schema fixtures
// ---------------------------------------------------------------------------

/**
 * users(id, name, email[PII]) → posts (hasMany), tags (m2m via post_tags).
 * posts(id, author_id, title, secret[PII]) → author (belongsTo).
 * tags(id, label, note[PII]).
 * A relation whose foreign key is NOT PII, so stitching is unaffected.
 */
function piiSchema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
    ],
    {
      posts: {
        type: 'hasMany',
        name: 'posts',
        from: 'users',
        to: 'posts',
        foreignKey: 'author_id',
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
  );
  const posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'author_id', field: 'authorId' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'secret', field: 'secret', pgType: 'text' },
    ],
    {
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'author_id',
        referenceKey: 'id',
      },
    },
  );
  const tags = mockTable('tags', [
    { name: 'id', field: 'id' },
    { name: 'label', field: 'label', pgType: 'text' },
    { name: 'note', field: 'note', pgType: 'text' },
  ]);
  // Tag the sensitive columns.
  setPii(users, 'email');
  setPii(posts, 'secret');
  setPii(tags, 'note');
  return { enums: {}, tables: { users, posts, tags } };
}

/** Same shape as piiSchema() but with NO pii tags — the byte-identical control. */
function untaggedSchema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
    ],
    {
      posts: {
        type: 'hasMany',
        name: 'posts',
        from: 'users',
        to: 'posts',
        foreignKey: 'author_id',
        referenceKey: 'id',
      },
    },
  );
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'author_id', field: 'authorId' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'secret', field: 'secret', pgType: 'text' },
  ]);
  return { enums: {}, tables: { users, posts } };
}

function setPii(table: TableMetadata, columnName: string): void {
  const col = table.columns.find((c) => c.name === columnName);
  if (!col) throw new Error(`test fixture: no column "${columnName}" on "${table.name}"`);
  col.pii = true;
}

function usersQuery(schema = piiSchema(), options?: Parameters<typeof makeQuery>[2]): QueryInterface {
  return makeQuery('users', schema, options) as unknown as QueryInterface;
}

// ---------------------------------------------------------------------------
// Top-level projection
// ---------------------------------------------------------------------------

describe('pii: default top-level projection excludes the PII column', () => {
  it('findMany with no select/omit omits email but keeps id and name', () => {
    const { sql } = usersQuery().buildFindMany({});
    assert.match(sql, /"users"\."id"/);
    assert.match(sql, /"users"\."name"/);
    assert.doesNotMatch(sql, /"users"\."email"/, 'PII column must not appear in the default projection');
    // It is an explicit list now, never the `*` shortcut.
    assert.doesNotMatch(sql, /"users"\.\*/);
  });

  it('findUnique with no select omits email', () => {
    const { sql } = usersQuery().buildFindUnique({ where: { id: 1 } });
    assert.match(sql, /"users"\."name"/);
    assert.doesNotMatch(sql, /"users"\."email"/);
  });

  it('omit-only projection still drops the PII column (omitting name, PII still gone)', () => {
    const { sql } = usersQuery().buildFindMany({ omit: { name: true } });
    assert.match(sql, /"users"\."id"/);
    assert.doesNotMatch(sql, /"users"\."name"/);
    assert.doesNotMatch(sql, /"users"\."email"/);
  });
});

describe('pii: explicit select IS the opt-in', () => {
  it('select naming email returns exactly it', () => {
    const { sql } = usersQuery().buildFindMany({ select: { email: true } });
    assert.match(sql, /"users"\."email"/);
    assert.doesNotMatch(sql, /"users"\."name"/, 'only the selected column is projected');
  });

  it('select of a non-PII column still excludes the PII column', () => {
    const { sql } = usersQuery().buildFindMany({ select: { name: true } });
    assert.match(sql, /"users"\."name"/);
    assert.doesNotMatch(sql, /"users"\."email"/);
  });
});

describe('pii: includePii returns everything', () => {
  it('includePii collapses back to SELECT t.* (email available)', () => {
    const { sql } = usersQuery().buildFindMany({ includePii: true });
    assert.match(sql, /"users"\.\*/, 'includePii with no select is the byte-identical `*` shape');
  });

  it('findUnique includePii returns SELECT t.*', () => {
    const { sql } = usersQuery().buildFindUnique({ where: { id: 1 }, includePii: true });
    assert.match(sql, /"users"\.\*/);
  });
});

// ---------------------------------------------------------------------------
// Relation subqueries (join strategy)
// ---------------------------------------------------------------------------

describe('pii: relation subqueries exclude the child PII column by default', () => {
  it('with: { posts } omits secret from the json_build_object', () => {
    const { sql } = usersQuery().buildFindMany({ with: { posts: true } });
    assert.match(sql, /'title'/, "the child's non-PII columns are projected");
    assert.doesNotMatch(sql, /'secret'/, "the child's PII column must be excluded");
  });

  it('includePii reaches the relation subquery (secret present)', () => {
    const { sql } = usersQuery().buildFindMany({ with: { posts: true }, includePii: true });
    assert.match(sql, /'secret'/, 'includePii applies to nested with levels');
  });

  it('relation select naming the PII column returns it (explicit opt-in per level)', () => {
    const { sql } = usersQuery().buildFindMany({ with: { posts: { select: { secret: true } } } });
    assert.match(sql, /'secret'/);
  });

  it('m2m relation excludes the target PII column by default and includes it under includePii', () => {
    const base = usersQuery().buildFindMany({ with: { tags: true } });
    assert.match(base.sql, /'label'/);
    assert.doesNotMatch(base.sql, /'note'/, 'm2m target PII excluded by default');
    const opted = usersQuery().buildFindMany({ with: { tags: true }, includePii: true });
    assert.match(opted.sql, /'note'/, 'm2m target PII returned under includePii');
  });

  it('nested with (posts → author) excludes the parent-side PII column at depth', () => {
    const { sql } = usersQuery().buildFindMany({ with: { posts: { with: { author: true } } } });
    // author is a users row nested under posts — its email must stay excluded.
    assert.doesNotMatch(sql, /'email'/, 'PII excluded at every nested level');
    const opted = usersQuery().buildFindMany({
      with: { posts: { with: { author: true } } },
      includePii: true,
    });
    assert.match(opted.sql, /'email'/, 'includePii reaches deeply nested levels');
  });
});

// ---------------------------------------------------------------------------
// Batched loader
// ---------------------------------------------------------------------------

describe('pii: the batched loader applies the same exclusion to its child fetch', () => {
  it('default batched child fetch omits the child PII column', async () => {
    const schema = piiSchema();
    const captured: string[] = [];
    const ctx = makeCtx(schema, captured, false);
    await loadRelationsBatched(ctx, [{ id: 1 }], { posts: true });
    const postFetch = captured.find((s) => s.includes('"posts"'));
    assert.ok(postFetch, 'a follow-up query against posts must run');
    assert.doesNotMatch(postFetch!, /"posts"\."secret"/, 'batched child fetch excludes PII');
    assert.match(postFetch!, /"posts"\."title"/);
  });

  it('includePii threads into the batched child fetch (secret present)', async () => {
    const schema = piiSchema();
    const captured: string[] = [];
    const ctx = makeCtx(schema, captured, true);
    await loadRelationsBatched(ctx, [{ id: 1 }], { posts: true });
    const postFetch = captured.find((s) => s.includes('"posts"'));
    assert.ok(postFetch);
    // includePii on the child collapses to `SELECT "posts".*`, which returns secret.
    assert.match(postFetch!, /"posts"\.\*/);
  });
});

/** A RelationLoadContext whose exec records SQL and returns no rows. */
function makeCtx(schema: SchemaMetadata, captured: string[], includePii: boolean): RelationLoadContext {
  return {
    parentMeta: schema.tables.users!,
    schema,
    makeChild: (table) => makeQuery(table, schema) as unknown as never,
    exec: async (sql) => {
      captured.push(sql);
      return { rows: [], rowCount: 0 } as never;
    },
    quote: (name) => `"${name.replace(/"/g, '""')}"`,
    buildInClause: (expr, paramRef) => `${expr} = ANY(${paramRef})`,
    inClauseParam: (values) => values,
    paramPlaceholder: (index) => `$${index}`,
    includePii,
  };
}

// ---------------------------------------------------------------------------
// Lateral pick ordering — allowed, never widens the projection
// ---------------------------------------------------------------------------

describe('pii: a lateral pick ORDER BY over a PII column stays allowed', () => {
  it('lateral pick ordering exposes only __turbine_pick, not a PII column', () => {
    const { sql } = usersQuery().buildFindMany({
      orderBy: {
        posts: { pick: { orderBy: { id: 'desc' } }, by: 'title', direction: 'desc', plan: 'lateral' },
      },
    });
    // The lateral pick exposes only the reserved __turbine_pick ordering value;
    // the parent projection still excludes email.
    assert.match(sql, /__turbine_pick/);
    assert.doesNotMatch(sql, /"users"\."email"/);
  });
});

// ---------------------------------------------------------------------------
// where / orderBy referencing a PII column — explicit, so allowed
// ---------------------------------------------------------------------------

describe('pii: where / orderBy referencing a PII column are allowed (explicit reference)', () => {
  it('where on email compiles and binds the value', () => {
    const { sql, params } = usersQuery().buildFindMany({ where: { email: 'a@b.c' } });
    assert.match(sql, /"email" = \$1/);
    assert.deepEqual(params, ['a@b.c']);
    // The reference does not resurrect email in the projection.
    assert.doesNotMatch(sql, /"users"\."email",|, "users"\."email"/);
  });

  it('orderBy on email compiles and the column stays out of the projection', () => {
    const { sql } = usersQuery().buildFindMany({ orderBy: { email: 'asc' } });
    assert.match(sql, /ORDER BY "email" ASC/);
    assert.doesNotMatch(sql, /"users"\."email"/, 'ordering by PII does not resurrect it in the SELECT list');
  });
});

// ---------------------------------------------------------------------------
// Write read policy
// ---------------------------------------------------------------------------

describe('pii: write RETURNING/reselect rows drop PII fields', () => {
  it('create strips email from the returned entity (write still RETURNING *)', () => {
    const d = usersQuery().buildCreate({ data: { name: 'x', email: 'e@x' } as never });
    assert.match(d.sql, /RETURNING \*/, 'the write SQL is unchanged — you may write PII freely');
    const row = d.transform({ rows: [{ id: 1, name: 'x', email: 'e@x' }] } as never) as Record<string, unknown>;
    assert.equal(row.name, 'x');
    assert.ok(!('email' in row), 'PII field is stripped from the create result');
  });

  it('update strips email from the returned entity', () => {
    const d = usersQuery().buildUpdate({ where: { id: 1 }, data: { name: 'y' } as never });
    const row = d.transform({ rows: [{ id: 1, name: 'y', email: 'e@x' }] } as never) as Record<string, unknown>;
    assert.ok(!('email' in row));
  });

  it('delete strips email from the returned entity', () => {
    const d = usersQuery().buildDelete({ where: { id: 1 } });
    const row = d.transform({ rows: [{ id: 1, name: 'z', email: 'e@x' }] } as never) as Record<string, unknown>;
    assert.ok(!('email' in row));
  });

  it('createMany strips email from every returned entity', () => {
    const d = usersQuery().buildCreateMany({ data: [{ name: 'a', email: 'e1' }] as never });
    const rows = d.transform({ rows: [{ id: 1, name: 'a', email: 'e1' }] } as never) as Record<string, unknown>[];
    assert.ok(!('email' in rows[0]!));
  });
});

// ---------------------------------------------------------------------------
// Cache fingerprint — includePii must not collide
// ---------------------------------------------------------------------------

describe('pii: includePii participates in the SQL-cache fingerprint', () => {
  function fresh(args: Record<string, unknown>): string {
    return (makeQuery('users', piiSchema(), { sqlCache: false }).buildFindMany(args as never) as { sql: string }).sql;
  }

  it('same args ± includePii produce different SQL', () => {
    const off = fresh({ with: { posts: true } });
    const on = fresh({ with: { posts: true }, includePii: true });
    assert.notEqual(off, on, 'default and includePii SQL must differ');
    assert.doesNotMatch(off, /'secret'/);
    assert.match(on, /'secret'/);
  });

  it('warm cache with includePii=false, then hit includePii=true — no cross-serve', () => {
    const q = makeQuery('users', piiSchema());
    // Warm the no-PII entry, then request the includePii variant on the same
    // interface: it must NOT be served the cached no-PII SQL.
    const cold = q.buildFindMany({ with: { posts: true } } as never) as { sql: string };
    const hot = q.buildFindMany({ with: { posts: true }, includePii: true } as never) as { sql: string };
    assert.doesNotMatch(cold.sql, /'secret'/);
    assert.match(hot.sql, /'secret'/);
    assert.equal(hot.sql, fresh({ with: { posts: true }, includePii: true }));
  });

  it('warm cache with includePii=true, then hit again — warm-hit stays correct', () => {
    const q = makeQuery('users', piiSchema());
    const first = q.buildFindMany({ includePii: true } as never) as { sql: string };
    const second = q.buildFindMany({ includePii: true } as never) as { sql: string };
    assert.equal(first.sql, second.sql);
    assert.match(second.sql, /"users"\.\*/);
  });

  it('warm cache with includePii=false twice — warm-hit stays PII-excluded', () => {
    const q = makeQuery('users', piiSchema());
    const first = q.buildFindMany({} as never) as { sql: string };
    const second = q.buildFindMany({} as never) as { sql: string };
    assert.equal(first.sql, second.sql);
    assert.doesNotMatch(second.sql, /"users"\."email"/);
  });
});

// ---------------------------------------------------------------------------
// Untagged schema is byte-identical to before
// ---------------------------------------------------------------------------

describe('pii: untagged schemas emit byte-identical SQL', () => {
  it('untagged default findMany uses SELECT t.* (unchanged)', () => {
    const { sql } = (makeQuery('users', untaggedSchema()) as unknown as QueryInterface).buildFindMany({});
    assert.match(sql, /"users"\.\*/, 'no PII columns → the `*` fast path is preserved');
  });

  it('a tagged schema under includePii matches the untagged control SQL', () => {
    const tagged = usersQuery().buildFindMany({ includePii: true });
    const control = (makeQuery('users', untaggedSchema()) as unknown as QueryInterface).buildFindMany({});
    assert.equal(tagged.sql, control.sql, 'includePii returns to the identical `*` projection');
  });

  it('untagged relation subquery is unchanged (secret present, no exclusion)', () => {
    const { sql } = (makeQuery('users', untaggedSchema()) as unknown as QueryInterface).buildFindMany({
      with: { posts: true },
    });
    assert.match(sql, /'secret'/, 'untagged posts.secret is a normal column');
  });
});

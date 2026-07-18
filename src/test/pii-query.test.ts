/**
 * turbine-orm: PII query semantics (Track F, build-only / no DB)
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
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import { loadRelationsBatched, type RelationLoadContext } from '../query/batched-loader.js';
import type { ReselectExecutor } from '../query/deferred.js';
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

/** Same shape as piiSchema() but with NO pii tags: the byte-identical control. */
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

function usersQuery(
  schema = piiSchema(),
  options?: Parameters<typeof makeQuery>[2],
): QueryInterface<Record<string, unknown>> {
  return makeQuery('users', schema, options) as unknown as QueryInterface<Record<string, unknown>>;
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
    // author is a users row nested under posts: its email must stay excluded.
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
// Lateral pick ordering: allowed, never widens the projection
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
// where / orderBy referencing a PII column: explicit, so allowed
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
// Write RETURNING projection excludes PII at the SQL level
//
// PII must not leave the database on a write: a tagged table's write emits an
// explicit non-PII RETURNING list instead of `RETURNING *`. The client-side
// strip in parseWriteRow stays as defense-in-depth (it becomes a no-op once the
// SQL already omits the column), so the transform still returns a PII-free row.
// ---------------------------------------------------------------------------

/** The substring of a statement from `RETURNING`/`OUTPUT` onward (the projection). */
function returnTail(sql: string): string {
  const i = Math.min(
    ...['RETURNING', 'OUTPUT'].map((k) => (sql.includes(k) ? sql.indexOf(k) : Number.POSITIVE_INFINITY)),
  );
  return Number.isFinite(i) ? sql.slice(i) : '';
}

describe('pii: write RETURNING excludes the PII column (Postgres)', () => {
  it('create emits RETURNING "id", "name" with no email and no `*`', () => {
    const d = usersQuery().buildCreate({ data: { name: 'x', email: 'e@x' } as never });
    assert.match(d.sql, /RETURNING "id", "name"/, 'explicit non-PII projection');
    assert.doesNotMatch(d.sql, /RETURNING \*/, 'the `*` shortcut would leak PII on the wire');
    assert.doesNotMatch(returnTail(d.sql), /"email"/, 'email must not appear in RETURNING');
    // Defense-in-depth strip still returns a PII-free row.
    const row = d.transform({ rows: [{ id: 1, name: 'x' }] } as never) as Record<string, unknown>;
    assert.equal(row.name, 'x');
    assert.ok(!('email' in row));
  });

  it('update emits an explicit non-PII RETURNING list', () => {
    const d = usersQuery().buildUpdate({ where: { id: 1 }, data: { name: 'y' } as never });
    assert.match(d.sql, /RETURNING "id", "name"/);
    assert.doesNotMatch(returnTail(d.sql), /"email"/);
    const row = d.transform({ rows: [{ id: 1, name: 'y' }] } as never) as Record<string, unknown>;
    assert.ok(!('email' in row));
  });

  it('delete emits an explicit non-PII RETURNING list', () => {
    const d = usersQuery().buildDelete({ where: { id: 1 } });
    assert.match(d.sql, /RETURNING "id", "name"/);
    assert.doesNotMatch(returnTail(d.sql), /"email"/);
    const row = d.transform({ rows: [{ id: 1, name: 'z' }] } as never) as Record<string, unknown>;
    assert.ok(!('email' in row));
  });

  it('createMany emits an explicit non-PII RETURNING list', () => {
    const d = usersQuery().buildCreateMany({ data: [{ name: 'a', email: 'e1' }] as never });
    assert.match(d.sql, /RETURNING "id", "name"/);
    assert.doesNotMatch(returnTail(d.sql), /"email"/);
    const rows = d.transform({ rows: [{ id: 1, name: 'a' }] } as never) as Record<string, unknown>[];
    assert.ok(!('email' in rows[0]!));
  });

  it('upsert emits an explicit non-PII RETURNING list', () => {
    const d = usersQuery().buildUpsert({ where: { id: 1 }, create: { name: 'a' }, update: { name: 'b' } } as never);
    assert.match(d.sql, /RETURNING "id", "name"/);
    assert.doesNotMatch(returnTail(d.sql), /"email"/);
  });
});

// ---------------------------------------------------------------------------
// Untagged control: writes keep `RETURNING *` byte-for-byte
// ---------------------------------------------------------------------------

describe('pii: untagged tables keep RETURNING * on writes (byte-identical)', () => {
  function untaggedUsers(): QueryInterface<Record<string, unknown>> {
    return makeQuery('users', untaggedSchema()) as unknown as QueryInterface<Record<string, unknown>>;
  }

  it('create on an untagged table still ends with RETURNING *', () => {
    const d = untaggedUsers().buildCreate({ data: { name: 'x', email: 'e@x' } as never });
    assert.match(d.sql, /RETURNING \*/, 'no PII column → the historical `*` is preserved');
  });

  it('update / delete on an untagged table still use RETURNING *', () => {
    const u = untaggedUsers().buildUpdate({ where: { id: 1 }, data: { name: 'y' } as never });
    const del = untaggedUsers().buildDelete({ where: { id: 1 } });
    assert.match(u.sql, /RETURNING \*/);
    assert.match(del.sql, /RETURNING \*/);
  });
});

// ---------------------------------------------------------------------------
// A PII-tagged PRIMARY KEY is kept in the write projection (out of scope for
// stripping; the returned row must stay addressable).
// ---------------------------------------------------------------------------

describe('pii: a PII-tagged primary key stays in the write RETURNING list', () => {
  function peopleSchema(): SchemaMetadata {
    const people = mockTable('people', [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'ssn', field: 'ssn', pgType: 'text' },
    ]);
    setPii(people, 'id'); // pathological: the PK itself tagged
    setPii(people, 'ssn');
    return { enums: {}, tables: { people } };
  }

  it('create keeps the PK column but drops the non-PK PII column', () => {
    const d = (makeQuery('people', peopleSchema()) as unknown as QueryInterface<Record<string, unknown>>).buildCreate({
      data: { name: 'x', ssn: '123' } as never,
    });
    assert.match(d.sql, /RETURNING "id", "name"/, 'PK kept even though tagged; row must stay addressable');
    assert.doesNotMatch(returnTail(d.sql), /"ssn"/, 'the non-PK PII column is excluded');
  });
});

// ---------------------------------------------------------------------------
// SQL Server: OUTPUT INSERTED./DELETED. list excludes PII per column
// ---------------------------------------------------------------------------

describe('pii: SQL Server OUTPUT excludes the PII column (per-column prefix)', () => {
  function mssqlUsers(schema = piiSchema()): QueryInterface<Record<string, unknown>> {
    return makeQuery('users', schema, { dialect: mssqlDialect }) as unknown as QueryInterface<Record<string, unknown>>;
  }

  it('create emits OUTPUT INSERTED.[id], INSERTED.[name] with no email and no `*`', () => {
    const d = mssqlUsers().buildCreate({ data: { name: 'x', email: 'e@x' } as never });
    assert.match(d.sql, /OUTPUT INSERTED\.\[id\], INSERTED\.\[name\]/);
    assert.doesNotMatch(d.sql, /INSERTED\.\*/);
    assert.doesNotMatch(returnTail(d.sql), /\[email\]/);
  });

  it('update emits OUTPUT INSERTED. non-PII list', () => {
    const d = mssqlUsers().buildUpdate({ where: { id: 1 }, data: { name: 'y' } as never });
    assert.match(d.sql, /OUTPUT INSERTED\.\[id\], INSERTED\.\[name\]/);
    assert.doesNotMatch(returnTail(d.sql), /\[email\]/);
  });

  it('delete emits OUTPUT DELETED. non-PII list', () => {
    const d = mssqlUsers().buildDelete({ where: { id: 1 } });
    assert.match(d.sql, /OUTPUT DELETED\.\[id\], DELETED\.\[name\]/);
    assert.doesNotMatch(returnTail(d.sql), /\[email\]/);
  });

  it('untagged control keeps OUTPUT INSERTED.* (byte-identical)', () => {
    const d = (
      makeQuery('users', untaggedSchema(), { dialect: mssqlDialect }) as unknown as QueryInterface<
        Record<string, unknown>
      >
    ).buildCreate({ data: { name: 'x' } as never });
    assert.match(d.sql, /OUTPUT INSERTED\.\*/);
  });
});

// ---------------------------------------------------------------------------
// MySQL (reselect): the follow-up SELECT projects the non-PII list
// ---------------------------------------------------------------------------

describe('pii: MySQL reselect SELECT projects the non-PII column list', () => {
  function mysqlUsers(schema = piiSchema()): QueryInterface<Record<string, unknown>> {
    return makeQuery('users', schema, { dialect: mysqlDialect }) as unknown as QueryInterface<Record<string, unknown>>;
  }

  /** Run a DeferredQuery's reselect plan, capturing every SQL string it issues. */
  async function captureReselect(reselect: (exec: ReselectExecutor) => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const exec: ReselectExecutor = async (sql) => {
      seen.push(sql);
      return { rows: [{ id: 1, name: 'y' }], rowCount: 1 } as never;
    };
    await reselect(exec);
    return seen;
  }

  it('update reselect SELECT excludes the PII column', async () => {
    const d = mysqlUsers().buildUpdate({ where: { id: 1 }, data: { name: 'y' } as never });
    assert.ok(d.reselect, 'mysql attaches a reselect plan');
    const issued = await captureReselect(d.reselect!);
    const sel = issued.find((s) => /^SELECT/.test(s));
    assert.ok(sel, 'a follow-up SELECT runs');
    assert.match(sel!, /SELECT `id`, `name` FROM/);
    assert.doesNotMatch(sel!, /SELECT \* FROM/);
    assert.doesNotMatch(sel!, /`email`/);
  });

  it('untagged control reselect keeps SELECT *', async () => {
    const d = (
      makeQuery('users', untaggedSchema(), { dialect: mysqlDialect }) as unknown as QueryInterface<
        Record<string, unknown>
      >
    ).buildUpdate({ where: { id: 1 }, data: { name: 'y' } as never });
    const issued = await captureReselect(d.reselect!);
    const sel = issued.find((s) => /^SELECT/.test(s));
    assert.match(sel!, /SELECT \* FROM/);
  });
});

// ---------------------------------------------------------------------------
// Cache fingerprint: includePii must not collide
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

  it('warm cache with includePii=false, then hit includePii=true: no cross-serve', () => {
    const q = makeQuery('users', piiSchema());
    // Warm the no-PII entry, then request the includePii variant on the same
    // interface: it must NOT be served the cached no-PII SQL.
    const cold = q.buildFindMany({ with: { posts: true } } as never) as { sql: string };
    const hot = q.buildFindMany({ with: { posts: true }, includePii: true } as never) as { sql: string };
    assert.doesNotMatch(cold.sql, /'secret'/);
    assert.match(hot.sql, /'secret'/);
    assert.equal(hot.sql, fresh({ with: { posts: true }, includePii: true }));
  });

  it('warm cache with includePii=true, then hit again: warm-hit stays correct', () => {
    const q = makeQuery('users', piiSchema());
    const first = q.buildFindMany({ includePii: true } as never) as { sql: string };
    const second = q.buildFindMany({ includePii: true } as never) as { sql: string };
    assert.equal(first.sql, second.sql);
    assert.match(second.sql, /"users"\.\*/);
  });

  it('warm cache with includePii=false twice: warm-hit stays PII-excluded', () => {
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
    const { sql } = (
      makeQuery('users', untaggedSchema()) as unknown as QueryInterface<Record<string, unknown>>
    ).buildFindMany({});
    assert.match(sql, /"users"\.\*/, 'no PII columns → the `*` fast path is preserved');
  });

  it('a tagged schema under includePii matches the untagged control SQL', () => {
    const tagged = usersQuery().buildFindMany({ includePii: true });
    const control = (
      makeQuery('users', untaggedSchema()) as unknown as QueryInterface<Record<string, unknown>>
    ).buildFindMany({});
    assert.equal(tagged.sql, control.sql, 'includePii returns to the identical `*` projection');
  });

  it('untagged relation subquery is unchanged (secret present, no exclusion)', () => {
    const { sql } = (
      makeQuery('users', untaggedSchema()) as unknown as QueryInterface<Record<string, unknown>>
    ).buildFindMany({
      with: { posts: true },
    });
    assert.match(sql, /'secret'/, 'untagged posts.secret is a normal column');
  });
});

/**
 * A relation has TWO accepted spellings on every caller-facing argument, and
 * which argument the name appears in must not change the answer.
 *
 * The relation-level twin of `column-spelling-symmetry.test.ts`, and it exists
 * for the same reason one level up. A relation carries one DECLARED name
 * (`blogPosts`), while the DDL anyone reads carries only the TABLE name
 * (`blog_posts`). Writing back what the schema shows used to fail: E005 in
 * `with`, E003 in a relation filter, E005 in `orderBy` — on names the error
 * text was already computing correctly ("Did you mean ...?"). A system that can
 * name the intended relation can accept it.
 *
 * Found by the agent eval, not by review: after the column fix landed, 65% of
 * the remaining failures across three models were a model reading the schema
 * and writing the table's own spelling back.
 *
 * THE SHAPE OF THIS SUITE IS THE POINT, and it mirrors its sibling exactly. One
 * list of surfaces, four questions asked of every one of them by construction:
 *
 *   1. the DECLARED relation name is accepted;
 *   2. the snake_case spelling of it is accepted;
 *   3. both compile to BYTE-IDENTICAL SQL and params (so they are the same
 *      query, not merely two accepted queries); and
 *   4. a name that is neither is still REFUSED.
 *
 * (3) is the one (1) and (2) cannot state, and it is also the cache argument:
 * the `with` fingerprint is the SQL-cache key, so two spellings that compiled
 * differently would mint two templates for one query, and two spellings that
 * compiled the same while fingerprinting differently would serve one query's
 * template to another.
 *
 * Adding a surface here is one array entry. Leaving one out is the failure this
 * file exists to prevent.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TurbineError } from '../errors.js';
import type { DeferredQuery } from '../query/deferred.js';
import { normalizeWithClause } from '../query/relation-names.js';
import { resolveRelation } from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture. Every relation name is MULTI-WORD, because a single-word relation
// (`posts`, `author`) is spelled identically in both conventions and can prove
// nothing here. That is exactly how the sibling bug survived: the common case
// is self-camouflaging.
// ---------------------------------------------------------------------------

const authors = mockTable(
  'authors',
  [
    { name: 'id', field: 'id' },
    { name: 'display_name', field: 'displayName' },
  ],
  {
    blogPosts: {
      type: 'hasMany',
      name: 'blogPosts',
      from: 'authors',
      to: 'blog_posts',
      foreignKey: 'author_id',
      referenceKey: 'id',
    },
  },
);

const blogPosts = mockTable(
  'blog_posts',
  [
    { name: 'id', field: 'id' },
    { name: 'author_id', field: 'authorId' },
    { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
  ],
  {
    blogAuthor: {
      type: 'belongsTo',
      name: 'blogAuthor',
      from: 'blog_posts',
      to: 'authors',
      foreignKey: 'author_id',
      referenceKey: 'id',
    },
  },
);

const schema = { tables: { authors, blog_posts: blogPosts }, enums: {} } as unknown as SchemaMetadata;
const qAuthors = () => makeQuery('authors', schema);
const qPosts = () => makeQuery('blog_posts', schema);

/** The to-many relation on `authors`, and the to-one on `blog_posts`. */
const MANY = { declared: 'blogPosts', snake: 'blog_posts', bogus: 'blog_postz' };
const ONE = { declared: 'blogAuthor', snake: 'blog_author', bogus: 'blog_auther' };

interface Surface {
  name: string;
  /** Defaults to the to-many trio; to-one surfaces carry their own. */
  trio?: typeof MANY;
  build: (name: string) => DeferredQuery<unknown>;
}

const SURFACES: Surface[] = [
  {
    name: 'with (bare true)',
    build: (n) => qAuthors().buildFindMany({ with: { [n]: true } } as never),
  },
  {
    name: 'with (options: limit + orderBy)',
    build: (n) => qAuthors().buildFindMany({ with: { [n]: { limit: 3, orderBy: { id: 'asc' } } } } as never),
  },
  {
    name: 'with (relation select)',
    build: (n) => qAuthors().buildFindMany({ with: { [n]: { select: { id: true } } } } as never),
  },
  {
    name: 'with (relation where)',
    build: (n) => qAuthors().buildFindMany({ with: { [n]: { where: { id: 1 } } } } as never),
  },
  {
    name: 'with (nested, on the TARGET table)',
    trio: ONE,
    build: (n) => qAuthors().buildFindMany({ with: { blogPosts: { with: { [n]: true } } } } as never),
  },
  {
    name: 'with _count (record form)',
    build: (n) => qAuthors().buildFindMany({ with: { _count: { [n]: true } } } as never),
  },
  {
    name: 'where relation filter (some)',
    build: (n) => qAuthors().buildFindMany({ where: { [n]: { some: { id: 1 } } } } as never),
  },
  {
    name: 'where relation filter (none)',
    build: (n) => qAuthors().buildFindMany({ where: { [n]: { none: { id: 1 } } } } as never),
  },
  {
    name: 'where relation filter (every)',
    build: (n) => qAuthors().buildFindMany({ where: { [n]: { every: { id: 1 } } } } as never),
  },
  {
    name: 'where relation filter, to-one (bare)',
    trio: ONE,
    build: (n) => qPosts().buildFindMany({ where: { [n]: { id: 1 } } } as never),
  },
  {
    name: 'where relation filter nested under OR',
    build: (n) => qAuthors().buildFindMany({ where: { OR: [{ [n]: { some: { id: 1 } } }, { id: 2 }] } } as never),
  },
  {
    name: 'orderBy relation _count',
    build: (n) => qAuthors().buildFindMany({ orderBy: { [n]: { _count: 'desc' } } } as never),
  },
  {
    name: 'orderBy to-one relation target column',
    trio: ONE,
    build: (n) => qPosts().buildFindMany({ orderBy: { [n]: { displayName: 'asc' } } } as never),
  },
  {
    name: 'count with a relation filter',
    build: (n) => qAuthors().buildCount({ where: { [n]: { some: { id: 1 } } } } as never),
  },
];

const trioOf = (s: Surface) => s.trio ?? MANY;

describe('relation spelling symmetry: the fixture can actually prove something', () => {
  it('every relation name is multi-word, so its two spellings differ', () => {
    for (const trio of [MANY, ONE]) {
      assert.notEqual(trio.declared, trio.snake, `${trio.declared} must differ from its snake spelling`);
      assert.notEqual(trio.declared, trio.bogus);
    }
  });

  it('the snake spelling is NOT itself a declared relation', () => {
    // Otherwise every "accepts the snake spelling" assertion below would pass
    // through the exact-match branch and the resolution rule would go untested.
    assert.equal(authors.relations[MANY.snake], undefined);
    assert.equal(blogPosts.relations[ONE.snake], undefined);
  });

  it('the bogus names name no relation under either spelling', () => {
    assert.equal(resolveRelation(authors.relations, MANY.bogus), undefined);
    assert.equal(resolveRelation(blogPosts.relations, ONE.bogus), undefined);
  });

  it('covers every surface exactly once (no duplicate entries masking a gap)', () => {
    assert.equal(new Set(SURFACES.map((s) => s.name)).size, SURFACES.length);
  });
});

describe('relation spelling symmetry: every surface accepts both spellings', () => {
  for (const surface of SURFACES) {
    const { declared, snake, bogus } = trioOf(surface);

    it(`${surface.name}: accepts the declared name "${declared}"`, () => {
      assert.ok(surface.build(declared).sql.length > 0);
    });

    it(`${surface.name}: accepts the table spelling "${snake}"`, () => {
      assert.ok(surface.build(snake).sql.length > 0);
    });

    it(`${surface.name}: both spellings compile to identical SQL and params`, () => {
      const a = surface.build(declared);
      const b = surface.build(snake);
      assert.equal(b.sql, a.sql, `${surface.name}: "${snake}" compiled differently from "${declared}"`);
      assert.deepEqual(b.params, a.params);
    });

    it(`${surface.name}: still refuses the unknown name "${bogus}"`, () => {
      // The point of the rule is that it WIDENS what resolves, never that it
      // stops refusing. A transform that accepted anything would pass all three
      // assertions above.
      assert.throws(
        () => surface.build(bogus),
        (err: unknown) => {
          assert.ok(err instanceof TurbineError, `expected a TurbineError, got ${String(err)}`);
          assert.match(err.code, /TURBINE_E00[35]/, `expected E003 or E005, got ${err.code}`);
          return true;
        },
      );
    });
  }
});

describe('relation spelling symmetry: the resolution rule itself', () => {
  it('an exact declared name wins over the transformed one', () => {
    // A schema that literally declares the snake name keeps it, so adopting the
    // rule cannot re-point an existing query at a different relation.
    const both = {
      blog_posts: { type: 'hasMany', name: 'blog_posts', from: 'a', to: 'x', foreignKey: 'f', referenceKey: 'id' },
      blogPosts: { type: 'hasMany', name: 'blogPosts', from: 'a', to: 'y', foreignKey: 'f', referenceKey: 'id' },
    } as unknown as Record<string, { to: string }>;
    assert.equal(resolveRelation(both, 'blog_posts')?.def.to, 'x');
    assert.equal(resolveRelation(both, 'blogPosts')?.def.to, 'y');
  });

  it('resolves to the DECLARED name, so the result key is canonical', () => {
    assert.equal(resolveRelation(authors.relations, MANY.snake)?.name, MANY.declared);
    assert.equal(resolveRelation(authors.relations, MANY.declared)?.name, MANY.declared);
  });

  it('does not invent a relation from an arbitrary string', () => {
    for (const junk of ['', '_', '__proto__', 'constructor', 'toString', 'blog__posts', 'BLOG_POSTS']) {
      assert.equal(resolveRelation(authors.relations, junk), undefined, `"${junk}" must not resolve`);
    }
  });

  it('normalizeWithClause returns the SAME object when nothing needs rewriting', () => {
    // The hot path: a query already spelling its relations the declared way
    // must allocate nothing and stay reference-identical.
    const clause = { blogPosts: true } as never;
    assert.equal(normalizeWithClause(schema, 'authors', clause), clause);
  });

  it('normalizeWithClause rewrites nested levels against the TARGET table', () => {
    const out = normalizeWithClause(schema, 'authors', { blog_posts: { with: { blog_author: true } } } as never) as
      | Record<string, { with?: Record<string, unknown> }>
      | undefined;
    assert.ok(out);
    assert.deepEqual(Object.keys(out), ['blogPosts']);
    assert.deepEqual(Object.keys(out.blogPosts?.with ?? {}), ['blogAuthor']);
  });

  it('normalizeWithClause leaves an unresolvable key verbatim for the builder to report', () => {
    // Reporting it here would move the error away from its context and change
    // which error type callers see.
    const out = normalizeWithClause(schema, 'authors', { not_a_relation: true } as never);
    assert.deepEqual(Object.keys(out ?? {}), ['not_a_relation']);
  });

  it('a relation named in `select` still points at `with`, under either spelling', () => {
    for (const name of [MANY.declared, MANY.snake]) {
      assert.throws(
        () => qAuthors().buildFindMany({ select: { [name]: true } } as never),
        (err: unknown) => {
          assert.ok(err instanceof TurbineError);
          assert.match(String(err.message), /relation/i);
          assert.match(String(err.message), /`?with`?/);
          return true;
        },
        `select: { ${name}: true } should name the relation and point at \`with\``,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Row-level arm. The compile arm above CANNOT reach this, and that gap shipped
// a real miss: `relationLoadStrategy: 'auto'` decides join-vs-batched inside
// the ASYNC method, and it splits the `with` clause on the raw keys BEFORE the
// builders (which is where normalization first lived) ever run. An `auto` query
// carrying a `limit` picks the join plan and never takes that branch, so every
// hand-written probe passed while an UNBOUNDED to-one relation still failed
// with E005. The agent eval found it; these tests pin it.
// ---------------------------------------------------------------------------

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const sqliteGate = skipGate(!DatabaseSync, 'node:sqlite unavailable (Node < 22.5)');

const EXEC_SCHEMA_SQL = `
CREATE TABLE blog_authors (
  id         INTEGER PRIMARY KEY,
  full_name  TEXT NOT NULL
);
CREATE TABLE blog_posts (
  id              INTEGER PRIMARY KEY,
  blog_author_id  INTEGER NOT NULL REFERENCES blog_authors(id),
  head_line       TEXT NOT NULL
);
CREATE INDEX idx_blog_posts_blog_author_id ON blog_posts(blog_author_id);
`;

describe('relation spelling symmetry: both spellings return the same ROWS', () => {
  let execDb: DatabaseSyncType;
  let execClient: TurbineClient;
  let execSchema: SchemaMetadata;

  beforeEach(() => {
    if (!DatabaseSync) return;
    execDb = new DatabaseSync(':memory:');
    execDb.exec('PRAGMA foreign_keys = ON');
    execDb.exec(EXEC_SCHEMA_SQL);
    // Uneven on purpose: an author with no posts exercises the empty relation.
    for (let a = 1; a <= 3; a++) {
      execDb.exec(`INSERT INTO blog_authors (id, full_name) VALUES (${a}, 'Author ${a}');`);
    }
    let post = 0;
    for (let a = 1; a <= 2; a++) {
      for (let i = 0; i < a; i++) {
        post += 1;
        execDb.exec(`INSERT INTO blog_posts (id, blog_author_id, head_line) VALUES (${post}, ${a}, 'Post ${post}');`);
      }
    }
    execSchema = introspectSqliteDatabase(execDb) as unknown as SchemaMetadata;
    execClient = turbineSqlite(execDb, execSchema as never);
  });

  afterEach(async () => {
    if (!DatabaseSync) return;
    await execClient.disconnect();
  });

  /** The declared relation names the sqlite introspector derives for this schema. */
  const declaredNames = () => ({
    toMany: Object.keys(execSchema.tables.blog_authors?.relations ?? {}),
    toOne: Object.keys(execSchema.tables.blog_posts?.relations ?? {}),
  });
  /** First declared name of a kind, asserted present so a fixture change fails loudly. */
  const firstName = (kind: 'toMany' | 'toOne'): string => {
    const [name] = declaredNames()[kind];
    assert.ok(name, `fixture has no ${kind} relation`);
    return name;
  };
  const snakeOf = (name: string): string => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  sqliteGate.it('the fixture actually has multi-word relation names to prove something with', () => {
    const { toMany, toOne } = declaredNames();
    assert.ok(
      toMany.some((n) => n !== n.toLowerCase()),
      `expected a camelCase to-many relation, got: ${toMany.join(', ')}`,
    );
    assert.ok(
      toOne.some((n) => n !== n.toLowerCase()),
      `expected a camelCase to-one relation, got: ${toOne.join(', ')}`,
    );
  });

  for (const strategy of ['join', 'batched', 'auto'] as const) {
    sqliteGate.it(`to-many relation, both spellings, same rows [${strategy}]`, async () => {
      const declared = firstName('toMany');
      const snake = snakeOf(declared);
      assert.notEqual(snake, declared, 'the fixture must have two distinct spellings');

      const t = execClient.table('blog_authors');
      const base = { orderBy: { id: 'asc' } } as Record<string, unknown>;
      const a = await t.findMany({ ...base, relationLoadStrategy: strategy, with: { [declared]: true } } as never);
      const b = await t.findMany({ ...base, relationLoadStrategy: strategy, with: { [snake]: true } } as never);
      assert.deepEqual(b, a, `"${snake}" returned different rows from "${declared}" under ${strategy}`);
      // Anti-vacuous: the relation must actually be populated, or two empty
      // results would compare equal and prove nothing.
      assert.ok(
        (a as Record<string, unknown>[]).some((r) => Array.isArray(r[declared]) && (r[declared] as []).length > 0),
        'the fixture returned no related rows, so equality proves nothing',
      );
    });

    sqliteGate.it(`UNBOUNDED to-one relation, both spellings, same rows [${strategy}]`, async () => {
      // No `limit`, which is what makes `auto` take its batched branch. This is
      // the exact shape that shipped broken.
      const declared = firstName('toOne');
      const snake = snakeOf(declared);
      assert.notEqual(snake, declared);

      const t = execClient.table('blog_posts');
      const base = { orderBy: { id: 'asc' } } as Record<string, unknown>;
      const a = await t.findMany({ ...base, relationLoadStrategy: strategy, with: { [declared]: true } } as never);
      const b = await t.findMany({ ...base, relationLoadStrategy: strategy, with: { [snake]: true } } as never);
      assert.deepEqual(b, a, `"${snake}" returned different rows from "${declared}" under ${strategy}`);
      assert.ok(
        (a as Record<string, unknown>[]).every((r) => r[declared] !== undefined && r[declared] !== null),
        'the to-one relation came back empty, so equality proves nothing',
      );
    });
  }

  sqliteGate.it('findFirst and findUnique accept the table spelling too', async () => {
    const declared = firstName('toOne');
    const snake = snakeOf(declared);
    const t = execClient.table('blog_posts');
    assert.deepEqual(
      await t.findFirst({ orderBy: { id: 'asc' }, with: { [snake]: true } } as never),
      await t.findFirst({ orderBy: { id: 'asc' }, with: { [declared]: true } } as never),
    );
    assert.deepEqual(
      await t.findUnique({ where: { id: 1 }, with: { [snake]: true } } as never),
      await t.findUnique({ where: { id: 1 }, with: { [declared]: true } } as never),
    );
  });
});

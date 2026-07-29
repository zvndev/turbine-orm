/**
 * A projection field name either resolves to a column or throws. Everywhere.
 *
 * ## What was wrong
 *
 * `select` / `omit` were resolved by two functions: one for the query's own
 * table, one for a relation target. The top-level pair mapped every name
 * through a throwing lookup. The relation pair mapped names optimistically and
 * then FILTERED OUT the ones that did not resolve, emitting SQL for whatever
 * survived. So the same key in the same query threw at the top level and was
 * silently ignored one level down:
 *
 *   - `with: { posts: { select: { titel: true } } }`  ->  `posts: [{}, {}]`
 *   - `with: { posts: { omit:   { titel: true } } }`  ->  `title` comes back
 *
 * The `omit` direction is the one worth staring at: a typo in the clause whose
 * whole job is suppression returned the column it was asked to suppress.
 *
 * ## Why it was worse than an inconsistency between depths
 *
 * The batched loader runs each relation as a real query against the target
 * table, so it went through the THROWING resolver, while the join plan went
 * through the silent one. The two strategies disagreed about whether the query
 * was VALID, and under `relationLoadStrategy: 'auto'` which one runs is decided
 * by a cost heuristic reading index coverage and table size. The same code
 * threw on one table and quietly returned `{}` rows on another. That is the
 * same failure mode as the nested `_count` disagreement fixed in 0.63, and the
 * reason both halves of this file exist: rejection, and AGREEMENT about
 * rejection.
 *
 * Runs on the in-process sqlite engine so it stays in `test:unit`, i.e. inside
 * the gate that runs on every publish, with no database required.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import type { WithClause } from '../query/types.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const dbIt: typeof it = DatabaseSync
  ? it
  : (((name: string) => it(name, { skip: 'requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof it);

const SCHEMA_SQL = `
CREATE TABLE author (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE post (
  id INTEGER PRIMARY KEY,
  author_id INTEGER REFERENCES author(id),
  title TEXT NOT NULL
);
CREATE TABLE tag (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE post_tag (
  post_id INTEGER NOT NULL REFERENCES post(id),
  tag_id INTEGER NOT NULL REFERENCES tag(id),
  PRIMARY KEY (post_id, tag_id)
);
INSERT INTO author VALUES (1, 'a'), (2, 'b');
INSERT INTO post VALUES (1, 1, 'first'), (2, 1, 'second'), (3, 2, 'third');
INSERT INTO tag VALUES (1, 'x'), (2, 'y');
INSERT INTO post_tag VALUES (1, 1), (1, 2), (2, 1);
`;

function fixture(): { db: DatabaseSyncType; schema: SchemaMetadata } {
  const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(':memory:');
  db.exec(SCHEMA_SQL);
  return { db, schema: introspectSqliteDatabase(db) };
}

function relTo(schema: SchemaMetadata, from: string, to: string, type?: string): string {
  const found = Object.values(schema.tables[from]?.relations ?? {}).find(
    (r) => r.to === to && (type === undefined || r.type === type),
  );
  assert.ok(found, `fixture should expose a ${from} -> ${to} relation`);
  return found.name;
}

/** Run `findMany` and report either the rows or the thrown error. */
async function attempt(
  client: ReturnType<typeof turbineSqlite>,
  args: Record<string, unknown>,
): Promise<{ ok: true; rows: unknown[] } | { ok: false; code: string; message: string }> {
  try {
    const rows = await client.table('author').findMany({ ...args, warnOnUnlimited: false } as never);
    return { ok: true, rows: rows as unknown[] };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, code: e.code ?? '(none)', message: e.message ?? '' };
  }
}

const STRATEGIES = ['join', 'batched', 'auto', 'flatten'] as const;

describe('projection field names: unresolvable names are refused, not filtered out', () => {
  dbIt('every projection entry point refuses an unknown field', async () => {
    if (!DatabaseSync) return;
    const { db, schema } = fixture();
    const client = turbineSqlite(db, schema);
    const posts = relTo(schema, 'author', 'post');
    const tags = relTo(schema, 'post', 'tag', 'manyToMany');
    const author = relTo(schema, 'post', 'author');

    // Every shape that turns a caller-supplied name into a column. The relation
    // rows are the ones that used to pass silently, so they pin the JOIN plan
    // explicitly: this fixture has no index on any foreign key, so `'auto'`
    // demotes these relations to the batched loader, which was ALREADY strict.
    // Left on the default, every relation case below would have passed against
    // the broken code, for a reason that has nothing to do with what it tests.
    // That is not a hypothetical, it is the hazard itself: which resolver ran
    // depended on index coverage and table size.
    const join = { relationLoadStrategy: 'join' as const };
    const cases: [label: string, args: Record<string, unknown>][] = [
      ['top-level select', { select: { nmae: true } }],
      ['top-level omit', { omit: { nmae: true } }],
      ['relation select', { ...join, with: { [posts]: { select: { titel: true } } } }],
      ['relation omit', { ...join, with: { [posts]: { omit: { titel: true } } } }],
      ['depth-2 select', { ...join, with: { [posts]: { with: { [tags]: { select: { labl: true } } } } } }],
      ['depth-2 omit', { ...join, with: { [posts]: { with: { [tags]: { omit: { labl: true } } } } } }],
      ['many-to-many select', { ...join, with: { [posts]: { with: { [tags]: { select: { labl: true } } } } } }],
      ['to-one relation select', { ...join, with: { [posts]: { with: { [author]: { select: { nmae: true } } } } } }],
      [
        'relation select under a root select',
        { ...join, select: { id: true }, with: { [posts]: { select: { titel: true } } } },
      ],
    ];

    for (const [label, args] of cases) {
      const got = await attempt(client, args);
      assert.equal(got.ok, false, `${label}: expected a throw, got rows`);
      assert.equal((got as { code: string }).code, 'TURBINE_E003', label);
    }

    await client.disconnect();
  });

  for (const strategy of STRATEGIES) {
    dbIt(`refuses identically under relationLoadStrategy: '${strategy}'`, async () => {
      if (!DatabaseSync) return;
      // The point of this case is AGREEMENT, not rejection. Before the fix the
      // join plan silently returned `{}` rows here while the batched loader
      // threw E003, and `'auto'` chose between them on table size, so the same
      // code was valid or invalid depending on how big the table had grown.
      const { db, schema } = fixture();
      const client = turbineSqlite(db, schema);
      const posts = relTo(schema, 'author', 'post');

      for (const clause of ['select', 'omit'] as const) {
        const got = await attempt(client, {
          with: { [posts]: { [clause]: { titel: true } } },
          relationLoadStrategy: strategy,
        });
        assert.equal(got.ok, false, `${strategy}/${clause}: expected a throw`);
        assert.equal((got as { code: string }).code, 'TURBINE_E003');
      }

      await client.disconnect();
    });
  }

  dbIt('a relation named in select or omit says so, and names the fix', async () => {
    if (!DatabaseSync) return;
    // Not a typo but a habit: Prisma nests relations inside `select`, so this is
    // the natural first guess. The generic unknown-field text degrades into
    // `Did you mean "tag" (a relation)?` for a name spelled exactly right,
    // which answers a question nobody asked, so this shape gets its own message.
    const { db, schema } = fixture();
    const client = turbineSqlite(db, schema);
    const posts = relTo(schema, 'author', 'post');
    const tags = relTo(schema, 'post', 'tag', 'manyToMany');

    const top = await attempt(client, { select: { [posts]: true } });
    assert.equal(top.ok, false);
    assert.match((top as { message: string }).message, /is a relation on table "author", not a column/);
    assert.match((top as { message: string }).message, /Load it with `with:/);

    // Join plan for the same reason as the entry-point case above.
    const nested = await attempt(client, {
      relationLoadStrategy: 'join',
      with: { [posts]: { select: { [tags]: true } } },
    });
    assert.equal(nested.ok, false);
    assert.match((nested as { message: string }).message, /is a relation on table "post", not a column/);

    const omitted = await attempt(client, { omit: { [posts]: true } });
    assert.equal(omitted.ok, false);
    assert.match((omitted as { message: string }).message, /leave it out of `with`/);

    await client.disconnect();
  });

  dbIt('does not over-reject: every spelling that resolved before still resolves', async () => {
    if (!DatabaseSync) return;
    // The risk of a stricter rule is that it refuses something legitimate. The
    // resolver accepts a camelCase field name, the snake_case COLUMN name, and
    // ignores a `false` value without resolving it at all (Prisma parity: a
    // false entry is not a request).
    const { db, schema } = fixture();
    const client = turbineSqlite(db, schema);
    const posts = relTo(schema, 'author', 'post');

    const camel = await attempt(client, { with: { [posts]: { select: { authorId: true, title: true } } } });
    assert.equal(camel.ok, true, 'camelCase field name must resolve');

    const snake = await attempt(client, { with: { [posts]: { select: { author_id: true } } } });
    assert.equal(snake.ok, true, 'the snake_case column name must resolve too');

    // A `false` entry is dropped before resolution, so an unknown key with a
    // false value is not an error. Pinned deliberately: it falls out of the
    // filter-then-map order, and someone reordering those would change it.
    const falsy = await attempt(client, { with: { [posts]: { select: { title: true, titel: false } } } });
    assert.equal(falsy.ok, true, 'a false-valued unknown key is ignored, not resolved');

    await client.disconnect();
  });

  dbIt('prisma-compat still translates a nested relation select, and now surfaces a bad field', async () => {
    if (!DatabaseSync) return;
    // The one real risk in tightening this rule. prisma-compat BUILDS `select`
    // objects: it splits a Prisma nested `select` into core's `with` plus a
    // scalar `select`, so if any key it emits failed to resolve, a stricter core
    // would turn a working migration into a thrown error. Driven end-to-end
    // through a real client rather than a translation spy, because the question
    // is what CORE does with what the adapter emitted.
    const { db, schema } = fixture();
    const client = turbineSqlite(db, schema);
    const posts = relTo(schema, 'author', 'post');
    const compat = createPrismaCompatClient(
      client as unknown as TurbineClient,
      {
        enums: {},
        models: {
          Author: {
            table: 'author',
            accessor: 'author',
            fields: { id: 'id', name: 'name' },
            relations: { posts: { name: posts, cardinality: 'many' } },
            compoundUniques: {},
          },
          Post: {
            table: 'post',
            accessor: 'post',
            fields: { id: 'id', title: 'title', authorId: 'authorId' },
            relations: {},
            compoundUniques: {},
          },
        },
      } as PrismaCompatMap,
    ) as unknown as {
      Author: { findMany(args: unknown): Promise<unknown[]> };
    };

    // The exact shape that produced the 0.63 report: a relation nested inside a
    // `select`. It must still work, and the relation key must not reach core's
    // `select` (which would now throw).
    const rows = await compat.Author.findMany({
      select: { id: true, posts: { select: { id: true, title: true } } },
    });
    // Keyed by the PRISMA relation name, not turbine's: the adapter renames on
    // the way back out, which is also proof the relation went through `with`
    // and never through core's `select`.
    assert.equal(
      JSON.stringify(rows),
      '[{"id":1,"posts":[{"id":1,"title":"first"},{"id":2,"title":"second"}]},' +
        '{"id":2,"posts":[{"id":3,"title":"third"}]}]',
    );

    // A field that is in neither the model map nor the table now surfaces
    // instead of vanishing. Prisma rejects this too, so it is parity, not drift.
    await assert.rejects(
      () => compat.Author.findMany({ select: { id: true, nmae: true } }),
      (err: { code?: string }) => err.code === 'TURBINE_E003',
    );

    await client.disconnect();
  });

  dbIt('a valid projection emits exactly what it did before', async () => {
    if (!DatabaseSync) return;
    // The whole change must be invisible to correct code. Byte-for-byte, not
    // deep-equal: key order is observable through JSON bodies.
    const { db, schema } = fixture();
    const client = turbineSqlite(db, schema);
    const posts = relTo(schema, 'author', 'post');
    const tags = relTo(schema, 'post', 'tag', 'manyToMany');

    const shape: { with: WithClause; orderBy: { id: 'asc' } } = {
      with: {
        [posts]: {
          select: { id: true, title: true },
          with: { [tags]: { omit: { label: true } } },
        },
      },
      orderBy: { id: 'asc' },
    };
    const rows = await client.table('author').findMany({ ...shape, warnOnUnlimited: false });
    assert.equal(
      JSON.stringify(rows),
      '[{"id":1,"name":"a","post":[{"id":1,"title":"first","tag":[{"id":1},{"id":2}]},' +
        '{"id":2,"title":"second","tag":[{"id":1}]}]},{"id":2,"name":"b","post":[{"id":3,"title":"third","tag":[]}]}]',
    );

    await client.disconnect();
  });
});

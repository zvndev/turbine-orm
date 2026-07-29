/**
 * A relation nested inside a `select`-narrowed relation must still load.
 *
 * ## The bug
 *
 * The batched loader stitches parents to children in JS, so every level needs
 * its correlation key present in the rows it was handed. The ROOT call sites
 * (builder.ts) resolve that key set with `neededParentKeyFields`, which walks
 * the whole `with` clause. The NESTED call sites in batched-loader.ts passed
 * only the single key that stitches the level to its own parent, so a child
 * projection narrowed by `select` (or by an `omit` naming the FK) dropped the
 * key the NEXT level down was about to correlate on.
 *
 * The result was silent. `uniqueKeys` skips a row whose key is `undefined`,
 * which is what an unprojected column is, so the loader saw zero keys and took
 * its legitimate "no parent points anywhere" branch: `null` for every to-one,
 * `[]` for every to-many, HTTP 200, well-formed payload. A reporting endpoint
 * that summed a money column across the relation returned 0 for every row it
 * touched, and nothing in the response distinguished that from the truth.
 *
 * ## Why it survived so long
 *
 * It needs THREE things at once: the batched strategy (which `'auto'` selects
 * on its own for an unindexed correlation column, so no caller has to ask for
 * it), a `select` or `omit` on a to-many, and another relation inside that.
 * `include` is unaffected (it projects every scalar, so the key is there) and
 * `join` is immune (it correlates in SQL and never reads a key off a row), so
 * the two shapes people reach for first are both clean.
 *
 * ## The class, which is the part worth remembering
 *
 * This is the SECOND time a missing correlation key has silently emptied a
 * relation: see batched-loader-pii-key.test.ts, where the key was absent
 * because it was PII-tagged and the default projection excluded it. That fix
 * landed at the root call sites and did not reach the nested ones, so the same
 * defect was still live one level down. Both are now covered here and there,
 * and the loader also refuses outright when a correlation key is missing from
 * every parent row rather than treating it as data (E017).
 *
 * Runs on the in-process sqlite engine so it stays in `test:unit`, i.e. inside
 * the gate that runs on every publish, with no database required.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it } from 'node:test';
import type { WithClause } from '../query/types.js';
import type { SchemaMetadata } from '../schema.js';
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

/**
 * stage -> depletion -> sale, plus a junction so the many-to-many loader (a
 * SEPARATE call site with the same defect) is covered by the same fixture.
 *
 * No index on any foreign key, deliberately: that is what makes `'auto'` demote
 * these relations to the batched loader without anyone asking, which is how the
 * bug reached ordinary application queries.
 */
const SCHEMA_SQL = `
CREATE TABLE stage (id INTEGER PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE sale (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL, voided INTEGER NOT NULL DEFAULT 0);
CREATE TABLE depletion (
  id INTEGER PRIMARY KEY,
  stage_id INTEGER NOT NULL REFERENCES stage(id),
  sale_id INTEGER REFERENCES sale(id),
  kind TEXT NOT NULL
);
CREATE TABLE category (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE tag (id INTEGER PRIMARY KEY, name TEXT NOT NULL, category_id INTEGER REFERENCES category(id));
CREATE TABLE depletion_tag (
  depletion_id INTEGER NOT NULL REFERENCES depletion(id),
  tag_id INTEGER NOT NULL REFERENCES tag(id),
  PRIMARY KEY (depletion_id, tag_id)
);
INSERT INTO stage VALUES (1, 'start'), (2, 'end');
INSERT INTO sale VALUES (1, 100, 0), (2, 250, 0), (3, 400, 1);
INSERT INTO depletion VALUES
  (1, 1, 1, 'sale'), (2, 1, 2, 'sale'), (3, 1, 3, 'sale'),
  (4, 2, 1, 'sale'), (5, 2, NULL, 'waste');
INSERT INTO category VALUES (1, 'cat-one'), (2, 'cat-two');
INSERT INTO tag VALUES (1, 'a', 1), (2, 'b', 2);
INSERT INTO depletion_tag VALUES (1, 1), (1, 2), (2, 1);
`;

function fixture(): { db: DatabaseSyncType; schema: SchemaMetadata } {
  const db = new (DatabaseSync as NonNullable<typeof DatabaseSync>)(':memory:');
  db.exec(SCHEMA_SQL);
  return { db, schema: introspectSqliteDatabase(db) };
}

/** Relation name for `from` -> `to`, since introspection derives the spelling. */
function relTo(schema: SchemaMetadata, from: string, to: string): string {
  const found = Object.values(schema.tables[from]?.relations ?? {}).find((r) => r.to === to);
  assert.ok(found, `fixture should expose a ${from} -> ${to} relation`);
  return found.name;
}

const STRATEGIES = ['join', 'batched', 'auto'] as const;

describe('batched loader: a relation nested inside a select-narrowed relation', () => {
  for (const strategy of STRATEGIES) {
    dbIt(`loads the nested to-one under relationLoadStrategy: '${strategy}'`, async () => {
      if (!DatabaseSync) return;
      const { db, schema } = fixture();
      const client = turbineSqlite(db, schema);
      const depletions = relTo(schema, 'stage', 'depletion');
      const sale = relTo(schema, 'depletion', 'sale');

      const rows = await client.table('stage').findMany({
        // `select` on the to-many is the trigger: it narrows the child
        // projection, and the FK the nested to-one correlates on is not in it.
        // This is what prisma-compat emits for a Prisma nested `select`.
        with: { [depletions]: { select: { id: true, kind: true }, with: { [sale]: { select: { id: true } } } } },
        orderBy: { id: 'asc' },
        relationLoadStrategy: strategy,
      });

      const children = rows.flatMap((r) => (r as Record<string, never>)[depletions] ?? []) as Record<
        string,
        { id: number } | null
      >[];
      assert.equal(children.length, 5, 'the to-many itself must load on every strategy');
      const populated = children.filter((c) => c[sale]?.id).length;
      assert.equal(populated, 4, `nested to-one came back on ${populated} of 5 rows under '${strategy}'`);

      // The row with a genuinely NULL foreign key must still be null, not
      // dropped and not invented: the fix must not paper over real absence.
      const nulls = children.filter((c) => c[sale] === null).length;
      assert.equal(nulls, 1, 'a genuinely null FK stays null');

      await client.disconnect();
    });
  }

  dbIt('an `omit` naming the foreign key breaks it the same way, and is fixed the same way', async () => {
    if (!DatabaseSync) return;
    // `omit` is the other spelling of the same narrowing. It was never reported
    // against this bug, and it failed identically before the fix, which is the
    // argument for resolving the key set from the `with` clause rather than
    // patching the one shape that got noticed.
    const { db, schema } = fixture();
    const client = turbineSqlite(db, schema);
    const depletions = relTo(schema, 'stage', 'depletion');
    const sale = relTo(schema, 'depletion', 'sale');

    const rows = await client.table('stage').findMany({
      with: { [depletions]: { omit: { saleId: true }, with: { [sale]: true } } },
      orderBy: { id: 'asc' },
      relationLoadStrategy: 'batched',
    });
    const children = rows.flatMap((r) => (r as Record<string, never>)[depletions] ?? []) as Record<string, unknown>[];
    assert.equal(children.filter((c) => c[sale]).length, 4);
    // The omitted column must still be absent from the output: it is added for
    // the query and stripped after stitching, exactly like any other stitch key.
    assert.equal(
      children.every((c) => !('saleId' in c)),
      true,
      'the omitted FK must not reappear in the payload',
    );
    await client.disconnect();
  });

  dbIt('the same holds through a many-to-many, which is its own call site', async () => {
    if (!DatabaseSync) return;
    // The m2m loader resolves target rows by PK and had the identical one-key
    // projection, so it needed the identical fix. Reaching it takes a NARROWED
    // m2m carrying its own nested relation: stage -> depletion (to-many, with a
    // `select`) -> tag (m2m, with a `select`) -> depletionTag (to-many).
    const { db, schema } = fixture();
    const client = turbineSqlite(db, schema);
    const depletions = relTo(schema, 'stage', 'depletion');
    const tags = relTo(schema, 'depletion', 'tag');
    const category = relTo(schema, 'tag', 'category');
    assert.equal(schema.tables.depletion?.relations[tags]?.type, 'manyToMany', 'this case must exercise the m2m path');

    // The nested relation below the m2m target must correlate on a column that
    // is NOT the target's own PK, or this case cannot discriminate: the m2m
    // loader already projects the target PK to group by, so a nested relation
    // keyed on that PK loads fine even against the broken code. Two earlier
    // versions of this case did exactly that and passed against the bug.
    // `tag.category_id` is the FK that the narrowing `select: { name: true }`
    // drops, which is the real shape.
    // Typed as WithClause explicitly: three levels of computed relation keys
    // defeat the literal inference that the shallower cases above rely on.
    const shape: { with: WithClause; orderBy: { id: 'asc' } } = {
      with: {
        [depletions]: {
          select: { kind: true },
          with: { [tags]: { select: { name: true }, with: { [category]: true } } },
        },
      },
      orderBy: { id: 'asc' },
    };
    const join = await client.table('stage').findMany({ ...shape, relationLoadStrategy: 'join' });
    const batched = await client.table('stage').findMany({ ...shape, relationLoadStrategy: 'batched' });
    assert.equal(JSON.stringify(batched), JSON.stringify(join));
    // Non-degenerate: the innermost level must actually have rows, or the two
    // strategies agree on nothing and this case proves nothing.
    assert.match(
      JSON.stringify(join),
      /"title":"cat-/,
      'the m2m fixture must carry a populated level below the target',
    );

    await client.disconnect();
  });

  dbIt('strategies agree byte-for-byte, key order included', async () => {
    if (!DatabaseSync) return;
    // The documented contract of the batched loader is that its output is
    // byte-for-byte what the join plan produces. `deepEqual` does not check key
    // order, and callers observe key order through JSON bodies and ETags, so
    // this compares the serialized form.
    const { db, schema } = fixture();
    const client = turbineSqlite(db, schema);
    const depletions = relTo(schema, 'stage', 'depletion');
    const sale = relTo(schema, 'depletion', 'sale');
    const args = {
      select: { id: true },
      with: { [depletions]: { select: { id: true, kind: true }, with: { [sale]: { select: { amount: true } } } } },
      orderBy: { id: 'asc' as const },
    };

    const join = await client.table('stage').findMany({ ...args, relationLoadStrategy: 'join' });
    const batched = await client.table('stage').findMany({ ...args, relationLoadStrategy: 'batched' });
    assert.deepEqual(batched, join);
    assert.equal(JSON.stringify(batched), JSON.stringify(join), 'key order must match, not just values');
    // Non-degenerate: two strategies that both return nothing agree vacuously.
    assert.match(JSON.stringify(join), /"amount":/, 'the fixture must actually carry nested data');

    await client.disconnect();
  });
});

/**
 * turbine-orm: a nested `create: [...]` array may mix row shapes.
 *
 * `createMany` refuses rows that do not all name the same fields (see
 * `create-many-uniform-rows.test.ts` and `assertUniformCreateManyRows` in
 * query/writes.ts). The nested-write batch fast path routes a nested
 * `create: [...]` array through `createMany`, so the guard also landed on
 * ordinary user input:
 *
 *   db.users.create({ data: { email, posts: { create: [{ title: 'a' },
 *                                                     { title: 'b', published: false }] } } })
 *
 * That array is legitimate, and it was ALREADY broken before the guard existed
 * (`published` never reached the database, and a field the first row named and a
 * later row omitted was written as NULL over its default). The fix belongs in
 * the nested-write path: split the array into contiguous same-shape runs and
 * issue one `createMany` per run, so each statement stays uniform and the rows
 * still land in the caller's array order.
 *
 * Tier 1 is the pure splitter plus a proof that every run it produces is a shape
 * `createMany` accepts; tier 2 runs the nested write against live engines
 * (SQLite in-process via `node:sqlite`, Postgres gated on DATABASE_URL) over
 * tables whose columns DEFAULT, which is the only way to tell an applied default
 * apart from a NULL written over it.
 *
 * Run: npx tsx --test src/test/create-many-mixed-shapes.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it as nodeIt } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import { createManyShapeRuns } from '../nested-write.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Tier 1, the splitter
// ---------------------------------------------------------------------------

describe('createManyShapeRuns', () => {
  nodeIt("hands back the caller's own array when every row names the same fields", () => {
    const rows = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const runs = createManyShapeRuns(rows);
    assert.equal(runs.length, 1);
    // Identity, not just equality: a uniform batch must reach createMany as the
    // very array the caller passed, so the emitted statement cannot differ.
    assert.equal(runs[0], rows);
  });

  nodeIt('key ORDER does not make a new run, only the set of named fields does', () => {
    const rows = [
      { n: 1, label: 'a' },
      { label: 'b', n: 2 },
    ];
    assert.deepEqual(createManyShapeRuns(rows), [rows]);
  });

  nodeIt('an explicit `undefined` counts as omitted, exactly as in `create`', () => {
    assert.equal(createManyShapeRuns([{ n: 1 }, { n: 2, label: undefined }]).length, 1);
    assert.equal(createManyShapeRuns([{ n: 1, label: 'a' }, { n: 2 }]).length, 2);
  });

  nodeIt('splits on every shape change and keeps the rows in order', () => {
    const a = { title: 'a' };
    const b = { title: 'b', published: true };
    const c = { title: 'c' };
    assert.deepEqual(createManyShapeRuns([a, b, c]), [[a], [b], [c]]);
  });

  nodeIt('batches CONTIGUOUS rows of one shape into a single run', () => {
    const rows = [{ n: 1 }, { n: 2 }, { n: 3, label: 'x' }, { n: 4, label: 'y' }, { n: 5 }];
    assert.deepEqual(createManyShapeRuns(rows), [[rows[0], rows[1]], [rows[2], rows[3]], [rows[4]]]);
  });

  nodeIt('never reorders rows: a repeated shape is a new run, not the earlier one', () => {
    // Grouping non-adjacent rows would batch [A, A][B] here and move the third
    // row ahead of the second, which any server-assigned sequence exposes.
    const rows = [{ n: 1 }, { n: 2, label: 'x' }, { n: 3 }];
    const runs = createManyShapeRuns(rows);
    assert.deepEqual(runs.flat(), rows);
  });

  nodeIt('an empty array produces no runs at all', () => {
    assert.deepEqual(createManyShapeRuns([]), []);
  });

  nodeIt('rows naming nothing are one run (the all-defaults insert)', () => {
    const rows = [{}, { n: undefined }];
    assert.deepEqual(createManyShapeRuns(rows), [rows]);
  });

  nodeIt('every run it produces is a batch createMany accepts', () => {
    const schema: SchemaMetadata = {
      enums: {},
      tables: {
        probe: mockTable('probe', [
          { name: 'id', field: 'id' },
          { name: 'label', field: 'label', pgType: 'text' },
          { name: 'n', field: 'n', pgType: 'int4' },
        ]),
      },
    };
    const rows = [{ n: 1 }, { n: 2, label: 'x' }, { n: 3, label: 'y' }, { n: 4 }];
    const sql = createManyShapeRuns(rows).map((run) => makeQuery('probe', schema).buildCreateMany({ data: run }).sql);
    assert.deepEqual(sql, [
      'INSERT INTO "probe" ("n") SELECT * FROM UNNEST($1::integer[]) RETURNING *',
      'INSERT INTO "probe" ("n", "label") SELECT * FROM UNNEST($1::integer[], $2::text[]) RETURNING *',
      'INSERT INTO "probe" ("n") SELECT * FROM UNNEST($1::integer[]) RETURNING *',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Tier 2, live nested writes
// ---------------------------------------------------------------------------

/**
 * `published` and `views` both DEFAULT, so a row that omits them proves the
 * difference between "the column default applied" and "NULL was written over
 * it" (the latter fails outright here, both columns are NOT NULL).
 */
const usersDdl = (autoPk: string) => `CREATE TABLE mixedshape_users (id ${autoPk}, email TEXT NOT NULL)`;
const postsDdl = (autoPk: string, boolType: string, trueLit: string) =>
  `CREATE TABLE mixedshape_posts (
     id ${autoPk},
     user_id INT NOT NULL REFERENCES mixedshape_users(id),
     title TEXT NOT NULL,
     published ${boolType} NOT NULL DEFAULT ${trueLit},
     views INT NOT NULL DEFAULT 7
   )`;

interface LiveTable {
  create(args: { data: Record<string, unknown> }): Promise<unknown>;
  findMany(args?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/**
 * The shared live assertions. `falseValue` is the engine's spelling of false
 * (SQLite has no boolean type, so `published` is an INTEGER 0/1 there).
 */
async function assertNestedMixedShapes(
  users: LiveTable,
  posts: LiveTable,
  falseValue: unknown,
  inserts: () => string[],
) {
  await users.create({
    data: {
      email: 'a@b.c',
      mixedshapePosts: {
        create: [{ title: 'a' }, { title: 'b', published: falseValue }, { title: 'c' }],
      },
    },
  });

  const rows = await posts.findMany({ orderBy: { id: 'asc' }, warnOnUnlimited: false });
  assert.deepEqual(
    rows.map((r) => r.title),
    ['a', 'b', 'c'],
    'rows land in the array order the caller wrote them, so generated keys stay ascending with the array',
  );
  // The omitted field takes the column DEFAULT, it is not NULLed out, and the
  // field only the middle row names actually reaches the database.
  assert.deepEqual(
    rows.map((r) => Boolean(r.published)),
    [true, false, true],
  );
  assert.deepEqual(
    rows.map((r) => Number(r.views)),
    [7, 7, 7],
  );
  assert.equal(inserts().length, 3, 'one statement per contiguous same-shape run');

  // A uniform array is untouched: still exactly ONE statement.
  inserts().length = 0;
  await users.create({
    data: { email: 'd@b.c', mixedshapePosts: { create: [{ title: 'u1' }, { title: 'u2' }] } },
  });
  assert.equal(inserts().length, 1, 'a uniform nested array is still one createMany');
  assert.match(inserts()[0]!, /INSERT INTO "mixedshape_posts" \("title", "user_id"\)/);
}

/** node:sqlite is a builtin only on Node >= 22.5; probe without a static import. */
const hasNodeSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const sqliteGate = skipGate(!hasNodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

describe('nested create with mixed row shapes, live sqlite', () => {
  sqliteGate.it('splits into contiguous runs, keeps order, and applies defaults', async () => {
    const { introspectSqliteDatabase, turbineSqlite } = await import('../sqlite.js');
    const { DatabaseSync } = createRequire(process.cwd())('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec(usersDdl('INTEGER PRIMARY KEY AUTOINCREMENT'));
    db.exec(postsDdl('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER', '1'));

    const client = turbineSqlite(db, introspectSqliteDatabase(db));
    const inserts: string[] = [];
    client.$on('query', (e) => {
      if (/^INSERT INTO "mixedshape_posts"/.test(e.sql)) inserts.push(e.sql);
    });
    try {
      await assertNestedMixedShapes(
        client.table('mixedshape_users') as never,
        client.table('mixedshape_posts') as never,
        0,
        () => inserts,
      );
    } finally {
      await client.disconnect();
    }
  });
});

const DATABASE_URL = process.env.DATABASE_URL;
const pgGate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('nested create with mixed row shapes, live postgres', () => {
  pgGate.it('splits into contiguous runs, keeps order, and applies defaults', async () => {
    const bootstrap = new pg.Pool({ connectionString: DATABASE_URL! });
    const drop = 'DROP TABLE IF EXISTS mixedshape_posts, mixedshape_users CASCADE';
    await bootstrap.query(drop);
    await bootstrap.query(usersDdl('BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY'));
    await bootstrap.query(postsDdl('BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY', 'BOOLEAN', 'true'));
    await bootstrap.end();

    const schema = await introspect({ connectionString: DATABASE_URL! });
    const client = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schema);
    await client.connect();
    const inserts: string[] = [];
    client.$on('query', (e) => {
      if (/^INSERT INTO "mixedshape_posts"/.test(e.sql)) inserts.push(e.sql);
    });
    try {
      await assertNestedMixedShapes(
        client.table('mixedshape_users') as never,
        client.table('mixedshape_posts') as never,
        false,
        () => inserts,
      );
    } finally {
      await client.disconnect();
      const cleanup = new pg.Pool({ connectionString: DATABASE_URL! });
      await cleanup.query(drop);
      await cleanup.end();
    }
  });
});

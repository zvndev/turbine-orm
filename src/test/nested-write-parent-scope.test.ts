/**
 * Nested writes must be scoped to the parent being written.
 *
 * `delete` / `update` / `disconnect` / `upsert` inside a relation's `data` used
 * only the caller-supplied `where`, with no predicate tying the child to the
 * parent, so `users.update({ where: { id: 1 }, data: { posts: { delete: { id: 4 } } } })`
 * happily deleted post 4 even though it belongs to user 2. Every one of those
 * operations must now AND the relation correlation (`child.fk = parent.ref`)
 * onto the caller's `where`, and report E001 when the target is not a child of
 * this parent.
 *
 * The behavioural half runs on the in-process sqlite engine so it executes in
 * the normal `test:unit` lane; the SQL-shape half drives the engine directly
 * with a recording mock transaction.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import type { BetterSqlite3Database } from '../better-sqlite3.js';
import type { TurbineClient } from '../client.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { executeNestedUpdate, type NestedWriteContext } from '../nested-write.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { mockTable, skipGate } from './helpers.js';
import { closeSqliteAfter } from './sqlite-fixture-lifetime.js';

// ---------------------------------------------------------------------------
// Part 1: the where handed to the child table carries the correlation
// ---------------------------------------------------------------------------

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    users: {
      ...mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
      relations: {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    },
    posts: mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'title', field: 'title', pgType: 'text' },
    ]),
  },
};

interface LogEntry {
  op: string;
  table: string;
  where?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

/** Mock tx whose child rows all belong to user 1, so user 2 owns nothing. */
function recordingCtx(): { ctx: NestedWriteContext; log: LogEntry[] } {
  const log: LogEntry[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: mock transaction for unit tests
  const table = (name: string): any => ({
    async create(args: { data: Record<string, unknown> }) {
      log.push({ op: 'create', table: name, data: args.data });
      return { id: 999, ...args.data };
    },
    async createMany(args: { data: Record<string, unknown>[] }) {
      log.push({ op: 'createMany', table: name });
      return args.data;
    },
    async update(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      log.push({ op: 'update', table: name, where: args.where, data: args.data });
      return { ...args.where, ...args.data };
    },
    async updateMany(args: { where: Record<string, unknown> }) {
      log.push({ op: 'updateMany', table: name, where: args.where });
      return { count: 1 };
    },
    async delete(args: { where: Record<string, unknown> }) {
      log.push({ op: 'delete', table: name, where: args.where });
      return args.where;
    },
    async deleteMany(args: { where: Record<string, unknown> }) {
      log.push({ op: 'deleteMany', table: name, where: args.where });
      return { count: 1 };
    },
    async findMany(args: { where: Record<string, unknown> }) {
      log.push({ op: 'findMany', table: name, where: args.where });
      return [];
    },
    async findUnique(args: { where: Record<string, unknown> }) {
      log.push({ op: 'findUnique', table: name, where: args.where });
      return { id: 1, ...args.where };
    },
  });
  return { ctx: { schema, tx: { table } }, log };
}

function childOp(log: LogEntry[], op: string): LogEntry {
  const entry = log.find((l) => l.table === 'posts' && l.op === op);
  assert.ok(entry, `expected a ${op} on posts`);
  return entry;
}

describe('nested writes: the child predicate carries the parent correlation', () => {
  it('delete ANDs the parent FK onto the caller where', async () => {
    const { ctx, log } = recordingCtx();
    await executeNestedUpdate(ctx, 'users', { id: 7 }, { posts: { delete: { id: 4 } } });
    assert.deepEqual(childOp(log, 'delete').where, { id: 4, userId: 7 });
  });

  it('update ANDs the parent FK onto the caller where', async () => {
    const { ctx, log } = recordingCtx();
    await executeNestedUpdate(
      ctx,
      'users',
      { id: 7 },
      { posts: { update: { where: { id: 4 }, data: { title: 'x' } } } },
    );
    assert.deepEqual(childOp(log, 'update').where, { id: 4, userId: 7 });
  });

  it('a caller where that names the FK itself is combined with AND, never overwritten', async () => {
    const { ctx, log } = recordingCtx();
    await executeNestedUpdate(ctx, 'users', { id: 7 }, { posts: { delete: { userId: 2 } } });
    assert.deepEqual(childOp(log, 'delete').where, { AND: [{ userId: 2 }, { userId: 7 }] });
  });

  it('upsert scopes its existence lookup to this parent', async () => {
    const { ctx, log } = recordingCtx();
    await executeNestedUpdate(
      ctx,
      'users',
      { id: 7 },
      {
        posts: { upsert: { where: { id: 4 }, create: { title: 'new' }, update: { title: 'upd' } } },
      },
    );
    assert.deepEqual(childOp(log, 'findUnique').where, { id: 4, userId: 7 });
  });

  it('an empty or all-undefined selector is refused, never widened to the whole relation', async () => {
    // The correlation makes the merged predicate non-empty, so the empty-where
    // guard downstream can no longer see that the CALLER selected nothing.
    for (const target of [{}, { id: undefined }]) {
      const { ctx, log } = recordingCtx();
      await assert.rejects(
        executeNestedUpdate(ctx, 'users', { id: 7 }, { posts: { delete: target } }),
        (err: unknown) => err instanceof ValidationError && /at least one defined value/.test((err as Error).message),
      );
      assert.equal(
        log.some((l) => l.table === 'posts' && l.op === 'delete'),
        false,
        'no delete may reach the child table',
      );
    }
  });

  it('an unsupported many-to-many nested write is refused, not silently dropped', async () => {
    // connect / disconnect / set now write junction rows (see nested-write.test.ts);
    // every other m2m operation still refuses. Before either change it fell off
    // the end of the dispatch, so the write never happened and the call
    // reported success.
    const m2mSchema: SchemaMetadata = {
      enums: {},
      tables: {
        users: {
          ...mockTable('users', [
            { name: 'id', field: 'id' },
            { name: 'name', field: 'name', pgType: 'text' },
          ]),
          relations: {
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
        },
        tags: mockTable('tags', [
          { name: 'id', field: 'id' },
          { name: 'label', field: 'label', pgType: 'text' },
        ]),
      },
    };
    const { ctx, log } = recordingCtx();
    await assert.rejects(
      executeNestedUpdate({ ...ctx, schema: m2mSchema }, 'users', { id: 7 }, { tags: { delete: { id: 1 } } }),
      (err: unknown) => err instanceof ValidationError && /many-to-many/.test((err as Error).message),
    );
    assert.equal(
      log.some((l) => l.table === 'user_tags'),
      false,
    );
  });

  it('a supported many-to-many op still refuses when the junction table is absent from the metadata', async () => {
    // The junction rows cannot be addressed without its metadata, so connect
    // must report that rather than write nothing and return success.
    const m2mSchema: SchemaMetadata = {
      enums: {},
      tables: {
        users: {
          ...mockTable('users', [
            { name: 'id', field: 'id' },
            { name: 'name', field: 'name', pgType: 'text' },
          ]),
          relations: {
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
        },
        tags: mockTable('tags', [
          { name: 'id', field: 'id' },
          { name: 'label', field: 'label', pgType: 'text' },
        ]),
      },
    };
    const { ctx, log } = recordingCtx();
    await assert.rejects(
      executeNestedUpdate({ ...ctx, schema: m2mSchema }, 'users', { id: 7 }, { tags: { connect: { id: 1 } } }),
      (err: unknown) =>
        err instanceof ValidationError && /junction table "user_tags" is not present/.test((err as Error).message),
    );
    assert.equal(
      log.some((l) => l.table === 'user_tags'),
      false,
    );
  });

  it('"delete: true" is refused on a to-many relation', async () => {
    const { ctx } = recordingCtx();
    await assert.rejects(
      executeNestedUpdate(ctx, 'users', { id: 7 }, { posts: { delete: true } }),
      (err: unknown) => err instanceof ValidationError && /every related "posts" row/.test((err as Error).message),
    );
  });

  it('a parent whose reference key is null relates to no child (E001, no write issued)', async () => {
    const { ctx, log } = recordingCtx();
    await assert.rejects(
      // findUnique on the mock echoes the where, so the parent row's `id` is null.
      executeNestedUpdate(ctx, 'users', { id: null }, { posts: { delete: { id: 4 } } }),
      (err: unknown) => err instanceof NotFoundError && /related to this parent/.test((err as Error).message),
    );
    assert.equal(
      log.some((l) => l.table === 'posts' && l.op === 'delete'),
      false,
      'no unscoped delete may reach the child table',
    );
  });
});

// ---------------------------------------------------------------------------
// Part 2: behaviour on a real in-process SQLite database, through each driver
// ---------------------------------------------------------------------------

const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

// The optional better-sqlite3 binding, which is not a dependency of this
// repository: CI installs the pinned release outside the checkout and names it
// with TURBINE_SQLITE_BINDING_PEER, and TURBINE_REQUIRE_SQLITE_BINDING=1 makes a
// binding that does not load fail this file (the guard
// src/test/sqlite-binding.test.ts uses for the same peer).
const BetterSqlite3: (new (path: string) => BetterSqlite3Database) | undefined = (() => {
  try {
    return createRequire(import.meta.url)(process.env.TURBINE_SQLITE_BINDING_PEER ?? 'better-sqlite3');
  } catch (error) {
    if (process.env.TURBINE_REQUIRE_SQLITE_BINDING === '1') throw error;
    return undefined;
  }
})();

const SCHEMA_SQL = `
CREATE TABLE users (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
CREATE TABLE posts (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  title   TEXT NOT NULL
);
`;

const SEED_SQL = `
INSERT INTO users (id, name) VALUES (1, 'alice'), (2, 'bob');
INSERT INTO posts (id, user_id, title) VALUES (1, 1, 'a1'), (4, 2, 'b1');
`;

/** The part of a native handle these tests use; both drivers provide it. */
interface NativeHandle {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

interface Driver {
  name: string;
  /** A test that registers as skipped when the driver cannot load here. */
  it: typeof it;
  /** A seeded handle, closed after the test, and a client over it. */
  open(t: TestContext): Promise<{ db: NativeHandle; client: TurbineClient; schema: SchemaMetadata }>;
}

const DRIVERS: Driver[] = [
  {
    name: 'node:sqlite',
    it: skipGate(!DatabaseSync, 'requires node:sqlite (Node >= 22.5)').it,
    async open(t) {
      const db = closeSqliteAfter(new DatabaseSync!(':memory:'), t.after.bind(t));
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(SCHEMA_SQL);
      db.exec(SEED_SQL);
      const schema = introspectSqliteDatabase(db);
      return { db, schema, client: turbineSqlite(db, schema, { warnOnUnlimited: false }) };
    },
  },
  {
    name: 'better-sqlite3',
    it: BetterSqlite3
      ? it
      : (((name: string) =>
          it(name, {
            skip: 'requires the optional better-sqlite3 peer (set TURBINE_SQLITE_BINDING_PEER)',
          }, () => {})) as typeof it),
    async open(t) {
      const { introspectBetterSqlite3Database, turbineBetterSqlite3 } = await import('../better-sqlite3.js');
      const db = new BetterSqlite3!(':memory:');
      // A supplied handle stays caller owned: the client never closes it.
      t.after(() => db.close());
      db.exec('PRAGMA foreign_keys = ON');
      db.exec(SCHEMA_SQL);
      db.exec(SEED_SQL);
      const schema = introspectBetterSqlite3Database(db);
      const client = (await turbineBetterSqlite3(db, schema, { warnOnUnlimited: false })) as unknown as TurbineClient;
      return { db, schema, client };
    },
  },
];

for (const driver of DRIVERS) {
  const dbIt = driver.it;
  let db: NativeHandle;
  let client: TurbineClient;
  let schema: SchemaMetadata;

  function user(id: number): Record<string, unknown> | undefined {
    return db.prepare('SELECT id, name FROM users WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  }

  function post(id: number): Record<string, unknown> | undefined {
    return db.prepare('SELECT id, user_id, title FROM posts WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
  }

  function count(sql: string): number {
    return Number((db.prepare(sql).get() as { c: number }).c);
  }

  /** Nested update on user 1 (post 4 belongs to user 2). */
  function updateUser1(data: Record<string, unknown>): Promise<unknown> {
    return client.table('users').update({ where: { id: 1 }, data } as never);
  }

  describe(`nested writes: a child of a different parent is untouchable (${driver.name})`, () => {
    beforeEach(async (t) => {
      assert.ok('after' in t, 'beforeEach must receive a test context');
      if (driver.it !== it) return;
      ({ db, client, schema } = await driver.open(t as TestContext));
    });

    afterEach(async () => {
      if (driver.it !== it) return;
      await client.disconnect();
    });

    dbIt('delete on a foreign child throws E001 and leaves the row intact', async () => {
      await assert.rejects(updateUser1({ posts: { delete: { id: 4 } } }), (err: unknown) => {
        assert.ok(err instanceof NotFoundError, `expected NotFoundError, got ${String(err)}`);
        assert.equal(err.code, 'TURBINE_E001');
        assert.match(err.message, /relation "posts"/);
        assert.match(err.message, /related to this parent/);
        return true;
      });
      assert.ok(post(4), 'post 4 must still exist');
    });

    dbIt('delete on an owned child still works', async () => {
      await updateUser1({ posts: { delete: { id: 1 } } });
      assert.equal(post(1), undefined);
      assert.ok(post(4));
    });

    dbIt('update on a foreign child throws E001 and leaves the row unchanged', async () => {
      await assert.rejects(
        updateUser1({ posts: { update: { where: { id: 4 }, data: { title: 'hijacked' } } } }),
        NotFoundError,
      );
      assert.equal(post(4)!.title, 'b1');
    });

    dbIt('update on an owned child still works', async () => {
      await updateUser1({ posts: { update: { where: { id: 1 }, data: { title: 'renamed' } } } });
      assert.equal(post(1)!.title, 'renamed');
    });

    dbIt('disconnect on a foreign child throws E001 and does not null its FK', async () => {
      await assert.rejects(updateUser1({ posts: { disconnect: { id: 4 } } }), NotFoundError);
      assert.equal(post(4)!.user_id, 2);
    });

    dbIt('disconnect on an owned child still nulls the FK', async () => {
      await updateUser1({ posts: { disconnect: { id: 1 } } });
      assert.equal(post(1)!.user_id, null);
    });

    dbIt('upsert never updates a foreign row: it creates one for this parent', async () => {
      await updateUser1({
        posts: { upsert: { where: { id: 4 }, create: { title: 'mine' }, update: { title: 'hijacked' } } },
      });
      assert.equal(post(4)!.title, 'b1', "another parent's row must not be updated");
      const created = db.prepare("SELECT user_id FROM posts WHERE title = 'mine'").get() as { user_id: number };
      assert.equal(created.user_id, 1);
    });

    dbIt('upsert on an owned row updates it in place', async () => {
      await updateUser1({
        posts: { upsert: { where: { id: 1 }, create: { title: 'never' }, update: { title: 'updated' } } },
      });
      assert.equal(post(1)!.title, 'updated');
      assert.equal(count("SELECT COUNT(*) AS c FROM posts WHERE title = 'never'"), 0);
    });
    dbIt('belongsTo upsert never rewrites the row this parent does not point at', async () => {
      // Post 1 belongs to user 1. A nested `user` upsert addressing user 2 must
      // not rename user 2: it is out of the relation, so the upsert falls to its
      // create branch and re-points post 1 at the newly created row.
      await client.table('posts').update({
        where: { id: 1 },
        data: { user: { upsert: { where: { id: 2 }, create: { name: 'fresh' }, update: { name: 'hijacked' } } } },
      } as never);
      assert.equal(user(2)!.name, 'bob', "another row's name must not be rewritten");
      const created = db.prepare("SELECT id FROM users WHERE name = 'fresh'").get() as { id: number };
      assert.equal(post(1)!.user_id, created.id);
    });

    dbIt('belongsTo upsert on the row this parent DOES point at updates it in place', async () => {
      await client.table('posts').update({
        where: { id: 1 },
        data: { user: { upsert: { where: { id: 1 }, create: { name: 'never' }, update: { name: 'renamed' } } } },
      } as never);
      assert.equal(user(1)!.name, 'renamed');
      assert.equal(post(1)!.user_id, 1);
      assert.equal(count("SELECT COUNT(*) AS c FROM users WHERE name = 'never'"), 0);
    });
    dbIt('set refuses to run when the parent reference key is missing, instead of clearing the table', async () => {
      // `set` clears current children with allowFullTableScan, which is exactly
      // what disables the empty-where guard: a missing reference key would null
      // every FK in the child table.
      const ctx = {
        schema,
        tx: {
          // The parent row comes back WITHOUT its `id` (the reference key), which
          // is the shape a projection that omits the correlation column produces.
          // biome-ignore lint/suspicious/noExplicitAny: only the guard runs; no write is issued
          table: () => ({ findUnique: async () => ({ name: 'alice' }) }) as any,
        },
      };
      await assert.rejects(
        executeNestedUpdate(ctx, 'users', { name: 'alice' }, { posts: { set: [{ id: 1 }] } }),
        (err: unknown) => err instanceof ValidationError && /reference key/.test((err as Error).message),
      );
      assert.equal(post(1)!.user_id, 1, 'no FK may be nulled');
    });
  });
}

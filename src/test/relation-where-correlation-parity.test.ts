/**
 * Batched vs join parity when a relation `where` names the CORRELATION column.
 *
 * The batched loader merges the chunk predicate (`fk IN (...)`) into the
 * relation's own `where`. A bare spread let the chunk predicate overwrite a
 * caller filter on that same column, so `with: { posts: { where: { userId: 1 } } }`
 * returned another parent's rows under 'batched' (and under the default 'auto',
 * which falls back to batched on unindexed correlation columns) while 'join'
 * excluded them. The two strategies must return identical results.
 *
 * Runs in the normal `test:unit` lane: the sqlite engine is in-process via
 * `node:sqlite`, so this guarantee is checked in CI with no DATABASE_URL.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { afterEach, beforeEach, describe, it as nodeIt } from 'node:test';
import type { TurbineClient } from '../client.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';

// `node:sqlite` is a builtin only on Node >= 22.5, so probe without a static
// import so the file still loads (and skips) on the lowest supported Node.
const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const it: typeof nodeIt = DatabaseSync
  ? nodeIt
  : (((name: string) => nodeIt(name, { skip: 'requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof nodeIt);

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
INSERT INTO posts (id, user_id, title) VALUES
  (1, 1, 'a1'), (2, 1, 'a2'), (3, 1, 'a3'), (4, 2, 'b1');
`;

interface PostRow {
  id: number;
  userId: number | null;
  title: string;
}
interface UserRow {
  id: number;
  name: string;
  posts?: PostRow[];
}

let db: DatabaseSyncType;
let client: TurbineClient;

beforeEach(() => {
  if (!DatabaseSync) return;
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  db.exec(SEED_SQL);
  client = turbineSqlite(db, introspectSqliteDatabase(db), { warnOnUnlimited: false });
});

afterEach(async () => {
  if (!DatabaseSync) return;
  await client.disconnect();
});

/** Run the same args under both strategies and assert byte-identical results. */
async function bothStrategies<T>(table: string, args: Record<string, unknown>): Promise<{ join: T[]; batched: T[] }> {
  const join = (await client.table(table).findMany({ ...args, relationLoadStrategy: 'join' } as never)) as T[];
  const batched = (await client.table(table).findMany({ ...args, relationLoadStrategy: 'batched' } as never)) as T[];
  assert.deepEqual(batched, join, 'batched result must equal the join result');
  return { join, batched };
}

describe('relation where on the correlation column: batched == join', () => {
  it('hasMany: a where on the child FK is not overwritten by the chunk predicate', async () => {
    const { batched } = await bothStrategies<UserRow>('users', {
      orderBy: { id: 'asc' },
      with: { posts: { where: { userId: 1 }, orderBy: { id: 'asc' } } },
    });

    const bob = batched.find((u) => u.id === 2)!;
    // Bob's own post (id 4) does NOT satisfy `userId = 1`, so his bucket is empty.
    assert.deepEqual(bob.posts, [], "another parent's rows must not leak in");
    const alice = batched.find((u) => u.id === 1)!;
    assert.deepEqual(
      alice.posts!.map((p) => p.id),
      [1, 2, 3],
    );
  });

  it('hasMany: a where EXCLUDING every parent yields empty buckets on both paths', async () => {
    const { batched } = await bothStrategies<UserRow>('users', {
      orderBy: { id: 'asc' },
      with: { posts: { where: { userId: 999 } } },
    });
    assert.deepEqual(
      batched.map((u) => u.posts),
      [[], []],
    );
  });

  it('hasMany: an operator filter on the FK still narrows (both predicates apply)', async () => {
    const { batched } = await bothStrategies<UserRow>('users', {
      orderBy: { id: 'asc' },
      with: { posts: { where: { userId: { gt: 1 } }, orderBy: { id: 'asc' } } },
    });
    assert.deepEqual(batched.find((u) => u.id === 1)!.posts, []);
    assert.deepEqual(
      batched.find((u) => u.id === 2)!.posts!.map((p) => p.id),
      [4],
    );
  });

  it('belongsTo: a where on the parent PK is not overwritten by the chunk predicate', async () => {
    const { batched } = await bothStrategies<PostRow & { user?: UserRow | null }>('posts', {
      orderBy: { id: 'asc' },
      with: { user: { where: { id: 999 } } },
    });
    assert.deepEqual(
      batched.map((p) => p.user),
      [null, null, null, null],
      'no post has an author with id 999',
    );
  });

  it('belongsTo: a matching where still resolves on both paths', async () => {
    const { batched } = await bothStrategies<PostRow & { user?: UserRow | null }>('posts', {
      orderBy: { id: 'asc' },
      with: { user: { where: { id: 1 } } },
    });
    assert.deepEqual(
      batched.map((p) => (p.user ? p.user.id : null)),
      [1, 1, 1, null],
    );
  });

  it('a relation where NOT naming the correlation column is unaffected', async () => {
    const { batched } = await bothStrategies<UserRow>('users', {
      orderBy: { id: 'asc' },
      with: { posts: { where: { title: 'a2' } } },
    });
    assert.deepEqual(
      batched.find((u) => u.id === 1)!.posts!.map((p) => p.title),
      ['a2'],
    );
    assert.deepEqual(batched.find((u) => u.id === 2)!.posts, []);
  });

  it('an OR combinator over the correlation column composes as AND with the chunk', async () => {
    const { batched } = await bothStrategies<UserRow>('users', {
      orderBy: { id: 'asc' },
      with: { posts: { where: { OR: [{ userId: 1 }, { title: 'nope' }] }, orderBy: { id: 'asc' } } },
    });
    assert.deepEqual(batched.find((u) => u.id === 2)!.posts, []);
    assert.equal(batched.find((u) => u.id === 1)!.posts!.length, 3);
  });
});

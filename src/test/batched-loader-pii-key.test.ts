/**
 * A PII-tagged correlation column must not silently empty a relation.
 *
 * The batched loader stitches parents to children in JS, so it needs the
 * correlation key present in the parent rows. The default projection excludes
 * PII-tagged columns, so a relation whose `referenceKey` is itself PII-tagged
 * had no keys to stitch on: the loader short-circuited and every parent came
 * back with an empty relation array, on the DEFAULT `'auto'` strategy, with no
 * error. The key is now projected explicitly and stripped after stitching, so
 * the value still never reaches the caller.
 *
 * Behaviour runs on the in-process sqlite engine so it stays in `test:unit`.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it } from 'node:test';
import { defaultProjectionFields, includeKeysForBatching } from '../query/batched-loader.js';
import { UNSAFE } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase, turbineSqlite } from '../sqlite.js';
import { mockTable } from './helpers.js';

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
CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
CREATE TABLE posts (id INTEGER PRIMARY KEY, author_email TEXT REFERENCES users(email), title TEXT NOT NULL);
INSERT INTO users VALUES (1, 'a@x', 'a'), (2, 'b@x', 'b');
INSERT INTO posts VALUES (1, 'a@x', 'p1'), (2, 'a@x', 'p2'), (3, 'b@x', 'p3');
`;

function taggedSchema(db: DatabaseSyncType): SchemaMetadata {
  const schema = introspectSqliteDatabase(db);
  for (const col of schema.tables.users!.columns) {
    if (col.name === 'email') col.pii = true;
  }
  return schema;
}

describe('batched loader: a PII-tagged correlation key', () => {
  for (const strategy of ['join', 'batched', 'auto'] as const) {
    dbIt(`still loads the relation under relationLoadStrategy: '${strategy}'`, async () => {
      if (!DatabaseSync) return;
      const db = new DatabaseSync(':memory:');
      db.exec(SCHEMA_SQL);
      // The strategy is a per-QUERY arg here: TurbineSqliteOptions does not
      // carry the client-level knob, so passing it there would silently test
      // the default three times.
      const client = turbineSqlite(db, taggedSchema(db), { warnOnUnlimited: false });
      try {
        const rows = (await client.table('users').findMany({
          with: { posts: true },
          orderBy: { id: 'asc' },
          relationLoadStrategy: strategy,
        } as never)) as Record<string, unknown>[];
        assert.deepEqual(
          rows.map((r) => (r.posts as { title: string }[]).map((p) => p.title)),
          [['p1', 'p2'], ['p3']],
          'every strategy must return the same children',
        );
        // The key was projected only to stitch: it must not reach the caller.
        for (const row of rows) {
          assert.equal(Object.hasOwn(row, 'email'), false, 'the PII correlation key must be stripped');
        }
      } finally {
        await client.disconnect();
      }
    });
  }

  dbIt('returns the PII key when the caller opts in with includePii', async () => {
    if (!DatabaseSync) return;
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA_SQL);
    const client = turbineSqlite(db, taggedSchema(db), { warnOnUnlimited: false });
    try {
      const rows = (await client.table('users').findMany({
        with: { posts: true },
        includePii: UNSAFE,
        orderBy: { id: 'asc' },
        relationLoadStrategy: 'batched',
      } as never)) as Record<string, unknown>[];
      assert.equal(rows[0]!.email, 'a@x');
      assert.equal((rows[0]!.posts as unknown[]).length, 2);
    } finally {
      await client.disconnect();
    }
  });
});

describe('includeKeysForBatching + defaultProjectionFields', () => {
  const meta = (() => {
    const t = mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'name', field: 'name', pgType: 'text' },
    ]);
    for (const c of t.columns) if (c.name === 'email') c.pii = true;
    return t;
  })();

  it('an untagged table keeps the select/omit-free fast path', () => {
    const plain = mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
    ]);
    assert.equal(defaultProjectionFields(plain, undefined), undefined);
    assert.deepEqual(includeKeysForBatching(undefined, undefined, ['id'], defaultProjectionFields(plain, undefined)), {
      select: undefined,
      omit: undefined,
      strip: [],
    });
  });

  it('includePii disables the whole mechanism (nothing is hidden)', () => {
    assert.equal(defaultProjectionFields(meta, true), undefined);
  });

  it('a hidden key becomes an explicit select of the visible columns plus that key', () => {
    const proj = includeKeysForBatching(undefined, undefined, ['email'], defaultProjectionFields(meta, undefined));
    assert.deepEqual(proj.select, { id: true, name: true, email: true });
    assert.equal(proj.omit, undefined);
    assert.deepEqual(proj.strip, ['email']);
  });

  it('a visible key still takes the fast path even on a tagged table', () => {
    const proj = includeKeysForBatching(undefined, undefined, ['id'], defaultProjectionFields(meta, undefined));
    assert.equal(proj.select, undefined);
    assert.deepEqual(proj.strip, []);
  });
});

/**
 * `with: { _count: ... }` on PowDB answers what Postgres answers.
 *
 * Each case runs on the in-process PowDB engine and, when DATABASE_URL is set,
 * on Postgres with the same schema and seed, and both are compared with the
 * expectation written here:
 *
 *   - hasMany counts, a parent with no rows counts 0;
 *   - manyToMany counts junction rows;
 *   - `_count: true` counts every to-many relation;
 *   - the counted table's global filter applies (for manyToMany, to the
 *     TARGET, not the junction), and `skipGlobalFilters` lifts it;
 *   - the refusals: a to-one in `_count` (E003), an unknown name (E005), a
 *     `_count` below the top level (E005), and an unknown relation even when
 *     the base query finds no rows (E005).
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { TurbineError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import { UNSAFE } from '../query/index.js';
import { defineSchema, type SchemaDef } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { skipGate } from './helpers.js';

let embedded = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embedded = typeof mod?.Database?.open === 'function';
} catch {
  embedded = false;
}
const { it } = skipGate(!embedded, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

// biome-ignore lint/suspicious/noExplicitAny: cases drive untyped table accessors
type Db = any;

const def: SchemaDef = defineSchema({
  users: { id: { type: 'serial', primaryKey: true }, tenantId: { type: 'integer', notNull: true } },
  posts: {
    id: { type: 'serial', primaryKey: true },
    userId: { type: 'integer', references: 'users.id' },
    tenantId: { type: 'integer', notNull: true },
  },
  tags: { id: { type: 'serial', primaryKey: true }, tenantId: { type: 'integer', notNull: true } },
  postTags: {
    postId: { type: 'integer', notNull: true, references: 'posts.id' },
    tagId: { type: 'integer', notNull: true, references: 'tags.id' },
    primaryKey: ['postId', 'tagId'],
  },
} as never);
const SCHEMA = schemaDefToMetadata(def);

async function seed(db: Db): Promise<void> {
  for (const tenantId of [1, 1, 2]) await db.table('users').create({ data: { tenantId } });
  for (const [userId, tenantId] of [
    [1, 1],
    [1, 2],
    [2, 1],
    [null, 1],
  ]) {
    await db.table('posts').create({ data: { userId, tenantId } });
  }
  for (const tenantId of [1, 1, 2]) await db.table('tags').create({ data: { tenantId } });
  for (const [postId, tagId] of [
    [1, 1],
    [1, 3],
    [2, 2],
    [3, 3],
  ]) {
    await db.table('post_tags').create({ data: { postId, tagId } });
  }
}

type Outcome = unknown;

interface Case {
  id: string;
  config?: Record<string, unknown>;
  run(db: Db): Promise<Outcome>;
  expect: Outcome;
}

/** `[id, _count]` per row, ids ascending. */
const counts =
  (table: string, args: Record<string, unknown>) =>
  async (db: Db): Promise<Outcome> => {
    const rows = await db.table(table).findMany({ select: { id: true }, orderBy: { id: 'asc' }, ...args });
    return rows.map((r: { id: number; _count: unknown }) => [Number(r.id), r._count]);
  };

const E003 = 'error:ValidationError:TURBINE_E003';
const E005 = 'error:RelationError:TURBINE_E005';

const CASES: Case[] = [
  {
    id: 'hasMany count, 0 for a parent with no rows',
    run: counts('users', { with: { _count: { posts: true } } }),
    expect: [
      [1, { posts: 2 }],
      [2, { posts: 1 }],
      [3, { posts: 0 }],
    ],
  },
  {
    id: 'manyToMany count',
    run: counts('posts', { with: { _count: { tags: true } } }),
    expect: [
      [1, { tags: 2 }],
      [2, { tags: 1 }],
      [3, { tags: 1 }],
      [4, { tags: 0 }],
    ],
  },
  {
    id: '_count: true counts every to-many relation',
    run: counts('posts', { where: { id: { in: [1, 4] } }, with: { _count: true } }),
    expect: [
      [1, { postTags: 2, tags: 2 }],
      [4, { postTags: 0, tags: 0 }],
    ],
  },
  {
    id: 'a hasMany count honours the counted table global filter',
    config: { globalFilters: { posts: { tenantId: 1 } } },
    run: counts('users', { with: { _count: { posts: true } } }),
    expect: [
      [1, { posts: 1 }],
      [2, { posts: 1 }],
      [3, { posts: 0 }],
    ],
  },
  {
    id: 'skipGlobalFilters lifts it',
    config: { globalFilters: { posts: { tenantId: 1 } } },
    run: counts('users', { with: { _count: { posts: true } }, skipGlobalFilters: [UNSAFE, 'posts'] }),
    expect: [
      [1, { posts: 2 }],
      [2, { posts: 1 }],
      [3, { posts: 0 }],
    ],
  },
  {
    id: 'a manyToMany count filters the target, not the junction',
    config: { globalFilters: { tags: { tenantId: 1 } } },
    run: counts('posts', { with: { _count: true } }),
    expect: [
      [1, { postTags: 2, tags: 1 }],
      [2, { postTags: 1, tags: 1 }],
      [3, { postTags: 1, tags: 0 }],
      [4, { postTags: 0, tags: 0 }],
    ],
  },
  {
    id: '_count is the last key, after the relations',
    run: async (db) => {
      const [row] = await db.table('users').findMany({
        select: { id: true },
        where: { id: 1 },
        with: { _count: { posts: true }, posts: { select: { id: true }, orderBy: { id: 'asc' } } },
      });
      return Object.keys(row);
    },
    expect: ['id', 'posts', '_count'],
  },
  { id: 'a to-one relation in _count', run: counts('posts', { with: { _count: { user: true } } }), expect: E003 },
  { id: 'an unknown name in _count', run: counts('users', { with: { _count: { nope: true } } }), expect: E005 },
  {
    id: '_count below the top level',
    run: counts('users', { with: { posts: { with: { _count: { tags: true } } } } }),
    expect: E005,
  },
  {
    id: 'an unknown relation with no rows is still refused',
    run: counts('users', { where: { id: 999 }, with: { nope: true } }),
    expect: E005,
  },
  {
    id: 'a bad _count with no rows is still refused',
    run: counts('users', { where: { id: 999 }, with: { _count: { nope: true } } }),
    expect: E005,
  },
];

async function outcome(open: () => Promise<Db>, c: Case): Promise<Outcome> {
  const db = await open();
  try {
    return await c.run(db);
  } catch (err) {
    if (err instanceof TurbineError) return `error:${err.constructor.name}:${err.code}`;
    throw err;
  } finally {
    await db.disconnect();
  }
}

const dirs: string[] = [];
let powdbDir = '';
const PG_URL = process.env.DATABASE_URL;
const PG_SCHEMA = 'turbine_powdb_parity_count';

function pgUrl(): string {
  const url = new URL(PG_URL!);
  url.searchParams.set('options', `-c search_path=${PG_SCHEMA}`);
  return url.toString();
}

describe('PowDB with._count agrees with Postgres', () => {
  before(async () => {
    if (!embedded) return;
    powdbDir = mkdtempSync(join(tmpdir(), 'turbine-powdb-count-'));
    dirs.push(powdbDir);
    const boot = await turbinePowDB({ embedded: powdbDir }, SCHEMA, { warnOnUnlimited: false });
    for (const stmt of powqlSchemaDDL(SCHEMA)) await boot.rawUnsafe(stmt);
    await seed(boot);
    await boot.disconnect();
    if (!PG_URL) return;
    const admin = new TurbineClient({ connectionString: PG_URL, warnOnUnlimited: false } as never, SCHEMA);
    await admin.rawUnsafe(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`);
    await admin.rawUnsafe(`CREATE SCHEMA "${PG_SCHEMA}"`);
    await admin.disconnect();
    const pg = new TurbineClient({ connectionString: pgUrl(), warnOnUnlimited: false } as never, SCHEMA);
    for (const stmt of schemaToSQL(def)) await pg.rawUnsafe(stmt);
    await seed(pg);
    await pg.disconnect();
  });
  after(async () => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    if (!embedded || !PG_URL) return;
    const admin = new TurbineClient({ connectionString: PG_URL, warnOnUnlimited: false } as never, SCHEMA);
    await admin.rawUnsafe(`DROP SCHEMA IF EXISTS "${PG_SCHEMA}" CASCADE`);
    await admin.disconnect();
  });

  for (const c of CASES) {
    it(c.id, async () => {
      const pow = await outcome(
        () => turbinePowDB({ embedded: powdbDir }, SCHEMA, { warnOnUnlimited: false, ...c.config }),
        c,
      );
      assert.deepEqual(pow, c.expect, `powdb: ${c.id}`);
      if (!PG_URL) return;
      const pg = await outcome(
        async () =>
          new TurbineClient({ connectionString: pgUrl(), warnOnUnlimited: false, ...c.config } as never, SCHEMA),
        c,
      );
      assert.deepEqual(pg, c.expect, `postgres: ${c.id}`);
    });
  }
});

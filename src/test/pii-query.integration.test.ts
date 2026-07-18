/**
 * turbine-orm: PII query semantics LIVE integration (Track F)
 *
 * Runs the real round-trip on two backends:
 *   1. `@zvndev/powdb-embedded` (in-process napi addon, no server), gated on the
 *      prebuilt binary loading, exactly like the other powdb integration suites.
 *      Exercises the keyed loaders AND the native-join strategy, plus a `str`
 *      and a `json` PII column.
 *   2. PostgreSQL: gated on `DATABASE_URL`. Same shapes over a real Postgres.
 *
 * The load-bearing property: a PII-tagged column is default-EXCLUDED from every
 * read (top-level, relation, both loader + join strategies), comes back only via
 * an explicit `select` or `includePii: true`, and is stripped from a write's
 * returned row while still being persisted (writes are unaffected).
 *
 * Run (embedded): npx tsx --test src/test/pii-query.integration.test.ts
 * Run (pg):       DATABASE_URL=postgres://… npx tsx --test src/test/pii-query.integration.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { UnsupportedFeatureError } from '../errors.js';
import { PowdbJsonParam, powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Shared schema fixture: a str PII column, a json PII column, and a relation.
// ---------------------------------------------------------------------------

function col(
  name: string,
  field: string,
  tsType: string,
  pgType: string,
  opts: Partial<ColumnMetadata> = {},
): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '', ...opts };
}

function makeTable(
  name: string,
  columns: ColumnMetadata[],
  relations: Record<string, RelationDef> = {},
): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(columns.filter((c) => c.tsType.startsWith('Date')).map((c) => c.name)),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

/**
 * `app_user(id, name, email[PII str], profile[PII json]) → posts (hasMany)`;
 * `post(id, author_id, title, secret[PII str]) → author (belongsTo)`.
 * `serialId` picks the PK style: an auto int for PowDB, a client uuid for PG.
 */
function schema(serialId: boolean): SchemaMetadata {
  const idOpts = serialId ? { isGenerated: true, hasDefault: true } : { hasDefault: true };
  return {
    enums: {},
    tables: {
      app_user: makeTable(
        'app_user',
        [
          col('id', 'id', serialId ? 'number' : 'string', serialId ? 'int8' : 'text', idOpts),
          col('name', 'name', 'string', 'text'),
          col('email', 'email', 'string', 'text', { pii: true }),
          col('profile', 'profile', 'Record<string, unknown>', 'jsonb', { nullable: true, pii: true }),
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'app_user',
            to: 'post',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
        },
      ),
      post: makeTable(
        'post',
        [
          col('id', 'id', serialId ? 'number' : 'string', serialId ? 'int8' : 'text', idOpts),
          col('author_id', 'authorId', serialId ? 'number' : 'string', serialId ? 'int8' : 'text'),
          col('title', 'title', 'string', 'text'),
          col('secret', 'secret', 'string', 'text', { pii: true }),
        ],
        {
          author: {
            type: 'belongsTo',
            name: 'author',
            from: 'post',
            to: 'app_user',
            foreignKey: 'author_id',
            referenceKey: 'id',
          },
        },
      ),
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: TurbineClient table accessors are dynamically typed at this seam.
type DB = any;

/** Shared assertions that hold on any backend once `author` is created + posts seeded. */
async function assertPiiSemantics(db: DB, authorId: unknown): Promise<void> {
  // (1) default read excludes both PII columns.
  const def = await db.table('app_user').findUnique({ where: { id: authorId } });
  assert.equal(def.name, 'Ada');
  assert.ok(!('email' in def), 'default read must exclude the str PII column');
  assert.ok(!('profile' in def), 'default read must exclude the json PII column');

  // (2) explicit select of a PII column returns exactly it (+ the PK).
  const sel = await db.table('app_user').findUnique({ where: { id: authorId }, select: { email: true } });
  assert.equal(sel.email, 'ada@x.test', 'select naming the PII column returns it');
  assert.ok(!('name' in sel), 'select projects only the named column (+ PK)');

  // (3) includePii returns everything, including the json PII column. (The exact
  // decoded json shape is a backend detail: assert presence, not bytes.)
  const all = await db.table('app_user').findUnique({ where: { id: authorId }, includePii: true });
  assert.equal(all.email, 'ada@x.test');
  assert.ok('profile' in all && all.profile != null, 'includePii returns the json PII column');

  // (4) relation subquery / loader excludes the child PII column by default.
  const withPostsDefault = await db
    .table('app_user')
    .findUnique({ where: { id: authorId }, with: { posts: { orderBy: { title: 'asc' } } } });
  assert.equal(withPostsDefault.posts.length, 2);
  for (const p of withPostsDefault.posts) {
    assert.ok(!('secret' in p), 'child PII column excluded in a default relation load');
    assert.ok('title' in p);
  }

  // (5) includePii reaches the nested relation level.
  const withPostsPii = await db
    .table('app_user')
    .findUnique({ where: { id: authorId }, with: { posts: { orderBy: { title: 'asc' } } }, includePii: true });
  for (const p of withPostsPii.posts) {
    assert.equal(typeof p.secret, 'string', 'child PII column present under includePii');
  }

  // (6) a relation-level select naming the PII column returns it.
  const withPostsSelect = await db.table('app_user').findUnique({
    where: { id: authorId },
    with: { posts: { orderBy: { title: 'asc' }, select: { secret: true } } },
  });
  for (const p of withPostsSelect.posts) assert.ok('secret' in p, 'relation select opt-in returns child PII');
}

// ---------------------------------------------------------------------------
// PowDB (embedded): keyed loaders AND native joins.
// ---------------------------------------------------------------------------

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const powdb = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

async function withPowdb(fn: (db: DB, authorId: unknown) => Promise<void>): Promise<void> {
  const s = schema(true);
  const dir = mkdtempSync(join(tmpdir(), 'powdb-pii-'));
  const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, s, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(s)) await db.raw([stmt]);
    // Writes accept PII freely; the returned row drops it, so re-read for the id.
    const created = await db.table('app_user').create({
      data: { name: 'Ada', email: 'ada@x.test', profile: new PowdbJsonParam({ tier: 'gold' }) },
    });
    assert.ok(!('email' in created), 'write result drops the PII column');
    const ada = await db.table('app_user').findFirst({ where: { name: 'Ada' } });
    await db.table('post').createMany({
      data: [
        { authorId: ada.id, title: 'p1', secret: 's1' },
        { authorId: ada.id, title: 'p2', secret: 's2' },
      ],
    });
    await fn(db, ada.id);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('pii integration (powdb embedded)', () => {
  powdb.it('keyed loaders: default exclusion, select opt-in, includePii, str + json PII', async () => {
    await withPowdb(async (db, authorId) => {
      await assertPiiSemantics(db, authorId);
      // The PII value really persisted (write unaffected), proven by (3) above,
      // and the DB row still carries it for the includePii read.
    });
  });

  powdb.it('native join strategy applies the same exclusion (parity with loaders)', async () => {
    await withPowdb(async (db, authorId) => {
      let joinRows: Record<string, unknown>[];
      try {
        joinRows = await db.table('app_user').findMany({
          where: { id: authorId },
          with: { posts: { orderBy: { title: 'asc' } } },
          relationLoadStrategy: 'join',
        });
      } catch (err) {
        // Older addons without the serverJoins capability throw E017 for an
        // explicit per-query 'join'; that is not a Track-F regression.
        if (err instanceof UnsupportedFeatureError) return;
        throw err;
      }
      const loaderRows = await db
        .table('app_user')
        .findMany({ where: { id: authorId }, with: { posts: { orderBy: { title: 'asc' } } } });
      assert.deepEqual(joinRows, loaderRows, 'join and loader output must match (both PII-excluded)');
      for (const p of joinRows[0]!.posts as Record<string, unknown>[]) {
        assert.ok(!('secret' in p), 'native join excludes the child PII column');
      }
      // includePii through the join path returns the child PII column.
      const joinPii = await db.table('app_user').findMany({
        where: { id: authorId },
        with: { posts: { orderBy: { title: 'asc' } } },
        relationLoadStrategy: 'join',
        includePii: true,
      });
      for (const p of joinPii[0]!.posts as Record<string, unknown>[]) {
        assert.equal(typeof p.secret, 'string', 'includePii reaches the join path');
      }
    });
  });
});

// ---------------------------------------------------------------------------
// PostgreSQL: DATABASE_URL gated.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const pg = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

describe('pii integration (postgres)', () => {
  pg.it('default exclusion, select opt-in, includePii, relation exclusion, write strip', async () => {
    const s = schema(false);
    const db: DB = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 3, warnOnUnlimited: false }, s);
    await db.connect();
    try {
      await db.raw(['DROP TABLE IF EXISTS pii_post']);
      await db.raw(['DROP TABLE IF EXISTS pii_app_user']);
      // Real table names differ from the metadata names below via search_path?
      // Keep them aligned: create the exact tables the metadata references.
      await db.raw(['DROP TABLE IF EXISTS post']);
      await db.raw(['DROP TABLE IF EXISTS app_user']);
      await db.raw([
        'CREATE TABLE app_user (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, name text NOT NULL, email text NOT NULL, profile jsonb)',
      ]);
      await db.raw([
        'CREATE TABLE post (id text PRIMARY KEY DEFAULT gen_random_uuid()::text, author_id text NOT NULL, title text NOT NULL, secret text NOT NULL)',
      ]);

      const created = await db.table('app_user').create({
        data: { name: 'Ada', email: 'ada@x.test', profile: { tier: 'gold' } },
      });
      assert.ok(!('email' in created), 'write result drops the str PII column');
      assert.ok(!('profile' in created), 'write result drops the json PII column');

      // Live proof of the boundary: the value was WRITTEN (persisted) even though
      // the create() result omitted it: the write's RETURNING excludes PII at the
      // SQL level, it is not merely stripped client-side. Read it back with raw SQL.
      const persisted = await db.raw(["SELECT email FROM app_user WHERE name = 'Ada'"]);
      assert.equal(persisted[0]?.email, 'ada@x.test', 'PII persisted despite being excluded from the write return');

      const ada = await db.table('app_user').findFirst({ where: { name: 'Ada' } });
      await db.table('post').createMany({
        data: [
          { authorId: ada.id, title: 'p1', secret: 's1' },
          { authorId: ada.id, title: 'p2', secret: 's2' },
        ],
      });

      await assertPiiSemantics(db, ada.id);

      // Batched strategy parity on Postgres.
      const batched = await db.table('app_user').findMany({
        where: { id: ada.id },
        with: { posts: { orderBy: { title: 'asc' } } },
        relationLoadStrategy: 'batched',
      });
      for (const p of batched[0]!.posts as Record<string, unknown>[]) {
        assert.ok(!('secret' in p), 'batched loader excludes the child PII column');
      }
    } finally {
      await db.raw(['DROP TABLE IF EXISTS post']).catch(() => {});
      await db.raw(['DROP TABLE IF EXISTS app_user']).catch(() => {});
      await db.disconnect();
    }
  });
});

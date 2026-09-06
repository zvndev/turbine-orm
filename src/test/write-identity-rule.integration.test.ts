/**
 * turbine-orm: the single-row write methods require a `where` that identifies ONE row.
 *
 * Three methods carry that contract, by two different mechanisms.
 *
 * The single-row write methods emit `UPDATE ... WHERE <predicate> RETURNING *`
 * and hand back `rows[0]`. With a non-unique predicate that touches every
 * matching row and reports one of them, which is the same hazard `findUnique`
 * refuses since 0.73 (arbitrary one of many) with a write attached. The rule is
 * the one `findUnique` uses, from query/compound-unique.ts: a primary key, a
 * single-column unique, or every column of a compound unique, pinned to a
 * non-null value at the top level of the caller's where. Extra predicates
 * beside the key are fine, they can only narrow a set of at most one row.
 * `updateMany` / `deleteMany` remain the many-row path and are untouched.
 *
 * `upsert`'s `where` is not a predicate at all: it becomes the CONFLICT TARGET,
 * so a non-unique one has no single row to update on conflict and the emitted
 * `ON CONFLICT (...)` names columns no unique constraint backs. Same rule, same
 * sources of uniqueness, its own sentence, and no escape hatch, because
 * `UpsertArgs` carries no `allowFullTableScan`.
 *
 * Nested writes scope every child write to its parent by merging the parent
 * correlation into the caller's selector; when the two overlap the merge is a
 * Turbine-branded `AND` wrapper (see `scopeWhereToParent`). The rule reads the
 * caller's identifying key THROUGH that wrapper, so a nested update by primary
 * key keeps working. It never reads through a caller-written `AND`.
 *
 * A to-one `disconnect: true` / `delete: true` gives the caller no selector at
 * all: the predicate is the relation's correlation key and nothing else,
 * written by the engine, and what makes it one row is the relation's declared
 * CARDINALITY rather than anything in the table metadata. Those are branded
 * with `markInternalRowSelector` and accepted; a caller-supplied non-unique
 * nested selector still is not.
 *
 * Integration half needs DATABASE_URL (creates and drops `qa78_wid_*` tables).
 * Build-only half (SQL engines + PowQL) runs without a database.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/write-identity-rule.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it as plainIt } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { isInternalRowSelector, markInternalRowSelector } from '../query/compound-unique.js';
import { UNSAFE } from '../query/index.js';
import { markInternalCombinator } from '../query/utils.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping write identity rule integration tests: DATABASE_URL not set');
}

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

/**
 * ONE schema read for the whole file, and one connection.
 *
 * `introspect()` reads pg_catalog over several statements, so a table another
 * test FILE drops between them raises "could not open relation with OID". Test
 * files run concurrently against one database, so every extra introspect call
 * is another window on that race: this file used to open four and flaked about
 * one run in eight. Every suite below shares this one read.
 */
const DDL = `
DROP TABLE IF EXISTS qa78_wid_posts CASCADE;
DROP TABLE IF EXISTS qa78_wid_users CASCADE;
DROP TABLE IF EXISTS qa78_wid_up_members CASCADE;
DROP TABLE IF EXISTS qa78_wid_up_users CASCADE;
DROP TABLE IF EXISTS qa78_wid_gf_users CASCADE;
DROP TABLE IF EXISTS qa78_wid_gf_orgs CASCADE;
DROP TABLE IF EXISTS qa78_wid_one_profiles CASCADE;
DROP TABLE IF EXISTS qa78_wid_one_users CASCADE;

CREATE TABLE qa78_wid_users (
  id    SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role  TEXT NOT NULL,
  name  TEXT NOT NULL
);
CREATE TABLE qa78_wid_posts (
  id      SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES qa78_wid_users(id) ON DELETE CASCADE,
  title   TEXT NOT NULL
);
INSERT INTO qa78_wid_users (email, role, name) VALUES
  ('g1@qa78.test', 'guest', 'g1'),
  ('g2@qa78.test', 'guest', 'g2'),
  ('a1@qa78.test', 'admin', 'a1');
INSERT INTO qa78_wid_posts (user_id, title) VALUES
  (1, 'p1-of-g1'), (2, 'p2-of-g2'), (2, 'p3-of-g2');

-- upsert: a single-column unique that is not the PK, and a composite PK.
CREATE TABLE qa78_wid_up_users (
  id    SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  role  TEXT NOT NULL,
  name  TEXT NOT NULL
);
CREATE TABLE qa78_wid_up_members (
  org_id  INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  note    TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
INSERT INTO qa78_wid_up_users (email, role, name) VALUES
  ('u1@qa78.test', 'member', 'u1'),
  ('u2@qa78.test', 'member', 'u2');
INSERT INTO qa78_wid_up_members (org_id, user_id, note) VALUES (1, 1, 'n1');

-- upsert under a global filter that is a RELATION filter.
CREATE TABLE qa78_wid_gf_orgs (id SERIAL PRIMARY KEY, active BOOLEAN NOT NULL);
CREATE TABLE qa78_wid_gf_users (
  id     SERIAL PRIMARY KEY,
  org_id INTEGER NOT NULL REFERENCES qa78_wid_gf_orgs(id),
  email  TEXT NOT NULL UNIQUE,
  name   TEXT NOT NULL
);
INSERT INTO qa78_wid_gf_orgs (active) VALUES (true);
INSERT INTO qa78_wid_gf_users (org_id, email, name) VALUES (1, 'gf1@qa78.test', 'gf1');

-- a to-one relation whose FK carries NO unique constraint.
CREATE TABLE qa78_wid_one_users (id SERIAL PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE qa78_wid_one_profiles (
  id      SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES qa78_wid_one_users(id),
  bio     TEXT
);
INSERT INTO qa78_wid_one_users (name) VALUES ('one1');
INSERT INTO qa78_wid_one_profiles (user_id, bio) VALUES (1, 'b1');
`;

const DROP_ALL = `
DROP TABLE IF EXISTS qa78_wid_posts CASCADE;
DROP TABLE IF EXISTS qa78_wid_users CASCADE;
DROP TABLE IF EXISTS qa78_wid_up_members CASCADE;
DROP TABLE IF EXISTS qa78_wid_up_users CASCADE;
DROP TABLE IF EXISTS qa78_wid_gf_users CASCADE;
DROP TABLE IF EXISTS qa78_wid_gf_orgs CASCADE;
DROP TABLE IF EXISTS qa78_wid_one_profiles CASCADE;
DROP TABLE IF EXISTS qa78_wid_one_users CASCADE;
`;

let raw: pg.Client;
let liveSchema: SchemaMetadata;

before(async () => {
  raw = new pg.Client({ connectionString: DATABASE_URL });
  await raw.connect();
  await raw.query(DDL);
  liveSchema = await introspectRetrying();
});

/**
 * `introspect()`, retried past the ONE transient failure a shared test database
 * produces.
 *
 * The catalog read is several statements, not one snapshot, so a table another
 * test FILE drops between them makes PostgreSQL raise "could not open relation
 * with OID <n>" on a row that was there when the scan started. It is a property
 * of running many files against one database and says nothing about the code
 * under test, so retrying is the honest handling; anything else fails a green
 * change for someone else's DROP. Bounded, and any OTHER error is rethrown
 * immediately, so a genuine introspection bug still fails the suite at once.
 */
async function introspectRetrying(attempts = 5): Promise<SchemaMetadata> {
  for (let i = 1; ; i++) {
    try {
      return await introspect({ connectionString: DATABASE_URL as string });
    } catch (err) {
      const transient = /could not open relation with OID|does not exist/.test(
        err instanceof Error ? err.message : String(err),
      );
      if (!transient || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}

after(async () => {
  await raw?.query(DROP_ALL);
  await raw?.end();
});

/** The declared name of the relation from `table` to `target` in the shared schema. */
function relationTo(table: string, target: string): string {
  const rels = liveSchema.tables[table]!.relations;
  return Object.entries(rels).find(([, r]: [string, RelationDef]) => r.to === target)![0];
}

/** A live client over the shared schema. */
function liveClient(globalFilters?: Record<string, Record<string, unknown>>): TurbineClient {
  return new TurbineClient(
    { connectionString: DATABASE_URL as string, warnOnUnlimited: false, ...(globalFilters ? { globalFilters } : {}) },
    liveSchema,
  );
}

/** The E003 refusal, checked for the property that matters: it names the many-row method. */
function refusedWith(op: 'update' | 'delete') {
  const many = op === 'update' ? 'updateMany' : 'deleteMany';
  return (err: unknown): true => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.match(err.message, new RegExp(`\\] ${op} on "`), 'the message names the refused operation');
    assert.match(err.message, /does not identify a single row/);
    assert.match(err.message, new RegExp(`\`${many}\``), `the message names ${many} as the many-row path`);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Integration: real PostgreSQL, the rows are the proof
// ---------------------------------------------------------------------------

describe('update / delete identity rule (live Postgres)', () => {
  let db: TurbineClient;
  let postsRel: string;

  const count = async (sql: string): Promise<number> => Number((await raw.query(sql)).rows[0].n);

  before(() => {
    db = liveClient();
    postsRel = relationTo('qa78_wid_users', 'qa78_wid_posts');
  });

  after(async () => {
    await db?.disconnect();
  });

  it('update({ where: { role } }) throws E003 naming updateMany and changes ZERO rows', async () => {
    await assert.rejects(
      db.table('qa78_wid_users').update({ where: { role: 'guest' }, data: { name: 'MASS' } }),
      refusedWith('update'),
    );
    assert.equal(await count(`SELECT count(*)::int AS n FROM qa78_wid_users WHERE name = 'MASS'`), 0);
  });

  it('delete({ where: { role } }) throws E003 naming deleteMany and removes ZERO rows', async () => {
    await assert.rejects(db.table('qa78_wid_users').delete({ where: { role: 'guest' } }), refusedWith('delete'));
    assert.equal(await count('SELECT count(*)::int AS n FROM qa78_wid_users'), 3);
  });

  it('update({ where: { id, role } }) still works: a narrowing predicate beside the key is fine', async () => {
    const row = await db.table('qa78_wid_users').update({ where: { id: 1, role: 'guest' }, data: { name: 'g1x' } });
    assert.equal(row.name, 'g1x');
    assert.equal(await count(`SELECT count(*)::int AS n FROM qa78_wid_users WHERE name = 'g1x'`), 1);
  });

  it('update by a single-column UNIQUE (not the PK) still works', async () => {
    const row = await db.table('qa78_wid_users').update({ where: { email: 'g2@qa78.test' }, data: { name: 'g2x' } });
    assert.equal(row.name, 'g2x');
  });

  it('a unique key pinned to NULL does not identify a row (any number of NULLs are unique)', async () => {
    await assert.rejects(
      db.table('qa78_wid_users').update({ where: { email: null }, data: { name: 'x' } }),
      refusedWith('update'),
    );
  });

  it('updateMany / deleteMany remain the many-row path', async () => {
    const updated = await db.table('qa78_wid_users').updateMany({ where: { role: 'guest' }, data: { name: 'many' } });
    assert.equal(updated.count, 2);
    assert.equal(await count(`SELECT count(*)::int AS n FROM qa78_wid_users WHERE name = 'many'`), 2);
    // Put the names back so later assertions read the seeded values.
    await raw.query(`UPDATE qa78_wid_users SET name = 'g1' WHERE id = 1`);
    await raw.query(`UPDATE qa78_wid_users SET name = 'g2' WHERE id = 2`);
  });

  it('nested update of a child by PRIMARY KEY keeps working (disjoint merge with the parent scope)', async () => {
    const row = await db.table('qa78_wid_users').update({
      where: { id: 2 },
      data: { [postsRel]: { update: { where: { id: 2 }, data: { title: 'p2-renamed' } } } },
    });
    const posts = row[postsRel] as { id: number; title: string }[];
    assert.ok(posts.some((p) => p.id === 2 && p.title === 'p2-renamed'));
  });

  it('nested update whose selector ALSO names the correlation column keeps working (internal AND wrapper)', async () => {
    // `{ id, userId }` overlaps the parent scope `{ userId }`, so the engine
    // wraps the two in its branded `AND`; the rule reads the PK through it.
    const row = await db.table('qa78_wid_users').update({
      where: { id: 2 },
      data: { [postsRel]: { update: { where: { id: 3, userId: 2 }, data: { title: 'p3-renamed' } } } },
    });
    const posts = row[postsRel] as { id: number; title: string }[];
    assert.ok(posts.some((p) => p.id === 3 && p.title === 'p3-renamed'));
  });

  it('nested delete of a child by PRIMARY KEY keeps working', async () => {
    await db.table('qa78_wid_users').update({
      where: { id: 2 },
      data: { [postsRel]: { delete: { id: 3 } } },
    });
    assert.equal(await count('SELECT count(*)::int AS n FROM qa78_wid_posts WHERE id = 3'), 0);
  });

  it('nested update of a child by a NON-unique selector is refused the same way (nothing written)', async () => {
    await assert.rejects(
      db.table('qa78_wid_users').update({
        where: { id: 2 },
        data: { [postsRel]: { update: { where: { title: 'p2-renamed' }, data: { title: 'MASS' } } } },
      }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
        assert.match(err.message, /does not identify a single row/);
        return true;
      },
    );
    assert.equal(await count(`SELECT count(*)::int AS n FROM qa78_wid_posts WHERE title = 'MASS'`), 0);
  });
});

// ---------------------------------------------------------------------------
// Build-only pins: SQL engines
// ---------------------------------------------------------------------------

function buildSchema(): SchemaMetadata {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email', field: 'email', pgType: 'text', unique: true },
    { name: 'role', field: 'role', pgType: 'text' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  const keyless = mockTable('keyless', [{ name: 'note', field: 'note', pgType: 'text' }], {}, []);
  keyless.uniqueColumns = [];
  return { enums: {}, tables: { users, posts, keyless } };
}

describe('update / delete identity rule (build-only, SQL engines)', () => {
  plainIt('buildUpdate refuses a non-unique where with E003 and names updateMany', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(() => q.buildUpdate({ where: { role: 'guest' }, data: { name: 'x' } }), refusedWith('update'));
  });

  plainIt('buildDelete refuses a non-unique where with E003 and names deleteMany', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(() => q.buildDelete({ where: { role: 'guest' } }), refusedWith('delete'));
  });

  plainIt('the refusal comes BEFORE any SQL is built, and lists the keys that would work', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildUpdate({ where: { role: 'guest' }, data: { name: 'x' } }),
      (err: Error) => {
        assert.match(err.message, /`id`/);
        assert.match(err.message, /`email`/);
        return true;
      },
    );
  });

  plainIt('a table with no unique key at all gets its own sentence', () => {
    const q = makeQuery('keyless', buildSchema());
    assert.throws(
      () => q.buildUpdate({ where: { note: 'x' }, data: { note: 'y' } }),
      (err: Error) => {
        assert.match(err.message, /declares no primary key and no unique constraint/);
        assert.match(err.message, /`updateMany`/);
        return true;
      },
    );
  });

  plainIt('PK, unique column, PK + narrowing predicate, and `{ equals }` all pass', () => {
    const q = makeQuery('users', buildSchema());
    assert.match(q.buildUpdate({ where: { id: 1 }, data: { name: 'x' } }).sql, /WHERE "id" = \$2/);
    assert.match(q.buildUpdate({ where: { email: 'a@b' }, data: { name: 'x' } }).sql, /WHERE "email" = \$2/);
    assert.match(
      q.buildUpdate({ where: { id: 1, role: 'guest' }, data: { name: 'x' } }).sql,
      /"id" = \$2 AND "role" = \$3/,
    );
    assert.match(q.buildDelete({ where: { id: { equals: 1 } } }).sql, /WHERE "id" = \$1/);
  });

  plainIt('the empty-where guard still fires first for `{}` (its own message, unchanged)', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(() => q.buildUpdate({ where: {}, data: { name: 'x' } }), /the `where` clause is empty/);
  });

  plainIt('reads the PK THROUGH the engine-branded parent-scope AND wrapper', () => {
    const q = makeQuery('posts', buildSchema());
    const scoped = markInternalCombinator({ AND: [{ id: 3, userId: 2 }, { userId: 2 }] });
    const { sql } = q.buildUpdate({ where: scoped as never, data: { title: 'x' } });
    assert.match(sql, /UPDATE "posts" SET "title" = \$1 WHERE/);
  });

  plainIt('never reads through a CALLER-written AND (a key inside a combinator is not an identity)', () => {
    const q = makeQuery('posts', buildSchema());
    assert.throws(
      () => q.buildUpdate({ where: { AND: [{ id: 3 }, { userId: 2 }] } as never, data: { title: 'x' } }),
      refusedWith('update'),
    );
  });

  plainIt('updateMany / deleteMany compile a non-unique where unchanged', () => {
    const q = makeQuery('users', buildSchema());
    assert.match(q.buildUpdateMany({ where: { role: 'guest' }, data: { name: 'x' } }).sql, /WHERE "role" = \$2/);
    assert.match(q.buildDeleteMany({ where: { role: 'guest' } }).sql, /WHERE "role" = \$1/);
  });
});

// ---------------------------------------------------------------------------
// Build-only pins: PowQL (a parallel implementation, so the rule is asserted there too)
// ---------------------------------------------------------------------------

function powqlMock() {
  const calls: { powql: string; params: unknown[] }[] = [];
  const pool = {
    capabilities: capabilitiesFromVersion('0.18.0'),
    retryStaleReads: false,
    readonly: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      return Promise.resolve({ rows: [{ id: 1, email: 'a', role: 'guest', name: 'x' }], rowCount: 1 });
    },
  } as unknown as PowdbPool;
  const schema = buildSchema();
  for (const t of Object.values(schema.tables)) {
    for (const c of t.columns) c.tsType = c.name === 'id' || c.name === 'user_id' ? 'number' : 'string';
  }
  return { calls, qi: () => new PowqlInterface(pool, 'users', schema, [], { warnOnUnlimited: false }) };
}

describe('update / delete identity rule (PowQL)', () => {
  plainIt('update({ where: { role } }) is refused with the same E003 and sends NOTHING to the engine', async () => {
    const m = powqlMock();
    await assert.rejects(m.qi().update({ where: { role: 'guest' }, data: { name: 'x' } }), refusedWith('update'));
    assert.equal(m.calls.length, 0, 'no statement reached the engine');
  });

  plainIt('delete({ where: { role } }) is refused with the same E003 and sends NOTHING to the engine', async () => {
    const m = powqlMock();
    await assert.rejects(m.qi().delete({ where: { role: 'guest' } }), refusedWith('delete'));
    assert.equal(m.calls.length, 0, 'no statement reached the engine');
  });

  plainIt('update / delete by PK still compile and run', async () => {
    const m = powqlMock();
    await m.qi().update({ where: { id: 1 }, data: { name: 'x' } });
    assert.match(m.calls[0]!.powql, /^users filter \.id = \$1 update \{/);
    await m.qi().delete({ where: { id: 1 } });
    assert.match(m.calls[1]!.powql, /^users filter \.id = \$1 delete returning$/);
  });

  plainIt('updateMany / deleteMany stay the many-row path on PowQL too', async () => {
    const m = powqlMock();
    await m.qi().updateMany({ where: { role: 'guest' }, data: { name: 'x' } });
    assert.match(m.calls[0]!.powql, /^users filter \.role = \$1 update \{/);
    await m.qi().deleteMany({ where: { role: 'guest' } });
    assert.match(m.calls[1]!.powql, /^users filter \.role = \$1 delete$/);
  });
});

// ---------------------------------------------------------------------------
// upsert: the same rule, a different consequence
//
// `upsert`'s `where` is not a predicate, it is the CONFLICT TARGET, so a
// non-unique one has no single row to update on conflict. It reached the
// server as `ON CONFLICT ("role")` and came back as a bare SQLSTATE 42P10 on
// PostgreSQL; on MySQL `ON DUPLICATE KEY UPDATE` ignores the target entirely
// and on SQL Server `MERGE ... ON` matches every row it matches.
// ---------------------------------------------------------------------------

/** The upsert refusal, checked for what makes it an UPSERT refusal rather than the update/delete one. */
function refusedUpsert(err: unknown): true {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal(err.code, 'TURBINE_E003');
  assert.match(err.message, /\] upsert on "/, 'the message names the refused operation');
  assert.match(err.message, /does not identify a single row/);
  assert.match(err.message, /conflict target/, 'the message states the consequence specific to upsert');
  // `allowFullTableScan` is not an option on UpsertArgs, so the message must
  // not offer it: naming a way out that does not exist is worse than naming none.
  assert.doesNotMatch(err.message, /allowFullTableScan/);
  return true;
}

describe('upsert identity rule (live Postgres)', () => {
  let db: TurbineClient;

  const scalar = async (sql: string): Promise<unknown> => (await raw.query(sql)).rows[0]?.v;

  before(() => {
    db = liveClient();
  });

  after(async () => {
    await db?.disconnect();
  });

  it('a non-unique where is refused with E003, and NOTHING is written', async () => {
    await assert.rejects(
      db.table('qa78_wid_up_users').upsert({
        where: { role: 'member' },
        create: { email: 'new@qa78.test', role: 'member', name: 'new' },
        update: { name: 'UPSERTED' },
      }),
      refusedUpsert,
    );
    assert.equal(await scalar(`SELECT count(*)::int AS v FROM qa78_wid_up_users WHERE name = 'UPSERTED'`), 0);
    assert.equal(await scalar(`SELECT count(*)::int AS v FROM qa78_wid_up_users`), 2);
  });

  it('an empty / all-undefined where is refused too (upsert runs no other where guard)', async () => {
    for (const where of [{}, { email: undefined }]) {
      await assert.rejects(
        db.table('qa78_wid_up_users').upsert({
          where: where as Record<string, unknown>,
          create: { email: 'x@qa78.test', role: 'member', name: 'x' },
          update: { name: 'x' },
        }),
        refusedUpsert,
      );
    }
    assert.equal(await scalar(`SELECT count(*)::int AS v FROM qa78_wid_up_users`), 2);
  });

  it('a single-column UNIQUE that is not the PK still upserts, both branches', async () => {
    const updated = await db.table('qa78_wid_up_users').upsert({
      where: { email: 'u1@qa78.test' },
      create: { email: 'u1@qa78.test', role: 'member', name: 'ignored' },
      update: { name: 'u1-updated' },
    });
    assert.equal((updated as { name: string }).name, 'u1-updated');
    const inserted = await db.table('qa78_wid_up_users').upsert({
      where: { email: 'u3@qa78.test' },
      create: { email: 'u3@qa78.test', role: 'guest', name: 'u3-created' },
      update: { name: 'ignored' },
    });
    assert.equal((inserted as { name: string }).name, 'u3-created');
    assert.equal(await scalar(`SELECT count(*)::int AS v FROM qa78_wid_up_users`), 3);
  });

  it('a COMPOSITE key upserts spelled flat', async () => {
    const row = await db.table('qa78_wid_up_members').upsert({
      where: { orgId: 1, userId: 1 },
      create: { orgId: 1, userId: 1, note: 'ignored' },
      update: { note: 'flat-updated' },
    });
    assert.equal((row as { note: string }).note, 'flat-updated');
  });

  it('a COMPOSITE key upserts through its joined selector', async () => {
    const row = await db.table('qa78_wid_up_members').upsert({
      where: { orgId_userId: { orgId: 1, userId: 1 } } as Record<string, unknown>,
      create: { orgId: 1, userId: 1, note: 'ignored' },
      update: { note: 'selector-updated' },
    });
    assert.equal((row as { note: string }).note, 'selector-updated');
    assert.equal(
      await scalar(`SELECT note AS v FROM qa78_wid_up_members WHERE org_id = 1 AND user_id = 1`),
      'selector-updated',
    );
  });

  it('HALF a composite key is refused: one column of a two-column PK identifies nothing', async () => {
    await assert.rejects(
      db.table('qa78_wid_up_members').upsert({
        where: { orgId: 1 },
        create: { orgId: 1, userId: 9, note: 'n' },
        update: { note: 'n' },
      }),
      refusedUpsert,
    );
  });
});

// ---------------------------------------------------------------------------
// The escape hatch, and the fact that the message names it
// ---------------------------------------------------------------------------

describe('allowFullTableScan: UNSAFE opens the rule for update / delete', () => {
  plainIt('the update / delete message names the hatch; the upsert message does not', () => {
    const q = makeQuery('users', buildSchema());
    for (const build of [
      () => q.buildUpdate({ where: { role: 'guest' }, data: { name: 'x' } }),
      () => q.buildDelete({ where: { role: 'guest' } }),
    ]) {
      assert.throws(build, (err: Error) => {
        assert.match(err.message, /`allowFullTableScan: UNSAFE`/);
        // Named with its cost, not as a casual opt-out.
        assert.match(err.message, /empty-`where` guard/);
        return true;
      });
    }
    assert.throws(
      () => q.buildUpsert({ where: { role: 'guest' }, create: { email: 'a@b' }, update: { name: 'x' } }),
      refusedUpsert,
    );
  });

  plainIt('the hatch actually opens it: a non-unique where compiles under UNSAFE', () => {
    const q = makeQuery('users', buildSchema());
    assert.match(
      q.buildUpdate({ where: { role: 'guest' }, data: { name: 'x' }, allowFullTableScan: UNSAFE }).sql,
      /UPDATE "users" SET "name" = \$1 WHERE "role" = \$2/,
    );
    assert.match(
      q.buildDelete({ where: { role: 'guest' }, allowFullTableScan: UNSAFE }).sql,
      /DELETE FROM "users" WHERE "role" = \$1/,
    );
  });

  plainIt('a literal `true` is still refused: the option takes the symbol only', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildUpdate({ where: { role: 'guest' }, data: { name: 'x' }, allowFullTableScan: true as never }),
      (err: Error) => {
        assert.match(err.message, /UNSAFE/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Build-only pins: upsert on the SQL engines
// ---------------------------------------------------------------------------

describe('upsert identity rule (build-only, SQL engines)', () => {
  plainIt('a non-unique where is refused before any SQL is built, and lists the keys that work', () => {
    const q = makeQuery('users', buildSchema());
    assert.throws(
      () => q.buildUpsert({ where: { role: 'guest' }, create: { email: 'a@b' }, update: { name: 'x' } }),
      (err: Error) => {
        refusedUpsert(err);
        assert.match(err.message, /`id`/);
        assert.match(err.message, /`email`/);
        return true;
      },
    );
  });

  plainIt('a table with no unique key at all gets its own sentence, and no advice it cannot take', () => {
    const q = makeQuery('keyless', buildSchema());
    assert.throws(
      () => q.buildUpsert({ where: { note: 'x' }, create: { note: 'x' }, update: { note: 'y' } }),
      (err: Error) => {
        assert.match(err.message, /declares no primary key and no unique constraint/);
        assert.match(err.message, /`create`/);
        assert.match(err.message, /`updateMany`/);
        return true;
      },
    );
  });

  plainIt('the emitted SQL for a VALID upsert is byte-for-byte what it was', () => {
    const q = makeQuery('users', buildSchema());
    assert.equal(
      q.buildUpsert({ where: { email: 'a@b' }, create: { email: 'a@b', role: 'r', name: 'n' }, update: { name: 'z' } })
        .sql,
      'INSERT INTO "users" ("email", "role", "name") VALUES ($1, $2, $3) ' +
        'ON CONFLICT ("email") DO UPDATE SET "name" = $4 RETURNING *',
    );
  });

  plainIt('a plain-column global filter on the conflict-UPDATE is byte-for-byte what it was', () => {
    const q = makeQuery('users', buildSchema(), { globalFilters: { users: { role: 'admin' } } });
    assert.equal(
      q.buildUpsert({ where: { email: 'a@b' }, create: { email: 'a@b', role: 'r', name: 'n' }, update: { name: 'z' } })
        .sql,
      'INSERT INTO "users" ("email", "role", "name") VALUES ($1, $2, $3) ' +
        'ON CONFLICT ("email") DO UPDATE SET "name" = $4 WHERE "users"."role" = $5 RETURNING *',
    );
  });
});

// ---------------------------------------------------------------------------
// The conflict-UPDATE predicate references the target table ONCE-quoted.
//
// A global filter that is a RELATION FILTER compiles to an EXISTS body that
// correlates back to the row being upserted. The reference in that body is the
// same reference `update` emits; when it was built by quoting an
// already-quoted alias it became `"""users"""` and the statement failed with
// 42P01 at execution, on a shape no plain-column filter test can see.
// ---------------------------------------------------------------------------

function relationFilterSchema(): SchemaMetadata {
  const orgs = mockTable('orgs', [
    { name: 'id', field: 'id' },
    { name: 'active', field: 'active', pgType: 'bool' },
  ]);
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'org_id', field: 'orgId' },
      { name: 'email', field: 'email', pgType: 'text', unique: true },
      { name: 'name', field: 'name', pgType: 'text' },
    ],
    {
      org: {
        type: 'belongsTo',
        name: 'org',
        from: 'users',
        to: 'orgs',
        foreignKey: 'org_id',
        referenceKey: 'id',
      } as RelationDef,
    },
  );
  return { enums: {}, tables: { users, orgs } };
}

describe('global filter on the conflict-UPDATE references the target table once-quoted', () => {
  const options = { globalFilters: { users: { org: { is: { active: true } } } } };

  plainIt('a relation-filter global filter correlates to `"users"`, never to a re-quoted alias', () => {
    const q = makeQuery('users', relationFilterSchema(), options);
    const { sql } = q.buildUpsert({
      where: { email: 'a@b' },
      create: { email: 'a@b', orgId: 1, name: 'n' },
      update: { name: 'z' },
    });
    assert.match(sql, /"orgs"\."id" = "users"\."org_id"/);
    assert.doesNotMatch(sql, /"{2,}users"{2,}/, 'the target reference must not be re-quoted');
  });

  plainIt('upsert and update emit the SAME correlation reference for the same filter', () => {
    const q = makeQuery('users', relationFilterSchema(), options);
    const corr = /"orgs"\."id" = ([^\s]+)\."org_id"/;
    const up = corr.exec(
      q.buildUpsert({ where: { email: 'a@b' }, create: { email: 'a@b', orgId: 1, name: 'n' }, update: { name: 'z' } })
        .sql,
    );
    const upd = corr.exec(q.buildUpdate({ where: { email: 'a@b' }, data: { name: 'z' } }).sql);
    assert.ok(up && upd, 'both statements carry the correlation');
    assert.equal(up[1], upd[1]);
    assert.equal(up[1], '"users"');
  });
});

describe('global filter on the conflict-UPDATE (live Postgres)', () => {
  let db: TurbineClient;

  before(() => {
    const orgRel = relationTo('qa78_wid_gf_users', 'qa78_wid_gf_orgs');
    db = liveClient({ qa78_wid_gf_users: { [orgRel]: { is: { active: true } } } });
  });

  after(async () => {
    await db?.disconnect();
  });

  it('a relation-filter global filter EXECUTES on the conflict path', async () => {
    const row = await db.table('qa78_wid_gf_users').upsert({
      where: { email: 'gf1@qa78.test' },
      create: { orgId: 1, email: 'gf1@qa78.test', name: 'ignored' },
      update: { name: 'gf1-updated' },
    });
    assert.equal((row as { name: string }).name, 'gf1-updated');
  });

  it('and on the insert path', async () => {
    const row = await db.table('qa78_wid_gf_users').upsert({
      where: { email: 'gf2@qa78.test' },
      create: { orgId: 1, email: 'gf2@qa78.test', name: 'gf2-created' },
      update: { name: 'ignored' },
    });
    assert.equal((row as { name: string }).name, 'gf2-created');
  });
});

// ---------------------------------------------------------------------------
// Nested to-one writes: the engine wrote the predicate, so the caller has no
// `where` to fix. `disconnect: true` / `delete: true` on a declared to-one is
// addressed by the relation's own correlation key, and a `hasOne` FK is
// frequently not ALSO declared unique (every `defineSchema` client, every
// PowDB schema, any FK backed only by a partial unique index).
// ---------------------------------------------------------------------------

describe('nested to-one writes on a relation whose FK is not declared unique (live Postgres)', () => {
  let db: TurbineClient;
  let profileRel: string;

  const count = async (sql: string): Promise<number> => Number((await raw.query(sql)).rows[0].n);

  before(() => {
    profileRel = relationTo('qa78_wid_one_users', 'qa78_wid_one_profiles');
    // A `defineSchema` client declares `hasOne` without declaring the FK unique,
    // which is what an introspected schema cannot produce here (there is no
    // unique index on user_id), so the declaration is applied by hand. Copied
    // rather than mutated in place: `liveSchema` is shared with every other
    // suite in this file.
    const users = liveSchema.tables.qa78_wid_one_users!;
    const schema: SchemaMetadata = {
      ...liveSchema,
      tables: {
        ...liveSchema.tables,
        qa78_wid_one_users: {
          ...users,
          relations: { ...users.relations, [profileRel]: { ...users.relations[profileRel]!, type: 'hasOne' } },
        },
      },
    };
    db = new TurbineClient({ connectionString: DATABASE_URL as string, warnOnUnlimited: false }, schema);
  });

  after(async () => {
    await db?.disconnect();
  });

  it('`disconnect: true` nulls the FK instead of demanding a unique key the caller never wrote', async () => {
    await db.table('qa78_wid_one_users').update({ where: { id: 1 }, data: { [profileRel]: { disconnect: true } } });
    assert.equal(await count('SELECT count(*)::int AS n FROM qa78_wid_one_profiles WHERE user_id IS NULL'), 1);
    await raw.query('UPDATE qa78_wid_one_profiles SET user_id = 1 WHERE id = 1');
  });

  it('`delete: true` removes the related row', async () => {
    await db.table('qa78_wid_one_users').update({ where: { id: 1 }, data: { [profileRel]: { delete: true } } });
    assert.equal(await count('SELECT count(*)::int AS n FROM qa78_wid_one_profiles'), 0);
  });

  it('a CALLER-supplied non-unique nested selector is still refused (the brand is not a blanket exemption)', async () => {
    await raw.query(`INSERT INTO qa78_wid_one_profiles (user_id, bio) VALUES (1, 'b2')`);
    await assert.rejects(
      db.table('qa78_wid_one_users').update({
        where: { id: 1 },
        data: { [profileRel]: { update: { where: { bio: 'b2' }, data: { bio: 'MASS' } } } },
      }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /does not identify a single row/);
        return true;
      },
    );
    assert.equal(await count(`SELECT count(*)::int AS n FROM qa78_wid_one_profiles WHERE bio = 'MASS'`), 0);
  });
});

// ---------------------------------------------------------------------------
// Build-only pins: the brand itself
// ---------------------------------------------------------------------------

describe('the engine-written row selector brand', () => {
  plainIt('an unbranded correlation-only predicate is still refused', () => {
    const q = makeQuery('posts', buildSchema());
    assert.throws(() => q.buildUpdate({ where: { userId: 2 }, data: { title: 'x' } }), refusedWith('update'));
  });

  plainIt('the SAME predicate branded compiles, and the brand changes no SQL', () => {
    const q = makeQuery('posts', buildSchema());
    const branded = markInternalRowSelector({ userId: 2 });
    assert.equal(
      q.buildUpdate({ where: branded as never, data: { title: 'x' } }).sql,
      q.buildUpdate({ where: { userId: 2 }, data: { title: 'x' }, allowFullTableScan: UNSAFE }).sql,
    );
    assert.match(
      q.buildDelete({ where: markInternalRowSelector({ userId: 2 }) as never }).sql,
      /DELETE FROM "posts" WHERE "user_id" = \$1/,
    );
  });

  plainIt('the brand is a Symbol, so no where walker enumerates it', () => {
    const branded = markInternalRowSelector({ userId: 2 });
    assert.deepEqual(Object.keys(branded), ['userId']);
    assert.deepEqual(JSON.parse(JSON.stringify(branded)), { userId: 2 });
  });

  plainIt('a request body cannot forge it: JSON.parse produces no symbol-keyed property', () => {
    const fromBody = JSON.parse('{"userId":2,"turbine.internalRowSelector":true}') as Record<string, unknown>;
    assert.equal(isInternalRowSelector(fromBody), false);
    const q = makeQuery('posts', buildSchema());
    // Refused either way (unknown key first, then the identity rule): what
    // matters is that the forged key does not compile a mass update.
    assert.throws(
      () => q.buildUpdate({ where: fromBody as never, data: { title: 'x' } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.code, 'TURBINE_E003');
        return true;
      },
    );
    delete fromBody['turbine.internalRowSelector'];
    assert.equal(isInternalRowSelector(fromBody), false);
    assert.throws(() => q.buildUpdate({ where: fromBody as never, data: { title: 'x' } }), refusedWith('update'));
  });
});

// ---------------------------------------------------------------------------
// PowQL: the parallel implementation gets the same rule, upsert included
// ---------------------------------------------------------------------------

describe('upsert identity rule (PowQL)', () => {
  plainIt('a non-unique where is refused with the same E003 and sends NOTHING to the engine', async () => {
    const m = powqlMock();
    await assert.rejects(
      m.qi().upsert({
        where: { role: 'guest' },
        create: { id: 1, email: 'a', role: 'g', name: 'n' },
        update: { name: 'x' },
      }),
      refusedUpsert,
    );
    assert.equal(m.calls.length, 0, 'no statement reached the engine');
  });

  plainIt('an empty where is refused too', async () => {
    const m = powqlMock();
    await assert.rejects(
      m.qi().upsert({ where: {}, create: { id: 1, email: 'a', role: 'g', name: 'n' }, update: { name: 'x' } }),
      refusedUpsert,
    );
    assert.equal(m.calls.length, 0);
  });

  plainIt('upsert by the PK still compiles and runs', async () => {
    const m = powqlMock();
    await m
      .qi()
      .upsert({ where: { id: 1 }, create: { id: 1, email: 'a', role: 'g', name: 'n' }, update: { name: 'x' } });
    assert.match(m.calls[0]!.powql, /^upsert users on \.id \{/);
  });

  plainIt('a single-column unique that is not the PK is accepted', async () => {
    const m = powqlMock();
    await m
      .qi()
      .upsert({ where: { email: 'a' }, create: { id: 1, email: 'a', role: 'g', name: 'n' }, update: { name: 'x' } });
    assert.ok(m.calls.length > 0, 'the statement reached the engine');
  });
});

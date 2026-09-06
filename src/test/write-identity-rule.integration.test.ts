/**
 * turbine-orm: `update()` and `delete()` require a `where` that identifies ONE row.
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
 * Nested writes scope every child write to its parent by merging the parent
 * correlation into the caller's selector; when the two overlap the merge is a
 * Turbine-branded `AND` wrapper (see `scopeWhereToParent`). The rule reads the
 * caller's identifying key THROUGH that wrapper, so a nested update by primary
 * key keeps working. It never reads through a caller-written `AND`.
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
import { markInternalCombinator } from '../query/utils.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping write identity rule integration tests: DATABASE_URL not set');
}

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const DDL = `
DROP TABLE IF EXISTS qa78_wid_posts CASCADE;
DROP TABLE IF EXISTS qa78_wid_users CASCADE;
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
`;

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
  let raw: pg.Client;
  let db: TurbineClient;
  let schema: SchemaMetadata;
  let postsRel: string;

  const count = async (sql: string): Promise<number> => Number((await raw.query(sql)).rows[0].n);

  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(DDL);
    schema = await introspect({ connectionString: DATABASE_URL as string });
    db = new TurbineClient({ connectionString: DATABASE_URL as string, warnOnUnlimited: false }, schema);
    const rels = schema.tables.qa78_wid_users!.relations;
    postsRel = Object.entries(rels).find(([, r]: [string, RelationDef]) => r.to === 'qa78_wid_posts')![0];
  });

  after(async () => {
    await db?.disconnect();
    await raw?.query('DROP TABLE IF EXISTS qa78_wid_posts CASCADE; DROP TABLE IF EXISTS qa78_wid_users CASCADE;');
    await raw?.end();
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

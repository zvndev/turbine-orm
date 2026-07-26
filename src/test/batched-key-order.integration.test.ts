/**
 * turbine-orm, live key-order parity between the relation-loading strategies.
 *
 * The batched/auto paths stitch relations client-side from concurrent follow-up
 * queries, so their OUTPUT KEY ORDER is not covered by a `deepEqual` parity test
 * (deepEqual ignores key order) nor by a mock-pool test (a fake pool resolves in
 * issue order). This suite compares `JSON.stringify` of the full result, which
 * is what a caller actually ships in an HTTP body, an ETag or a cache key.
 *
 * It creates and drops its own tables, so it needs no seeded fixture, only a
 * reachable Postgres:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/batched-key-order.integration.test.ts
 *
 * The child tables deliberately have NO index on their foreign key, which is
 * what makes `relationLoadStrategy: 'auto'` demote the relations to the batched
 * loader (that demotion is how this ordering bug reached ordinary queries).
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const SKIP = !DATABASE_URL;
if (SKIP) {
  console.log('⚠ Skipping batched key-order integration tests: DATABASE_URL not set');
}

/** DDL/teardown run on a plain pg pool: the ORM has no raw-DDL surface. */
async function runSql(statements: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

/** Child tables, named so declaration order and alphabetical order differ. */
const CHILDREN = ['ko_zeta', 'ko_alpha', 'ko_mid', 'ko_beta'];

const DDL = [
  'DROP TABLE IF EXISTS ko_zeta, ko_alpha, ko_mid, ko_beta, ko_owner CASCADE',
  'CREATE TABLE ko_owner (id serial PRIMARY KEY, name text NOT NULL, note text)',
  ...CHILDREN.map(
    (t) => `CREATE TABLE ${t} (id serial PRIMARY KEY, ko_owner_id int NOT NULL REFERENCES ko_owner(id), label text)`,
  ),
  "INSERT INTO ko_owner (name, note) SELECT 'owner ' || g, 'n' || g FROM generate_series(1, 20) g",
  ...CHILDREN.map(
    (t) => `INSERT INTO ${t} (ko_owner_id, label) SELECT o.id, '${t}-' || s FROM ko_owner o, generate_series(1, 3) s`,
  ),
];

let db: TurbineClient;
let schema: SchemaMetadata;

const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

describe('relation strategies produce byte-identical key order (live)', () => {
  before(async () => {
    await runSql(DDL);
    schema = await introspect({ connectionString: DATABASE_URL! });
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 8, warnOnUnlimited: false }, schema);
    await db.connect();
  });

  after(async () => {
    if (db) await db.disconnect();
    await runSql(['DROP TABLE IF EXISTS ko_zeta, ko_alpha, ko_mid, ko_beta, ko_owner CASCADE']);
  });

  /** The relation names introspection derived for ko_owner's four children. */
  function relationNames(): string[] {
    const rels = schema.tables.ko_owner!.relations;
    return Object.values(rels)
      .filter((r) => r.type === 'hasMany')
      .map((r) => r.name);
  }

  async function run(strategy: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}) {
    return JSON.stringify(
      await db.table('ko_owner').findMany({ ...args, ...extra, relationLoadStrategy: strategy } as never),
    );
  }

  it('four to-many `_count`s: join, batched and auto all serialize identically', async () => {
    const spec: Record<string, boolean> = {};
    for (const name of relationNames()) spec[name] = true;
    const args = { orderBy: { id: 'asc' }, limit: 20, with: { _count: spec } };

    const join = await run('join', args);
    const batched = new Set<string>();
    const auto = new Set<string>();
    for (let i = 0; i < 8; i++) {
      batched.add(await run('batched', args));
      auto.add(await run('auto', args));
    }
    assert.equal(batched.size, 1, `batched produced ${batched.size} distinct serializations across 8 runs`);
    assert.equal(auto.size, 1, `auto produced ${auto.size} distinct serializations across 8 runs`);
    assert.equal([...batched][0], join, 'batched must serialize exactly like join');
    assert.equal([...auto][0], join, 'auto must serialize exactly like join');
    // Non-trivial: the counts are real.
    assert.match(join, /"_count":\{/);
  });

  it('a small page (limit 5) is stable too, 12 runs of each strategy', async () => {
    const spec: Record<string, boolean> = {};
    for (const name of relationNames()) spec[name] = true;
    const args = { orderBy: { id: 'asc' }, limit: 5, with: { _count: spec } };
    const join = await run('join', args);
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      seen.add(await run('auto', args));
      seen.add(await run('batched', args));
    }
    assert.deepEqual([...seen], [join]);
  });

  it('relation rows plus `_count` keep the join plan key order', async () => {
    const names = relationNames();
    const withClause: Record<string, unknown> = { _count: { [names[0]!]: true } };
    // Request the relations in a deliberately non-alphabetical order.
    for (const name of [...names].reverse()) withClause[name] = { orderBy: { id: 'asc' } };
    const args = { orderBy: { id: 'asc' }, limit: 10, with: withClause };

    const join = await run('join', args);
    for (let i = 0; i < 6; i++) {
      assert.equal(await run('batched', args), join, 'batched must serialize exactly like join');
      assert.equal(await run('auto', args), join, 'auto must serialize exactly like join');
    }
    const first = JSON.parse(join)[0] as Record<string, unknown>;
    // `_count` is last on the join plan, so it must be last everywhere.
    assert.equal(Object.keys(first).at(-1), '_count');
  });

  it('stableRelationOrder: true does not change the answer', async () => {
    const names = relationNames();
    const withClause: Record<string, unknown> = { _count: true };
    for (const name of [...names].reverse()) withClause[name] = true;
    const args = { orderBy: { id: 'asc' }, limit: 10, with: withClause };

    const join = await run('join', args, { stableRelationOrder: true });
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      seen.add(await run('batched', args, { stableRelationOrder: true }));
      seen.add(await run('auto', args, { stableRelationOrder: true }));
    }
    assert.deepEqual([...seen], [join]);
  });
});

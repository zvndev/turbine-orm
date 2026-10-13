/**
 * Nested writes on an optional belongsTo relation.
 *
 *   - `disconnect: true` when nothing is connected is a no-op, as in Prisma:
 *     the record already points at nothing, which is what was asked. A
 *     `delete`, or a `disconnect` naming fields, asks about a row that is not
 *     there and is E001 saying nothing is connected.
 *   - An operation whose value is `undefined` is absent, as everywhere else in
 *     a query: `set: undefined` on a belongsTo is not refused as a `set`.
 *
 * Live: needs DATABASE_URL.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/where-hardening-nested-write.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { NotFoundError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: nested-write payloads are untyped here
type Any = any;

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');

async function runSql(statements: string[]): Promise<void> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    for (const sql of statements) await pool.query(sql);
  } finally {
    await pool.end();
  }
}

const DDL = [
  'DROP TABLE IF EXISTS wh_nw_members, wh_nw_orgs',
  'CREATE TABLE wh_nw_orgs (id int PRIMARY KEY, name text NOT NULL)',
  'CREATE TABLE wh_nw_members (id int PRIMARY KEY, org_id int REFERENCES wh_nw_orgs(id), name text NOT NULL)',
  "INSERT INTO wh_nw_orgs VALUES (1, 'one'), (2, 'two')",
];

const RESET = [
  'DELETE FROM wh_nw_members',
  "INSERT INTO wh_nw_members VALUES (1, NULL, 'loose'), (2, 1, 'member')",
  "INSERT INTO wh_nw_orgs VALUES (1, 'one'), (2, 'two') ON CONFLICT (id) DO NOTHING",
];

function notConnected(op: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof NotFoundError, `expected NotFoundError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E001');
    assert.match(err.message, new RegExp(`Nested ${op} .*nothing is connected`, 's'), err.message);
    return true;
  };
}

describe('nested writes on an optional belongsTo', () => {
  let db: TurbineClient;
  let schema: SchemaMetadata;
  let rel: string;
  const members = () => db.table<{ id: number; orgId: number | null; name: string }>('wh_nw_members');
  const orgOf = async (id: number) => (await members().findUnique({ where: { id } }))?.orgId ?? null;

  live.before(async () => {
    await runSql(DDL);
    schema = await introspect({ connectionString: DATABASE_URL!, include: ['wh_nw_orgs', 'wh_nw_members'] });
    const relation = Object.values(schema.tables.wh_nw_members!.relations).find((r) => r.type === 'belongsTo');
    assert.ok(relation, 'introspection found the belongsTo relation');
    rel = relation.name;
    db = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 1, warnOnUnlimited: false }, schema);
  });

  live.after(async () => {
    await db?.disconnect();
    await runSql(['DROP TABLE IF EXISTS wh_nw_members, wh_nw_orgs']);
  });

  live.it('disconnect: true with nothing connected is a no-op', async () => {
    await runSql(RESET);
    const row = await members().update({
      where: { id: 1 },
      data: { name: 'still loose', [rel]: { disconnect: true } },
    } as Any);
    assert.equal(row.name, 'still loose');
    assert.equal(await orgOf(1), null);
  });

  live.it('disconnect: {} with nothing connected is the same no-op', async () => {
    await runSql(RESET);
    await members().update({ where: { id: 1 }, data: { [rel]: { disconnect: {} } } } as Any);
    assert.equal(await orgOf(1), null);
  });

  live.it('disconnect: true with a row connected clears the foreign key', async () => {
    await runSql(RESET);
    await members().update({ where: { id: 2 }, data: { [rel]: { disconnect: true } } } as Any);
    assert.equal(await orgOf(2), null);
  });

  live.it('delete: true with nothing connected is E001, and nothing changes', async () => {
    await runSql(RESET);
    await assert.rejects(
      () => members().update({ where: { id: 1 }, data: { name: 'x', [rel]: { delete: true } } } as Any),
      notConnected('delete'),
    );
    assert.equal((await members().findUnique({ where: { id: 1 } }))?.name, 'loose');
  });

  live.it('a disconnect naming fields with nothing connected is E001', async () => {
    await runSql(RESET);
    await assert.rejects(
      () => members().update({ where: { id: 1 }, data: { [rel]: { disconnect: { name: 'one' } } } } as Any),
      notConnected('disconnect'),
    );
  });

  live.it('set: undefined is absent, not a refused set', async () => {
    await runSql(RESET);
    await members().update({ where: { id: 1 }, data: { [rel]: { set: undefined, connect: { id: 2 } } } } as Any);
    assert.equal(await orgOf(1), 2);
    await members().update({ where: { id: 2 }, data: { [rel]: { set: undefined } } } as Any);
    assert.equal(await orgOf(2), 1);
  });

  live.it('an update-only operation holding undefined is absent inside create', async () => {
    await runSql(RESET);
    await members().create({
      data: { id: 3, name: 'new', [rel]: { connect: { id: 1 }, disconnect: undefined } },
    } as Any);
    assert.equal(await orgOf(3), 1);
  });

  live.it('a defined set is still refused on a belongsTo', async () => {
    await runSql(RESET);
    await assert.rejects(
      () => members().update({ where: { id: 1 }, data: { [rel]: { set: [{ id: 2 }] } } } as Any),
      /Nested set on .* is not supported/,
    );
  });
});

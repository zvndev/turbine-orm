/**
 * turbine-orm, `select` / `omit` on single-row writes (live PostgreSQL)
 *
 * The build-only half (write-projection.test.ts) pins the SQL; this half pins
 * what comes back from a real server, across every write path that returns a
 * row: plain create / update / delete / upsert, a nested create and a nested
 * update (which return through the nested engine's final read-back), and the
 * batched `$transaction([...])` form (which runs `buildCreate` directly).
 *
 * Creates and drops its own tables; needs only a reachable Postgres:
 *   DATABASE_URL=postgres://... npx tsx --test src/test/write-projection.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const SCHEMA: SchemaMetadata = {
  enums: {},
  tables: {
    wp_inbox: mockTable(
      'wp_inbox',
      [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'kind', field: 'kind', pgType: 'text' },
        { name: 'payload', field: 'payload', pgType: 'jsonb' },
        { name: 'secret', field: 'secret', pgType: 'text', pii: true },
      ],
      {
        notes: {
          type: 'hasMany',
          name: 'notes',
          from: 'wp_inbox',
          to: 'wp_notes',
          foreignKey: 'inbox_id',
          referenceKey: 'id',
        },
      },
    ),
    wp_notes: mockTable('wp_notes', [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: 'inbox_id', field: 'inboxId', pgType: 'int4' },
      { name: 'body', field: 'body', pgType: 'text' },
    ]),
  },
};

type Inbox = { id: number; kind: string; payload: unknown; secret: string | null };

let db: TurbineClient;
let admin: pg.Client;
const inbox = () => db.table<Inbox>('wp_inbox');

describe('write select / omit against PostgreSQL', () => {
  before(async () => {
    admin = new pg.Client({ connectionString: DATABASE_URL });
    await admin.connect();
    await admin.query('DROP TABLE IF EXISTS wp_notes, wp_inbox');
    await admin.query('CREATE TABLE wp_inbox (id serial PRIMARY KEY, kind text NOT NULL, payload jsonb, secret text)');
    await admin.query(
      'CREATE TABLE wp_notes (id serial PRIMARY KEY, inbox_id int NOT NULL REFERENCES wp_inbox(id), body text NOT NULL)',
    );
    db = new TurbineClient({ connectionString: DATABASE_URL }, SCHEMA);
  });

  after(async () => {
    await db?.disconnect();
    await admin?.query('DROP TABLE IF EXISTS wp_notes, wp_inbox');
    await admin?.end();
  });

  it('create: select returns exactly the named fields', async () => {
    const row = await inbox().create({ data: { kind: 'a', payload: { big: 'x'.repeat(3000) } }, select: { id: true } });
    assert.deepEqual(Object.keys(row), ['id']);
    assert.equal(typeof row.id, 'number');
  });

  it('create: omit drops the named fields and keeps PII out', async () => {
    const row = await inbox().create({ data: { kind: 'b', payload: { a: 1 }, secret: 's' }, omit: { payload: true } });
    assert.deepEqual(Object.keys(row).sort(), ['id', 'kind']);
  });

  it('create: an explicit select of a PII field returns it', async () => {
    const row = await inbox().create({ data: { kind: 'c', secret: 'shh' }, select: { id: true, secret: true } });
    assert.equal(row.secret, 'shh');
  });

  it('update, delete and upsert narrow the same way', async () => {
    const { id } = await inbox().create({ data: { kind: 'd', payload: { n: 1 } }, select: { id: true } });
    const updated = await inbox().update({ where: { id }, data: { kind: 'd2' }, select: { kind: true } });
    assert.deepEqual(updated, { kind: 'd2' });

    const upserted = await inbox().upsert({
      where: { id },
      create: { id, kind: 'never' },
      update: { kind: 'd3' },
      omit: { payload: true },
    });
    assert.deepEqual(upserted, { id, kind: 'd3' });

    const deleted = await inbox().delete({ where: { id }, select: { id: true, kind: true } });
    assert.deepEqual(deleted, { id, kind: 'd3' });
  });

  it('a nested create applies the projection to the top-level row', async () => {
    const row = (await inbox().create({
      data: { kind: 'nested', payload: { p: 1 }, notes: { create: [{ body: 'hi' }] } } as never,
      select: { id: true },
    })) as Record<string, unknown>;
    assert.equal(typeof row.id, 'number');
    assert.equal('payload' in row, false, 'the projection reaches the nested read-back');
    assert.equal('kind' in row, false);
  });

  it('a nested update applies it too', async () => {
    const { id } = await inbox().create({ data: { kind: 'nu' }, select: { id: true } });
    const row = (await inbox().update({
      where: { id },
      data: { kind: 'nu2', notes: { create: [{ body: 'x' }] } } as never,
      omit: { payload: true },
    })) as Record<string, unknown>;
    assert.equal(row.kind, 'nu2');
    assert.equal('payload' in row, false);
  });

  it('the batched $transaction form narrows through buildCreate', async () => {
    const [a, b] = await db.$transaction([
      inbox().buildCreate({ data: { kind: 't1', payload: { z: 1 } }, select: { kind: true } }),
      inbox().buildCreate({ data: { kind: 't2' }, omit: { payload: true } }),
    ]);
    assert.deepEqual(a, { kind: 't1' });
    assert.deepEqual(Object.keys(b).sort(), ['id', 'kind']);
  });

  it('a bad projection writes nothing', async () => {
    const before = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM wp_inbox');
    await assert.rejects(inbox().create({ data: { kind: 'no' }, select: { kynd: true } as never }), /kynd/);
    await assert.rejects(
      inbox().create({
        data: { kind: 'no', notes: { create: [{ body: 'x' }] } } as never,
        select: { kynd: true } as never,
      }),
      /kynd/,
    );
    const after = await admin.query<{ n: number }>('SELECT count(*)::int AS n FROM wp_inbox');
    assert.equal(after.rows[0]?.n, before.rows[0]?.n);
  });
});

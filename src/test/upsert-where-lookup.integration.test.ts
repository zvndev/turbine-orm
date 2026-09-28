/**
 * turbine-orm: `upsert` finds the row its `where` names (live Postgres).
 *
 * An upsert means "find the row `where` names; update it if it exists, else
 * insert `create`". A single `INSERT ... ON CONFLICT (<where keys>)` compares
 * the conflict columns against the values being INSERTED, which are
 * `create`'s, and never reads `where`'s values. The two agree only when every
 * `where` key is pinned to the value `create` carries, and core used to emit
 * the statement regardless:
 *
 * - `where: { id }` with a `create` that leaves `id` to its sequence inserted a
 *   NEW row every time and never touched the row `where` named;
 * - `where: { email: a }` with `create: { email: b }` updated the row holding
 *   `b`, or inserted `b`, and left `a` alone;
 * - an empty `update` emitted `DO UPDATE SET` with nothing after it, a syntax
 *   error on every engine.
 *
 * Each of those now looks the row up by `where` first, inside one transaction
 * (the caller's when there is one). A call whose `where` does match `create`
 * keeps the single atomic statement, which is asserted here from the query
 * events, not assumed. Nested relation writes in `create` / `update` run
 * through the nested-write engine on the same path.
 *
 * Every stored value is read back through a raw pg client, never through the
 * ORM's own row parser.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/upsert-where-lookup.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { UniqueConstraintError, ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { QueryEvent } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
// skipGate gates it / before / after; the per-test reset needs the same gate.
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

const DDL = `
DROP TABLE IF EXISTS qa81_notes CASCADE;
DROP TABLE IF EXISTS qa81_accounts CASCADE;
CREATE TABLE qa81_accounts (
  id     SERIAL PRIMARY KEY,
  email  TEXT NOT NULL UNIQUE,
  name   TEXT NOT NULL,
  tenant TEXT NOT NULL DEFAULT 't1'
);
CREATE TABLE qa81_notes (
  id         SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES qa81_accounts(id),
  body       TEXT NOT NULL
);
`;

const RESET = `
TRUNCATE qa81_notes, qa81_accounts RESTART IDENTITY CASCADE;
INSERT INTO qa81_accounts (email, name, tenant) VALUES
  ('a@x.test', 'A', 't1'),
  ('b@x.test', 'B', 't2');
`;

type Account = { id: number; email: string; name: string; tenant: string };

describe('upsert: the row `where` names is the row it updates (live Postgres)', () => {
  let raw: pg.Client;
  let schema: SchemaMetadata;
  let db: TurbineClient;
  let events: QueryEvent[];
  let notesRelation: string;

  const accounts = () => db.table<Account>('qa81_accounts');
  const rows = async (): Promise<Account[]> =>
    (await raw.query('SELECT id, email, name, tenant FROM qa81_accounts ORDER BY id')).rows;
  const statements = () => events.map((e) => e.sql.trim().split(/\s+/)[0]!.toUpperCase());

  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(DDL);
    schema = await introspect({ connectionString: DATABASE_URL as string });
    const rel = Object.entries(schema.tables.qa81_accounts!.relations).find(([, r]) => r.to === 'qa81_notes');
    assert.ok(rel, 'introspection found the accounts -> notes relation');
    notesRelation = rel[0];
    db = new TurbineClient({ connectionString: DATABASE_URL as string, warnOnUnlimited: false }, schema);
    db.$on('query', (e) => events.push(e));
  });

  beforeEach(async () => {
    await raw.query(RESET);
    events = [];
  });

  after(async () => {
    await db?.disconnect();
    await raw?.query('DROP TABLE IF EXISTS qa81_notes CASCADE; DROP TABLE IF EXISTS qa81_accounts CASCADE;');
    await raw?.end();
  });

  it('`where: { id }` with a keyless `create` updates that row and inserts nothing', async () => {
    const row = await accounts().upsert({
      where: { id: 1 },
      create: { email: 'new@x.test', name: 'never' },
      update: { name: 'A2' },
    });
    assert.equal(row.id, 1);
    assert.equal(row.name, 'A2');
    assert.deepEqual(
      (await rows()).map((r) => [r.id, r.name]),
      [
        [1, 'A2'],
        [2, 'B'],
      ],
      'row 1 updated, no third row',
    );
  });

  it('`where: { email: a }` with `create: { email: b }` updates a, not b', async () => {
    const row = await accounts().upsert({
      where: { email: 'a@x.test' },
      create: { email: 'b@x.test', name: 'never' },
      update: { name: 'A3' },
    });
    assert.equal(row.email, 'a@x.test');
    const all = await rows();
    assert.equal(all.find((r) => r.email === 'a@x.test')?.name, 'A3');
    assert.equal(all.find((r) => r.email === 'b@x.test')?.name, 'B', 'the row holding create.email is untouched');
  });

  it('inserts `create` when no row matches `where`', async () => {
    const row = await accounts().upsert({
      where: { id: 99 },
      create: { email: 'c@x.test', name: 'C' },
      update: { name: 'never' },
    });
    assert.equal(row.email, 'c@x.test');
    assert.equal((await rows()).length, 3);
  });

  it('a `where` pinned to `create` still runs as ONE atomic statement', async () => {
    const row = await accounts().upsert({
      where: { email: 'a@x.test' },
      create: { email: 'a@x.test', name: 'never' },
      update: { name: 'A4' },
    });
    assert.equal(row.name, 'A4');
    assert.deepEqual(statements(), ['INSERT'], 'no lookup, no transaction: the single conflict statement');
  });

  it('the lookup path is one SELECT then one UPDATE (transaction control emits no query event)', async () => {
    await accounts().upsert({ where: { id: 1 }, create: { email: 'z@x.test', name: 'z' }, update: { name: 'A5' } });
    assert.deepEqual(statements(), ['SELECT', 'UPDATE']);
  });

  it('an empty `update` returns the row as it is, and inserts when it is missing', async () => {
    const found = await accounts().upsert({
      where: { email: 'a@x.test' },
      create: { email: 'a@x.test', name: 'x' },
      update: {},
    });
    assert.equal(found.name, 'A');
    assert.deepEqual(statements(), ['SELECT'], 'nothing to set: the lookup IS the answer, no second read or write');
    const made = await accounts().upsert({
      where: { email: 'd@x.test' },
      create: { email: 'd@x.test', name: 'D' },
      update: {},
    });
    assert.equal(made.name, 'D');
    assert.equal((await rows()).length, 3);
  });

  it('select / omit shape the answer on both branches', async () => {
    const updated = await accounts().upsert({
      where: { id: 1 },
      create: { email: 'q@x.test', name: 'never' },
      update: { name: 'A6' },
      select: { id: true, name: true },
    });
    assert.deepEqual(updated, { id: 1, name: 'A6' });
    const created = await accounts().upsert({
      where: { id: 42 },
      create: { email: 'e@x.test', name: 'E' },
      update: { name: 'never' },
      omit: { tenant: true },
    });
    assert.deepEqual(Object.keys(created).sort(), ['email', 'id', 'name']);
  });

  it('an unknown field in `update` is refused whether or not the row exists, and nothing is written', async () => {
    for (const where of [{ id: 1 }, { id: 99 }]) {
      await assert.rejects(
        () =>
          accounts().upsert({
            where,
            create: { email: 'u@x.test', name: 'u' },
            update: { nmae: 'typo' } as never,
          }),
        ValidationError,
      );
    }
    assert.deepEqual(
      (await rows()).map((r) => r.name),
      ['A', 'B'],
    );
    assert.deepEqual(statements(), [], 'refused before any statement was sent');
  });

  it('nested writes: `create` makes the children, `update` adds to them', async () => {
    const created = await accounts().upsert({
      where: { email: 'n@x.test' },
      create: { email: 'n@x.test', name: 'N', [notesRelation]: { create: [{ body: 'first' }] } } as never,
      update: { name: 'never' },
    });
    await accounts().upsert({
      where: { id: created.id },
      create: { email: 'never@x.test', name: 'never' },
      update: { name: 'N2', [notesRelation]: { create: [{ body: 'second' }] } } as never,
    });
    const notes = await raw.query('SELECT body FROM qa81_notes WHERE account_id = $1 ORDER BY id', [created.id]);
    assert.deepEqual(
      notes.rows.map((r) => r.body),
      ['first', 'second'],
    );
    assert.equal((await rows()).find((r) => r.id === created.id)?.name, 'N2');
  });

  it('inside $transaction the lookup joins the caller transaction and rolls back with it', async () => {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.table<Account>('qa81_accounts').upsert({
          where: { id: 1 },
          create: { email: 'tx@x.test', name: 'never' },
          update: { name: 'in-tx' },
        });
        throw new Error('roll it back');
      }),
      /roll it back/,
    );
    assert.equal((await rows())[0]!.name, 'A', 'the update rolled back with the caller transaction');
  });

  it('a global filter hides another tenant row from the lookup, so it is never updated', async () => {
    const scoped = new TurbineClient(
      {
        connectionString: DATABASE_URL as string,
        warnOnUnlimited: false,
        globalFilters: { qa81_accounts: { tenant: 't1' } },
      },
      schema,
    );
    try {
      // Row 2 belongs to t2. The lookup cannot see it, so this is an insert,
      // and create's email collides with row 2's: refused, row 2 untouched.
      await assert.rejects(
        () =>
          scoped.table<Account>('qa81_accounts').upsert({
            where: { id: 2 },
            create: { email: 'b@x.test', name: 'hijack', tenant: 't1' },
            update: { name: 'hijack' },
          }),
        UniqueConstraintError,
      );
      assert.equal((await rows()).find((r) => r.id === 2)?.name, 'B');
    } finally {
      await scoped.disconnect();
    }
  });

  it('a batched upsert whose `where` differs from `create` is refused, not run as the wrong statement', async () => {
    assert.throws(
      () =>
        accounts().buildUpsert({ where: { id: 1 }, create: { email: 'x@x.test', name: 'x' }, update: { name: 'x' } }),
      (err: unknown) => err instanceof ValidationError && /does not carry `create`'s values/.test(err.message),
    );
    assert.throws(
      () => accounts().buildUpsert({ where: { id: 1 }, create: { id: 1, email: 'x@x.test', name: 'x' }, update: {} }),
      (err: unknown) => err instanceof ValidationError && /`update` is empty/.test(err.message),
    );
  });
});

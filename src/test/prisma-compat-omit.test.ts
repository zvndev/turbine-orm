/**
 * prisma-compat: `omit` on reads.
 *
 * It used to be DROPPED silently. That is a data-exposure bug rather than an
 * ergonomics one: `omit` is the idiom for a sensitive-but-untagged column
 * (`passwordHash`, `resetToken`), so the caller asked for the column to be
 * left out, got no error, and shipped the column in a response they believed
 * was filtered. Turbine core has supported `omit` on reads all along; only the
 * translation was missing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { type CompatTurbineClient, createPrismaCompatClient } from '../prisma-compat.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

type Models = {
  User: { Row: { id: number; email: string; passwordHash: string } };
  Post: { Row: { id: number; title: string; draftNotes: string; authorId: number } };
};

/**
 * A `@map` divergence on the omitted fields, deliberately: `omit` carries FIELD
 * NAMES, so it is only provably translated on a model whose Prisma and turbine
 * spellings differ.
 */
function fixture(): { schema: SchemaMetadata; map: PrismaCompatMap } {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email_address', field: 'emailAddress', pgType: 'text' },
    { name: 'password_hash', field: 'passwordHash', pgType: 'text' },
  ]);
  users.primaryKey = ['id'];
  users.relations = {
    posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'author_id', referenceKey: 'id' },
  };

  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'draft_notes', field: 'draftNotes', pgType: 'text' },
    { name: 'author_id', field: 'authorId' },
  ]);
  posts.primaryKey = ['id'];

  const schema: SchemaMetadata = { enums: {}, tables: { users, posts } };
  const map: PrismaCompatMap = {
    enums: {},
    models: {
      User: {
        table: 'users',
        accessor: 'users',
        fields: { id: 'id', email: 'emailAddress', passwordHash: 'passwordHash' },
        relations: { posts: { name: 'posts', cardinality: 'many' } },
        compoundUniques: {},
      },
      Post: {
        table: 'posts',
        accessor: 'posts',
        fields: { id: 'id', title: 'title', notes: 'draftNotes', authorId: 'authorId' },
        relations: {},
        compoundUniques: {},
      },
    },
  };
  return { schema, map };
}

interface SpyCall {
  method: string;
  args: Any;
}

function spyDb(schema: SchemaMetadata): { db: CompatTurbineClient; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const qi = (table: string): Any =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (args: Any) => {
            calls.push({ method: `${table}.${prop}`, args });
            if (/Many$/.test(prop) || prop === 'groupBy') return Promise.resolve([]);
            return Promise.resolve(null);
          };
        },
      },
    );
  const db = { schema, table: qi, $transaction: (arg: Any) => arg({ table: qi }) };
  return { db: db as unknown as CompatTurbineClient, calls };
}

/** Run one delegate call and return the turbine args core received. */
async function argsOf(call: (compat: Any) => Promise<unknown>, method: string): Promise<Any> {
  const { schema, map } = fixture();
  const { db, calls } = spyDb(schema);
  await call(createPrismaCompatClient<Models>(db as unknown as TurbineClient, map));
  const hit = calls.find((c) => c.method === method);
  assert.ok(hit, `expected a core ${method} call, saw ${calls.map((c) => c.method).join(', ') || '(none)'}`);
  return hit.args;
}

describe('prisma-compat, omit on reads', () => {
  it('a top-level omit reaches core, translated into turbine field names', async () => {
    const args = await argsOf((c) => c.User.findMany({ omit: { passwordHash: true } }), 'users.findMany');
    assert.deepEqual(args.omit, { passwordHash: true }, 'omit must not be dropped');
  });

  it('a @map-diverging field name is renamed, not copied blind', async () => {
    const args = await argsOf((c) => c.Post.findMany({ omit: { notes: true } }), 'posts.findMany');
    assert.deepEqual(args.omit, { draftNotes: true }, 'the Prisma spelling must be renamed into turbine space');
  });

  it('omit survives every read shape that accepts it', async () => {
    for (const [call, method] of [
      [(c: Any) => c.User.findMany({ omit: { passwordHash: true } }), 'users.findMany'],
      [(c: Any) => c.User.findFirst({ omit: { passwordHash: true } }), 'users.findFirst'],
      [(c: Any) => c.User.findUnique({ where: { id: 1 }, omit: { passwordHash: true } }), 'users.findUnique'],
      [
        (c: Any) => c.User.findUniqueOrThrow({ where: { id: 1 }, omit: { passwordHash: true } }),
        'users.findUniqueOrThrow',
      ],
      [(c: Any) => c.User.findFirstOrThrow({ omit: { passwordHash: true } }), 'users.findFirstOrThrow'],
    ] as [(c: Any) => Promise<unknown>, string][]) {
      const args = await argsOf(call, method);
      assert.deepEqual(args.omit, { passwordHash: true }, `omit dropped on ${method}`);
    }
  });

  it('omit + include coexist (Prisma allows it: omit scalars, add relations)', async () => {
    const args = await argsOf(
      (c) => c.User.findMany({ omit: { passwordHash: true }, include: { posts: true } }),
      'users.findMany',
    );
    assert.deepEqual(args.omit, { passwordHash: true });
    assert.deepEqual(args.with, { posts: true });
  });

  it('a nested relation omit reaches the with-clause (child rows are just as exposed)', async () => {
    const args = await argsOf(
      (c) => c.User.findMany({ include: { posts: { omit: { notes: true } } } }),
      'users.findMany',
    );
    assert.deepEqual(args.with, { posts: { omit: { draftNotes: true } } });
  });

  it('omit: { field: false } contributes nothing (Prisma semantics)', async () => {
    const args = await argsOf((c) => c.User.findMany({ omit: { passwordHash: false } }), 'users.findMany');
    assert.equal(args.omit, undefined);
  });

  it('select + omit throws instead of silently preferring one', async () => {
    await assert.rejects(
      () => argsOf((c) => c.User.findMany({ select: { id: true }, omit: { passwordHash: true } }), 'users.findMany'),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /`select` and `omit` are mutually exclusive/);
        return true;
      },
    );
  });

  it('omitting a RELATION throws rather than compiling to nothing', async () => {
    await assert.rejects(
      () => argsOf((c) => c.User.findMany({ omit: { posts: true } as Any }), 'users.findMany'),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /is a relation/);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Write projections: the one projection surface core never sees
// ---------------------------------------------------------------------------

/** A spy whose writes return a real row, so the projection is observable. */
function spyWriteDb(schema: SchemaMetadata, row: Record<string, unknown>): CompatTurbineClient {
  const qi = (): Any =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (_args: Any) => (/Many$/.test(prop) ? Promise.resolve([row]) : Promise.resolve({ ...row }));
        },
      },
    );
  return { schema, table: qi, $transaction: (arg: Any) => arg({ table: qi }) } as unknown as CompatTurbineClient;
}

function writeCompat(row: Record<string, unknown>): Any {
  const { schema, map } = fixture();
  return createPrismaCompatClient<Models>(spyWriteDb(schema, row) as unknown as TurbineClient, map);
}

describe('prisma-compat, write projections validate their field names', () => {
  // `select` / `omit` on a WRITE are applied to the returned object here, they
  // are never handed to core, so core's E003 on an unknown projection key (the
  // rule the caller has already met on findMany) could not fire. A misspelled
  // key was simply added to the Set and did nothing.
  const ROW = { id: 1, email: 'ada@example.com', passwordHash: 'argon2:...' };

  it('a misspelled `omit` key throws instead of returning the column', async () => {
    // The direction that matters. `omit: { passwordHahs: true }` used to return
    // the hash, with no error, to a caller who had asked for it withheld.
    await assert.rejects(
      () => writeCompat(ROW).User.create({ data: { email: 'a@b.c' }, omit: { passwordHahs: true } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /unknown field "passwordHahs"/);
        assert.match((err as Error).message, /Did you mean "passwordHash"\?/);
        return true;
      },
    );
  });

  it('a misspelled `select` key throws instead of quietly dropping the field', async () => {
    await assert.rejects(
      () => writeCompat(ROW).User.update({ where: { id: 1 }, data: {}, select: { emial: true } }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match((err as Error).message, /unknown field "emial"/);
        return true;
      },
    );
  });

  it('the check spans every write that takes a projection', async () => {
    const calls: [string, () => Promise<unknown>][] = [
      ['create', () => writeCompat(ROW).User.create({ data: {}, omit: { nope: true } })],
      ['update', () => writeCompat(ROW).User.update({ where: { id: 1 }, data: {}, omit: { nope: true } })],
      ['delete', () => writeCompat(ROW).User.delete({ where: { id: 1 }, omit: { nope: true } })],
      [
        'upsert',
        () => writeCompat(ROW).User.upsert({ where: { id: 1 }, create: {}, update: {}, omit: { nope: true } }),
      ],
    ];
    for (const [name, run] of calls) {
      await assert.rejects(run, (err: unknown) => err instanceof ValidationError, `${name} accepted an unknown field`);
    }
  });

  it('a CORRECT projection still works, and is applied to the returned row', async () => {
    const compat = writeCompat(ROW);
    const omitted = (await compat.User.create({ data: {}, omit: { passwordHash: true } })) as Record<string, unknown>;
    assert.equal('passwordHash' in omitted, false, 'omit must still drop the field');
    assert.equal(omitted.email, 'ada@example.com');

    const picked = (await compat.User.create({ data: {}, select: { id: true } })) as Record<string, unknown>;
    assert.deepEqual(picked, { id: 1 });
  });

  it('the Prisma spelling is what gets validated, not the turbine one', async () => {
    // Post maps Prisma `notes` -> turbine `draftNotes`. The projection is
    // applied to an already-reshaped row, so `notes` is right and `draftNotes`
    // names nothing in Prisma space.
    const post = { id: 1, title: 't', notes: 'secret', authorId: 1 };
    await assert.doesNotReject(() => writeCompat(post).Post.create({ data: {}, omit: { notes: true } }));
    await assert.rejects(
      () => writeCompat(post).Post.create({ data: {}, omit: { draftNotes: true } }),
      (err: unknown) => err instanceof ValidationError,
    );
  });
});

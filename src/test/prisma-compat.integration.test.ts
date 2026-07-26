/**
 * turbine-orm/prisma-compat, end-to-end integration against a real Postgres.
 *
 * Drives the compat client over a self-contained fixture that exercises the
 * hard cases: a `@@map` divergence (Prisma `User.email` → column
 * `email_address`), a composite primary key (compound-unique selector), an
 * `include` tree (to-many + to-one), a lazy `$transaction([...])` array, and
 * `createMany({ skipDuplicates })`. Gated on `DATABASE_URL`; creates and drops
 * its own tables so it never touches shared fixtures.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TurbineClient } from '../client.js';
import { TurbineError, TurbineErrorCode } from '../errors.js';
import { introspect } from '../introspect.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import type { PrismaCompatMap, RelationDef, SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const url = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!url, 'DATABASE_URL not set');

describe('prisma-compat, integration (real Postgres)', () => {
  let db: TurbineClient;
  let schema: SchemaMetadata;
  let map: PrismaCompatMap;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
  let compat: any;

  const ddl = [
    'DROP TABLE IF EXISTS membership, post, app_user CASCADE',
    `CREATE TABLE app_user (
       id            serial PRIMARY KEY,
       email_address text NOT NULL UNIQUE,
       display_name  text
     )`,
    `CREATE TABLE post (
       id        serial PRIMARY KEY,
       title     text NOT NULL,
       author_id int NOT NULL REFERENCES app_user(id)
     )`,
    `CREATE TABLE membership (
       org_id  int  NOT NULL,
       user_id int  NOT NULL,
       role    text NOT NULL,
       PRIMARY KEY (org_id, user_id)
     )`,
  ];

  before(async () => {
    if (!url) return;
    const admin = new TurbineClient({ connectionString: url }, { enums: {}, tables: {} });
    for (const stmt of ddl) await admin.raw([stmt] as unknown as TemplateStringsArray);
    await admin.raw([
      "INSERT INTO app_user (email_address, display_name) VALUES ('a@acme.com','Ada'),('b@other.com','Bob')",
    ] as unknown as TemplateStringsArray);
    await admin.raw([
      "INSERT INTO post (title, author_id) VALUES ('First', 1),('Second', 1),('Third', 2)",
    ] as unknown as TemplateStringsArray);
    await admin.raw([
      "INSERT INTO membership (org_id, user_id, role) VALUES (10, 1, 'admin'),(10, 2, 'member')",
    ] as unknown as TemplateStringsArray);
    await admin.disconnect();

    schema = await introspect({ connectionString: url });
    db = new TurbineClient({ connectionString: url }, schema);

    // Discover the introspected relation names so the map is not hard-coded.
    const userRels = schema.tables.app_user!.relations;
    const postsRel = Object.entries(userRels).find(([, r]: [string, RelationDef]) => r.to === 'post')![0];
    const postRels = schema.tables.post!.relations;
    const authorRel = Object.entries(postRels).find(([, r]: [string, RelationDef]) => r.to === 'app_user')![0];

    map = {
      enums: {},
      models: {
        User: {
          table: 'app_user',
          accessor: 'appUser',
          fields: { id: 'id', email: 'emailAddress', displayName: 'displayName' },
          relations: { posts: { name: postsRel, cardinality: 'many' } },
          compoundUniques: {},
        },
        Post: {
          table: 'post',
          accessor: 'post',
          fields: { id: 'id', title: 'title', authorId: 'authorId' },
          relations: { author: { name: authorRel, cardinality: 'one' } },
          compoundUniques: {},
        },
        Membership: {
          table: 'membership',
          accessor: 'membership',
          fields: { id: 'id', orgId: 'orgId', userId: 'userId', role: 'role' },
          relations: {},
          compoundUniques: { orgId_userId: ['orgId', 'userId'], org_user: ['orgId', 'userId'] },
        },
      },
    };
    compat = createPrismaCompatClient(db, map);
  });

  after(async () => {
    if (!url || !db) return;
    await db.raw(['DROP TABLE IF EXISTS membership, post, app_user CASCADE'] as unknown as TemplateStringsArray);
    await db.disconnect();
  });

  it('findMany with a @@map-diverged where field returns Prisma-shaped rows', async () => {
    const rows = await compat.User.findMany({ where: { email: { contains: 'acme' } } });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].email, 'a@acme.com', 'field keyed back to Prisma name');
    assert.equal(rows[0].displayName, 'Ada');
    assert.equal(rows[0].emailAddress, undefined, 'turbine field name not leaked');
  });

  it('include tree: to-many posts (array) + to-one author (object)', async () => {
    const users = await compat.User.findMany({
      where: { email: 'a@acme.com' },
      include: { posts: { orderBy: { title: 'asc' } } },
    });
    assert.equal(users[0].posts.length, 2);
    assert.deepEqual(
      users[0].posts.map((p: { title: string }) => p.title),
      ['First', 'Second'],
    );

    const posts = await compat.Post.findMany({ where: { title: 'First' }, include: { author: true } });
    assert.equal(posts[0].author.email, 'a@acme.com', 'to-one relation is an object, reshaped');
    assert.equal(Array.isArray(posts[0].author), false);
  });

  it('_count keyed back to the Prisma relation name (+ _all)', async () => {
    const users = await compat.User.findMany({
      where: { email: 'a@acme.com' },
      include: { _count: { select: { posts: true } } },
    });
    assert.equal(users[0]._count.posts, 2);
  });

  it('compound-unique findUnique via the default selector name', async () => {
    const m = await compat.Membership.findUnique({ where: { orgId_userId: { orgId: 10, userId: 1 } } });
    assert.equal(m.role, 'admin');
  });

  it('compound-unique findUnique via a custom @@unique(name:) selector', async () => {
    const m = await compat.Membership.findUnique({ where: { org_user: { orgId: 10, userId: 2 } } });
    assert.equal(m.role, 'member');
  });

  it('cursor + skip:1 paginates exclusively', async () => {
    const page = await compat.Post.findMany({ orderBy: { id: 'asc' }, cursor: { id: 1 }, skip: 1, take: 1 });
    assert.equal(page.length, 1);
    assert.equal(page[0].id, 2, 'cursor row excluded, next row returned');
  });

  it('$transaction([...]) array batches lazy creates atomically', async () => {
    const [u, p] = await compat.$transaction([
      compat.User.create({ data: { email: 'tx@acme.com', displayName: 'Tx' } }),
      compat.Membership.create({ data: { orgId: 20, userId: 99, role: 'owner' } }),
    ]);
    assert.equal(u.email, 'tx@acme.com');
    assert.equal(p.role, 'owner');
    // Both rows are visible after the batch commits.
    const back = await compat.User.findUnique({ where: { email: 'tx@acme.com' } });
    assert.equal(back.displayName, 'Tx');
  });

  it('$transaction([...]) rolls the whole batch back on a mid-array failure', async () => {
    await assert.rejects(() =>
      compat.$transaction([
        compat.User.create({ data: { email: 'rollback@acme.com', displayName: 'RB' } }),
        // Duplicate email → unique violation aborts the batch.
        compat.User.create({ data: { email: 'a@acme.com', displayName: 'dup' } }),
      ]),
    );
    const orphan = await compat.User.findUnique({ where: { email: 'rollback@acme.com' } });
    assert.equal(orphan, null, 'first insert rolled back');
  });

  it('createMany({ skipDuplicates }) skips conflicting rows on Postgres', async () => {
    // 'a@acme.com' already exists (unique) → skipped; 'fresh@acme.com' inserted.
    const res = await compat.User.createMany({
      data: [{ email: 'a@acme.com' }, { email: 'fresh@acme.com' }],
      skipDuplicates: true,
    });
    assert.equal(res.count, 1, 'one row inserted, the duplicate skipped');
    const fresh = await compat.User.findUnique({ where: { email: 'fresh@acme.com' } });
    assert.ok(fresh, 'the non-conflicting row landed');
  });

  it('$queryRaw runs a parameterized query and returns rows', async () => {
    const rows = await compat.$queryRaw`SELECT count(*)::int AS n FROM app_user WHERE email_address LIKE ${'%acme%'}`;
    assert.ok(rows[0].n >= 2);
  });

  // -------------------------------------------------------------------------
  // Raw SQL inside $transaction. These are the tests that PROVE atomicity: a
  // raw statement that quietly ran on a pool connection would survive the
  // rollback, and the caller would never know.
  // -------------------------------------------------------------------------

  it('a raw INSERT inside $transaction is rolled back when the callback throws', async () => {
    const email = 'raw-rollback@acme.com';
    await assert.rejects(
      () =>
        compat.$transaction(
          async (tx: { $executeRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<number> }) => {
            const n =
              await tx.$executeRaw`INSERT INTO app_user (email_address, display_name) VALUES (${email}, 'RawRB')`;
            assert.equal(n, 1, 'the raw insert reported one affected row');
            throw new Error('abort');
          },
        ),
      /abort/,
    );
    const gone = await compat.User.findUnique({ where: { email } });
    assert.equal(gone, null, 'the raw insert rolled back with the transaction');
  });

  it('a raw INSERT inside $transaction commits with the transaction', async () => {
    const email = 'raw-commit@acme.com';
    const n = await compat.$transaction(
      async (tx: { $executeRawUnsafe: (sql: string, ...p: unknown[]) => Promise<number> }) =>
        tx.$executeRawUnsafe('INSERT INTO app_user (email_address, display_name) VALUES ($1, $2)', email, 'RawOK'),
    );
    assert.equal(n, 1);
    const back = await compat.User.findUnique({ where: { email } });
    assert.equal(back.displayName, 'RawOK');
  });

  it('a raw read inside $transaction sees the delegate write that precedes it', async () => {
    // Only possible on the transaction's OWN connection: an uncommitted row is
    // invisible to any other connection, so a pool fallback would return 0.
    const email = 'raw-sees@acme.com';
    const seen = await compat.$transaction(
      async (tx: {
        User: { create: (a: unknown) => Promise<unknown> };
        $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<{ n: number }[]>;
      }) => {
        await tx.User.create({ data: { email, displayName: 'Uncommitted' } });
        const rows = await tx.$queryRaw`SELECT count(*)::int AS n FROM app_user WHERE email_address = ${email}`;
        return rows[0]!.n;
      },
    );
    assert.equal(seen, 1, 'the raw read ran on the transaction connection');
  });

  it('a delegate write is rolled back by a failing raw statement in the same transaction', async () => {
    const email = 'raw-fail@acme.com';
    await assert.rejects(
      () =>
        compat.$transaction(
          async (tx: {
            User: { create: (a: unknown) => Promise<unknown> };
            $executeRawUnsafe: (sql: string, ...p: unknown[]) => Promise<number>;
          }) => {
            await tx.User.create({ data: { email, displayName: 'Doomed' } });
            // Duplicate email → unique violation aborts the transaction.
            await tx.$executeRawUnsafe('INSERT INTO app_user (email_address) VALUES ($1)', 'a@acme.com');
          },
        ),
      // The statement itself must be what fails. A bare `rejects` also passes
      // when `tx.$executeRawUnsafe` is undefined (TypeError), which rolls the
      // transaction back for the wrong reason and proves nothing about raw SQL.
      (e: unknown) => e instanceof TurbineError && e.code === TurbineErrorCode.UNIQUE_VIOLATION,
    );
    const gone = await compat.User.findUnique({ where: { email } });
    assert.equal(gone, null, 'the delegate write rolled back too');
  });
});

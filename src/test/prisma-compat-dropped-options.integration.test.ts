/**
 * prisma-compat, the nested-option refusals and one-name field lists, measured
 * against a live PostgreSQL backend with the numbers the unit test cannot see.
 *
 * The unit test shows what reaches core. This one shows the ANSWER: a filtered
 * relation count must never come back as the unfiltered number, `distinct`
 * written as one name must dedupe, `groupBy({ by: 'field' })` must group, a
 * single-object `createMany` must insert a row, and the array form of
 * `$transaction(queries, options)` must open the transaction at the isolation
 * level it was asked for (read off the `BEGIN` the server was sent).
 *
 * Requires DATABASE_URL (seeded with src/test/fixtures/seed.sql).
 * Run: npx tsx --test src/test/prisma-compat-dropped-options.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { introspect } from '../introspect.js';
import type { PgCompatPool, PgCompatPoolClient } from '../pg-types.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import type { PrismaCompatMap } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const gate = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const { it, before, after } = gate;

// biome-ignore lint/suspicious/noExplicitAny: the compat surface is intentionally loose
type Any = any;

const MAP: PrismaCompatMap = {
  enums: {},
  models: {
    User: {
      table: 'users',
      accessor: 'users',
      fields: { id: 'id', email: 'email', name: 'name', orgId: 'orgId' },
      relations: { posts: { name: 'posts', cardinality: 'many' } },
      compoundUniques: {},
    },
    Post: {
      table: 'posts',
      accessor: 'posts',
      fields: { id: 'id', userId: 'userId', title: 'title', published: 'published' },
      relations: { user: { name: 'user', cardinality: 'one' } },
      compoundUniques: {},
    },
    Organization: {
      table: 'organizations',
      accessor: 'organizations',
      fields: { id: 'id', name: 'name', slug: 'slug', plan: 'plan' },
      relations: {},
      compoundUniques: {},
    },
  },
};

describe('prisma-compat, dropped options against a live database', () => {
  let pool: pg.Pool;
  let db: TurbineClient;
  let compat: Any;
  /** Every statement sent on a CHECKED-OUT connection (transactions), in order. */
  const sent: string[] = [];

  before(async () => {
    const schema = await introspect({ connectionString: DATABASE_URL! });
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 3 });
    const recording: PgCompatPool = {
      query: (text, values) => pool.query(text, values as unknown[]) as Any,
      end: async () => {},
      connect: async (): Promise<PgCompatPoolClient> => {
        const client = await pool.connect();
        return {
          query: ((text: string, values?: unknown[]) => {
            sent.push(text);
            return client.query(text, values);
          }) as Any,
          release: (err) => client.release(err as Any),
        };
      },
    };
    db = new TurbineClient({ pool: recording, warnOnUnlimited: false }, schema);
    compat = createPrismaCompatClient(db, MAP);
  });

  after(async () => {
    await pool.end();
  });

  it('a filtered relation count is refused, and the unfiltered one is still the true total', async () => {
    const total = await db.table('posts').count({ where: { userId: 1 } });
    const published = await db.table('posts').count({ where: { userId: 1, published: true } });
    assert.ok(published < total, 'the fixture must make the filtered and unfiltered numbers differ');

    const unfiltered = await compat.user.findUnique({
      where: { id: 1 },
      select: { id: true, _count: { select: { posts: true } } },
    });
    // An external pool keeps the driver's own int8 reading (a string), so only the count is compared.
    assert.deepEqual(unfiltered._count, { posts: total });

    await assert.rejects(
      compat.user.findUnique({
        where: { id: 1 },
        select: { id: true, _count: { select: { posts: { where: { published: true } } } } },
      }),
      /filtered relation count.*prisma\.post\.count/s,
    );
  });

  it('a misspelled `_count` is refused instead of counting nothing or everything', async () => {
    await assert.rejects(
      compat.user.findMany({ where: { id: 1 }, select: { id: true, _count: { select: { postz: true } } } }),
      /unknown relation "postz".*Did you mean "posts"\?/s,
    );
    await assert.rejects(
      compat.user.findMany({ where: { id: 1 }, select: { id: true, _count: { selec: { posts: true } } } }),
      /unknown key "selec" in `_count`/,
    );
  });

  it('nested `distinct` is refused, and a nested typo is not an unfiltered include', async () => {
    await assert.rejects(
      compat.user.findUnique({ where: { id: 1 }, include: { posts: { distinct: ['published'] } } }),
      /distinct on a nested relation include/,
    );
    await assert.rejects(
      compat.user.findUnique({ where: { id: 1 }, include: { posts: { wher: { published: true } } } }),
      /unknown option "wher".*Did you mean "where"\?/s,
    );
  });

  it('`distinct: "field"` dedupes exactly like the array spelling', async () => {
    const ids = (rows: { id: number }[]) => rows.map((r) => Number(r.id));
    const all = ids(await compat.post.findMany({ where: { userId: 1 }, orderBy: { id: 'asc' } }));
    const asArray = ids(
      await compat.post.findMany({ where: { userId: 1 }, distinct: ['published'], orderBy: { id: 'asc' } }),
    );
    const asName = ids(
      await compat.post.findMany({ where: { userId: 1 }, distinct: 'published', orderBy: { id: 'asc' } }),
    );
    assert.ok(asArray.length < all.length, 'the fixture must contain duplicates on `published`');
    assert.deepEqual(asName, asArray);
  });

  it('groupBy `by: "field"` groups exactly like the array spelling', async () => {
    const asArray = await compat.post.groupBy({ by: ['published'], _count: true, orderBy: { published: 'asc' } });
    const asName = await compat.post.groupBy({ by: 'published', _count: true, orderBy: { published: 'asc' } });
    assert.ok(asArray.length >= 2);
    assert.deepEqual(asName, asArray);
    await assert.rejects(compat.post.groupBy({ _count: true }), /requires `by`/);
  });

  it('createMany with one row object inserts that row (and is rolled back here)', async () => {
    const sentinel = new Error('roll back');
    const slug = `compat-dropped-${Date.now()}`;
    let inside = -1;
    let before = -1;
    await assert.rejects(
      compat.$transaction(async (tx: Any) => {
        before = await tx.organization.count({ where: { slug } });
        const res = await tx.organization.createMany({ data: { name: 'One row', slug } });
        assert.deepEqual(res, { count: 1 });
        inside = await tx.organization.count({ where: { slug } });
        throw sentinel;
      }),
      (err: unknown) => err === sentinel,
    );
    assert.equal(before, 0);
    assert.equal(inside, 1, 'a single row object used to insert nothing and report count: 0');
    assert.equal(await db.table('organizations').count({ where: { slug } }), 0, 'the transaction rolled back');
  });

  it('the array form of $transaction runs at the isolation level it was given', async () => {
    sent.length = 0;
    await compat.$transaction(
      [compat.user.findMany({ where: { id: 1 } }), compat.post.count({ where: { userId: 1 } })],
      {
        isolationLevel: 'Serializable',
      },
    );
    const begin = sent.find((s) => /^BEGIN/i.test(s));
    assert.ok(begin, `no BEGIN was sent; saw ${sent.join(' | ')}`);
    assert.match(begin, /ISOLATION LEVEL SERIALIZABLE/i);

    sent.length = 0;
    await compat.$transaction([compat.user.findMany({ where: { id: 1 } })]);
    assert.doesNotMatch(sent.find((s) => /^BEGIN/i.test(s)) ?? '', /ISOLATION/i, 'no options means the default level');
  });

  it('a misspelled transaction option rejects before any BEGIN is sent', async () => {
    sent.length = 0;
    await assert.rejects(
      compat.$transaction([compat.user.findMany({ where: { id: 1 } })], { isolationLevl: 'Serializable' }),
      /unknown \$transaction option "isolationLevl".*Did you mean "isolationLevel"\?/s,
    );
    assert.deepEqual(sent, []);
  });
});

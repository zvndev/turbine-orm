/**
 * turbine-orm/prisma-compat — DB-less translation + reshaping tests.
 *
 * Two harnesses over one fixture (a `@@map` divergence — Prisma `User.email` →
 * column `email_address` — plus a compound `@@unique`, a to-one and a to-many
 * relation):
 *   - `sqlDb()` backs each model with a real `makeQuery` QueryInterface, so a
 *     delegate's lazy `build*` produces real SQL to assert against.
 *   - `spyDb()` records the translated Turbine args each `build*` receives and
 *     returns canned Turbine-shaped rows, so arg translation, result reshaping,
 *     `$transaction` batching, and raw SQL can be asserted without a database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TurbineError, TurbineErrorCode } from '../errors.js';
import {
  COMPAT_DEFERRED,
  type CompatTurbineClient,
  createPrismaCompatClient,
  Prisma,
  type PrismaCompatOptions,
} from '../prisma-compat.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** Concrete per-model type bundles so `compat.User` etc. are typed (not optional). */
type Models = {
  User: { Row: { id: number; email: string; name: string } };
  Post: { Row: { id: number; title: string; authorId: number } };
  Membership: { Row: { id: number; orgId: number; userId: number; role: string } };
};

/** Typed compat-client factory used throughout the tests. */
function mkCompat(db: CompatTurbineClient, map: PrismaCompatMap, opts?: PrismaCompatOptions) {
  // The stubs satisfy the narrow surface the adapter uses; cast to the real
  // client param type the public factory declares.
  return createPrismaCompatClient<Models>(db as unknown as TurbineClient, map, opts);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function fixture(): { schema: SchemaMetadata; map: PrismaCompatMap } {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email_address', field: 'emailAddress', pgType: 'text' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  users.primaryKey = ['id'];
  users.uniqueColumns = [['id'], ['email_address']];
  users.relations = {
    posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'author_id', referenceKey: 'id' },
  };

  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'author_id', field: 'authorId' },
  ]);
  posts.primaryKey = ['id'];
  posts.relations = {
    author: {
      type: 'belongsTo',
      name: 'author',
      from: 'posts',
      to: 'users',
      foreignKey: 'author_id',
      referenceKey: 'id',
    },
  };

  const memberships = mockTable('memberships', [
    { name: 'id', field: 'id' },
    { name: 'org_id', field: 'orgId' },
    { name: 'user_id', field: 'userId' },
    { name: 'role', field: 'role', pgType: 'text' },
  ]);
  memberships.primaryKey = ['id'];
  memberships.uniqueColumns = [['id'], ['org_id', 'user_id']];

  const schema: SchemaMetadata = { enums: {}, tables: { users, posts, memberships } };

  const map: PrismaCompatMap = {
    enums: {},
    models: {
      User: {
        table: 'users',
        accessor: 'users',
        // Prisma `email` diverges from turbine field `emailAddress`.
        fields: { id: 'id', email: 'emailAddress', name: 'name' },
        relations: { posts: { name: 'posts', cardinality: 'many' } },
        compoundUniques: {},
      },
      Post: {
        table: 'posts',
        accessor: 'posts',
        fields: { id: 'id', title: 'title', authorId: 'authorId' },
        relations: { author: { name: 'author', cardinality: 'one' } },
        compoundUniques: {},
      },
      Membership: {
        table: 'memberships',
        accessor: 'memberships',
        fields: { id: 'id', orgId: 'orgId', userId: 'userId', role: 'role' },
        relations: {},
        // Default Prisma selector name AND a custom `@@unique(name: "org_user")`.
        compoundUniques: { orgId_userId: ['orgId', 'userId'], org_user: ['orgId', 'userId'] },
      },
    },
  };
  return { schema, map };
}

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

/** A client whose model ops build real SQL via `makeQuery` (null pool). */
function sqlDb(schema: SchemaMetadata): CompatTurbineClient {
  return {
    schema,
    table: (name: string) => makeQuery(name, schema) as Any,
    $transaction: (() => {
      throw new Error('sqlDb has no execution path');
    }) as Any,
  } as unknown as CompatTurbineClient;
}

interface SpyCall {
  table: string;
  method: string;
  args: Any;
}

/** A recording client: captures translated args, returns canned rows. */
function spyDb(
  schema: SchemaMetadata,
  results: Record<string, unknown> = {},
): { db: CompatTurbineClient; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const qi = (table: string): Any =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (args: Any) => {
            calls.push({ table, method: prop, args });
            if (prop.startsWith('build')) {
              return {
                sql: `SQL:${table}.${prop}`,
                params: [],
                transform: () => results[`${table}.result`] ?? {},
                tag: prop,
              };
            }
            const key = `${table}.${prop}`;
            if (key in results) return Promise.resolve(results[key]);
            if (prop === 'count') return Promise.resolve(0);
            if (/Many$/.test(prop) || prop === 'groupBy') return Promise.resolve([]);
            return Promise.resolve(null);
          };
        },
      },
    );
  const db = {
    schema,
    table: qi,
    pool: {
      query: async (sql: string, params: unknown[]) => ({ rows: [{ sql, params }], rowCount: 7 }),
    },
    dialect: { paramPlaceholder: (n: number) => `$${n}` },
    $transaction: (arg: Any, _opts?: Any) => {
      if (Array.isArray(arg)) {
        // Return each deferred's transformed (canned) result.
        return Promise.resolve(arg.map((d: Any) => d.transform(null)));
      }
      return arg({ table: qi });
    },
  };
  return { db: db as unknown as CompatTurbineClient, calls };
}

/** Pull the lazy batchable and build the underlying Turbine args/DeferredQuery. */
function built(p: unknown): { sql: string; params: unknown[]; tag: string } {
  return (p as Any)[COMPAT_DEFERRED].build();
}
/** The translated Turbine args a spy delegate produced for its last build. */
function lastArgs(calls: SpyCall[]): Any {
  return calls[calls.length - 1]!.args;
}

// ---------------------------------------------------------------------------
// Field / relation name translation
// ---------------------------------------------------------------------------

describe('prisma-compat — field renaming (@@map divergence)', () => {
  it('renames a where field to its turbine column in real SQL', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(sqlDb(schema), map);
    const q = built(compat.User.findMany({ where: { email: { contains: 'acme' } } }));
    assert.match(q.sql, /"email_address"/);
    assert.doesNotMatch(q.sql, /"email"\b/);
  });

  it('translates a Prisma include into a Turbine with (relation subquery present)', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.User.findMany({ include: { posts: { where: { title: 'x' }, orderBy: { title: 'asc' }, take: 3 } } }));
    const args = lastArgs(calls);
    assert.ok(args.with?.posts, 'relation moved under with');
    assert.equal(args.with.posts.limit, 3, 'take → limit');
    assert.deepEqual(args.with.posts.where, { title: 'x' });
    assert.deepEqual(args.with.posts.orderBy, { title: 'asc' });
    assert.equal(args.select, undefined, 'include keeps all scalars');
  });

  it('splits a Prisma select into scalar select + relation with', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.User.findMany({ select: { email: true, posts: true } }));
    const args = lastArgs(calls);
    assert.deepEqual(args.select, { emailAddress: true }, 'scalar renamed');
    assert.deepEqual(args.with, { posts: true }, 'relation moved to with');
  });
});

// ---------------------------------------------------------------------------
// Pagination: take / skip / cursor
// ---------------------------------------------------------------------------

describe('prisma-compat — take/skip', () => {
  it('maps take→limit and skip→offset with no cursor', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.User.findMany({ take: 10, skip: 20 }));
    const args = lastArgs(calls);
    assert.equal(args.limit, 10);
    assert.equal(args.offset, 20);
    assert.equal(args.cursor, undefined);
  });

  it('throws on negative take (no reverse-take in Turbine)', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    assert.throws(() => built(compat.User.findMany({ take: -5 })), /negative take/);
  });
});

describe('prisma-compat — cursor translation', () => {
  it('cursor + skip:1 → exclusive cursor + offset 0 (idiomatic exact match)', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.Post.findMany({ cursor: { id: 100 }, skip: 1, take: 5, orderBy: { id: 'asc' } }));
    const args = lastArgs(calls);
    assert.deepEqual(args.cursor, { id: 100 });
    assert.equal(args.offset, 0);
    assert.equal(args.limit, 5);
  });

  it('cursor + skip:3 → exclusive cursor + offset 2', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.Post.findMany({ cursor: { id: 100 }, skip: 3, orderBy: { id: 'asc' } }));
    const args = lastArgs(calls);
    assert.deepEqual(args.cursor, { id: 100 });
    assert.equal(args.offset, 2);
  });

  it('bare inclusive cursor on the single-column PK (no orderBy) → gte keyset merged into where', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.Post.findMany({ cursor: { id: 100 } }));
    const args = lastArgs(calls);
    assert.equal(args.cursor, undefined, 'no exclusive cursor for inclusive form');
    assert.deepEqual(args.where, { id: { gte: 100 } });
    assert.deepEqual(args.orderBy, { id: 'asc' });
  });

  it('bare inclusive cursor whose field IS the single orderBy field → gte (asc) / lte (desc)', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.Post.findMany({ cursor: { id: 100 }, orderBy: { id: 'desc' } }));
    assert.deepEqual(lastArgs(calls).where, { id: { lte: 100 } });
  });

  it('bare inclusive cursor whose field renames through the map still keysets correctly', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    // Prisma cursor field `email` → turbine `emailAddress`; matching orderBy.
    built(compat.User.findMany({ cursor: { email: 'z@x.com' }, orderBy: { email: 'asc' } }));
    assert.deepEqual(lastArgs(calls).where, { emailAddress: { gte: 'z@x.com' } });
  });

  it('THROWS when a bare inclusive cursor field is not the sort key (avoids a wrong page)', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    assert.throws(
      () => built(compat.Post.findMany({ cursor: { id: 100 }, orderBy: { title: 'asc' } })),
      /cursor field .* single orderBy field|not the sort key/,
    );
  });

  it('THROWS when a bare inclusive cursor field is not the PK and no orderBy is given', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    assert.throws(() => built(compat.Post.findMany({ cursor: { title: 'x' } })), /primary key|single orderBy/);
  });
});

// ---------------------------------------------------------------------------
// Compound unique
// ---------------------------------------------------------------------------

describe('prisma-compat — compound unique selectors', () => {
  it('default selector name compiles to the column conjunction (via core expansion)', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(sqlDb(schema), map);
    const q = built(compat.Membership.findUnique({ where: { orgId_userId: { orgId: 1, userId: 2 } } }));
    assert.match(q.sql, /"org_id" = \$1 AND "user_id" = \$2/);
    assert.deepEqual(q.params, [1, 2]);
  });

  it('custom @@unique(name:) selector is translated to the core selector form and expands', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(sqlDb(schema), map);
    const q = built(compat.Membership.findUnique({ where: { org_user: { orgId: 5, userId: 9 } } }));
    assert.match(q.sql, /"org_id" = \$1 AND "user_id" = \$2/);
    assert.deepEqual(q.params, [5, 9]);
  });
});

// ---------------------------------------------------------------------------
// Nested relation include: unsupported offset
// ---------------------------------------------------------------------------

describe('prisma-compat — nested include limits', () => {
  it('throws on skip inside a nested relation include (no offset in with)', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    assert.throws(
      () => built(compat.User.findMany({ include: { posts: { skip: 2 } } })),
      /skip \(offset\) on a nested relation/,
    );
  });
});

// ---------------------------------------------------------------------------
// Result reshaping
// ---------------------------------------------------------------------------

describe('prisma-compat — result reshaping', () => {
  it('renames turbine field keys back to Prisma names on read', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema, { 'users.findMany': [{ id: 1, emailAddress: 'a@b.com', name: 'A' }] });
    const compat = mkCompat(db, map);
    const rows = await compat.User.findMany({});
    assert.deepEqual(rows, [{ id: 1, email: 'a@b.com', name: 'A' }]);
  });

  it('unwraps a to-one relation array to object|null when the map says cardinality one', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema, {
      'posts.findMany': [
        { id: 1, title: 'T', author: [{ id: 9, emailAddress: 'a@b.com' }] },
        { id: 2, title: 'U', author: [] },
      ],
    });
    const compat = mkCompat(db, map);
    const rows = (await compat.Post.findMany({ include: { author: true } })) as Any[];
    assert.deepEqual(rows[0].author, { id: 9, email: 'a@b.com' }, 'first element, nested reshape');
    assert.equal(rows[1].author, null, 'empty to-one → null');
  });

  it('keeps a to-many relation as an array', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema, { 'users.findMany': [{ id: 1, posts: [{ id: 5, title: 'p' }] }] });
    const compat = mkCompat(db, map);
    const rows = (await compat.User.findMany({ include: { posts: true } })) as Any[];
    assert.deepEqual(rows[0].posts, [{ id: 5, title: 'p' }]);
  });

  it('keys _count back to Prisma relation names (with _all passthrough)', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema, { 'users.findMany': [{ id: 1, _count: { posts: 3, _all: 3 } }] });
    const compat = mkCompat(db, map);
    const rows = (await compat.User.findMany({ include: { _count: { select: { posts: true } } } })) as Any[];
    assert.deepEqual(rows[0]._count, { posts: 3, _all: 3 });
  });
});

// ---------------------------------------------------------------------------
// Aggregate / groupBy
// ---------------------------------------------------------------------------

describe('prisma-compat — aggregate / groupBy', () => {
  it('passes _count { _all: true } through and renames _sum field keys', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.Membership.aggregate({ _count: { _all: true }, _sum: { orgId: true }, where: { role: 'admin' } }));
    const args = lastArgs(calls);
    assert.deepEqual(args._count, { _all: true });
    assert.deepEqual(args._sum, { orgId: true });
    assert.deepEqual(args.where, { role: 'admin' });
  });

  it('groupBy renames by[] fields and maps take/skip', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.User.groupBy({ by: ['email'], _count: { _all: true }, take: 5, skip: 2 }));
    const args = lastArgs(calls);
    assert.deepEqual(args.by, ['emailAddress']);
    assert.equal(args.limit, 5);
    assert.equal(args.offset, 2);
  });

  it('reshapes aggregate result field keys back to Prisma names', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema, { 'users.aggregate': { _count: { _all: 4 }, _max: { emailAddress: 'z' } } });
    const compat = mkCompat(db, map);
    const res = (await compat.User.aggregate({ _count: { _all: true }, _max: { email: true } })) as Any;
    assert.deepEqual(res, { _count: { _all: 4 }, _max: { email: 'z' } });
  });
});

// ---------------------------------------------------------------------------
// Writes + createMany skipDuplicates
// ---------------------------------------------------------------------------

describe('prisma-compat — writes', () => {
  it('createMany maps skipDuplicates onto the core option and returns { count }', async () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema, { 'users.createMany': [{ id: 1 }, { id: 2 }] });
    const compat = mkCompat(db, map);
    const res = await compat.User.createMany({ data: [{ email: 'a' }, { email: 'b' }], skipDuplicates: true });
    assert.deepEqual(res, { count: 2 });
    const call = calls.find((c) => c.method === 'createMany')!;
    assert.equal(call.args.skipDuplicates, true);
    assert.deepEqual(call.args.data, [{ emailAddress: 'a' }, { emailAddress: 'b' }], 'row fields renamed');
  });

  it('translates a nested create relation write to the turbine relation name', async () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema, { 'users.result': { id: 1, emailAddress: 'a' } });
    const compat = mkCompat(db, map);
    built(compat.User.create({ data: { email: 'a', posts: { create: [{ title: 't' }] } } }));
    const call = calls.find((c) => c.method === 'buildCreate')!;
    assert.equal(call.args.data.emailAddress, 'a');
    assert.deepEqual(call.args.data.posts, { create: [{ title: 't' }] });
  });

  it('update translates where + data', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.User.update({ where: { email: 'a@b.com' }, data: { name: 'New' } }));
    const args = lastArgs(calls);
    assert.deepEqual(args.where, { emailAddress: 'a@b.com' });
    assert.deepEqual(args.data, { name: 'New' });
  });

  it('deleteMany with no where opts into the full-table-scan flag', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.User.deleteMany());
    assert.equal(lastArgs(calls).allowFullTableScan, true);
  });
});

// ---------------------------------------------------------------------------
// Laziness + $transaction + build* contract
// ---------------------------------------------------------------------------

describe('prisma-compat — laziness + $transaction', () => {
  it('a delegate call does not execute until awaited (Prisma-style lazy promise)', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    compat.User.findMany({ where: { email: 'x' } }); // not awaited
    assert.equal(calls.length, 0, 'no query ran');
  });

  it('exposes the underlying DeferredQuery via COMPAT_DEFERRED for batching', () => {
    const { schema, map } = fixture();
    const compat = mkCompat(sqlDb(schema), map);
    const p = compat.User.findMany({});
    const b = (p as Any)[COMPAT_DEFERRED];
    assert.ok(b, 'batchable present');
    const dq = b.build();
    assert.equal(typeof dq.sql, 'string');
    assert.ok(Array.isArray(dq.params));
    assert.equal(typeof dq.transform, 'function');
  });

  it('$transaction([...]) batches lazy calls through the core batch path and reshapes each', async () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema, {
      'users.result': { id: 1, emailAddress: 'a@b.com' },
      'posts.result': { id: 9, title: 'p' },
    });
    const compat = mkCompat(db, map);
    const [u, p] = await compat.$transaction([
      compat.User.create({ data: { email: 'a@b.com' } }),
      compat.Post.create({ data: { title: 'p' } }),
    ]);
    assert.deepEqual(u, { id: 1, email: 'a@b.com' }, 'user reshaped');
    assert.deepEqual(p, { id: 9, title: 'p' });
    // Both were built (lazy) — the async create() path never ran.
    assert.ok(calls.some((c) => c.method === 'buildCreate' && c.table === 'users'));
    assert.ok(!calls.some((c) => c.method === 'create'));
  });

  it('$transaction([...]) rejects a non-lazy item with a clear error', async () => {
    const { schema, map } = fixture();
    const compat = mkCompat(spyDb(schema).db, map);
    await assert.rejects(() => compat.$transaction([Promise.resolve(1) as Any]), /not a lazy model call/);
  });

  it('$transaction(callback) hands a compat-wrapped tx client', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema, { 'users.findMany': [{ id: 1, emailAddress: 'a@b.com' }] });
    const compat = mkCompat(db, map);
    const out = await compat.$transaction(async (tx) => tx.User.findMany({}));
    assert.deepEqual(out, [{ id: 1, email: 'a@b.com' }]);
  });
});

// ---------------------------------------------------------------------------
// build* public-contract pin (RESOLUTIONS: guard the QueryInterface seam)
// ---------------------------------------------------------------------------

describe('prisma-compat — QueryInterface build* contract', () => {
  it('every build* method the adapter depends on exists and returns a DeferredQuery', () => {
    const { schema } = fixture();
    const qi = makeQuery('users', schema) as Any;
    const methods = [
      'buildFindMany',
      'buildFindFirst',
      'buildFindUnique',
      'buildFindFirstOrThrow',
      'buildFindUniqueOrThrow',
      'buildCreate',
      'buildCreateMany',
      'buildUpdate',
      'buildUpdateMany',
      'buildDelete',
      'buildDeleteMany',
      'buildUpsert',
      'buildCount',
      'buildAggregate',
      'buildGroupBy',
    ];
    for (const m of methods) {
      assert.equal(typeof qi[m], 'function', `${m} is a public method`);
    }
    const dq = qi.buildFindMany({});
    assert.ok('sql' in dq && 'params' in dq && 'transform' in dq && 'tag' in dq, 'DeferredQuery shape');
  });
});

// ---------------------------------------------------------------------------
// Raw SQL
// ---------------------------------------------------------------------------

describe('prisma-compat — raw SQL', () => {
  it('$queryRaw flattens a template, parameterizes values, returns rows', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map);
    const id = 42;
    const rows = (await compat.$queryRaw`SELECT * FROM users WHERE id = ${id}`) as Any[];
    assert.equal(rows[0].sql, 'SELECT * FROM users WHERE id = $1');
    assert.deepEqual(rows[0].params, [42]);
  });

  it('$queryRaw flattens nested Prisma.sql fragments with correct placeholder numbering', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map);
    const cond = Prisma.sql`id = ${1} AND name = ${'x'}`;
    const rows = (await compat.$queryRaw`SELECT * FROM users WHERE ${cond} LIMIT ${10}`) as Any[];
    assert.equal(rows[0].sql, 'SELECT * FROM users WHERE id = $1 AND name = $2 LIMIT $3');
    assert.deepEqual(rows[0].params, [1, 'x', 10]);
  });

  it('$executeRaw returns the affected row count', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map);
    const n = await compat.$executeRaw`UPDATE users SET name = ${'y'}`;
    assert.equal(n, 7);
  });

  it('$queryRawUnsafe forwards sql + params verbatim', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map);
    const rows = (await compat.$queryRawUnsafe('SELECT $1::int AS n', 5)) as Any[];
    assert.equal(rows[0].sql, 'SELECT $1::int AS n');
    assert.deepEqual(rows[0].params, [5]);
  });
});

// ---------------------------------------------------------------------------
// Options: stablePkOrder + prismaErrorCodes
// ---------------------------------------------------------------------------

describe('prisma-compat — options', () => {
  it('stablePkOrder passes through the core stableRelationOrder flag (no tree walking)', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map, { stablePkOrder: true });
    built(compat.User.findMany({ include: { posts: true } }));
    assert.equal(lastArgs(calls).stableRelationOrder, true);
  });

  it('stablePkOrder off leaves the flag unset', () => {
    const { schema, map } = fixture();
    const { db, calls } = spyDb(schema);
    const compat = mkCompat(db, map);
    built(compat.User.findMany({}));
    assert.equal(lastArgs(calls).stableRelationOrder, undefined);
  });

  it('prismaErrorCodes decorates a thrown TurbineError with the Prisma code', async () => {
    const { schema, map } = fixture();
    const err = new TurbineError(TurbineErrorCode.UNIQUE_VIOLATION, 'dup');
    const { db } = spyDb(schema);
    (db as Any).table = () => ({
      findMany: () => Promise.reject(err),
      buildFindMany: () => ({ sql: '', params: [], transform: () => ({}), tag: '' }),
    });
    const compat = mkCompat(db, map, { prismaErrorCodes: true });
    await assert.rejects(
      () => compat.User.findMany({}) as Promise<unknown>,
      (e: Any) => e.code === 'P2002',
    );
  });
});

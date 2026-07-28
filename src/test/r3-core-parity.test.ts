/**
 * Round-3 cross-surface parity tests.
 *
 * Three fixes whose defect shape was identical: a correctness rule applied to
 * one engine / one operation and not to its siblings, which is worse than not
 * applying it at all because the working sibling is evidence the rule holds
 * everywhere.
 *
 *  1. orderBy direction validation on the PowDB engine (core refused a bad
 *     token, PowQL silently emitted `asc`).
 *  2. prisma-compat `omit` on the four write operations (honoured on reads,
 *     silently dropped on create / update / delete / upsert).
 *  3. `pool.connect()` checkouts in query/builder.ts that were outside the
 *     try, so a connection-time pg error escaped unwrapped.
 *  4. `skipGlobalFilters: [UNSAFE]` (sentinel, no table names) was a silent
 *     no-op.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { ConnectionError, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { ALL_POWDB_CAPABILITIES, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { type CompatTurbineClient, createPrismaCompatClient } from '../prisma-compat.js';
import { QueryInterface } from '../query/builder.js';
import { resolveSkipGlobalFilters, UNSAFE } from '../query/types.js';
import type { ColumnMetadata, PrismaCompatMap, SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Minimal PowDB fixture
// ---------------------------------------------------------------------------

function col(name: string, field: string, tsType: string, pgType: string, opts: Partial<ColumnMetadata> = {}) {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: '', ...opts };
}

function table(name: string, columns: ColumnMetadata[], pk: string[] = ['id']): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set<string>(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: pk,
    uniqueColumns: [pk],
    relations: {},
    indexes: [],
  };
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    app_user: table('app_user', [
      col('id', 'id', 'string', 'text', { hasDefault: true }),
      col('name', 'name', 'string', 'text'),
      col('age', 'age', 'number', 'int4', { nullable: true }),
      col('data', 'data', 'Record<string, unknown>', 'jsonb', { nullable: true }),
    ]),
  },
};

function mockPool() {
  const calls: { powql: string; params: unknown[] }[] = [];
  const pool = {
    capabilities: ALL_POWDB_CAPABILITIES,
    retryStaleReads: false,
    readonly: false,
    query(powql: string, params: unknown[]) {
      calls.push({ powql, params });
      return Promise.resolve({ rows: [{ id: '1' }], rowCount: 1 });
    },
  } as unknown as PowdbPool;
  return { pool, calls, last: () => calls[calls.length - 1]! };
}

function qi(mock: ReturnType<typeof mockPool>) {
  return new PowqlInterface(mock.pool, 'app_user', schema, [], { warnOnUnlimited: false });
}

// ---------------------------------------------------------------------------
// 1. PowDB orderBy direction parity with core
// ---------------------------------------------------------------------------

describe('R3: PowDB orderBy direction validation', () => {
  // The original finding: each of these emitted `order .name asc`.
  for (const bad of ['descending', 'DES', '', 'ascending', null, 1, true] as unknown[]) {
    it(`refuses direction ${JSON.stringify(bad)} instead of silently sorting asc`, async () => {
      await assert.rejects(
        () => qi(mockPool()).findMany({ orderBy: { name: bad } as never }),
        (e: unknown) => e instanceof ValidationError && /Invalid orderBy direction/.test((e as Error).message),
      );
    });
  }

  it("honours 'DESC' the same way core does (uppercase is valid, not a silent asc)", async () => {
    const mock = mockPool();
    await qi(mock).findMany({ orderBy: { name: 'DESC' } as never });
    assert.match(mock.last().powql, /order \.name desc/);
  });

  it("still emits asc for 'ASC' and desc for 'desc'", async () => {
    const a = mockPool();
    await qi(a).findMany({ orderBy: { name: 'ASC' } as never });
    assert.match(a.last().powql, /order \.name asc/);
    const d = mockPool();
    await qi(d).findMany({ orderBy: { name: 'desc' } });
    assert.match(d.last().powql, /order \.name desc/);
  });

  it('validates the OrderBySpec { sort } form', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ orderBy: { name: { sort: 'DESC' } } as never });
    assert.match(mock.last().powql, /order \.name desc/);
    await assert.rejects(
      () => qi(mockPool()).findMany({ orderBy: { name: { sort: 'descending' } } as never }),
      ValidationError,
    );
  });

  it('validates the JSON-path orderBy direction', async () => {
    const mock = mockPool();
    await qi(mock).findMany({ orderBy: { data: { path: ['k'], direction: 'DESC' } } as never });
    assert.match(mock.last().powql, /desc/);
    await assert.rejects(
      () => qi(mockPool()).findMany({ orderBy: { data: { path: ['k'], direction: 'down' } } as never }),
      ValidationError,
    );
  });

  it('validates groupBy orderBy directions', async () => {
    const mock = mockPool();
    await qi(mock).groupBy({ by: ['name'], orderBy: { name: 'DESC' } as never });
    assert.match(mock.last().powql, /order \.name desc/);
    await assert.rejects(
      () => qi(mockPool()).groupBy({ by: ['name'], orderBy: { name: 'descending' } as never }),
      ValidationError,
    );
    await assert.rejects(
      () => qi(mockPool()).groupBy({ by: ['name'], orderBy: { name: { sort: 'descending' } } as never }),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. skipGlobalFilters: [UNSAFE]
// ---------------------------------------------------------------------------

describe('R3: skipGlobalFilters sentinel-only array', () => {
  it('[UNSAFE] with no table names throws instead of silently keeping every filter', () => {
    assert.throws(
      () => resolveSkipGlobalFilters([UNSAFE]),
      (e: unknown) => e instanceof ValidationError && /names no table/.test((e as Error).message),
    );
  });

  it('bare UNSAFE still means "skip every table"', () => {
    assert.equal(resolveSkipGlobalFilters(UNSAFE), true);
  });

  it('[UNSAFE, "posts"] still resolves to the named list', () => {
    assert.deepEqual(resolveSkipGlobalFilters([UNSAFE, 'posts']), ['posts']);
  });
});

// ---------------------------------------------------------------------------
// 2. prisma-compat write projections
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

type CompatModels = {
  User: { Row: { id: number; email: string; passwordHash: string } };
};

function compatFixture() {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email_address', field: 'emailAddress', pgType: 'text' },
    { name: 'password_hash', field: 'passwordHash', pgType: 'text' },
  ]);
  users.primaryKey = ['id'];
  users.uniqueColumns = [['id']];
  users.relations = {
    posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'author_id', referenceKey: 'id' },
  };
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
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
        fields: { id: 'id', authorId: 'authorId' },
        relations: {},
        compoundUniques: {},
      },
    },
  };
  return { schema, map };
}

/** A client whose write ops return one canned turbine-shaped row. */
function compatDb(schema: SchemaMetadata): CompatTurbineClient {
  const row = { id: 1, emailAddress: 'a@b.c', passwordHash: 'secret-hash' };
  const qi = (): Any =>
    new Proxy(
      {},
      {
        get: (_t, prop: string) => (_args: Any) =>
          prop.startsWith('build') ? { sql: 'SQL', params: [], transform: () => row, tag: prop } : Promise.resolve(row),
      },
    );
  return {
    schema,
    table: qi,
    $transaction: (arg: Any) =>
      Array.isArray(arg) ? Promise.resolve(arg.map((d: Any) => d.transform(null))) : arg({ table: qi }),
  } as unknown as CompatTurbineClient;
}

function compat() {
  const { schema, map } = compatFixture();
  return createPrismaCompatClient<CompatModels>(compatDb(schema) as unknown as TurbineClient, map);
}

describe('R3: prisma-compat omit on write operations', () => {
  const cases: [string, (c: Any, extra: Any) => Promise<unknown>][] = [
    ['create', (c, extra) => c.user.create({ data: { email: 'a@b.c' }, ...extra })],
    ['update', (c, extra) => c.user.update({ where: { id: 1 }, data: { email: 'a@b.c' }, ...extra })],
    ['delete', (c, extra) => c.user.delete({ where: { id: 1 }, ...extra })],
    ['upsert', (c, extra) => c.user.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, ...extra })],
  ];

  for (const [op, call] of cases) {
    it(`${op}: \`omit\` drops the field from the returned row`, async () => {
      const row = (await call(compat(), { omit: { passwordHash: true } })) as Record<string, unknown>;
      assert.equal('passwordHash' in row, false, `${op} still returned passwordHash`);
      assert.equal(row.email, 'a@b.c');
      assert.equal(row.id, 1);
    });

    it(`${op}: no projection still returns the whole row`, async () => {
      const row = (await call(compat(), {})) as Record<string, unknown>;
      assert.deepEqual(row, { id: 1, email: 'a@b.c', passwordHash: 'secret-hash' });
    });

    it(`${op}: scalar \`select\` narrows the returned row`, async () => {
      const row = (await call(compat(), { select: { id: true } })) as Record<string, unknown>;
      assert.deepEqual(row, { id: 1 });
    });

    it(`${op}: a relation in \`select\` throws instead of returning undefined`, async () => {
      await assert.rejects(() => call(compat(), { select: { id: true, posts: true } }), UnsupportedFeatureError);
    });

    it(`${op}: \`include\` of a relation throws instead of being ignored`, async () => {
      await assert.rejects(() => call(compat(), { include: { posts: true } }), UnsupportedFeatureError);
    });

    it(`${op}: a relation in \`omit\` throws`, async () => {
      await assert.rejects(() => call(compat(), { omit: { posts: true } }), ValidationError);
    });

    it(`${op}: \`select\` + \`omit\` together throw`, async () => {
      await assert.rejects(() => call(compat(), { select: { id: true }, omit: { email: true } }), ValidationError);
    });
  }

  it('the batched $transaction([...]) array form applies the projection too', async () => {
    const c = compat() as Any;
    const [row] = (await c.$transaction([
      c.user.create({ data: { email: 'a@b.c' }, omit: { passwordHash: true } }),
    ])) as Record<string, unknown>[];
    assert.equal('passwordHash' in row!, false);
  });
});

// ---------------------------------------------------------------------------
// 3. builder.ts pool.connect() checkouts
// ---------------------------------------------------------------------------

describe('R3: builder connection checkouts wrap driver errors', () => {
  const sqlUsers = mockTable('users', [{ name: 'id', field: 'id' }]);
  sqlUsers.primaryKey = ['id'];
  sqlUsers.relations = {
    posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'author_id', referenceKey: 'id' },
  };
  const sqlPosts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'author_id', field: 'authorId' },
  ]);
  sqlPosts.primaryKey = ['id'];
  const sqlSchema: SchemaMetadata = { enums: {}, tables: { users: sqlUsers, posts: sqlPosts } };

  /** A pool whose connect() rejects the way pg does on a bad password. */
  function failingPool() {
    const err = Object.assign(new Error('password authentication failed for user "app"'), { code: '28P01' });
    return { connect: () => Promise.reject(err), query: () => Promise.reject(err) } as Any;
  }

  it('runInImplicitTx (every nested write) surfaces a typed ConnectionError', async () => {
    const qi = new QueryInterface(failingPool(), 'users', sqlSchema, []) as Any;
    await assert.rejects(
      () => qi.create({ data: { id: 1, posts: { create: [{}] } } }),
      (e: unknown) => {
        assert.ok(e instanceof ConnectionError, `expected ConnectionError, got ${(e as Error).constructor.name}`);
        assert.equal((e as ConnectionError).code, 'TURBINE_E004');
        return true;
      },
    );
  });

  it('findManyStream surfaces a typed ConnectionError', async () => {
    // The speculative fetch must SUCCEED and overflow the batch, otherwise the
    // stream never reaches the cursor checkout and the test proves nothing.
    const err = Object.assign(new Error('password authentication failed for user "app"'), { code: '28P01' });
    const pool = {
      connect: () => Promise.reject(err),
      query: () => Promise.resolve({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 }),
    } as Any;
    const qi = new QueryInterface(pool, 'users', sqlSchema, []) as Any;
    await assert.rejects(
      async () => {
        for await (const _ of qi.findManyStream({ batchSize: 1, allowFullTableScan: UNSAFE })) {
          // never reached
        }
      },
      (e: unknown) => e instanceof ConnectionError && (e as ConnectionError).code === 'TURBINE_E004',
    );
  });
});

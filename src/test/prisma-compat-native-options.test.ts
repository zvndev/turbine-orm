/**
 * turbine-orm/prisma-compat, turbine-native query options through the compat
 * surface, and the unknown-key diagnostic that keeps the surface honest.
 *
 * WHY THIS FILE EXISTS. The adapter builds a FRESH turbine args object out of
 * Prisma-shaped input and copies over the keys it recognizes. That list was
 * hand-maintained, so every core query option added after the adapter shipped
 * was accepted by the caller's type-checker and then dropped on the floor with
 * no error, no warning, and no test. `forceCustomPlan` was the instance that
 * surfaced it; `warnOnUnlimited`, `skipGlobalFilters`, `allowFullTableScan`,
 * `stableRelationOrder`, `optimisticLock`, `distinctOn` and six of the seven
 * `timeout` sites were stranded the same way.
 *
 * Every assertion here is on the args a delegate actually hands to core, driven
 * through the public delegate surface. (The wire-level proof that the option
 * then does its job lives in `prisma-compat-native-options.integration.test.ts`,
 * which reads `pg_prepared_statements`; an args-object assertion alone is the
 * layer the original bug hid behind.)
 *
 * Deliberately imports ONLY the compat exports that predate the fix, so the
 * same file can be run against the pre-fix source to show it failing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TurbineError, TurbineErrorCode } from '../errors.js';
import { type CompatTurbineClient, createPrismaCompatClient, type PrismaCompatOptions } from '../prisma-compat.js';
import { UNSAFE } from '../query/index.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

const WARN_NS_UNKNOWN_QUERY_OPTION = 'unknownQueryOption';

type Models = {
  User: { Row: { id: number; email: string; name: string; version: number } };
  Post: { Row: { id: number; title: string; authorId: number } };
};

/**
 * Fixture with a `@map` divergence on TWO fields, because the name-carrying
 * options (`optimisticLock.field`, `distinctOn.columns`) are only provably
 * translated on a model whose Prisma and turbine spellings differ.
 */
function fixture(): { schema: SchemaMetadata; map: PrismaCompatMap } {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email_address', field: 'emailAddress', pgType: 'text' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'row_version', field: 'rowVersion', pgType: 'int4' },
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

  const schema: SchemaMetadata = { enums: {}, tables: { users, posts } };
  const map: PrismaCompatMap = {
    enums: {},
    models: {
      User: {
        table: 'users',
        accessor: 'users',
        fields: { id: 'id', email: 'emailAddress', name: 'name', version: 'rowVersion' },
        relations: { posts: { name: 'posts', cardinality: 'many' } },
        compoundUniques: {},
      },
      Post: {
        table: 'posts',
        accessor: 'posts',
        fields: { id: 'id', title: 'title', authorId: 'authorId' },
        relations: {},
        compoundUniques: {},
      },
    },
  };
  return { schema, map };
}

interface SpyCall {
  table: string;
  method: string;
  args: Any;
}

/** Recording client: captures the translated turbine args each core call receives. */
function spyDb(schema: SchemaMetadata): { db: CompatTurbineClient; calls: SpyCall[] } {
  const calls: SpyCall[] = [];
  const qi = (table: string): Any =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (args: Any) => {
            calls.push({ table, method: prop, args });
            if (prop.startsWith('build')) {
              return { sql: `SQL:${table}.${prop}`, params: [], transform: () => ({}), tag: prop };
            }
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
    $transaction: (arg: Any) => (Array.isArray(arg) ? Promise.resolve([]) : arg({ table: qi })),
  };
  return { db: db as unknown as CompatTurbineClient, calls };
}

function mkCompat(db: CompatTurbineClient, map: PrismaCompatMap, opts?: PrismaCompatOptions) {
  return createPrismaCompatClient<Models>(db as unknown as TurbineClient, map, opts);
}

/** Run one delegate call and return the turbine args the named core method got. */
async function argsOf(
  call: (compat: Any) => Promise<unknown>,
  method: string,
  opts?: PrismaCompatOptions,
): Promise<Any> {
  const { schema, map } = fixture();
  const { db, calls } = spyDb(schema);
  await call(mkCompat(db, map, opts));
  const hit = calls.find((c) => c.method === method);
  assert.ok(hit, `expected a core ${method} call, saw ${calls.map((c) => c.method).join(', ') || '(none)'}`);
  return hit.args;
}

/** Capture everything written to console.warn while `fn` runs. */
async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const lines: string[] = [];
  const original = console.warn;
  console.warn = (...parts: unknown[]) => {
    lines.push(parts.join(' '));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// A. Every turbine-native option reaches core, on every operation that has it
// ---------------------------------------------------------------------------

describe('prisma-compat, turbine-native query options reach core', () => {
  it('forceCustomPlan survives findMany (the reported instance)', async () => {
    const args = await argsOf((c) => c.User.findMany({ where: { email: 'a' }, forceCustomPlan: true }), 'findMany');
    assert.equal(args.forceCustomPlan, true);
  });

  it('forceCustomPlan survives findUnique, count, aggregate and groupBy', async () => {
    assert.equal(
      (await argsOf((c) => c.User.findUnique({ where: { id: 1 }, forceCustomPlan: true }), 'findUnique'))
        .forceCustomPlan,
      true,
    );
    assert.equal((await argsOf((c) => c.User.count({ forceCustomPlan: true }), 'count')).forceCustomPlan, true);
    assert.equal(
      (await argsOf((c) => c.User.aggregate({ _count: true, forceCustomPlan: true }), 'aggregate')).forceCustomPlan,
      true,
    );
    assert.equal(
      (await argsOf((c) => c.User.groupBy({ by: ['id'], forceCustomPlan: true }), 'groupBy')).forceCustomPlan,
      true,
    );
  });

  it('warnOnUnlimited survives findMany', async () => {
    const args = await argsOf((c) => c.User.findMany({ warnOnUnlimited: false }), 'findMany');
    assert.equal(args.warnOnUnlimited, false);
  });

  it('skipGlobalFilters survives every read and every write that declares it', async () => {
    const cases: [string, (c: Any) => Promise<unknown>][] = [
      ['findMany', (c) => c.User.findMany({ skipGlobalFilters: UNSAFE })],
      ['findUnique', (c) => c.User.findUnique({ where: { id: 1 }, skipGlobalFilters: UNSAFE })],
      ['count', (c) => c.User.count({ skipGlobalFilters: UNSAFE })],
      ['aggregate', (c) => c.User.aggregate({ _count: true, skipGlobalFilters: UNSAFE })],
      ['groupBy', (c) => c.User.groupBy({ by: ['id'], skipGlobalFilters: UNSAFE })],
      ['update', (c) => c.User.update({ where: { id: 1 }, data: { name: 'x' }, skipGlobalFilters: UNSAFE })],
      ['updateMany', (c) => c.User.updateMany({ where: { id: 1 }, data: { name: 'x' }, skipGlobalFilters: UNSAFE })],
      ['delete', (c) => c.User.delete({ where: { id: 1 }, skipGlobalFilters: UNSAFE })],
      ['deleteMany', (c) => c.User.deleteMany({ where: { id: 1 }, skipGlobalFilters: UNSAFE })],
      ['upsert', (c) => c.User.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, skipGlobalFilters: UNSAFE })],
    ];
    for (const [method, call] of cases) {
      const args = await argsOf(call, method);
      assert.equal(args.skipGlobalFilters, UNSAFE, `skipGlobalFilters dropped on ${method}`);
    }
  });

  it('timeout survives every write, not just create', async () => {
    const cases: [string, (c: Any) => Promise<unknown>][] = [
      ['create', (c) => c.User.create({ data: { name: 'x' }, timeout: 11 })],
      ['createMany', (c) => c.User.createMany({ data: [{ name: 'x' }], timeout: 11 })],
      ['update', (c) => c.User.update({ where: { id: 1 }, data: { name: 'x' }, timeout: 11 })],
      ['updateMany', (c) => c.User.updateMany({ where: { id: 1 }, data: { name: 'x' }, timeout: 11 })],
      ['delete', (c) => c.User.delete({ where: { id: 1 }, timeout: 11 })],
      ['deleteMany', (c) => c.User.deleteMany({ where: { id: 1 }, timeout: 11 })],
      ['upsert', (c) => c.User.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, timeout: 11 })],
    ];
    for (const [method, call] of cases) {
      const args = await argsOf(call, method);
      assert.equal(args.timeout, 11, `timeout dropped on ${method}`);
    }
  });

  it('a per-call stableRelationOrder overrides the client-level stablePkOrder default', async () => {
    const onlyOption = await argsOf((c) => c.User.findMany({}), 'findMany', { stablePkOrder: true });
    assert.equal(onlyOption.stableRelationOrder, true);
    const overridden = await argsOf((c) => c.User.findMany({ stableRelationOrder: false }), 'findMany', {
      stablePkOrder: true,
    });
    assert.equal(overridden.stableRelationOrder, false, 'the per-call arg must win over the client default');
    const perCallOnly = await argsOf((c) => c.User.findMany({ stableRelationOrder: true }), 'findMany');
    assert.equal(perCallOnly.stableRelationOrder, true);
  });

  it('allowFullTableScan is forwarded, and compat’s implicit true still wins on a where-less mass mutation', async () => {
    const explicit = await argsOf(
      (c) => c.User.updateMany({ where: { id: 1 }, data: { name: 'x' }, allowFullTableScan: UNSAFE }),
      'updateMany',
    );
    assert.equal(explicit.allowFullTableScan, UNSAFE);
    // Prisma's where-less updateMany affects every row. An explicit `false`
    // must NOT be able to turn that parity into a thrown empty-where guard.
    const whereless = await argsOf(
      (c) => c.User.updateMany({ data: { name: 'x' }, allowFullTableScan: false }),
      'updateMany',
    );
    assert.equal(whereless.allowFullTableScan, UNSAFE);
    const del = await argsOf((c) => c.User.deleteMany({ allowFullTableScan: false }), 'deleteMany');
    assert.equal(del.allowFullTableScan, UNSAFE);
  });
});

// ---------------------------------------------------------------------------
// B. Name-carrying options are TRANSLATED, never copied
// ---------------------------------------------------------------------------

describe('prisma-compat, options whose values carry field names', () => {
  it('optimisticLock.field is renamed into turbine field space', async () => {
    const args = await argsOf(
      (c) =>
        c.User.update({ where: { id: 1 }, data: { name: 'x' }, optimisticLock: { field: 'version', expected: 3 } }),
      'update',
    );
    // Prisma `version` maps to turbine `rowVersion`; a blind passthrough would
    // send `version`, which is not a column on this model.
    assert.deepEqual(args.optimisticLock, { field: 'rowVersion', expected: 3 });
  });

  it('groupBy distinctOn columns and orderBy are renamed', async () => {
    const args = await argsOf(
      (c) =>
        c.User.groupBy({
          by: ['email'],
          distinctOn: { columns: ['email'], orderBy: { email: 'asc' } },
        }),
      'groupBy',
    );
    assert.deepEqual(args.by, ['emailAddress']);
    assert.deepEqual(args.distinctOn, { columns: ['emailAddress'], orderBy: { emailAddress: 'asc' } });
  });
});

// ---------------------------------------------------------------------------
// C. relationLoadStrategy: same key, different value domain
// ---------------------------------------------------------------------------

describe('prisma-compat, relationLoadStrategy value domains', () => {
  it("Prisma's 'query' becomes turbine's 'batched', not the join plan", async () => {
    const args = await argsOf((c) => c.User.findMany({ relationLoadStrategy: 'query' }), 'findMany');
    assert.equal(args.relationLoadStrategy, 'batched');
  });

  it("'join' and the turbine-only values pass through unchanged", async () => {
    for (const value of ['join', 'batched', 'auto', 'flatten']) {
      const args = await argsOf((c) => c.User.findMany({ relationLoadStrategy: value }), 'findMany');
      assert.equal(args.relationLoadStrategy, value);
    }
  });
});

// ---------------------------------------------------------------------------
// D. The one option that is REFUSED rather than warned about
// ---------------------------------------------------------------------------

describe('prisma-compat, row-bounded mass mutations', () => {
  const isE017 = (err: unknown) => err instanceof TurbineError && err.code === TurbineErrorCode.UNSUPPORTED_FEATURE;

  it('`limit` on updateMany throws rather than silently mutating every matching row', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    await assert.rejects(
      () => compat.User.updateMany({ where: { id: { gt: 0 } }, data: { name: 'x' }, limit: 10 }),
      isE017,
    );
  });

  it('`limit` on deleteMany throws for the same reason', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    await assert.rejects(() => compat.User.deleteMany({ where: { id: { gt: 0 } }, limit: 10 }), isE017);
  });
});

// ---------------------------------------------------------------------------
// E. The unknown-key diagnostic
// ---------------------------------------------------------------------------

describe('prisma-compat, unknown query-option warnings', () => {
  it('warns once per model.operation.key, and again after a reset', async () => {
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    const first = await captureWarnings(() => compat.User.findMany({ thisOptionDoesNotExist: true }));
    assert.equal(first.length, 1);
    assert.match(first[0]!, /unknown option "thisOptionDoesNotExist" in User\.findMany\(\), it is ignored\./);
    const second = await captureWarnings(() => compat.User.findMany({ thisOptionDoesNotExist: true }));
    assert.deepEqual(second, []);
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    const third = await captureWarnings(() => compat.User.findMany({ thisOptionDoesNotExist: true }));
    assert.equal(third.length, 1);
  });

  it('suggests the real option for a typo and for a name missing a whole word', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    const typo = await captureWarnings(() => compat.User.findMany({ forceCustomPln: true }));
    assert.match(typo[0]!, /Did you mean "forceCustomPlan"\?/);
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    const missingWord = await captureWarnings(() => compat.User.findMany({ customPlan: true }));
    assert.match(missingWord[0]!, /Did you mean "forceCustomPlan"\?/);
  });

  it('names the Prisma key for a turbine spelling instead of a fuzzy guess', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    for (const [turbineKey, prismaKey, value] of [
      ['limit', 'take', 10],
      ['offset', 'skip', 5],
      ['with', 'include', { posts: true }],
    ] as [string, string, unknown][]) {
      resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
      const lines = await captureWarnings(() => compat.User.findMany({ [turbineKey]: value }));
      assert.equal(lines.length, 1, `expected one line for ${turbineKey}`);
      assert.match(
        lines[0]!,
        new RegExp(
          `"${turbineKey}" is Turbine's spelling and is ignored here; prisma-compat takes Prisma's "${prismaKey}"`,
        ),
      );
      assert.match(lines[0]!, /\(User\.findMany\)/);
    }
  });

  it('never warns on a legitimate Prisma arg key, including the ones this adapter drops', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    // Every shape below is real Prisma. Several are deliberately IGNORED by this
    // adapter today (write projections, aggregate paging, `count({ select })`),
    // which is exactly why the known set is Prisma's surface and not the subset
    // the translator happens to read.
    const shapes: (() => Promise<unknown>)[] = [
      () =>
        compat.User.findMany({
          select: { id: true },
          where: {},
          orderBy: { id: 'asc' },
          take: 2,
          skip: 1,
          distinct: ['id'],
          relationLoadStrategy: 'join',
        }),
      () => compat.User.findMany({ include: { posts: true }, omit: { name: true } }),
      () => compat.User.findFirst({ where: {}, orderBy: { id: 'asc' }, cursor: { id: 1 }, skip: 1, take: 1 }),
      () => compat.User.findFirstOrThrow({ where: {} }),
      () => compat.User.findUnique({ where: { id: 1 }, select: { id: true }, relationLoadStrategy: 'join' }),
      () => compat.User.findUniqueOrThrow({ where: { id: 1 }, include: { posts: true } }),
      () => compat.User.create({ data: { name: 'x' }, select: { id: true }, omit: { name: true }, include: undefined }),
      () => compat.User.createMany({ data: [{ name: 'x' }], skipDuplicates: true }),
      () => compat.User.update({ where: { id: 1 }, data: { name: 'x' }, select: { id: true } }),
      () => compat.User.updateMany({ where: { id: 1 }, data: { name: 'x' } }),
      () => compat.User.delete({ where: { id: 1 }, include: { posts: true } }),
      () => compat.User.deleteMany({ where: { id: 1 } }),
      () => compat.User.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, select: { id: true } }),
      () =>
        compat.User.count({
          where: {},
          orderBy: { id: 'asc' },
          cursor: { id: 1 },
          take: 2,
          skip: 1,
          select: { _all: true },
        }),
      () =>
        compat.User.aggregate({
          where: {},
          orderBy: { id: 'asc' },
          cursor: { id: 1 },
          take: 2,
          skip: 1,
          _count: true,
          _avg: {},
          _sum: {},
          _min: {},
          _max: {},
        }),
      () =>
        compat.User.groupBy({
          by: ['id'],
          where: {},
          orderBy: { id: 'asc' },
          having: {},
          take: 2,
          skip: 1,
          _count: true,
          _avg: {},
          _sum: {},
          _min: {},
          _max: {},
        }),
    ];
    const lines = await captureWarnings(async () => {
      for (const shape of shapes) await shape().catch(() => undefined);
    });
    assert.deepEqual(lines, [], `legitimate Prisma keys must never warn, got:\n${lines.join('\n')}`);
  });

  it('never warns on a turbine-native option either', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    const lines = await captureWarnings(() =>
      compat.User.findMany({
        timeout: 5,
        includePii: UNSAFE,
        forceCustomPlan: true,
        warnOnUnlimited: false,
        skipGlobalFilters: UNSAFE,
        stableRelationOrder: true,
      }),
    );
    assert.deepEqual(lines, []);
  });

  it('never warns on a turbine-only option it hand-translates', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    const lines = await captureWarnings(async () => {
      await compat.User.update({
        where: { id: 1 },
        data: { name: 'x' },
        optimisticLock: { field: 'version', expected: 1 },
      });
      await compat.User.groupBy({ by: ['id'], distinctOn: { columns: ['id'], orderBy: { id: 'asc' } } });
    });
    assert.deepEqual(lines, []);
  });

  it('does not warn for an undefined-valued unknown key', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    const lines = await captureWarnings(() => compat.User.findMany({ nonsenseKey: undefined }));
    assert.deepEqual(lines, []);
  });

  it('does not warn in production', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const lines = await captureWarnings(() => compat.User.findMany({ definitelyNotAnOption: true }));
      assert.deepEqual(lines, []);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('a compat promise that is never awaited produces no output', async () => {
    const { schema, map } = fixture();
    const { db } = spyDb(schema);
    const compat = mkCompat(db, map) as Any;
    resetWarnOnce(WARN_NS_UNKNOWN_QUERY_OPTION);
    const lines = await captureWarnings(async () => {
      compat.User.findMany({ neverAwaitedNonsense: true });
      await new Promise((resolve) => setImmediate(resolve));
    });
    assert.deepEqual(lines, []);
  });
});

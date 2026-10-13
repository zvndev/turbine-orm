/**
 * prisma-compat: a Prisma option is translated, refused by name, or refused as
 * unknown. It is never accepted and dropped.
 *
 * Each of these used to return a plausible, wrong answer with no error:
 *
 *   - `_count: { select: { posts: { where } } }` counted EVERY post,
 *   - `_count: { selec: ... }` counted every relation, `postz` counted none,
 *   - `include: { posts: { distinct } }` returned duplicates,
 *   - `include: { posts: { wher } }` and `{ limit: 3 }` ignored the option,
 *   - `distinct: 'field'` and `groupBy({ by: 'field' })` (one name, not an array),
 *   - `createMany({ data: row })` (one row, not an array) inserted nothing,
 *   - the array form of `$transaction(queries, options)` ran at the default
 *     isolation level, and a misspelled option name did the same,
 *   - a nested write payload key the layer did not read (`update: { where, data,
 *     select }`).
 *
 * The spy client records what core receives, so "reached core" and "never
 * reached core" are both assertions about the real boundary.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { resolveDiagnostics } from '../diagnostics.js';
import { TurbineErrorCode, UnsupportedFeatureError, ValidationError } from '../errors.js';
import { CLIENT_LOG_CONTEXT, type TurbineLogger } from '../logger.js';
import { type CompatTurbineClient, createPrismaCompatClient } from '../prisma-compat.js';
import { resetWarnOnce } from '../query/warn-registry.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

interface SpyCall {
  method: string;
  args: Any;
}

/**
 * `email` is a `@map`ped field (turbine `emailAddress`), so a translated name is
 * distinguishable from one copied through.
 */
function fixture(opts: { withCommentModel?: boolean } = {}): { schema: SchemaMetadata; map: PrismaCompatMap } {
  const users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email_address', field: 'emailAddress', pgType: 'text' },
  ]);
  users.relations = {
    posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
  };
  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'is_published', field: 'isPublished', pgType: 'bool' },
    { name: 'user_id', field: 'userId' },
  ]);
  posts.relations = {
    user: { type: 'belongsTo', name: 'user', from: 'posts', to: 'users', foreignKey: 'user_id', referenceKey: 'id' },
    comments: {
      type: 'hasMany',
      name: 'comments',
      from: 'posts',
      to: 'comments',
      foreignKey: 'post_id',
      referenceKey: 'id',
    },
  };
  const comments = mockTable('comments', [
    { name: 'id', field: 'id' },
    { name: 'post_id', field: 'postId' },
    { name: 'body', field: 'body', pgType: 'text' },
  ]);
  const schema: SchemaMetadata = { enums: {}, tables: { users, posts, comments } };
  const models: PrismaCompatMap['models'] = {
    User: {
      table: 'users',
      accessor: 'users',
      fields: { id: 'id', email: 'emailAddress' },
      relations: { posts: { name: 'posts', cardinality: 'many' } },
      compoundUniques: {},
    },
    Post: {
      table: 'posts',
      accessor: 'posts',
      fields: { id: 'id', title: 'title', published: 'isPublished', userId: 'userId' },
      relations: { user: { name: 'user', cardinality: 'one' }, comments: { name: 'comments', cardinality: 'many' } },
      compoundUniques: {},
    },
  };
  if (opts.withCommentModel !== false) {
    models.Comment = {
      table: 'comments',
      accessor: 'comments',
      fields: { id: 'id', postId: 'postId', body: 'body' },
      relations: {},
      compoundUniques: {},
    };
  }
  return { schema, map: { enums: {}, models } };
}

interface Spy {
  db: CompatTurbineClient;
  calls: SpyCall[];
  txOptions: Any[];
  warnings: { message: string; code: string | undefined }[];
}

function spy(schema: SchemaMetadata): Spy {
  const calls: SpyCall[] = [];
  const txOptions: Any[] = [];
  const warnings: Spy['warnings'] = [];
  const qi = (table: string): Any =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (args: Any) => {
            calls.push({ method: `${table}.${prop}`, args });
            if (prop.startsWith('build')) return { sql: prop, params: [], tag: prop, transform: (r: Any) => r };
            if (/Many$/.test(prop) || prop === 'groupBy') return Promise.resolve([]);
            return Promise.resolve(null);
          };
        },
      },
    );
  const logger: TurbineLogger = {
    warn: (message, entry) => warnings.push({ message, code: entry.code }),
  };
  const db = {
    schema,
    table: qi,
    $transaction: (arg: Any, options?: Any) => {
      txOptions.push(options);
      if (typeof arg === 'function') return arg({ table: qi });
      return Promise.resolve((arg as unknown[]).map(() => []));
    },
    [CLIENT_LOG_CONTEXT]: { logger, diagnostics: resolveDiagnostics({ mode: 'development' }) },
  };
  return { db: db as unknown as CompatTurbineClient, calls, txOptions, warnings };
}

function client(opts: { withCommentModel?: boolean } = {}): { compat: Any } & Spy {
  const { schema, map } = fixture(opts);
  const s = spy(schema);
  return { ...s, compat: createPrismaCompatClient(s.db as unknown as TurbineClient, map) };
}

function lastArgs(calls: SpyCall[], method: string): Any {
  const hit = [...calls].reverse().find((c) => c.method === method);
  assert.ok(hit, `expected a core ${method} call, saw ${calls.map((c) => c.method).join(', ') || '(none)'}`);
  return hit.args;
}

/** The promise rejects with `ValidationError` (E003) matching `re`, and nothing reached core. */
async function refusesE003(run: () => Promise<unknown>, calls: SpyCall[], re: RegExp): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, TurbineErrorCode.VALIDATION);
    assert.match(err.message, re);
    return true;
  });
  assert.deepEqual(calls, [], 'a refused call must not reach core');
}

/** The promise rejects with `UnsupportedFeatureError` (E017) matching `re`, and nothing reached core. */
async function refusesE017(run: () => Promise<unknown>, calls: SpyCall[], re: RegExp): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof UnsupportedFeatureError, `expected UnsupportedFeatureError, got ${String(err)}`);
    assert.equal(err.code, TurbineErrorCode.UNSUPPORTED_FEATURE);
    assert.match(err.message, re);
    return true;
  });
  assert.deepEqual(calls, [], 'a refused call must not reach core');
}

describe('prisma-compat, relation counts', () => {
  it('a filtered relation count is refused (E017) in select and in include, naming the alternative', async () => {
    for (const shape of ['select', 'include'] as const) {
      const { compat, calls } = client();
      const args = {
        where: { id: 1 },
        [shape]: {
          ...(shape === 'select' ? { id: true } : {}),
          _count: { select: { posts: { where: { published: true } } } },
        },
      };
      await refusesE017(
        () => compat.User.findMany(args),
        calls,
        /filtered relation count.*posts.*prisma\.post\.count/s,
      );
    }
  });

  it('the refusal does not depend on the shape of the filter', async () => {
    for (const where of [{ published: true }, { OR: [{ title: 'a' }] }, { NOT: {} }, { AND: [] }]) {
      const { compat, calls } = client();
      await refusesE017(
        () => compat.User.findMany({ include: { _count: { select: { posts: { where } } } } }),
        calls,
        /filtered relation count/,
      );
    }
  });

  it('an unfiltered count in every spelling still reaches core as a plain count', async () => {
    const cases: [Any, Any][] = [
      [{ _count: true }, true],
      [{ _count: { select: { posts: true } } }, { posts: true }],
      [{ _count: { select: { posts: { where: {} } } } }, { posts: true }],
      [{ _count: { select: { posts: { where: { published: undefined } } } } }, { posts: true }],
      [{ _count: { select: { posts: {} } } }, { posts: true }],
      [{ _count: { select: { posts: false } } }, {}],
      [{ _count: {} }, true],
    ];
    for (const [include, expected] of cases) {
      const { compat, calls } = client();
      await compat.User.findMany({ include });
      assert.deepEqual(lastArgs(calls, 'users.findMany').with, { _count: expected }, JSON.stringify(include));
    }
  });

  it('a relation the model does not have is E003 with a suggestion, never a silent no-op', async () => {
    const { compat, calls } = client();
    await refusesE003(
      () => compat.User.findMany({ select: { id: true, _count: { select: { postz: true } } } }),
      calls,
      /unknown relation "postz".*Did you mean "posts"\?.*Relations: posts/s,
    );
  });

  it('a key other than `select` under `_count` is E003 (a misspelled `selec` counted every relation)', async () => {
    const { compat, calls } = client();
    await refusesE003(
      () => compat.User.findMany({ select: { id: true, _count: { selec: { posts: true } } } }),
      calls,
      /unknown key "selec" in `_count`.*Did you mean "select"\?/s,
    );
  });

  it('a key other than `where` under a counted relation is E003', async () => {
    const { compat, calls } = client();
    await refusesE003(
      () => compat.User.findMany({ include: { _count: { select: { posts: { wher: { published: true } } } } } }),
      calls,
      /unknown key "wher" in `_count.select.posts`.*Did you mean "where"\?/s,
    );
  });

  it('values that are not true, false, null or an object are E003', async () => {
    for (const bad of [1, 'yes', [true]]) {
      const { compat, calls } = client();
      await refusesE003(
        () => compat.User.findMany({ include: { _count: { select: { posts: bad } } } }),
        calls,
        /`_count\.select\.posts`.*takes true, false or \{ where \}/s,
      );
    }
    const { compat, calls } = client();
    await refusesE003(() => compat.User.findMany({ include: { _count: 'all' } }), calls, /`_count`.*takes true or/s);
    await refusesE003(
      () => compat.User.findMany({ include: { _count: { select: ['posts'] } } }),
      calls,
      /`_count\.select`.*takes \{ <relation>: true \}/s,
    );
  });

  it('a nested include validates its own `_count` too', async () => {
    const { compat, calls } = client();
    await refusesE003(
      () => compat.User.findMany({ include: { posts: { include: { _count: { select: { comentz: true } } } } } }),
      calls,
      /unknown relation "comentz".*Did you mean "comments"\?/s,
    );
    const c2 = client();
    await refusesE017(
      () =>
        c2.compat.User.findMany({
          include: { posts: { include: { _count: { select: { comments: { where: { body: 'x' } } } } } } },
        }),
      c2.calls,
      /filtered relation count.*comments/s,
    );
  });
});

describe('prisma-compat, options on an included relation', () => {
  it('`distinct` on a nested include is E017, whatever it names', async () => {
    for (const distinct of [['published'], 'published']) {
      const { compat, calls } = client();
      await refusesE017(
        () => compat.User.findUnique({ where: { id: 1 }, include: { posts: { distinct, orderBy: { id: 'asc' } } } }),
        calls,
        /distinct on a nested relation include \("User\.posts"\)/,
      );
    }
  });

  it('an empty `distinct` names no field, so it is not a request', async () => {
    const { compat, calls } = client();
    await compat.User.findMany({ include: { posts: { distinct: [], take: 2 } } });
    assert.deepEqual(lastArgs(calls, 'users.findMany').with, { posts: { limit: 2 } });
  });

  it('an unknown option is E003 with a suggestion', async () => {
    const { compat, calls } = client();
    await refusesE003(
      () => compat.User.findMany({ include: { posts: { wher: { published: true } } } }),
      calls,
      /unknown option "wher" in the options of relation "User\.posts".*Did you mean "where"\?/s,
    );
  });

  it("Turbine's own spellings are refused with the Prisma name", async () => {
    for (const [key, prisma] of [
      ['limit', 'take'],
      ['offset', 'skip'],
      ['with', 'include'],
    ] as const) {
      const { compat, calls } = client();
      await refusesE003(
        () => compat.User.findMany({ include: { posts: { [key]: key === 'with' ? { user: true } : 2 } } }),
        calls,
        new RegExp(`"${key}".*Turbine's spelling.*"${prisma}"`, 's'),
      );
    }
  });

  it('an `undefined` option is absent, not an unknown key', async () => {
    const { compat, calls } = client();
    await compat.User.findMany({ include: { posts: { where: undefined, bogus: undefined, take: 1 } } });
    assert.deepEqual(lastArgs(calls, 'users.findMany').with, { posts: { limit: 1 } });
  });

  it('every option that is translated still reaches core, in turbine names', async () => {
    const { compat, calls } = client();
    await compat.User.findMany({
      include: {
        posts: {
          where: { published: true },
          orderBy: { title: 'desc' },
          take: 3,
          skip: 1,
          select: { id: true, published: true },
        },
      },
    });
    assert.deepEqual(lastArgs(calls, 'users.findMany').with, {
      posts: {
        where: { isPublished: true },
        orderBy: { title: 'desc' },
        limit: 3,
        offset: 1,
        select: { id: true, isPublished: true },
      },
    });
  });

  it('a nested include, omit and _count are translated through the relation', async () => {
    const { compat, calls } = client();
    await compat.User.findMany({
      include: { posts: { omit: { published: true }, include: { comments: { take: 1 }, _count: true } } },
    });
    assert.deepEqual(lastArgs(calls, 'users.findMany').with, {
      posts: { omit: { isPublished: true }, with: { comments: { limit: 1 }, _count: true } },
    });
  });

  it('`cursor` stays E017', async () => {
    const { compat, calls } = client();
    await refusesE017(
      () => compat.User.findMany({ include: { posts: { cursor: { id: 1 } } } }),
      calls,
      /cursor on a nested relation include/,
    );
  });

  it('a value that is neither true nor an options object is E003', async () => {
    for (const bad of [1, 'yes', ['x']]) {
      const { compat, calls } = client();
      await refusesE003(
        () => compat.User.findMany({ include: { posts: bad } }),
        calls,
        /value for relation "User\.posts" must be true or an options object/,
      );
    }
  });

  it('the same checks run for a relation chosen through `select`', async () => {
    const { compat, calls } = client();
    await refusesE003(
      () => compat.User.findMany({ select: { id: true, posts: { wher: {} } } }),
      calls,
      /unknown option "wher"/,
    );
    const c2 = client();
    await refusesE017(
      () => c2.compat.User.findMany({ select: { id: true, posts: { distinct: ['title'] } } }),
      c2.calls,
      /distinct on a nested relation/,
    );
  });

  it('a projection on a relation whose model is not in the map is E003, not a dropped projection', async () => {
    const { compat, calls } = client({ withCommentModel: false });
    await refusesE003(
      () => compat.Post.findMany({ include: { comments: { omit: { body: true } } } }),
      calls,
      /relation "Post\.comments" points at a table that is not in the compat map.*cannot be translated/s,
    );
    // The relation without a projection still works: nothing is dropped.
    await compat.Post.findMany({ include: { comments: { take: 2 } } });
    assert.deepEqual(lastArgs(calls, 'posts.findMany').with, { comments: { limit: 2 } });
  });
});

describe('prisma-compat, a field list written as one name', () => {
  it('`distinct: "field"` reaches core as a one-element list, renamed', async () => {
    const { compat, calls } = client();
    await compat.Post.findMany({ distinct: 'published' });
    assert.deepEqual(lastArgs(calls, 'posts.findMany').distinct, ['isPublished']);
    await compat.Post.findMany({ distinct: ['published', 'title'] });
    assert.deepEqual(lastArgs(calls, 'posts.findMany').distinct, ['isPublished', 'title']);
  });

  it('`distinct` that is neither a name nor a list of names is E003', async () => {
    for (const bad of [5, [1], { published: true }, null, [['published']]]) {
      const { compat, calls } = client();
      await refusesE003(
        () => compat.Post.findMany({ distinct: bad }),
        calls,
        /`distinct` on model "Post" takes a field name or an array of field names/,
      );
    }
  });

  it('groupBy `by` takes one name or a list, and is required', async () => {
    const { compat, calls } = client();
    await compat.Post.groupBy({ by: 'published', _count: true });
    assert.deepEqual(lastArgs(calls, 'posts.groupBy').by, ['isPublished']);
    await compat.Post.groupBy({ by: ['published', 'userId'], _count: true });
    assert.deepEqual(lastArgs(calls, 'posts.groupBy').by, ['isPublished', 'userId']);

    const c2 = client();
    await refusesE003(
      () => c2.compat.Post.groupBy({ _count: true }),
      c2.calls,
      /groupBy on model "Post" requires `by`/,
    );
    const c3 = client();
    await refusesE003(() => c3.compat.Post.groupBy({ by: 7 }), c3.calls, /`by` on model "Post" takes a field name/);
  });

  it('groupBy take and skip are never dropped for being the wrong type', async () => {
    const { compat, calls } = client();
    await compat.Post.groupBy({ by: ['title'], take: 2, skip: 1 });
    const t = lastArgs(calls, 'posts.groupBy');
    assert.equal(t.limit, 2);
    assert.equal(t.offset, 1);
    await compat.Post.groupBy({ by: ['title'], take: '2' });
    assert.equal(lastArgs(calls, 'posts.groupBy').limit, '2', 'a non-number reaches core, which refuses it');
    const c2 = client();
    await refusesE017(() => c2.compat.Post.groupBy({ by: ['title'], take: -1 }), c2.calls, /negative take/);
  });
});

describe('prisma-compat, createMany data', () => {
  it('a single row object is one row, translated', async () => {
    const { compat, calls } = client();
    await compat.User.createMany({ data: { email: 'a@x.test' } });
    assert.deepEqual(lastArgs(calls, 'users.createMany').data, [{ emailAddress: 'a@x.test' }]);
  });

  it('an array still works, and an empty one is zero rows', async () => {
    const { compat, calls } = client();
    await compat.User.createMany({ data: [{ email: 'a' }, { email: 'b' }] });
    assert.deepEqual(lastArgs(calls, 'users.createMany').data, [{ emailAddress: 'a' }, { emailAddress: 'b' }]);
    await compat.User.createMany({ data: [] });
    assert.deepEqual(lastArgs(calls, 'users.createMany').data, []);
  });

  it('a missing or non-object `data` is E003, not "zero rows"', async () => {
    for (const bad of [undefined, null, 5, 'row']) {
      const { compat, calls } = client();
      await refusesE003(
        () => compat.User.createMany({ data: bad }),
        calls,
        /createMany on model "User" requires `data`, a row object or an array of them/,
      );
    }
  });
});

describe('prisma-compat, nested write payload keys', () => {
  const cases: [string, Any, RegExp][] = [
    [
      'update',
      { update: { where: { id: 1 }, data: { title: 'x' }, select: { id: true } } },
      /unknown key "select" in a nested update/,
    ],
    ['updateMany', { updateMany: { where: {}, data: {}, limit: 1 } }, /unknown key "limit" in a nested updateMany/],
    [
      'connectOrCreate',
      { connectOrCreate: { where: { id: 1 }, create: {}, update: {} } },
      /unknown key "update" in a nested connectOrCreate/,
    ],
    [
      'upsert',
      { upsert: { where: { id: 1 }, create: {}, updat: {} } },
      /unknown key "updat" in a nested upsert.*Did you mean "update"\?/s,
    ],
  ];
  for (const [name, ops, re] of cases) {
    it(`an unread key in a nested ${name} is E003`, async () => {
      const { compat, calls } = client();
      await refusesE003(() => compat.User.update({ where: { id: 1 }, data: { posts: ops } }), calls, re);
    });
  }

  it('the keys that are read still translate', async () => {
    const { compat, calls } = client();
    await compat.User.update({
      where: { id: 1 },
      data: {
        posts: {
          update: { where: { id: 1 }, data: { published: true } },
          upsert: { where: { id: 2 }, create: { published: false }, update: { published: true } },
          connectOrCreate: { where: { id: 3 }, create: { published: false } },
        },
      },
    });
    assert.deepEqual(lastArgs(calls, 'users.update').data, {
      posts: {
        update: { where: { id: 1 }, data: { isPublished: true } },
        upsert: { where: { id: 2 }, create: { isPublished: false }, update: { isPublished: true } },
        connectOrCreate: { where: { id: 3 }, create: { isPublished: false } },
      },
    });
  });
});

describe('prisma-compat, $transaction options', () => {
  it('the array form forwards its options to the transaction', async () => {
    const { compat, txOptions, calls } = client();
    await compat.$transaction([compat.User.findMany({}), compat.Post.findMany({})], {
      isolationLevel: 'Serializable',
      timeout: 5000,
    });
    assert.deepEqual(txOptions, [{ isolationLevel: 'Serializable', timeout: 5000 }]);
    assert.deepEqual(
      calls.map((c) => c.method),
      ['users.buildFindMany', 'posts.buildFindMany'],
    );
  });

  it('the callback form forwards them too', async () => {
    const { compat, txOptions } = client();
    await compat.$transaction(async () => 1, { isolationLevel: 'RepeatableRead' });
    assert.deepEqual(txOptions, [{ isolationLevel: 'RepeatableRead' }]);
  });

  it('no options means none are passed', async () => {
    const { compat, txOptions } = client();
    await compat.$transaction([compat.User.findMany({})]);
    await compat.$transaction(async () => 1);
    assert.deepEqual(txOptions, [undefined, undefined]);
  });

  it('an unknown option REJECTS (it never throws) and no transaction opens', async () => {
    const { compat, txOptions } = client();
    let pending: Promise<unknown> | undefined;
    assert.doesNotThrow(() => {
      pending = compat.$transaction([compat.User.findMany({})], { isolationLevl: 'Serializable' });
    });
    await assert.rejects(
      pending as Promise<unknown>,
      (err: unknown) =>
        err instanceof ValidationError &&
        /unknown \$transaction option "isolationLevl".*Did you mean "isolationLevel"\?/s.test(err.message),
    );
    await assert.rejects(
      compat.$transaction(async () => 1, { isolationLevl: 'Serializable' }),
      (err: unknown) => err instanceof ValidationError && /unknown \$transaction option/.test(err.message),
    );
    assert.deepEqual(txOptions, [], 'a refused option set must not open a transaction');
  });

  it('options that are not an object are refused', async () => {
    const { compat } = client();
    await assert.rejects(
      compat.$transaction(async () => 1, 'Serializable'),
      (err: unknown) =>
        err instanceof ValidationError && /options must be an object, received a string/.test(err.message),
    );
  });

  it("Turbine's own transaction options still pass through", async () => {
    const { compat, txOptions } = client();
    await compat.$transaction(async () => 1, { readOnly: true, sessionContext: { 'app.tenant': '1' } });
    assert.deepEqual(txOptions, [{ readOnly: true, sessionContext: { 'app.tenant': '1' } }]);
  });

  it('`maxWait` is accepted, not forwarded, and warned about once', async () => {
    resetWarnOnce('prismaCompatTxOption');
    const { compat, txOptions, warnings } = client();
    await compat.$transaction(async () => 1, { maxWait: 100, timeout: 5000 });
    await compat.$transaction([compat.User.findMany({})], { maxWait: 100 });
    assert.deepEqual(txOptions, [{ timeout: 5000 }, {}], 'maxWait must not reach core');
    const mine = warnings.filter((w) => /maxWait/.test(w.message));
    assert.equal(mine.length, 1, 'one warning, not one per transaction');
    assert.equal(mine[0]!.code, 'prisma-compat-unknown-option');
    assert.match(mine[0]!.message, /connectionTimeoutMs/);
  });
});

/**
 * prisma-compat: the arg-translation walkers are depth-capped.
 *
 * Core caps every WHERE / HAVING walk (`assertWhereDepth`, `MAX_WHERE_DEPTH`),
 * and the cap fires at exactly 33 and passes at 32. That guard was UNREACHABLE
 * for every compat consumer, because this layer translates the whole clause into
 * turbine field names FIRST: `translateWhere` recursed on the same combinator
 * and relation-filter keys with nothing bounding it, so on a deep predicate the
 * stack overflowed here and core never ran. A `RangeError` is not a
 * `TurbineError`, so it walks straight past the typed-error surface callers
 * catch on and lands as an unhandled rejection.
 *
 * Measured on Node 24, against the wire bodies these tests send:
 *
 *   where     `{"NOT":…}` x1,000    8 KB  -> translated fine (no refusal)
 *   where     `{"NOT":…}` x4,000   32 KB  -> RangeError
 *   orderBy   `[[[…]]]`   x1,500    3 KB  -> translated fine (no refusal)
 *   orderBy   `[[[…]]]`   x2,000    4 KB  -> RangeError
 *   include   chain       x1,000   45 KB  -> RangeError
 *   data      chain       x1,000   43 KB  -> RangeError
 *   having    `{"NOT":…}` x8,000   64 KB  -> RangeError
 *
 * `orderBy` is the sharpest of them and the reason the cap could not simply be
 * left to core: core's `normalizeOrderBy` reads ONE level of array and never
 * recurses, so nested orderBy arrays have no second line of defense anywhere.
 *
 * Every refusal test here was run against the pre-fix module and observed to
 * fail; each `it` says which way it failed.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { TurbineErrorCode, ValidationError } from '../errors.js';
import { type CompatTurbineClient, createPrismaCompatClient } from '../prisma-compat.js';
import { MAX_WHERE_DEPTH } from '../query/where-compile.js';
import type { PrismaCompatMap, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
type Any = any;

type Models = {
  User: { Row: { id: number; name: string; emailAddress: string } };
  Post: { Row: { id: number; title: string; userId: number } };
};

/**
 * Two models with relations pointing BOTH ways (`User.posts` / `Post.author`),
 * which is what lets a payload alternate relation hops indefinitely. A chain
 * that only goes one way terminates after a single hop and proves nothing.
 */
function fixture(): { schema: SchemaMetadata; map: PrismaCompatMap } {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email_address', field: 'emailAddress', pgType: 'text' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
    },
  );
  const posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'title', field: 'title', pgType: 'text' },
    ],
    {
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );

  const schema: SchemaMetadata = { enums: {}, tables: { users, posts } };
  const map: PrismaCompatMap = {
    enums: {},
    models: {
      User: {
        table: 'users',
        accessor: 'users',
        fields: { id: 'id', name: 'name', email: 'emailAddress' },
        relations: { posts: { name: 'posts', cardinality: 'many' } },
        compoundUniques: {},
      },
      Post: {
        table: 'posts',
        accessor: 'posts',
        fields: { id: 'id', title: 'title', authorId: 'userId' },
        relations: { author: { name: 'author', cardinality: 'one' } },
        compoundUniques: {},
      },
    },
  };
  return { schema, map };
}

/** A compat client over a stub that records nothing and answers everything. */
function compat(): Any {
  const { schema, map } = fixture();
  const qi = (): Any =>
    new Proxy(
      {},
      {
        get: (_t, prop: string) => () =>
          /Many$/.test(prop) || prop === 'groupBy' ? Promise.resolve([]) : Promise.resolve(null),
      },
    );
  const db = { schema, table: qi, $transaction: (arg: Any) => arg({ table: qi }) };
  return createPrismaCompatClient<Models>(db as unknown as CompatTurbineClient as unknown as TurbineClient, map);
}

/**
 * Args built by PARSING a wire body rather than by nesting values in JS.
 *
 * `JSON.stringify` blows its own stack well before these depths, so a
 * JS-constructed fixture cannot even express the payload; and the bytes are what
 * an HTTP handler actually hands the adapter, which is where the finding lives.
 */
function wire(open: string, inner: string, close: string, depth: number): Any {
  return JSON.parse(`${open.repeat(depth)}${inner}${close.repeat(depth)}`);
}

/** Assert a rejection is the typed depth refusal and NOT a stack overflow. */
async function assertDepthRefusal(run: () => Promise<unknown>, clause: string): Promise<void> {
  await assert.rejects(run, (err: unknown) => {
    assert.ok(!(err instanceof RangeError), `raised a RangeError instead of a typed refusal: ${String(err)}`);
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal((err as ValidationError).code, TurbineErrorCode.VALIDATION);
    assert.match((err as Error).message, new RegExp(`\`${clause}\``));
    assert.match((err as Error).message, new RegExp(`more than ${MAX_WHERE_DEPTH} levels`));
    return true;
  });
}

describe('prisma-compat: translation walkers are depth-capped', () => {
  it('refuses a deep `where` NOT chain (used to RangeError at 32 KB)', async () => {
    // Pre-fix: RangeError at 4,000. Also pre-fix at 1,000: accepted outright.
    const c = compat();
    await assertDepthRefusal(() => c.User.findMany({ where: wire('{"NOT":', '{"id":1}', '}', 4000) }), 'where');
  });

  it('refuses a deep relation-filter chain (`some` / `is` bodies are where clauses)', async () => {
    // Pre-fix: RangeError at 1,500 hops (a 55 KB body).
    const c = compat();
    await assertDepthRefusal(
      () => c.User.findMany({ where: wire('{"posts":{"some":{"author":{"is":', '{"id":1}', '}}}}', 1500) }),
      'where',
    );
  });

  it('refuses a deep `orderBy` ARRAY nest, which core does not walk at all', async () => {
    // Pre-fix: accepted at 1,500, RangeError at 2,000 (a 4 KB body). This is the
    // one shape with no second line of defense: core reads one array level.
    const c = compat();
    await assertDepthRefusal(() => c.User.findMany({ orderBy: wire('[', '{"id":"asc"}', ']', 2000) }), 'orderBy');
  });

  it('refuses a deep `include` chain (used to RangeError at 45 KB)', async () => {
    // Pre-fix: accepted at 500 hops, RangeError at 1,000.
    const c = compat();
    await assertDepthRefusal(
      () => c.User.findMany({ include: wire('{"posts":{"include":{"author":{"include":', 'true', '}}}}', 1000) }),
      'include',
    );
  });

  it('refuses a deep `select` chain (the same walker, the other spelling)', async () => {
    const c = compat();
    await assertDepthRefusal(
      () => c.User.findMany({ select: wire('{"posts":{"select":{"author":{"select":', '{"id":true}', '}}}}', 1000) }),
      'include',
    );
  });

  it('refuses a deep nested-write `data` chain (used to RangeError at 43 KB)', async () => {
    // Pre-fix: accepted at 500 hops, RangeError at 1,000. Core's nested-write
    // engine caps at 10, so this payload was always going to be refused; what
    // changes is that the refusal is now typed instead of a stack overflow
    // raised before core is reached.
    const c = compat();
    await assertDepthRefusal(
      () => c.User.create({ data: wire('{"posts":{"create":{"author":{"create":', '{"id":1}', '}}}}', 1000) }),
      'data',
    );
  });

  it('refuses a deep nested-write chain through `connectOrCreate` and `upsert` too', async () => {
    const c = compat();
    await assertDepthRefusal(
      () =>
        c.User.create({
          data: wire(
            '{"posts":{"connectOrCreate":{"create":{"author":{"connectOrCreate":{"create":',
            '{"id":1}',
            '}}}}}}',
            500,
          ),
        }),
      'data',
    );
    await assertDepthRefusal(
      () =>
        c.User.update({
          where: { id: 1 },
          data: wire('{"posts":{"upsert":{"create":{"author":{"upsert":{"create":', '{"id":1}', '}}}}}}', 500),
        }),
      'data',
    );
  });

  it('refuses a deep groupBy `having` chain (used to RangeError at 64 KB)', async () => {
    const c = compat();
    await assertDepthRefusal(
      () => c.User.groupBy({ by: ['id'], having: wire('{"NOT":', '{"id":{"_count":{"gt":1}}}', '}', 4000) }),
      'having',
    );
  });

  it('caps a `where` nested inside a deep `include`, not each arg on its own budget', async () => {
    // The budget is spent on TOTAL nesting: a payload cannot pad one arg with
    // relation hops and then nest another to reach the same stack depth.
    const c = compat();
    await assertDepthRefusal(
      () =>
        c.User.findMany({
          include: { posts: { where: wire('{"NOT":', '{"id":1}', '}', 4000) } },
        }),
      'where',
    );
  });
});

/**
 * The cap has to land where core's lands, or a compat consumer and a core
 * consumer disagree about whether the same query is valid. `translateWhere`
 * increments at exactly the two places `walkWhere` does, a combinator branch and
 * a relation-filter descent (whose wrapper body is its own level there, so it is
 * one here too).
 */
describe('prisma-compat: the cap sits at core depth, not a second convention', () => {
  function notChain(depth: number): Any {
    return wire('{"NOT":', '{"id":1}', '}', depth);
  }

  it(`passes at exactly ${MAX_WHERE_DEPTH} and fires at ${MAX_WHERE_DEPTH + 1}`, async () => {
    const c = compat();
    await c.User.findMany({ where: notChain(MAX_WHERE_DEPTH) });
    await assertDepthRefusal(() => c.User.findMany({ where: notChain(MAX_WHERE_DEPTH + 1) }), 'where');
  });

  it("reuses core's own message for `where` and `having`, verbatim", async () => {
    // These two have a core counterpart, so the compat caller reads exactly what
    // a core caller reads rather than a parallel wording that can drift.
    const c = compat();
    await assert.rejects(
      () => c.User.findMany({ where: notChain(MAX_WHERE_DEPTH + 1) }),
      /`where` clause nests more than 32 levels of AND \/ OR \/ NOT/,
    );
    await assert.rejects(
      () => c.User.groupBy({ by: ['id'], having: notChain(MAX_WHERE_DEPTH + 1) }),
      /`having` clause nests more than 32 levels of AND \/ OR \/ NOT/,
    );
  });

  it('a wide clause is ONE level however wide, so nothing legal is refused', async () => {
    // The refusal counts NESTING. An `OR` of 5,000 conditions, a 5,000-element
    // orderBy array, and a 5,000-key where all sit at one level and must pass;
    // if the cap counted nodes instead, each of these would be refused.
    const c = compat();
    await c.User.findMany({ where: { OR: Array.from({ length: 5000 }, (_, i) => ({ id: i })) } });
    await c.User.findMany({ orderBy: Array.from({ length: 5000 }, () => ({ id: 'asc' })) });
    await c.User.findMany({ where: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`f${i}`, i])) });
  });

  it('an ordinary nested query still translates unchanged', async () => {
    // The regression side: the cap must be invisible to every real payload.
    const c = compat();
    const calls: Any[] = [];
    const { schema, map } = fixture();
    const qi = (table: string): Any =>
      new Proxy(
        {},
        {
          get: (_t, prop: string) => (args: Any) => {
            calls.push({ method: `${table}.${prop}`, args });
            return Promise.resolve([]);
          },
        },
      );
    const db = { schema, table: qi, $transaction: (arg: Any) => arg({ table: qi }) };
    const client = createPrismaCompatClient<Models>(db as unknown as TurbineClient, map);
    await client.User.findMany({
      where: { OR: [{ email: 'a@b.c' }, { posts: { some: { title: { contains: 'x' } } } }] },
      orderBy: [{ email: 'desc' }, { posts: { _count: 'asc' } }],
      include: { posts: { where: { title: 'x' }, orderBy: { title: 'asc' }, include: { author: true } } },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.where, {
      OR: [{ emailAddress: 'a@b.c' }, { posts: { some: { title: { contains: 'x' } } } }],
    });
    assert.deepEqual(calls[0].args.orderBy, [{ emailAddress: 'desc' }, { posts: { _count: 'asc' } }]);
    assert.deepEqual(calls[0].args.with, {
      posts: { where: { title: 'x' }, orderBy: { title: 'asc' }, with: { author: true } },
    });
    assert.equal(c !== undefined, true);
  });
});

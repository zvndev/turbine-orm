/**
 * turbine-orm: the `params.args` a middleware receives is a plain copy.
 *
 * Middleware can read it, spread it, serialize it and `structuredClone` it. A
 * change to it, in place or by passing a different object to `next`, is refused
 * with a TypeError naming the path, because the query is compiled from the
 * caller's args and the change would never reach it. A structurally equal copy
 * is accepted.
 *
 * No database.
 *
 * Run: npx tsx --test src/test/fix-txerr-middleware.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from 'node:util';
import type { PgCompatPool } from '../pg-types.js';
import { col } from '../query/column-ref.js';
import type { MiddlewareFn } from '../query/index.js';
import { QueryInterface } from '../query/index.js';
import { CURSOR_INCLUSIVE } from '../query/normalize-args.js';
import {
  assertMiddlewareArgsKept,
  isInternalCombinator,
  markInternalCombinator,
  readOnlyMiddlewareParams,
} from '../query/utils.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    tables: {
      users: mockTable('users', [
        { name: 'id', field: 'id' },
        { name: 'role', field: 'role', pgType: 'text' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
    enums: {},
  } as SchemaMetadata;
}

function qi(middlewares: MiddlewareFn[]) {
  const sent: string[] = [];
  const pool = {
    query: async (text: unknown) => {
      sent.push(typeof text === 'string' ? text : String((text as { text: string }).text));
      return { rows: [{ id: 1 }], rowCount: 1 };
    },
    connect: async () => {
      throw new Error('no connections in this test');
    },
  };
  return { sent, users: new QueryInterface(pool as unknown as PgCompatPool, 'users', schema(), middlewares) };
}

const refused = (path: string) => (err: unknown) => {
  assert.ok(err instanceof TypeError, String(err));
  assert.ok(err.message.includes(`\`params.${path}\``), err.message);
  assert.match(err.message, /globalFilters/);
  return true;
};

describe('middleware can copy params.args', () => {
  it('structuredClone works, and the copy can be passed to next', async () => {
    const seen: unknown[] = [];
    const { users, sent } = qi([
      async (params, next) => {
        const copy = structuredClone(params.args);
        seen.push(copy);
        return next({ ...params, args: copy });
      },
    ]);
    const when = new Date('2024-05-06T07:08:09Z');
    await users.findMany({ where: { name: 'a', id: { in: [1, 2, 3] } }, orderBy: [{ id: 'asc' }], limit: 5 });
    assert.deepEqual(seen[0], { where: { name: 'a', id: { in: [1, 2, 3] } }, orderBy: [{ id: 'asc' }], limit: 5 });
    assert.equal(sent.length, 1, 'the query ran');
    // Date, bigint and Buffer survive a structuredClone round trip and still count as equal.
    const second = qi([async (params, next) => next({ ...params, args: structuredClone(params.args) })]);
    await second.users.findMany({ where: { name: when as unknown as string, id: 5n as unknown as number }, limit: 1 });
    await second.users.findMany({ where: { name: Buffer.from('abc') as unknown as string }, limit: 1 });
    assert.equal(second.sent.length, 2);
  });

  it('spreading params and args, and rebuilding both, are accepted', async () => {
    const { users, sent } = qi([
      async (p, next) => next({ ...p }),
      async (p, next) => next({ ...p, args: { ...p.args } }),
      async (p, next) => next({ model: p.model, action: p.action, args: JSON.parse(JSON.stringify(p.args)) }),
    ]);
    await users.findMany({ where: { name: 'a' }, limit: 2 });
    assert.equal(sent.length, 1);
  });

  it('key order and a different Buffer class do not matter, a different value does', async () => {
    const { users, sent } = qi([
      async (p, next) => {
        const where = p.args.where as Record<string, unknown>;
        return next({ ...p, args: { limit: p.args.limit, where: { name: where.name, id: where.id } } });
      },
    ]);
    await users.findMany({ where: { id: 1, name: 'a' }, limit: 2 });
    assert.equal(sent.length, 1);
  });

  it('JSON.stringify and util.inspect show the values, not accessors', async () => {
    let text = '';
    let shown = '';
    const { users } = qi([
      async (p, next) => {
        text = JSON.stringify(p);
        shown = inspect(p);
        return next(p);
      },
    ]);
    await users.findMany({ where: { name: 'a' }, limit: 2 });
    assert.equal(
      text,
      JSON.stringify({ model: 'users', action: 'findMany', args: { where: { name: 'a' }, limit: 2 } }),
    );
    assert.match(shown, /model: 'users'/);
    assert.match(shown, /name: 'a'/);
    assert.doesNotMatch(shown, /Getter/);
  });

  it('a middleware that never reads params.args does not copy it', async () => {
    let reads = 0;
    const args = {
      limit: 3,
      get where(): Record<string, unknown> {
        reads++;
        return { name: 'a' };
      },
    };
    const params = readOnlyMiddlewareParams('users', 'findMany', args);
    assertMiddlewareArgsKept(params, params);
    assert.equal(params.model, 'users');
    assert.equal(reads, 0, 'the args were copied without being read');
    void params.args;
    assert.equal(reads, 1, 'the copy is made once, on first read');
    void params.args;
    assert.equal(reads, 1, 'and kept');
  });
});

describe('a change to params.args is refused at next, in strict and in sloppy code', () => {
  const attempts: [string, MiddlewareFn][] = [
    [
      'args.where.id',
      async (p, next) => {
        (p.args.where as Record<string, unknown>).id = 2;
        return next(p);
      },
    ],
    [
      'args.where.role',
      async (p, next) => {
        (p.args.where as Record<string, unknown>).role = 'admin';
        return next(p);
      },
    ],
    [
      'args.limit',
      async (p, next) => {
        delete p.args.limit;
        return next(p);
      },
    ],
    [
      'args.orderBy.0.id',
      async (p, next) => {
        Object.defineProperty((p.args.orderBy as object[])[0], 'id', { value: 'desc' });
        return next(p);
      },
    ],
    [
      'args.orderBy.1',
      async (p, next) => {
        (p.args.orderBy as object[]).push({ name: 'asc' });
        return next(p);
      },
    ],
    [
      'args.take',
      async (p, next) => {
        return next({ ...p, args: { ...p.args, take: 1 } });
      },
    ],
    [
      'args.limit',
      async (p, next) => {
        const rebuilt = structuredClone(p.args);
        rebuilt.limit = 1;
        return next({ ...p, args: rebuilt });
      },
    ],
  ];

  for (const [path, mw] of attempts) {
    it(`${path}`, async () => {
      const { users, sent } = qi([mw]);
      await assert.rejects(users.findMany({ where: { id: 1 }, orderBy: [{ id: 'asc' }], limit: 5 }), refused(path));
      assert.equal(sent.length, 0, 'nothing reached the database');
    });
  }

  it('the same write from a script that is not in strict mode is refused too, not silently ignored', async () => {
    // new Function bodies are sloppy-mode code: a frozen object would swallow these writes.
    const sloppy = new Function(
      'params',
      'next',
      'params.args.where.role = "admin"; return next(params);',
    ) as MiddlewareFn;
    assert.equal(new Function('return this === undefined')(), false, 'precondition: new Function is sloppy');
    const { users, sent } = qi([sloppy]);
    await assert.rejects(users.findMany({ where: { id: 1 }, limit: 5 }), refused('args.where.role'));
    assert.equal(sent.length, 0);

    const sloppyDelete = new Function(
      'params',
      'next',
      'delete params.args.where.id; return next(params);',
    ) as MiddlewareFn;
    const second = qi([sloppyDelete]);
    await assert.rejects(second.users.findMany({ where: { id: 1 }, limit: 5 }), refused('args.where.id'));
    assert.equal(second.sent.length, 0);
  });

  it('replacing params.args throws at the assignment, and params.model or params.action are refused at next', async () => {
    for (const [path, mw] of [
      [
        'args',
        async (p, next) => {
          p.args = { ...p.args };
          return next(p);
        },
      ],
      [
        'model',
        async (p, next) => {
          p.model = 'posts';
          return next(p);
        },
      ],
      [
        'action',
        async (p, next) => {
          p.action = 'findFirst';
          return next(p);
        },
      ],
    ] as [string, MiddlewareFn][]) {
      const { users, sent } = qi([mw]);
      await assert.rejects(users.findMany({ limit: 1 }), refused(path), path);
      assert.equal(sent.length, 0);
    }
  });

  it('a middleware may add its own properties to params', async () => {
    let seen: unknown;
    const { users } = qi([
      async (p, next) => {
        (p as unknown as { startedAt: number }).startedAt = 1;
        return next(p);
      },
      async (p, next) => {
        seen = (p as unknown as { startedAt?: number }).startedAt;
        return next(p);
      },
    ]);
    await users.findMany({ limit: 1 });
    assert.equal(seen, 1);
  });

  it('mutating the copy without calling next harms nothing', async () => {
    const { users, sent } = qi([
      async (p) => {
        (p.args.where as Record<string, unknown>).id = 99;
        return [];
      },
    ]);
    assert.deepEqual(await users.findMany({ where: { id: 1 }, limit: 5 }), []);
    assert.equal(sent.length, 0);
  });
});

describe('the copy carries the pipeline markers', () => {
  it('internal-combinator brand (non-enumerable), cursor flag and column reference brand are on the copy', () => {
    const cursor = { id: 4 } as Record<string, unknown>;
    Object.defineProperty(cursor, CURSOR_INCLUSIVE, { value: true, enumerable: true, configurable: true });
    const where = markInternalCombinator({ AND: [{ id: 1 }, { name: 'a' }] });
    const ref = col('name');
    const args = { where, cursor, orderBy: [{ id: ref }] } as unknown as Record<string, unknown>;
    const params = readOnlyMiddlewareParams('users', 'findMany', args);
    const copy = params.args as Record<string, unknown>;

    assert.notEqual(copy, args);
    assert.notEqual(copy.where, where);
    assert.equal(isInternalCombinator(copy.where), true, 'the internal-combinator brand was lost');
    assert.equal(
      Object.getOwnPropertyDescriptor(copy.where, Symbol.for('turbine.internalCombinator'))?.enumerable,
      false,
    );
    assert.equal((copy.cursor as Record<symbol, unknown>)[CURSOR_INCLUSIVE], true, 'the cursor flag was lost');
    const copiedRef = (copy.orderBy as Array<Record<string, unknown>>)[0]!.id as Record<symbol, unknown>;
    assert.equal(copiedRef[Symbol.for('turbine-orm.columnRef')], true, 'the column reference brand was lost');
    assertMiddlewareArgsKept(params, { args: copy });
  });

  it("the caller's own objects are never touched", () => {
    const args = { where: { id: 1 }, tags: ['a'] };
    const params = readOnlyMiddlewareParams('users', 'findMany', args);
    const copy = params.args as typeof args;
    copy.where.id = 7;
    copy.tags.push('b');
    assert.deepEqual(args, { where: { id: 1 }, tags: ['a'] });
    assert.throws(() => assertMiddlewareArgsKept(params, params), refused('args.where.id'));
  });

  it('a Date, a Buffer and a class instance are shared, not copied', () => {
    class Money {
      constructor(readonly cents: number) {}
    }
    const when = new Date(0);
    const bytes = Buffer.from('xyz');
    const money = new Money(5);
    const params = readOnlyMiddlewareParams('users', 'findMany', { where: { a: when, b: bytes, c: money } });
    const where = (params.args as { where: Record<string, unknown> }).where;
    assert.equal(where.a, when);
    assert.equal(where.b, bytes);
    assert.equal(where.c, money);
  });

  it('an own __proto__ key (from JSON.parse) is copied as data and does not change the prototype', () => {
    const args = JSON.parse('{"where":{"__proto__":{"admin":true},"id":1}}') as Record<string, unknown>;
    const params = readOnlyMiddlewareParams('users', 'findMany', args);
    const where = (params.args as { where: Record<string, unknown> }).where;
    assert.equal(Object.getPrototypeOf(where), Object.prototype);
    assert.equal((where as { admin?: unknown }).admin, undefined);
    assert.deepEqual(Object.keys(where), ['__proto__', 'id']);
    assertMiddlewareArgsKept(params, params);
  });

  it('a self-referencing object stops copying instead of overflowing the stack', () => {
    const args: Record<string, unknown> = { id: 1 };
    args.self = args;
    const params = readOnlyMiddlewareParams('users', 'findMany', args);
    assert.doesNotThrow(() => params.args);
    assert.doesNotThrow(() => assertMiddlewareArgsKept(params, params));
  });
});

describe('assertMiddlewareArgsKept names the first path that differs', () => {
  const original = {
    where: { id: 1, name: 'a', created: new Date(1000), blob: Buffer.from([1, 2, 3]), big: 5n },
    orderBy: [{ id: 'asc' }],
    limit: 5,
  };
  const check = (change: (copy: typeof original) => void, path: string | undefined) => {
    const params = readOnlyMiddlewareParams('users', 'findMany', original as Record<string, unknown>);
    const copy = structuredClone(original);
    change(copy);
    if (path === undefined) assertMiddlewareArgsKept(params, { args: copy });
    else assert.throws(() => assertMiddlewareArgsKept(params, { args: copy }), refused(path));
  };

  it('an untouched structuredClone is equal', () => check(() => {}, undefined));
  it('a different scalar', () => check((c) => ((c.where as Record<string, unknown>).name = 'b'), 'args.where.name'));
  it('a different Date', () =>
    check((c) => ((c.where as Record<string, unknown>).created = new Date(2000)), 'args.where.created'));
  it('a different Buffer', () =>
    check((c) => ((c.where as Record<string, unknown>).blob = Buffer.from([1, 2, 4])), 'args.where.blob'));
  it('a different bigint', () => check((c) => ((c.where as Record<string, unknown>).big = 6n), 'args.where.big'));
  it('a longer array', () => check((c) => c.orderBy.push({ id: 'desc' }), 'args.orderBy.1'));
  it('a missing key', () => check((c) => delete (c as Partial<typeof original>).limit, 'args.limit'));
  it('an extra key', () => check((c) => ((c as Record<string, unknown>).offset = 1), 'args.offset'));
  it('an array where an object was', () => check((c) => ((c as Record<string, unknown>).where = []), 'args.where'));
  it('no args at all', () => {
    const params = readOnlyMiddlewareParams('users', 'findMany', { limit: 1 });
    assert.throws(() => assertMiddlewareArgsKept(params, undefined), refused('args'));
    assert.throws(() => assertMiddlewareArgsKept(params, {}), refused('args'));
    assert.throws(() => assertMiddlewareArgsKept(params, { args: null }), refused('args'));
  });
  it('the original object itself is fine', () => {
    const params = readOnlyMiddlewareParams('users', 'findMany', original as Record<string, unknown>);
    assertMiddlewareArgsKept(params, { args: original });
  });
});

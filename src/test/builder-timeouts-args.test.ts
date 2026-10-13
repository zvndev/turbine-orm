/**
 * turbine-orm: query arguments that used to be ignored, misread or rewritable.
 *
 * Build-only (no database). Covers read-only middleware args, per-query
 * option validation, paging refused on bulk writes, `optimisticLock` refused
 * on upsert, the findUnique simple path, page-1 tiebreakers, cursor value
 * validation, `NotFoundError.where` under safe messages, the error mappings
 * for undefined operators, binary bind failures and pool checkout timeouts,
 * and the closest-name suggestion.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  ConnectionError,
  getErrorMessageMode,
  NotFoundError,
  ReadOnlyError,
  setErrorMessageMode,
  TimeoutError,
  TurbineError,
  ValidationError,
  wrapPgError,
} from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { PgCompatPool } from '../pg-types.js';
import { col } from '../query/column-ref.js';
import type { MiddlewareFn } from '../query/index.js';
import { QueryInterface } from '../query/index.js';
import { closestName } from '../query/utils.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const posts: RelationDef = {
    type: 'hasMany',
    name: 'posts',
    from: 'users',
    to: 'posts',
    foreignKey: 'user_id',
    referenceKey: 'id',
  } as RelationDef;
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'email', field: 'email', pgType: 'text', unique: true },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'tenant_id', field: 'tenantId' },
      { name: 'meta', field: 'meta', pgType: 'jsonb' },
      { name: 'version', field: 'version' },
      { name: 'nick', field: 'nick', pgType: 'text', unique: true },
    ],
    { posts },
  );
  // `nick` is unique but nullable, so it cannot make an order total.
  const nick = users.columns.find((c) => c.name === 'nick')!;
  nick.nullable = true;
  const tables: Record<string, TableMetadata> = {
    users,
    posts: mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
      { name: 'title', field: 'title', pgType: 'text' },
    ]),
  };
  return { tables, enums: {} } as SchemaMetadata;
}

/** A pool that answers every query with `rows` and records what it was sent. */
function recordingPool(rows: Record<string, unknown>[] = [{ id: 1 }]) {
  const sent: string[] = [];
  const pool = {
    sent,
    query: async (text: unknown) => {
      sent.push(typeof text === 'string' ? text : String((text as { text: string }).text));
      return { rows, rowCount: rows.length };
    },
    connect: async () => {
      throw new Error('this test pool hands out no connections');
    },
  };
  return pool;
}

function qi(middlewares: MiddlewareFn[] = [], rows?: Record<string, unknown>[]) {
  const pool = recordingPool(rows);
  return { pool, users: new QueryInterface(pool as unknown as PgCompatPool, 'users', schema(), middlewares) };
}

const isE003 = (err: unknown): boolean => err instanceof ValidationError && err.code === 'TURBINE_E003';

describe('middleware sees read-only args', () => {
  it('replacing params.args throws a TypeError naming the path, and nothing runs', async () => {
    const { pool, users } = qi([
      async (params, next) => {
        params.args = { ...params.args, limit: 1 };
        return next(params);
      },
    ]);
    await assert.rejects(users.findMany({ limit: 100 }), (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.match(err.message, /cannot change `params\.args` on users\.findMany/);
      assert.match(err.message, /globalFilters/);
      return true;
    });
    assert.equal(pool.sent.length, 0);
  });

  it('a nested write, a delete and a defineProperty all throw', async () => {
    const attempts: [string, MiddlewareFn][] = [
      [
        'args.where.id',
        async (p, next) => {
          (p.args.where as Record<string, unknown>).id = 2;
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
        'args.where.tenantId',
        async (p, next) => {
          Object.assign(p.args.where as object, { tenantId: 7 });
          return next(p);
        },
      ],
    ];
    for (const [path, mw] of attempts) {
      const { pool, users } = qi([mw]);
      await assert.rejects(
        users.findMany({ where: { id: 1 }, orderBy: [{ id: 'asc' }], limit: 5 }),
        (err: unknown) => err instanceof TypeError && err.message.includes(`params.${path}`),
        path,
      );
      assert.equal(pool.sent.length, 0, path);
    }
  });

  it('next() with a rebuilt args object throws instead of being ignored', async () => {
    const { pool, users } = qi([async (p, next) => next({ ...p, args: { ...p.args, limit: 1 } })]);
    await assert.rejects(users.findMany({ limit: 100 }), TypeError);
    assert.equal(pool.sent.length, 0);
  });

  it('reading args, spreading params into next() and transforming the result all still work', async () => {
    const seen: string[] = [];
    const when = new Date('2024-01-02T03:04:05Z');
    const { users } = qi(
      [
        async (p, next) => {
          seen.push(JSON.stringify(p.args));
          const where = p.args.where as Record<string, unknown>;
          assert.ok(where.name === 'a' && (p.args.with as object) === undefined);
          return next({ ...p });
        },
        async (p, next) => {
          const rows = (await next(p)) as Record<string, unknown>[];
          return rows.map((r) => ({ ...r, tagged: true }));
        },
      ],
      [{ id: 1 }],
    );
    const rows = (await users.findMany({ where: { name: 'a' }, limit: 2 })) as unknown as Record<string, unknown>[];
    assert.deepEqual(rows, [{ id: 1, tagged: true }]);
    assert.equal(seen[0], JSON.stringify({ where: { name: 'a' }, limit: 2 }));
    // A Date in args reaches middleware as itself, not a proxy.
    const { users: u2 } = qi([
      async (p, next) => {
        const v = (p.args.where as Record<string, unknown>).name as unknown;
        assert.ok(v instanceof Date && v.getTime() === when.getTime());
        return next(p);
      },
    ]);
    await u2.findMany({ where: { name: when as unknown as string }, limit: 1 });
  });
});

describe('per-query options are validated', () => {
  const users = () => makeQuery('users', schema());

  it('timeout must be a positive finite number of milliseconds up to 2147483647', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, '100', null, true]) {
      assert.throws(
        () => users().buildFindMany({ timeout: bad as never, limit: 1 }),
        (err: unknown) => isE003(err) && /`timeout` on users must be a positive number/.test((err as Error).message),
        String(bad),
      );
    }
    for (const good of [1, 0.5, 30_000, 2_147_483_647]) users().buildFindMany({ timeout: good, limit: 1 });
  });

  it('timeout is validated on writes too', () => {
    assert.throws(() => users().buildCreate({ data: { email: 'a' }, timeout: -5 } as never), isE003);
    assert.throws(
      () => users().buildUpdateMany({ where: { id: 1 }, data: { name: 'b' }, timeout: 0 } as never),
      isE003,
    );
  });

  it('relationLoadStrategy must be one of the four strategies, per query and per client', () => {
    for (const bad of ['lateral', 'JOIN', 'query', '', 1]) {
      assert.throws(
        () => users().buildFindMany({ with: { posts: true }, relationLoadStrategy: bad as never }),
        (err: unknown) =>
          isE003(err) && /`relationLoadStrategy` must be one of 'join', 'batched', 'auto', 'flatten'/.test(String(err)),
        String(bad),
      );
    }
    for (const good of ['join', 'batched', 'auto', 'flatten'] as const) {
      users().buildFindMany({ with: { posts: true }, relationLoadStrategy: good });
    }
    assert.throws(() => makeQuery('users', schema(), { relationLoadStrategy: 'lateral' as never }), isE003);
  });
});

describe('updateMany / deleteMany refuse paging on every engine', () => {
  const dialects = [undefined, mysqlDialect, sqliteDialect, mssqlDialect];
  for (const dialect of dialects) {
    const name = dialect?.name ?? 'postgresql';
    it(`limit / take / offset / skip are refused (${name})`, () => {
      const users = makeQuery('users', schema(), dialect ? { dialect } : undefined);
      for (const key of ['limit', 'take', 'offset', 'skip']) {
        const paging = { [key]: 10 };
        assert.throws(
          () => users.buildDeleteMany({ where: { tenantId: 1 }, ...paging } as never),
          (err: unknown) => isE003(err) && /is not supported on deleteMany for "users"/.test(String(err)),
          `${name} deleteMany ${key}`,
        );
        assert.throws(
          () => users.buildUpdateMany({ where: { tenantId: 1 }, data: { name: 'x' }, ...paging } as never),
          (err: unknown) => isE003(err) && /select the ids first/.test(String(err)),
          `${name} updateMany ${key}`,
        );
      }
      // Without paging both still build.
      users.buildDeleteMany({ where: { tenantId: 1 } });
      users.buildUpdateMany({ where: { tenantId: 1 }, data: { name: 'x' } });
    });
  }

  it('the async methods refuse before sending anything', async () => {
    const { pool, users } = qi();
    await assert.rejects(users.deleteMany({ where: { tenantId: 1 }, limit: 5 } as never), isE003);
    await assert.rejects(users.updateMany({ where: { tenantId: 1 }, data: { name: 'x' }, take: 5 } as never), isE003);
    assert.equal(pool.sent.length, 0);
  });
});

describe('upsert refuses optimisticLock', () => {
  const lock = { field: 'version', expected: 3 };

  it('with plain data, before any statement', async () => {
    const { pool, users } = qi();
    await assert.rejects(
      users.upsert({
        where: { id: 1 },
        create: { id: 1, email: 'a' },
        update: { name: 'b' },
        optimisticLock: lock,
      } as never),
      (err: unknown) => isE003(err) && /`optimisticLock` is an `update` option and upsert on "users"/.test(String(err)),
    );
    assert.equal(pool.sent.length, 0);
  });

  it('with nested relation data, which takes the lookup path', async () => {
    const { pool, users } = qi();
    await assert.rejects(
      users.upsert({
        where: { id: 1 },
        create: { id: 1, email: 'a', posts: { create: [{ title: 't' }] } },
        update: { name: 'b' },
        optimisticLock: lock,
      } as never),
      isE003,
    );
    assert.equal(pool.sent.length, 0);
  });
});

describe('findUnique simple path', () => {
  const users = () => makeQuery('users', schema());

  it('an array, an unknown operator object or a column reference is validated, not bound', () => {
    // `id` identifies the row, so the unique-key check passes and the value
    // beside it is what the simple path would have bound as it is.
    for (const value of [[1, 2], { foo: 1 }, col('id'), { col: 'id' }]) {
      assert.throws(
        () => users().buildFindUnique({ where: { id: 1, tenantId: value } } as never),
        isE003,
        JSON.stringify(value),
      );
    }
  });

  it('a Date, a Buffer and a bigint still take the simple path', () => {
    for (const value of [new Date(0), Buffer.from('ab'), 5n, 'x', 7, true]) {
      const d = users().buildFindUnique({ where: { email: value } } as never);
      assert.match(d.sql, /WHERE "email" = \$1 LIMIT 1$/, String(value));
      assert.equal(d.params.length, 1);
    }
  });
});

describe('page 1 gets the same tiebreaker as the cursor pages after it', () => {
  const users = () => makeQuery('users', schema());
  const orderOf = (sql: string): string => (sql.match(/ORDER BY (.*?)( LIMIT| OFFSET|$)/)?.[1] ?? '').trim();

  it('a paginated order over a non-unique column ends in the primary key, in the last direction', () => {
    const page = users().buildFindMany({ orderBy: { name: 'desc' }, limit: 10 });
    assert.equal(orderOf(page.sql), '"name" DESC, "id" DESC');
    const offset = users().buildFindMany({ orderBy: [{ tenantId: 'asc' }, { name: 'asc' }], offset: 20 });
    assert.equal(orderOf(offset.sql), '"tenant_id" ASC, "name" ASC, "id" ASC');
  });

  it('a nullable unique column does not make the order total', () => {
    const page = users().buildFindMany({ orderBy: { nick: 'asc' }, limit: 10 });
    assert.equal(orderOf(page.sql), '"nick" ASC, "id" ASC');
  });

  it('is left alone when the order is total, the query is not a page, or it is a findFirst', () => {
    assert.equal(orderOf(users().buildFindMany({ orderBy: { email: 'asc' }, limit: 10 }).sql), '"email" ASC');
    assert.equal(orderOf(users().buildFindMany({ orderBy: { name: 'asc' } }).sql), '"name" ASC');
    assert.equal(
      orderOf(users().buildFindFirst({ orderBy: { name: 'asc' } }).sql),
      '"name" ASC',
      'findFirst is one row, not a page',
    );
  });

  it('page 1 is ordered exactly like the cursor pages that follow it', () => {
    const first = users().buildFindMany({ orderBy: { name: 'desc' }, limit: 10 });
    const next = users().buildFindMany({ orderBy: { name: 'desc' }, limit: 10, cursor: { name: 'm', id: 5 } });
    assert.equal(orderOf(first.sql), orderOf(next.sql));
  });
});

describe('cursor values', () => {
  const users = () => makeQuery('users', schema());

  it('an operator object, an array or a column reference is refused', () => {
    for (const value of [{ gt: 5 }, [1, 2], col('tenantId'), { col: 'tenantId' }]) {
      assert.throws(
        () => users().buildFindMany({ orderBy: { id: 'asc' }, limit: 5, cursor: { id: value } } as never),
        isE003,
        JSON.stringify(value),
      );
    }
  });

  it('{ equals: v } is the same cursor as v, in value and row mode', () => {
    const bare = users().buildFindMany({ orderBy: { id: 'asc' }, limit: 5, cursor: { id: 5 } });
    const wrapped = users().buildFindMany({ orderBy: { id: 'asc' }, limit: 5, cursor: { id: { equals: 5 } } as never });
    assert.equal(wrapped.sql, bare.sql);
    assert.deepEqual(wrapped.params, bare.params);
    const rowBare = users().buildFindMany({ orderBy: { name: 'asc' }, limit: 5, cursor: { email: 'a@x' } });
    const rowWrapped = users().buildFindMany({
      orderBy: { name: 'asc' },
      limit: 5,
      cursor: { email: { equals: 'a@x' } } as never,
    });
    assert.equal(rowWrapped.sql, rowBare.sql);
    assert.deepEqual(rowWrapped.params, rowBare.params);
  });

  it('a cursor emptied by undefined values is refused; cursor: {} still means none', () => {
    assert.throws(
      () => users().buildFindMany({ orderBy: { id: 'asc' }, limit: 5, cursor: { id: undefined } }),
      (err: unknown) => isE003(err) && /every field of `cursor` was undefined/.test(String(err)),
    );
    const none = users().buildFindMany({ orderBy: { id: 'asc' }, limit: 5, cursor: {} });
    const plain = users().buildFindMany({ orderBy: { id: 'asc' }, limit: 5 });
    assert.equal(none.sql, plain.sql);
  });
});

describe('NotFoundError.where under safe messages', () => {
  const mode = getErrorMessageMode();
  afterEach(() => setErrorMessageMode(mode));

  it('is readable but not enumerable in safe mode, so serializing the error does not carry it', () => {
    setErrorMessageMode('safe');
    const err = new NotFoundError({ table: 'users', where: { email: 'alice@example.com' }, operation: 'update' });
    assert.deepEqual(err.where, { email: 'alice@example.com' });
    assert.equal(Object.keys(err).includes('where'), false);
    assert.equal(JSON.stringify(err).includes('alice@example.com'), false);
    assert.equal(err.message.includes('alice@example.com'), false);
  });

  it('is enumerable in verbose mode', () => {
    setErrorMessageMode('verbose');
    const err = new NotFoundError({ table: 'users', where: { email: 'alice@example.com' }, operation: 'update' });
    assert.ok(Object.keys(err).includes('where'));
    assert.ok(JSON.stringify(err).includes('alice@example.com'));
  });
});

describe('driver errors that used to arrive untyped or mistyped', () => {
  const pgError = (fields: Record<string, unknown>): Error => Object.assign(new Error(String(fields.message)), fields);

  it('42883 (no operator for these types) is a ValidationError that keeps the type names', () => {
    const err = wrapPgError(
      pgError({ code: '42883', severity: 'ERROR', message: 'operator does not exist: bigint = text' }),
    );
    assert.ok(isE003(err));
    assert.match((err as Error).message, /operator does not exist: bigint = text \(SQLSTATE 42883\)/);
    assert.match((err as Error).message, /Pass a value of the column's type/);
  });

  it('a bind-time 08P01 (a Buffer sent for a bigint) is a ValidationError, a FATAL one stays a ConnectionError', () => {
    const bind = wrapPgError(
      pgError({ code: '08P01', severity: 'ERROR', message: 'insufficient data left in message' }),
    );
    assert.ok(isE003(bind));
    assert.match((bind as Error).message, /A Buffer is sent as binary data/);
    const fatal = wrapPgError(pgError({ code: '08P01', severity: 'FATAL', message: 'invalid frontend message type' }));
    assert.ok(fatal instanceof ConnectionError);
  });

  it('a write in a read-only transaction is a ReadOnlyError with reason transaction, on Postgres and MySQL', () => {
    const pg = wrapPgError(
      pgError({ code: '25006', severity: 'ERROR', message: 'cannot execute INSERT in a read-only transaction' }),
    );
    assert.ok(pg instanceof ReadOnlyError && pg.code === 'TURBINE_E018');
    assert.equal((pg as ReadOnlyError).reason, 'transaction');
    assert.match((pg as Error).message, /cannot execute INSERT in a read-only transaction/);
    assert.match((pg as Error).message, /read-write transaction/);
    const mysql = wrapPgError(
      pgError({
        code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION',
        errno: 1792,
        sqlState: '25006',
        message: 'Cannot execute statement in a READ ONLY transaction.',
      }),
    );
    assert.ok(mysql instanceof ReadOnlyError && mysql.reason === 'transaction');
    // The existing reasons keep their wording.
    assert.match(new ReadOnlyError('refused.', { reason: 'rbac' }).message, /Route writes to a writable primary/);
  });

  it("a cancel request's 57014 names Turbine's timeout; statement_timeout keeps its own wording", () => {
    const cancelled = wrapPgError(
      pgError({ code: '57014', severity: 'ERROR', message: 'canceling statement due to user request' }),
    );
    assert.ok(cancelled instanceof TimeoutError && cancelled.outcome === 'not-executed');
    assert.match((cancelled as Error).message, /Turbine sends when a query or transaction `timeout` expires/);
    assert.doesNotMatch((cancelled as Error).message, /statement_timeout/);
    const server = wrapPgError(
      pgError({ code: '57014', severity: 'ERROR', message: 'canceling statement due to statement timeout' }),
    );
    assert.match((server as Error).message, /server-side statement_timeout/);
  });

  it("pg-pool's checkout timeout on a caller's own pool is a ConnectionError naming the fix", () => {
    const err = wrapPgError(new Error('timeout exceeded when trying to connect'));
    assert.ok(err instanceof ConnectionError && err instanceof TurbineError);
    assert.match((err as Error).message, /Timed out waiting for a free connection from the pool/);
    assert.match((err as Error).message, /use `tx` there/);
  });
});

describe('closest-name suggestions', () => {
  it('a short name contained in the input does not outrank a near miss', () => {
    assert.equal(closestName('tenentId', ['id', 'tenantId', 'name']), 'tenantId');
    assert.equal(closestName('userid', ['id', 'userId']), 'userId');
    assert.equal(closestName('emailAddress', ['email', 'id']), 'email');
  });

  it('an unknown where key suggests the near miss, not the primary key', () => {
    assert.throws(
      () => makeQuery('users', schema()).buildFindMany({ where: { tenentId: 1 } as never }),
      (err: unknown) => isE003(err) && /tenantId/.test(String(err)) && !/Did you mean "id"/.test(String(err)),
    );
  });
});

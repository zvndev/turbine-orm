/**
 * Row locks (`lock`), build side and the execute-entry refusals, no database.
 *
 * - The clause per engine, mode and wait policy, always naming the queried
 *   table (`FOR UPDATE OF "t"`), after pagination.
 * - Only the base statement carries it: a `with` subquery, a flatten join, a
 *   lateral pick and a batched follow-up never do.
 * - Every refusal and its message: outside a transaction, with `distinct`, on
 *   a stream, a malformed value, and a mode the engine has no clause for.
 * - The SQL-template cache keys a locked read apart from an unlocked one.
 *
 * Run: npx tsx --test src/test/wave-c-locks.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dialect } from '../dialect.js';
import {
  DeadlockError,
  LockNotAvailableError,
  SerializationFailureError,
  UnsupportedFeatureError,
  ValidationError,
  wrapPgError,
} from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import { mysqlDialect } from '../mysql.js';
import type { PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { QueryInterface, type QueryInterfaceOptions } from '../query/index.js';
import { assertNoLockInAutocommitPipeline } from '../query/row-lock.js';
import type { RowLock } from '../query/types.js';
import type { SchemaMetadata } from '../schema.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      jobs: mockTable('jobs', [
        { name: 'id', field: 'id' },
        { name: 'status', field: 'status', pgType: 'text' },
      ]),
      users: mockTable(
        'users',
        [
          { name: 'id', field: 'id' },
          { name: 'name', field: 'name', pgType: 'text' },
        ],
        {
          posts: {
            type: 'hasMany',
            name: 'posts',
            from: 'users',
            to: 'posts',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
      posts: mockTable(
        'posts',
        [
          { name: 'id', field: 'id' },
          { name: 'user_id', field: 'userId' },
          { name: 'title', field: 'title', pgType: 'text' },
        ],
        {
          user: {
            type: 'belongsTo',
            name: 'user',
            from: 'posts',
            to: 'users',
            foreignKey: 'user_id',
            referenceKey: 'id',
          },
        },
      ),
    },
  };
}

type Built = { sql: string; params: unknown[]; rowLock?: true };
type BuildOp =
  | 'buildFindMany'
  | 'buildFindUnique'
  | 'buildFindFirst'
  | 'buildFindFirstOrThrow'
  | 'buildFindUniqueOrThrow';
type Q = Record<BuildOp, (args?: unknown) => Built>;

function q(table: string, options: QueryInterfaceOptions = {}): Q {
  return makeQuery(table, schema(), { warnOnUnlimited: false, ...options }) as unknown as Q;
}

/** A pool that records every statement and answers from `rowsFor`. */
function recordingPool(rowsFor: (sql: string) => Record<string, unknown>[] = () => []) {
  const seen: string[] = [];
  return {
    seen,
    async query(arg: string | { text: string }) {
      const text = typeof arg === 'string' ? arg : arg.text;
      seen.push(text);
      const rows = rowsFor(text);
      return { rows, rowCount: rows.length, command: 'SELECT', fields: [] };
    },
    async connect(): Promise<never> {
      throw new Error('this test pool hands out no connections');
    },
    async end() {},
  };
}

type ExecOp = 'findMany' | 'findFirst' | 'findFirstOrThrow' | 'findUnique' | 'findUniqueOrThrow';
type Exec = Record<ExecOp, (args?: unknown) => Promise<unknown>>;

/** A live-shaped accessor over a recording pool; `txScoped` is what a TransactionClient sets. */
function accessor(table: string, pool: ReturnType<typeof recordingPool>, options: QueryInterfaceOptions = {}): Exec {
  return new QueryInterface(pool as never, table, schema(), undefined, {
    warnOnUnlimited: false,
    ...options,
  }) as unknown as Exec;
}

const MODES = [
  ['update', 'UPDATE'],
  ['noKeyUpdate', 'NO KEY UPDATE'],
  ['share', 'SHARE'],
  ['keyShare', 'KEY SHARE'],
] as const;

describe('lock: SQL per mode and wait policy (PostgreSQL)', () => {
  for (const [mode, sql] of MODES) {
    it(`${mode} blocks, waits with noWait, skips with skipLocked`, () => {
      const jobs = q('jobs');
      const page = { orderBy: { id: 'asc' }, limit: 3 };
      assert.match(jobs.buildFindMany({ ...page, lock: mode }).sql, new RegExp(`LIMIT \\$1 FOR ${sql} OF "jobs"$`));
      assert.match(
        jobs.buildFindMany({ ...page, lock: { mode, noWait: true } }).sql,
        new RegExp(`LIMIT \\$1 FOR ${sql} OF "jobs" NOWAIT$`),
      );
      assert.match(
        jobs.buildFindMany({ ...page, lock: { mode, skipLocked: true } }).sql,
        new RegExp(`LIMIT \\$1 FOR ${sql} OF "jobs" SKIP LOCKED$`),
      );
    });
  }

  it('a false wait flag is no wait policy', () => {
    const sql = q('jobs').buildFindMany({ lock: { mode: 'update', noWait: false, skipLocked: false } }).sql;
    assert.match(sql, / FOR UPDATE OF "jobs"$/);
  });

  it('follows LIMIT and OFFSET, and binds nothing', () => {
    const plain = q('jobs').buildFindMany({ where: { status: 'new' }, orderBy: { id: 'asc' }, limit: 5, offset: 2 });
    const locked = q('jobs').buildFindMany({
      where: { status: 'new' },
      orderBy: { id: 'asc' },
      limit: 5,
      offset: 2,
      lock: { mode: 'update', skipLocked: true },
    });
    assert.equal(locked.sql, `${plain.sql} FOR UPDATE OF "jobs" SKIP LOCKED`);
    assert.deepEqual(locked.params, plain.params);
  });

  it('findUnique, on its simple, general and with paths', () => {
    const users = q('users');
    assert.match(users.buildFindUnique({ where: { id: 1 }, lock: 'update' }).sql, / LIMIT 1 FOR UPDATE OF "users"$/);
    assert.match(
      users.buildFindUnique({ where: { id: 1, name: { not: 'x' } }, lock: 'share' }).sql,
      / LIMIT 1 FOR SHARE OF "users"$/,
    );
    const withSql = users.buildFindUnique({ where: { id: 1 }, with: { posts: true }, lock: 'update' }).sql;
    assert.match(withSql, / LIMIT 1 FOR UPDATE OF "users"$/);
    assert.equal(withSql.match(/ FOR /g)?.length, 1, 'the relation subquery is not locked');
  });

  it('findFirst and the OrThrow builders carry it', () => {
    const jobs = q('jobs');
    assert.match(jobs.buildFindFirst({ lock: 'update' }).sql, / FOR UPDATE OF "jobs"$/);
    assert.match(jobs.buildFindFirstOrThrow({ lock: 'update' }).sql, / FOR UPDATE OF "jobs"$/);
    assert.match(jobs.buildFindUniqueOrThrow({ where: { id: 1 }, lock: 'update' }).sql, / FOR UPDATE OF "jobs"$/);
  });

  it('no lock, no clause', () => {
    const jobs = q('jobs');
    for (const sql of [
      jobs.buildFindMany({ limit: 1 }).sql,
      jobs.buildFindUnique({ where: { id: 1 } }).sql,
      jobs.buildFindFirst({}).sql,
    ]) {
      assert.doesNotMatch(sql, / FOR /);
    }
  });

  it('a with clause: one clause, on the base table only (join)', () => {
    const sql = q('users').buildFindMany({ with: { posts: true }, limit: 2, lock: 'update' }).sql;
    assert.equal(sql.match(/ FOR /g)?.length, 1);
    assert.match(sql, / FOR UPDATE OF "users"$/);
  });

  it('flatten: the joined table is named out of the lock by OF', () => {
    const sql = q('posts').buildFindMany({
      with: { user: true },
      relationLoadStrategy: 'flatten',
      jsonEncoding: 'object',
      lock: 'update',
    }).sql;
    assert.match(sql, /LEFT JOIN/, 'the flatten plan ran');
    assert.match(sql, / FOR UPDATE OF "posts"$/);
  });

  it('a lateral pick: the joined subquery is named out of the lock by OF', () => {
    const sql = q('users').buildFindMany({
      orderBy: { posts: { pick: { orderBy: { id: 'desc' } }, by: 'title', plan: 'lateral' } },
      lock: 'noKeyUpdate',
    }).sql;
    assert.match(sql, /LEFT JOIN LATERAL/);
    assert.match(sql, / FOR NO KEY UPDATE OF "users"$/);
  });

  it('a cursor page', () => {
    const sql = q('jobs').buildFindMany({ orderBy: { id: 'asc' }, cursor: { id: 3 }, limit: 2, lock: 'update' }).sql;
    assert.match(sql, /WHERE .* LIMIT \$\d+ FOR UPDATE OF "jobs"$/);
  });

  it('a global filter stays in WHERE, so only rows in scope are locked', () => {
    const sql = q('jobs', { globalFilters: { jobs: { status: 'new' } } }).buildFindMany({ lock: 'update' }).sql;
    assert.match(sql, /WHERE "status" = \$1 FOR UPDATE OF "jobs"$/);
  });

  it('marks the DeferredQuery, and only a locking one', () => {
    const jobs = q('jobs');
    assert.equal(jobs.buildFindMany({ lock: 'update' }).rowLock, true);
    assert.equal(jobs.buildFindUnique({ where: { id: 1 }, lock: 'share' }).rowLock, true);
    assert.equal(jobs.buildFindFirst({ lock: 'update' }).rowLock, true);
    assert.equal(jobs.buildFindFirstOrThrow({ lock: 'update' }).rowLock, true);
    assert.equal(jobs.buildFindUniqueOrThrow({ where: { id: 1 }, lock: 'update' }).rowLock, true);
    assert.equal(Object.hasOwn(jobs.buildFindMany({}), 'rowLock'), false);
    assert.equal(Object.hasOwn(jobs.buildFindUnique({ where: { id: 1 } }), 'rowLock'), false);
  });
});

describe('lock: MySQL', () => {
  const opts = { dialect: mysqlDialect };

  it('update and share, after the inline LIMIT, with backtick OF', () => {
    const jobs = q('jobs', opts);
    assert.match(jobs.buildFindMany({ limit: 3, lock: 'update' }).sql, /LIMIT 3 FOR UPDATE OF `jobs`$/);
    assert.match(
      jobs.buildFindMany({ limit: 3, lock: { mode: 'share', skipLocked: true } }).sql,
      /LIMIT 3 FOR SHARE OF `jobs` SKIP LOCKED$/,
    );
    assert.match(
      jobs.buildFindUnique({ where: { id: 1 }, lock: { mode: 'update', noWait: true } }).sql,
      /LIMIT 1 FOR UPDATE OF `jobs` NOWAIT$/,
    );
  });

  it('a with clause locks the base table only', () => {
    const sql = q('users', opts).buildFindMany({ with: { posts: true }, limit: 2, lock: 'update' }).sql;
    assert.equal(sql.match(/ FOR /g)?.length, 1);
    assert.match(sql, / FOR UPDATE OF `users`$/);
  });

  for (const mode of ['noKeyUpdate', 'keyShare'] as const) {
    it(`${mode} is E017, and Turbine never upgrades it`, () => {
      assert.throws(
        () => q('jobs', opts).buildFindMany({ lock: mode }),
        (e: unknown) =>
          e instanceof UnsupportedFeatureError &&
          e.message.includes(`lock: '${mode}' is unsupported on "mysql"`) &&
          e.message.includes("MySQL supports lock: 'update' and lock: 'share' only"),
      );
    });
  }
});

describe('lock: engines without row locks (E017)', () => {
  const engines: [string, Dialect, string][] = [
    ['sqlite', sqliteDialect, 'SQLite has no row locks: a write transaction locks the whole database.'],
    ['mssql', mssqlDialect, 'Row locks are not available on SQL Server in this release.'],
  ];
  for (const [name, dialect, hint] of engines) {
    for (const [mode] of MODES) {
      it(`${name}: ${mode}`, () => {
        assert.throws(
          () => q('jobs', { dialect }).buildFindMany({ lock: { mode, skipLocked: true } }),
          (e: unknown) => e instanceof UnsupportedFeatureError && e.message.includes(hint),
        );
        assert.throws(
          () => q('jobs', { dialect }).buildFindUnique({ where: { id: 1 }, lock: mode }),
          UnsupportedFeatureError,
        );
      });
    }
  }
});

describe('lock: malformed values are E003', () => {
  const jobs = q('jobs');
  const cases: [string, unknown, RegExp][] = [
    [
      'both wait policies',
      { mode: 'update', noWait: true, skipLocked: true },
      /noWait and skipLocked cannot be combined/,
    ],
    ['an unknown mode', 'updat', /unknown mode 'updat'\. Did you mean 'update'\?/],
    ['an unknown mode in the object form', { mode: 'exclusive' }, /unknown mode 'exclusive'/],
    ['a missing mode', { noWait: true }, /unknown mode undefined/],
    ['an unknown key', { mode: 'update', nowait: true }, /unknown key "nowait"\. Did you mean "noWait"\?/],
    ['a non-boolean flag', { mode: 'update', skipLocked: 'yes' }, /skipLocked must be true or false, received 'yes'/],
    ['a number', 1, /must be a mode .* received 1\./],
    ['null', null, /received null\./],
    ['an array', ['update'], /received an array\./],
    ['true', true, /received true\./],
  ];
  for (const [label, lock, message] of cases) {
    it(label, () => {
      assert.throws(
        () => jobs.buildFindMany({ lock }),
        (e: unknown) => e instanceof ValidationError && message.test(e.message),
      );
    });
  }

  it('with distinct', () => {
    assert.throws(
      () => jobs.buildFindMany({ distinct: ['status'], lock: 'update' }),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.message.includes('lock on "jobs" cannot be combined with distinct') &&
        e.message.includes('Lock first (findMany with lock), then de-duplicate.'),
    );
    // Through findFirst too, which builds on findMany.
    assert.throws(() => jobs.buildFindFirst({ distinct: ['status'], lock: 'update' }), ValidationError);
  });
});

describe('lock: execution needs a transaction', () => {
  const ops: [ExecOp, unknown][] = [
    ['findMany', { lock: 'update' }],
    ['findFirst', { lock: 'update' }],
    ['findFirstOrThrow', { lock: 'update' }],
    ['findUnique', { where: { id: 1 }, lock: 'update' }],
    ['findUniqueOrThrow', { where: { id: 1 }, lock: 'update' }],
  ];

  for (const [op, args] of ops) {
    it(`${op} outside a transaction is E003 and sends nothing`, async () => {
      const pool = recordingPool();
      await assert.rejects(
        accessor('jobs', pool)[op](args),
        (e: unknown) =>
          e instanceof ValidationError &&
          e.message.includes(`lock on "jobs".${op}() needs a transaction`) &&
          e.message.includes(`db.$transaction(async (tx) => tx.jobs.${op}({ ..., lock }))`),
      );
      assert.deepEqual(pool.seen, []);
    });

    it(`${op} inside a transaction runs the locking statement`, async () => {
      const pool = recordingPool(() => [{ id: 1, status: 'new' }]);
      await accessor('jobs', pool, { _txScoped: true })[op](args);
      assert.equal(pool.seen.length, 1);
      assert.match(pool.seen[0]!, / FOR UPDATE OF "jobs"$/);
    });
  }

  it('an engine with no row locks answers E017 first, not "use a transaction"', async () => {
    const pool = recordingPool();
    await assert.rejects(
      accessor('jobs', pool, { dialect: sqliteDialect }).findMany({ lock: 'update' }),
      UnsupportedFeatureError,
    );
    assert.deepEqual(pool.seen, []);
  });

  it('a malformed lock is E003 before the transaction question', async () => {
    const pool = recordingPool();
    await assert.rejects(
      accessor('jobs', pool).findMany({ lock: 'exclusive' }),
      (e: unknown) => e instanceof ValidationError && /unknown mode 'exclusive'/.test(e.message),
    );
  });

  it('an unlocked read outside a transaction is untouched', async () => {
    const pool = recordingPool();
    await accessor('jobs', pool).findMany({ limit: 1 });
    assert.equal(pool.seen.length, 1);
  });
});

describe('lock: streams refuse it', () => {
  for (const op of ['findManyStream', 'findManyStreamBatches'] as const) {
    it(`${op}, even inside a transaction`, async () => {
      const pool = recordingPool();
      const qi = new QueryInterface(pool as never, 'jobs', schema(), undefined, {
        _txScoped: true,
      }) as unknown as Record<typeof op, (a: unknown) => AsyncGenerator<unknown>>;
      const stream = qi[op]({ lock: 'update' as RowLock });
      await assert.rejects(
        stream.next(),
        (e: unknown) =>
          e instanceof ValidationError &&
          e.message.includes(`lock is not supported on "jobs".${op}()`) &&
          e.message.includes('Page with findMany({ lock, limit }) inside the transaction instead.'),
      );
      assert.deepEqual(pool.seen, []);
    });
  }
});

describe('lock: relation strategies lock only the base statement', () => {
  it("'batched': the base read is locked, the follow-up is not", async () => {
    const pool = recordingPool((sql) => (/FROM "users"/.test(sql) ? [{ id: 1, name: 'a' }] : []));
    await accessor('users', pool, { _txScoped: true }).findMany({
      with: { posts: true },
      relationLoadStrategy: 'batched',
      lock: 'update',
    });
    assert.equal(pool.seen.length, 2, pool.seen.join('\n'));
    assert.match(pool.seen[0]!, /FROM "users".* FOR UPDATE OF "users"$/);
    assert.match(pool.seen[1]!, /FROM "posts"/);
    assert.doesNotMatch(pool.seen[1]!, / FOR /);
  });

  it("'batched' findUnique: same", async () => {
    const pool = recordingPool((sql) => (/FROM "users"/.test(sql) ? [{ id: 1, name: 'a' }] : []));
    await accessor('users', pool, { _txScoped: true }).findUnique({
      where: { id: 1 },
      with: { posts: true },
      relationLoadStrategy: 'batched',
      lock: { mode: 'share', noWait: true },
    });
    assert.match(pool.seen[0]!, / FOR SHARE OF "users" NOWAIT$/);
    assert.doesNotMatch(pool.seen[1]!, / FOR /);
  });
});

describe('lock: the SQL-template cache', () => {
  it('a locked read never shares a template with an unlocked one or another mode', () => {
    const jobs = makeQuery('jobs', schema(), { warnOnUnlimited: false }) as unknown as Q & {
      cacheStats(): { size: number };
    };
    const base = { where: { status: 'new' }, limit: 1 };
    const plain = jobs.buildFindMany(base).sql;
    const update = jobs.buildFindMany({ ...base, lock: 'update' }).sql;
    const share = jobs.buildFindMany({ ...base, lock: 'share' }).sql;
    const skip = jobs.buildFindMany({ ...base, lock: { mode: 'share', skipLocked: true } }).sql;
    // Again, from the cache: each call must get its own statement back.
    assert.equal(jobs.buildFindMany(base).sql, plain);
    assert.equal(jobs.buildFindMany({ ...base, lock: 'update' }).sql, update);
    assert.equal(jobs.buildFindMany({ ...base, lock: { mode: 'share', skipLocked: true } }).sql, skip);
    assert.equal(new Set([plain, update, share, skip]).size, 4);
    assert.equal(jobs.cacheStats().size, 4);
  });

  it('the same for findUnique', () => {
    const jobs = q('jobs');
    const plain = jobs.buildFindUnique({ where: { id: 1 } }).sql;
    const locked = jobs.buildFindUnique({ where: { id: 1 }, lock: 'update' }).sql;
    assert.equal(jobs.buildFindUnique({ where: { id: 1 } }).sql, plain);
    assert.notEqual(locked, plain);
  });

  it('an unlocked read keeps its key: no lock segment', () => {
    const jobs = makeQuery('jobs', schema(), { warnOnUnlimited: false });
    (jobs as unknown as Q).buildFindMany({ limit: 1 });
    (jobs as unknown as Q).buildFindUnique({ where: { id: 1 } });
    (jobs as unknown as Q).buildFindMany({ limit: 1, lock: 'update' });
    const keys = [
      ...(jobs as unknown as { sqlTemplateCache: { cache: Map<string, unknown> } }).sqlTemplateCache.cache.keys(),
    ];
    assert.equal(keys.filter((k) => k.includes('|lk=')).length, 1);
    assert.equal(keys.filter((k) => !k.includes('|lk=')).length, 2);
  });

  it('a locking statement keeps its prepared-statement name (the set is bounded)', () => {
    const jobs = q('jobs');
    const built = jobs.buildFindMany({ limit: 1, lock: { mode: 'update', skipLocked: true } }) as Built & {
      preparedName?: string;
    };
    assert.ok(built.preparedName, 'named');
  });
});

describe('lock: driver errors map to LockNotAvailableError (E013)', () => {
  const driverError = (fields: Record<string, unknown>) => Object.assign(new Error('driver text'), fields);
  const cases: [string, Record<string, unknown>][] = [
    ['PostgreSQL 55P03 (NOWAIT, lock_timeout)', { code: '55P03' }],
    ['MySQL 3572 ER_LOCK_NOWAIT', { code: 'ER_LOCK_NOWAIT', errno: 3572 }],
    ['MySQL 1205 lock wait timeout, as mysql.ts annotates it', { code: '40001', errno: 1205 }],
    ['SQL Server 1222 lock request timeout, as mssql.ts annotates it', { code: '40001', number: 1222 }],
  ];
  for (const [label, fields] of cases) {
    it(label, () => {
      const cause = driverError(fields);
      const err = wrapPgError(cause);
      assert.ok(err instanceof LockNotAvailableError, String(err));
      assert.ok(err instanceof SerializationFailureError, 'existing E013 retry loops still catch it');
      assert.equal(err.code, 'TURBINE_E013');
      assert.equal((err as LockNotAvailableError).isRetryable, true);
      assert.equal(err.cause, cause);
    });
  }

  it('a real serialization failure is not a lock wait', () => {
    const err = wrapPgError(driverError({ code: '40001' }));
    assert.ok(err instanceof SerializationFailureError);
    assert.equal(err instanceof LockNotAvailableError, false);
  });

  it('a deadlock stays a deadlock', () => {
    assert.ok(wrapPgError(driverError({ code: '40P01' })) instanceof DeadlockError);
    // SQL Server's deadlock victim, as mssql.ts annotates it.
    assert.ok(wrapPgError(driverError({ code: '40P01', number: 1205 })) instanceof DeadlockError);
  });
});

describe('lock: PowDB refuses it (E017) on every read entry point, before any statement', () => {
  for (const op of ['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow'] as const) {
    it(op, async () => {
      const sent: string[] = [];
      const pool = {
        async query(powql: string) {
          sent.push(powql);
          return { rows: [], rowCount: 0 };
        },
        async connect(): Promise<never> {
          throw new Error('no connections');
        },
      } as unknown as PowdbPool;
      const qi = new PowqlInterface(pool, 'jobs', schema()) as unknown as Exec;
      await assert.rejects(
        qi[op]({ where: { id: 1 }, lock: { mode: 'update', skipLocked: true } }),
        (e: unknown) =>
          e instanceof UnsupportedFeatureError &&
          e.message.includes('PowDB has no row locks: a transaction holds the single writer gate.'),
      );
      assert.deepEqual(sent, []);
    });
  }
});

describe('lock: an autocommit pipeline refuses a locking read', () => {
  it('names the slot and the way out', () => {
    const jobs = q('jobs');
    const plain = jobs.buildFindMany({ limit: 1 });
    const locked = jobs.buildFindMany({ limit: 1, lock: 'update' });
    assert.doesNotThrow(() => assertNoLockInAutocommitPipeline([plain, plain]));
    assert.throws(
      () => assertNoLockInAutocommitPipeline([plain, locked]),
      (e: unknown) =>
        e instanceof ValidationError &&
        e.message.includes('pipeline query 1 (') &&
        e.message.includes('db.$transaction([...])'),
    );
  });
});

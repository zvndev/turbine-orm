/**
 * `errorMessages` is a property of the CLIENT, on every entry point.
 *
 * 0.66 made the mode per-client instead of last-constructor-wins, by running
 * each operation inside an AsyncLocalStorage scope carrying that client's mode.
 * A review found three paths where the scope was never established, and all
 * three failed in the direction that leaks: a `'safe'` client rendered row
 * VALUES as soon as any `'verbose'` client existed anywhere in the process.
 *
 *   1. A HOISTED DELEGATE. The scoping proxy was built only once two clients
 *      had already diverged, but a delegate is handed out once and kept.
 *      `const users = db.users` at module load, then an analytics client with
 *      `errorMessages: 'verbose'` constructed later, and the safe client's
 *      accessor was a bare unscoped reference forever. Divergence is a property
 *      of the process over TIME; the old check asked the question at the wrong
 *      moment.
 *   2. `pipeline()`. It builds NotFoundErrors (a `buildFindUniqueOrThrow` slot)
 *      and wraps driver errors, entirely outside any scope.
 *   3. `client.sql`. `withErrorMode`'s own docstring listed the typed-SQL
 *      builder as covered. It was not, and the adjacent `raw` tag WAS, so two
 *      raw-SQL entry points disagreed about the same statement. The subtlety
 *      that hid it: `TypedSqlQuery` is LAZY, so a scope wrapped around the
 *      tagged-template call is torn down before a row is fetched. The scope has
 *      to reach the execution, which is why it is now a constructor parameter.
 *
 * Every test here constructs a `'verbose'` client to force divergence, then
 * asserts the `'safe'` client still redacts. Without the divergence the module
 * default already answers 'safe' and every assertion would pass vacuously, which
 * is exactly how this class of bug survived: `clientModesDiverged` is
 * process-wide and monotonic, so the ORDER below is load-bearing and each test
 * establishes it for itself rather than relying on a previous one.
 *
 * Run: npx tsx --test src/test/error-mode-scoping.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, TurbineClient } from '../client.js';
import { NotFoundError, REDACTED_DETAIL, UniqueConstraintError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

/** The value that must never reach a message or a `.cause` under 'safe'. */
const SECRET = 'alice@example.com';

function probeSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      users: {
        // mockTable's third parameter is `relations`, not options, so the
        // unique constraint is applied afterwards. `email` has to be unique for
        // `findUniqueOrThrow` to accept it as a selector.
        ...mockTable('users', [
          { name: 'id', field: 'id', pgType: 'int4' },
          { name: 'email', field: 'email', pgType: 'text' },
        ]),
        primaryKey: ['id'],
        uniqueColumns: [['email']],
      },
    },
  };
}

/** A pg-compatible pool that answers every statement with zero rows. */
function emptyPool(): PgCompatPool {
  const answer = async () => ({ rows: [], rowCount: 0 });
  return {
    query: answer,
    connect: async () => ({ query: answer, release: () => {} }),
    end: async () => {},
  } as unknown as PgCompatPool;
}

/**
 * A pool that fails every real statement with a pg 23505 carrying the value,
 * while letting transaction control through.
 *
 * The BEGIN/COMMIT exemption is not cosmetic. Failing those too made the
 * pipeline test pass on BROKEN code: the pipeline's `BEGIN` is issued outside
 * the block that calls `wrapPgError`, so a failure there propagates as the raw
 * driver error, which carries no `.cause` for the assertion to inspect. The
 * test was green for a reason that had nothing to do with what it claimed to
 * check, which is the exact shape this file exists to prevent.
 */
function conflictPool(): PgCompatPool {
  const run = async (text: string) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [], rowCount: 0 };
    throw Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), {
      code: '23505',
      detail: `Key (email)=(${SECRET}) already exists.`,
      table: 'users',
      constraint: 'users_email_key',
    });
  };
  return {
    query: run,
    connect: async () => ({ query: run, release: () => {} }),
    end: async () => {},
  } as unknown as PgCompatPool;
}

/**
 * A `'safe'` client plus a `'verbose'` one, in that order, so the safe client's
 * accessors are handed out BEFORE the process diverges. That order is the
 * reproduction for case 1 and harmless for the others.
 */
function divergedPair(pool: PgCompatPool): { safe: TurbineClient; verbose: TurbineClient } {
  const safe = new TurbineClient({ pool, errorMessages: 'safe' }, probeSchema());
  const verbose = new TurbineClient({ pool: emptyPool(), errorMessages: 'verbose' }, probeSchema());
  return { safe, verbose };
}

describe('errorMessages scoping: a hoisted delegate keeps its client mode', () => {
  it('redacts on an accessor captured before another client diverged', async () => {
    const pool = emptyPool();
    const safe = new TurbineClient({ pool, errorMessages: 'safe' }, probeSchema());

    // The reproduction: capture the delegate FIRST. Before the fix this was the
    // bare QueryInterface, and it stayed bare for the life of the process.
    const users = safe.table('users');

    // ...and only now does a second client diverge the process.
    new TurbineClient({ pool: emptyPool(), errorMessages: 'verbose' }, probeSchema());

    const err = await users.findUniqueOrThrow({ where: { email: SECRET } as never }).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof NotFoundError, `expected NotFoundError, got ${String(err)}`);
    assert.ok(!err.message.includes(SECRET), `message leaked the value: ${err.message}`);
    assert.ok(err.message.includes('email'), `message should still name the KEY: ${err.message}`);
    // The structured field is deliberately never redacted, only the message is.
    assert.deepEqual(err.where, { email: SECRET });
  });

  it('still renders values for a verbose client in the same process', async () => {
    const { verbose } = divergedPair(emptyPool());
    const err = await verbose
      .table('users')
      .findUniqueOrThrow({ where: { email: SECRET } as never })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    assert.ok(err instanceof NotFoundError);
    assert.ok(err.message.includes(SECRET), `verbose should render the value: ${err.message}`);
  });
});

describe('errorMessages scoping: pipeline', () => {
  it('redacts a NotFoundError raised inside a pipeline slot', async () => {
    const { safe } = divergedPair(emptyPool());
    const users = safe.table('users');
    const err = await safe.pipeline([users.buildFindUniqueOrThrow({ where: { email: SECRET } as never })]).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error, `expected an error, got ${String(err)}`);
    assert.ok(!err.message.includes(SECRET), `pipeline message leaked the value: ${err.message}`);
  });

  it('redacts a wrapped driver error raised inside a pipeline slot', async () => {
    const { safe } = divergedPair(conflictPool());
    const users = safe.table('users');
    const err = await safe.pipeline([users.buildCreate({ data: { email: SECRET } as never })]).then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof Error, `expected an error, got ${String(err)}`);
    const seen = JSON.stringify({ m: err.message, c: describeCause(err) });
    assert.ok(!seen.includes(SECRET), `pipeline cause leaked the value: ${seen}`);
  });
});

describe('errorMessages scoping: client.sql', () => {
  it('redacts the driver cause of a typed-SQL statement', async () => {
    const { safe } = divergedPair(conflictPool());
    const err = await safe.sql`INSERT INTO users (email) VALUES (${SECRET})`.then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof UniqueConstraintError, `expected UniqueConstraintError, got ${String(err)}`);
    const cause = err.cause as { detail?: string } | undefined;
    assert.equal(cause?.detail, REDACTED_DETAIL, `typed SQL leaked the driver detail: ${cause?.detail}`);
  });

  it('scopes .one() and .scalar(), not only await', async () => {
    const { safe } = divergedPair(conflictPool());
    for (const run of [() => safe.sql`SELECT 1`.one(), () => safe.sql`SELECT 1`.scalar()]) {
      const err = await run().then(
        () => undefined,
        (e: unknown) => e,
      );
      assert.ok(err instanceof UniqueConstraintError);
      assert.equal((err.cause as { detail?: string }).detail, REDACTED_DETAIL);
    }
  });

  it('leaves the driver cause intact for a verbose client', async () => {
    const pool = conflictPool();
    new TurbineClient({ pool: emptyPool(), errorMessages: 'safe' }, probeSchema());
    const verbose = new TurbineClient({ pool, errorMessages: 'verbose' }, probeSchema());
    const err = await verbose.sql`INSERT INTO users (email) VALUES (${SECRET})`.then(
      () => undefined,
      (e: unknown) => e,
    );
    assert.ok(err instanceof UniqueConstraintError);
    assert.ok(
      (err.cause as { detail?: string }).detail?.includes(SECRET),
      'verbose must keep the driver detail for diagnosis',
    );
  });
});

/** Flatten whatever a thrown error carries, so a leak anywhere is visible. */
function describeCause(err: Error): unknown {
  const cause = (err as { cause?: unknown }).cause;
  if (cause === undefined) return undefined;
  if (cause instanceof Error) {
    return { message: cause.message, ...(cause as unknown as Record<string, unknown>) };
  }
  return cause;
}

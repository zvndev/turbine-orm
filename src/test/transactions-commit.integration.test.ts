/**
 * turbine-orm: a COMMIT that PostgreSQL answers with ROLLBACK is a failure.
 *
 * Any statement error aborts a PostgreSQL transaction. When the callback
 * catches that error and returns normally, the COMMIT that follows is answered
 * with the command tag `ROLLBACK` and no error, so every write in the
 * transaction is gone. `$transaction` must reject in that case, carrying the
 * statement that failed first as `cause`, instead of resolving as if it had
 * committed. A nested `tx.$transaction` block whose callback swallowed an error
 * is rolled back to its savepoint and rejects the same way, which leaves the
 * outer transaction usable.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/transactions-commit.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import type { TurbineClient } from '../client.js';
import { SerializationFailureError, UniqueConstraintError, ValidationError } from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

/** The rejection every swallowed-failure case must produce. */
function rolledBack(expectedCause?: new (...args: never[]) => Error) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof Error, `expected an Error, got ${String(err)}`);
    assert.match(err.message, /rolled back, not (committed|released)/, err.message);
    if (expectedCause) {
      assert.ok(
        err.cause instanceof expectedCause,
        `expected cause ${expectedCause.name}, got ${String((err as { cause?: unknown }).cause)}`,
      );
    }
    return true;
  };
}

describe('transactions: COMMIT answered with ROLLBACK rejects (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;
  const users = () => db.table<{ id: number; email: string }>(fx.t.users);

  before(async () => {
    fx = await openFixture('tx90c');
    db = fx.client();
  });
  beforeEach(async () => {
    await fx.reset();
  });
  after(async () => {
    await fx?.close();
  });

  it('interactive: a caught duplicate insert makes $transaction reject, and nothing is saved', async () => {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.table(fx.t.users).create({ data: { email: 'k1@x' } });
        try {
          await tx.table(fx.t.users).create({ data: { email: 'a@x' } });
        } catch {
          // the everyday "ignore the duplicate" pattern
        }
        return 'resolved ok';
      }),
      rolledBack(UniqueConstraintError),
    );
    assert.equal(await fx.count(fx.t.users, "email = 'k1@x'"), 0, 'the earlier insert is gone, so success was false');
  });

  it('interactive: the rejection is E003 when the first failure is not retryable', async () => {
    await assert.rejects(
      db.$transaction(async (tx) => {
        try {
          await tx.raw`SELECT 1/0`;
        } catch {}
      }),
      (err: unknown) => err instanceof ValidationError && err.code === 'TURBINE_E003',
    );
  });

  it('interactive: a retryable first failure keeps its class, so $retry can retry the whole transaction', async () => {
    let attempts = 0;
    await assert.rejects(
      db.$retry(
        () =>
          db.$transaction(async (tx) => {
            attempts++;
            try {
              await tx.raw`DO $$ BEGIN RAISE EXCEPTION 'conflict' USING ERRCODE = '40001'; END $$`;
            } catch {}
          }),
        { maxAttempts: 3, baseDelay: 1 },
      ),
      (err: unknown) => {
        assert.ok(err instanceof SerializationFailureError, String(err));
        assert.equal(err.isRetryable, true);
        assert.match(err.message, /rolled back, not committed/);
        return true;
      },
    );
    assert.equal(attempts, 3, 'every attempt was retried');
  });

  it('$withSession: same rule', async () => {
    await assert.rejects(
      db.$withSession({ 'app.tenant': 't1' }, async (tx) => {
        await tx.table(fx.t.users).create({ data: { email: 'k2@x' } });
        try {
          await tx.table(fx.t.users).create({ data: { email: 'a@x' } });
        } catch {}
      }),
      rolledBack(UniqueConstraintError),
    );
    assert.equal(await fx.count(fx.t.users, "email = 'k2@x'"), 0);
  });

  it('raw transaction(): a caught failure on the raw client rejects too', async () => {
    await assert.rejects(
      db.transaction(async (client) => {
        await client.query(`INSERT INTO ${fx.t.users} (email) VALUES ('k3@x')`);
        try {
          await client.query(`INSERT INTO ${fx.t.users} (email) VALUES ('a@x')`);
        } catch {}
      }),
      rolledBack(),
    );
    assert.equal(await fx.count(fx.t.users, "email = 'k3@x'"), 0);
  });

  it('nested: a block that swallowed a failure rejects, and the outer transaction still commits its own work', async () => {
    let nestedError: unknown;
    const result = await db.$transaction(async (tx) => {
      await tx.table(fx.t.users).create({ data: { email: 'outer1@x' } });
      try {
        await tx.$transaction(async (inner) => {
          await inner.table(fx.t.users).create({ data: { email: 'inner@x' } });
          try {
            await inner.table(fx.t.users).create({ data: { email: 'a@x' } });
          } catch {}
          return 'inner resolved';
        });
      } catch (err) {
        nestedError = err;
      }
      await tx.table(fx.t.users).create({ data: { email: 'outer2@x' } });
      return 'outer ok';
    });
    assert.equal(result, 'outer ok');
    rolledBack(UniqueConstraintError)(nestedError);
    assert.equal(await fx.count(fx.t.users, "email IN ('outer1@x', 'outer2@x')"), 2, 'outer work committed');
    assert.equal(await fx.count(fx.t.users, "email = 'inner@x'"), 0, 'the nested block was rolled back');
  });

  it('nested: a block that rejected on its own is rolled back and the outer transaction continues', async () => {
    await db.$transaction(async (tx) => {
      await assert.rejects(
        tx.$transaction(async (inner) => {
          await inner.table(fx.t.users).create({ data: { email: 'gone@x' } });
          await inner.table(fx.t.users).create({ data: { email: 'a@x' } });
        }),
        UniqueConstraintError,
      );
      await tx.table(fx.t.users).create({ data: { email: 'kept@x' } });
    });
    assert.equal(await fx.count(fx.t.users, "email = 'kept@x'"), 1);
    assert.equal(await fx.count(fx.t.users, "email = 'gone@x'"), 0);
  });

  it('a failure undone by a savepoint is not reported as the cause of a later rollback', async () => {
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx
          .$transaction(async (inner) => inner.table(fx.t.users).create({ data: { email: 'a@x' } }))
          .catch(() => {});
        try {
          await tx.raw`SELECT 1/0`;
        } catch {}
      }),
      (err: unknown) => {
        rolledBack()(err);
        const cause = (err as { cause?: unknown }).cause;
        assert.ok(!(cause instanceof UniqueConstraintError), 'the savepoint already undid the duplicate');
        return true;
      },
    );
  });

  it('an ordinary transaction still commits and resolves with the callback value', async () => {
    const value = await db.$transaction(async (tx) => {
      await users().count();
      await tx.table(fx.t.users).create({ data: { email: 'fine@x' } });
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(await fx.count(fx.t.users, "email = 'fine@x'"), 1);
  });
});

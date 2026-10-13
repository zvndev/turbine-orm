/**
 * turbine-orm: transaction lifecycle against a live PostgreSQL.
 *
 * What these pin, each with the server as the witness rather than the client:
 *   - a timed-out transaction is stopped ON THE SERVER before `$transaction`
 *     rejects, so the row locks it took are free at that moment;
 *   - a callback that returns while its own query is still running rolls the
 *     transaction back (E003) instead of committing part of the work;
 *   - `transaction(fn)` hands out a client that is closed when the
 *     transaction settles, and that refuses `release()`;
 *   - a statement the callback issues while a savepoint block it opened is
 *     still running waits for that block, so the block's rollback cannot undo
 *     it;
 *   - a nested block opened from a callback that lost the async context (a
 *     timer created before the transaction) runs instead of hanging;
 *   - `readOnly`, `tx.sql`, and the `sessionContext` name rules.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/client-v090-transactions.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe, beforeEach as eachTest } from 'node:test';
import pg from 'pg';
import type { PgCompatPoolClient, TransactionClient, TurbineClient } from '../client.js';
import { TimeoutError, TransactionRolledBackError, ValidationError } from '../errors.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, openFixture, sleep, type TxFixture } from './transactions-fixture.js';

const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');
const beforeEach: typeof eachTest = DATABASE_URL ? eachTest : () => {};

function e019(pattern: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof TransactionRolledBackError, `expected TransactionRolledBackError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E019');
    assert.match(err.message, pattern, err.message);
    return true;
  };
}

function e003(pattern: RegExp) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.match(err.message, pattern, err.message);
    return true;
  };
}

/** Reject if `work` has not settled within `ms`: a hang becomes a failure, not a stuck run. */
function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function openClient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  return client;
}

describe('transaction lifecycle (live Postgres)', () => {
  let fx: TxFixture;
  let db: TurbineClient;
  let single: TurbineClient;

  before(async () => {
    fx = await openFixture('c90t');
    db = fx.client({ poolSize: 4 });
    single = fx.client({ poolSize: 1 });
  });
  beforeEach(async () => {
    await fx.reset();
  });
  after(async () => {
    await fx?.close();
  });

  it('a timed-out transaction is stopped on the server before it rejects, so its locks are free', async () => {
    const { counters } = fx.t;
    const locker = await openClient();
    const probe = await openClient();
    try {
      await locker.query('BEGIN');
      await locker.query(`SELECT * FROM ${counters} WHERE id = 1 FOR UPDATE`);
      const started = Date.now();
      await assert.rejects(
        db.$transaction(
          async (tx) => {
            await tx.rawUnsafe(`UPDATE ${counters} SET n = n + 1 WHERE id = 2`);
            // Waits on `locker` until the timeout.
            await tx.rawUnsafe(`UPDATE ${counters} SET n = n + 1 WHERE id = 1`);
          },
          { timeout: 300 },
        ),
        (err: unknown) => err instanceof TimeoutError && /cancelled on the server/.test(err.message),
      );
      const elapsed = Date.now() - started;
      // Without the cancel, the ROLLBACK queues behind the blocked UPDATE until
      // the 2s grace period gives up on the connection.
      assert.ok(elapsed < 2000, `rejected after ${elapsed}ms; the rollback waited on the blocked statement`);

      // Row 2 was locked by the timed-out transaction. With lock_timeout set,
      // a write to it fails at once if that transaction is still alive.
      await probe.query('BEGIN');
      await probe.query("SELECT set_config('lock_timeout', '300', true)");
      await probe.query(`UPDATE ${counters} SET n = n + 10 WHERE id = 2`);
      await probe.query('COMMIT');

      const waiting = await fx.raw.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${counters}%`],
      );
      assert.equal(waiting.rows[0].n, 0, 'a backend is still waiting on the lock');
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      await locker.end();
      await probe.end();
    }
    const rows = await fx.raw.query(`SELECT id, n FROM ${counters} ORDER BY id`);
    assert.deepEqual(rows.rows, [
      { id: 1, n: 100 },
      { id: 2, n: 10 },
    ]);
    // The connection the timeout stopped is reusable, or was replaced.
    assert.equal((await db.rawUnsafe<{ one: number }>('SELECT 1 AS one'))[0]?.one, 1);
  });

  describe('a per-query timeout inside $transaction', () => {
    /** Holds counter 1's row lock until `release`, so an update of it waits. */
    async function holdCounterOne(): Promise<{ release: () => Promise<void> }> {
      const locker = await openClient();
      await locker.query('BEGIN');
      await locker.query(`SELECT * FROM ${fx.t.counters} WHERE id = 1 FOR UPDATE`);
      return {
        release: async () => {
          await locker.query('ROLLBACK').catch(() => {});
          await locker.end();
        },
      };
    }
    const cancelledInTx = (err: unknown): boolean => {
      assert.ok(err instanceof TimeoutError, `expected TimeoutError, got ${String(err)}`);
      assert.equal(err.outcome, 'not-executed');
      assert.match(err.message, /cancelled on the server, so it made no change[\s\S]*rolls back instead of committing/);
      return true;
    };

    it('cancels the statement on the server, and the transaction rolls back', async () => {
      const { users, counters } = fx.t;
      const lock = await holdCounterOne();
      try {
        const started = Date.now();
        await assert.rejects(
          within(
            db.$transaction(async (tx) => {
              await tx.table(users).create({ data: { email: 'q-timeout@x' } });
              await tx.table(counters).update({ where: { id: 1 }, data: { n: 7 }, timeout: 150 });
            }),
            3000,
            'the timed-out transaction',
          ),
          cancelledInTx,
        );
        assert.ok(Date.now() - started < 1500, 'the cancel stopped the wait, not the lock holder');
        const waiting = await fx.raw.query(
          `SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
          [`%${counters}%`],
        );
        assert.equal(waiting.rows[0].n, 0, 'the timed-out statement is still waiting on the server');
      } finally {
        await lock.release();
      }
      assert.equal(await fx.count(users, "email = 'q-timeout@x'"), 0);
    });

    it('a callback that catches the timeout and returns cannot commit what came before it', async () => {
      const { users, counters } = fx.t;
      const lock = await holdCounterOne();
      let caught: unknown;
      try {
        await assert.rejects(
          within(
            db.$transaction(async (tx) => {
              await tx.table(users).create({ data: { email: 'q-caught@x' } });
              try {
                await tx.table(counters).update({ where: { id: 1 }, data: { n: 7 }, timeout: 150 });
              } catch (err) {
                caught = err;
              }
              return 'done';
            }),
            3000,
            'the transaction whose callback caught the timeout',
          ),
          (err: unknown) => {
            e019(/rolled back, not committed/)(err);
            assert.equal((err as Error).cause, caught);
            return true;
          },
        );
      } finally {
        await lock.release();
      }
      assert.ok(cancelledInTx(caught));
      assert.equal(await fx.count(users, "email = 'q-caught@x'"), 0);
    });

    it('in a nested tx.$transaction, only that block rolls back and the rest commits', async () => {
      const { users, counters } = fx.t;
      const lock = await holdCounterOne();
      try {
        await within(
          db.$transaction(async (tx) => {
            await tx.table(users).create({ data: { email: 'q-outer@x' } });
            await assert.rejects(
              tx.$transaction(async (inner) => {
                await inner.table(users).create({ data: { email: 'q-inner@x' } });
                await inner.table(counters).update({ where: { id: 1 }, data: { n: 7 }, timeout: 150 });
              }),
              cancelledInTx,
            );
            await tx.table(users).create({ data: { email: 'q-after@x' } });
          }),
          3000,
          'the transaction with a timed-out nested block',
        );
      } finally {
        await lock.release();
      }
      assert.equal(await fx.count(users, "email IN ('q-outer@x', 'q-after@x')"), 2);
      assert.equal(await fx.count(users, "email = 'q-inner@x'"), 0);
    });

    it('a statement that finishes in time is unaffected', async () => {
      const n = await db.$transaction(async (tx) => tx.table(fx.t.counters).count({ where: { id: 1 }, timeout: 2000 }));
      assert.equal(n, 1);
    });
  });

  it('a callback that returns while its query is still running rolls everything back, including awaited work', async () => {
    const { users, posts } = fx.t;
    const locker = await openClient();
    try {
      // Holding the email makes the un-awaited insert wait on the unique index.
      await locker.query('BEGIN');
      await locker.query(`INSERT INTO ${users} (email) VALUES ('held@x')`);
      let late: Promise<unknown> | undefined;
      await assert.rejects(
        within(
          db.$transaction(async (tx) => {
            await tx.table(users).create({ data: { email: 'awaited@x' } });
            late = tx.table(users).create({
              data: { email: 'held@x', posts: { create: [{ title: 'n1' }, { title: 'n2' }] } },
            });
            late.catch(() => {});
            await sleep(80);
          }),
          4000,
          '$transaction',
        ),
        e003(/callback returned while a query it started on the transaction was still running/),
      );
      await late?.catch(() => {});
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      await locker.end();
    }
    assert.equal(await fx.count(users, "email IN ('awaited@x', 'held@x')"), 0, 'part of the work was committed');
    assert.equal(await fx.count(posts, "title IN ('n1', 'n2')"), 0);
  });

  it('a statement issued while an earlier savepoint block is open waits for it, and survives its rollback', async () => {
    const { users } = fx.t;
    await db.$transaction(async (tx) => {
      const block = tx
        .$transaction(async (b) => {
          await b.rawUnsafe(`INSERT INTO ${users} (email) VALUES ('in-block@x')`);
          await sleep(60);
          throw new Error('undo the block');
        })
        .catch((err: unknown) => err);
      await sleep(20);
      // Issued while the block is open (its SAVEPOINT is set, its insert ran).
      // Sent at once, it would run inside the block's savepoint and be rolled
      // back with it.
      await tx.rawUnsafe(`INSERT INTO ${users} (email) VALUES ('parent@x')`);
      assert.match(String(await block), /undo the block/);
    });
    assert.equal(await fx.count(users, "email = 'parent@x'"), 1, "the parent's insert was undone by the block");
    assert.equal(await fx.count(users, "email = 'in-block@x'"), 0);
  });

  it('a nested block opened from a callback that lost the async context runs instead of hanging', async () => {
    const { users } = fx.t;
    // A job queue whose timer exists before the transaction: its callbacks run
    // in the timer's context, which knows nothing of the transaction.
    const jobs: Array<() => void> = [];
    const timer = setInterval(() => jobs.shift()?.(), 5);
    try {
      await within(
        db.$transaction(async (tx) => {
          await tx.$transaction(async (outer) => {
            await outer.rawUnsafe(`INSERT INTO ${users} (email) VALUES ('outer@x')`);
            await new Promise<void>((resolve, reject) => {
              jobs.push(() => {
                outer
                  .$transaction(async (inner: TransactionClient) => {
                    await inner.rawUnsafe(`INSERT INTO ${users} (email) VALUES ('from-job@x')`);
                  })
                  .then(resolve, reject);
              });
            });
          });
        }),
        4000,
        'the transaction with a lost-context nested block',
      );
    } finally {
      clearInterval(timer);
    }
    assert.equal(await fx.count(users, "email IN ('outer@x', 'from-job@x')"), 2);
  });

  it('transaction(fn): the client is closed when the transaction settles, even with the connection reused', async () => {
    const { users } = fx.t;
    let leaked: PgCompatPoolClient | undefined;
    await single.transaction(async (client) => {
      leaked = client;
      await client.query('SELECT 1');
    });
    // Request B now holds the only connection, the one `leaked` was bound to.
    const requestB = single.transaction(async (client) => {
      await client.query(`INSERT INTO ${users} (email) VALUES ('B@x')`);
      await sleep(120);
    });
    await sleep(30);
    await assert.rejects(leaked!.query(`INSERT INTO ${users} (email) VALUES ('A-late@x')`), (err: unknown) => {
      e003(/This transaction committed[\s\S]*inside the `transaction` callback/)(err);
      assert.doesNotMatch((err as Error).message, /\$transaction|`tx`/, 'names an API the caller did not use');
      return true;
    });
    await requestB;
    assert.equal(await fx.count(users, "email = 'A-late@x'"), 0, 'the late write ran in the next transaction');
    assert.equal(await fx.count(users, "email = 'B@x'"), 1);
  });

  it('transaction(fn): a caught failure still rolls back, and the error names a fix for this API', async () => {
    const { users } = fx.t;
    await assert.rejects(
      single.transaction(async (client) => {
        await client.query(`INSERT INTO ${users} (email) VALUES ('kept?@x')`);
        await client.query('SELECT 1/0').catch(() => {});
      }),
      (err: unknown) => {
        e019(/rolled back, not committed[\s\S]*ROLLBACK TO SAVEPOINT/)(err);
        assert.doesNotMatch((err as Error).message, /tx\.\$transaction/);
        return true;
      },
    );
    assert.equal(await fx.count(users, "email = 'kept?@x'"), 0);
  });

  it('transaction(fn): the callback may not release the client, and the connection survives the attempt', async () => {
    const { users } = fx.t;
    await assert.rejects(
      single.transaction(async (client) => {
        await client.query(`INSERT INTO ${users} (email) VALUES ('released@x')`);
        client.release();
      }),
      e003(/must not release its client/),
    );
    assert.equal(await fx.count(users, "email = 'released@x'"), 0);
    assert.equal((await single.rawUnsafe<{ one: number }>('SELECT 1 AS one'))[0]?.one, 1);
  });

  it('transaction(fn): an un-awaited query rolls the transaction back', async () => {
    const { users } = fx.t;
    const locker = await openClient();
    try {
      await locker.query('BEGIN');
      await locker.query(`INSERT INTO ${users} (email) VALUES ('raw-held@x')`);
      let late: Promise<unknown> | undefined;
      await assert.rejects(
        within(
          single.transaction(async (client) => {
            await client.query(`INSERT INTO ${users} (email) VALUES ('raw-awaited@x')`);
            late = client.query(`INSERT INTO ${users} (email) VALUES ('raw-held@x')`);
            late.catch(() => {});
            await sleep(60);
          }),
          4000,
          'transaction()',
        ),
        e003(/`transaction` callback returned while a query/),
      );
      await late?.catch(() => {});
    } finally {
      await locker.query('ROLLBACK').catch(() => {});
      await locker.end();
    }
    assert.equal(await fx.count(users, "email LIKE 'raw-%'"), 0);
  });

  it('readOnly: reads run, a write is refused by the server, and isolation combines with it', async () => {
    const { users } = fx.t;
    const seen = await db.$transaction(
      async (tx) => {
        const r = await tx.rawUnsafe<{ ro: string; iso: string }>(
          "SELECT current_setting('transaction_read_only') AS ro, current_setting('transaction_isolation') AS iso",
        );
        return { ...r[0], users: await tx.table(users).count() };
      },
      { readOnly: true, isolationLevel: 'RepeatableRead' },
    );
    assert.deepEqual(seen, { ro: 'on', iso: 'repeatable read', users: 3 });
    // SQLSTATE 25006, read_only_sql_transaction: the server refused the write.
    const refusedByServer = (err: unknown): boolean => {
      const e = err as { code?: string; cause?: { code?: string } };
      assert.equal(e.cause?.code ?? e.code, '25006', String(err));
      return true;
    };
    await assert.rejects(
      db.$transaction(async (tx) => tx.table(users).create({ data: { email: 'ro@x' } }), { readOnly: true }),
      refusedByServer,
    );
    await assert.rejects(
      db.$transaction([db.table(users).buildCreate({ data: { email: 'ro2@x' } })], { readOnly: true }),
      refusedByServer,
    );
    assert.equal(await fx.count(users, "email IN ('ro@x', 'ro2@x')"), 0);
  });

  it('tx.sql runs typed SQL inside the transaction and is closed with it', async () => {
    assert.equal(fx.t.users, 'c90t_users', 'the statements below name the table literally');
    let kept: TransactionClient | undefined;
    const out = await db.$transaction(async (tx) => {
      kept = tx;
      await tx.table(fx.t.users).create({ data: { email: 'typed@x' } });
      const email = 'typed@x';
      // Sees the transaction's own uncommitted row.
      const rows = await tx.sql<{ email: string }>`SELECT email FROM c90t_users WHERE email = ${email}`;
      const one = await tx.sql<{ email: string }>`SELECT email FROM c90t_users WHERE email = ${email}`.one();
      const n = await tx.sql`SELECT 41 + ${1}::int AS n`.scalar<number>();
      return { rows, one, n };
    });
    assert.deepEqual(out, { rows: [{ email: 'typed@x' }], one: { email: 'typed@x' }, n: 42 });
    assert.throws(() => kept!.sql`SELECT 1`, e003(/This transaction committed/));
  });

  it('tx.$connection(): runs inside the transaction, rolls back with it, and is closed after it', async () => {
    const { users } = fx.t;
    let kept: PgCompatPoolClient | undefined;
    const seen = await db.$transaction(async (tx) => {
      const conn = tx.$connection();
      kept = conn;
      assert.equal(tx.$connection(), conn, 'one handle per transaction');
      await conn.query(`INSERT INTO ${users} (email) VALUES ('handle@x')`);
      const mine = await tx.table(users).count({ where: { email: 'handle@x' } });
      const pid = (await conn.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      const txPid = (await tx.rawUnsafe<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid;
      assert.throws(() => conn.release(), e003(/must not release its client/));
      return { mine, sameBackend: pid === txPid };
    });
    assert.deepEqual(seen, { mine: 1, sameBackend: true });
    assert.equal(await fx.count(users, "email = 'handle@x'"), 1);
    await assert.rejects(kept!.query('SELECT 1'), e003(/This transaction committed/));

    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.$connection().query(`INSERT INTO ${users} (email) VALUES ('handle-rolled@x')`);
        throw new Error('stop');
      }),
      /stop/,
    );
    assert.equal(await fx.count(users, "email = 'handle-rolled@x'"), 0);
  });

  it('sessionContext: a namespaced name is set for the transaction only', async () => {
    const inTx = await single.$transaction(
      async (tx) => (await tx.rawUnsafe<{ v: string }>("SELECT current_setting('app.tenant', true) AS v"))[0]?.v,
      { sessionContext: { 'app.tenant': 'tenant-9' } },
    );
    assert.equal(inTx, 'tenant-9');
    const after = (await single.rawUnsafe<{ v: string | null }>("SELECT current_setting('app.tenant', true) AS v"))[0]
      ?.v;
    assert.ok(after === '' || after === null, `the setting outlived the transaction: ${after}`);
  });

  it('sessionContext: a built-in setting needs allowBuiltinSettings, and then is transaction-local', async () => {
    await assert.rejects(
      single.$transaction(async () => {}, { sessionContext: { statement_timeout: '1234' } }),
      e003(/names a PostgreSQL setting/),
    );
    const inTx = await single.$transaction(
      async (tx) => (await tx.rawUnsafe<{ statement_timeout: string }>('SHOW statement_timeout'))[0]?.statement_timeout,
      { sessionContext: { statement_timeout: '1234' }, allowBuiltinSettings: ['statement_timeout'] },
    );
    assert.equal(inTx, '1234ms');
    const after = (await single.rawUnsafe<{ statement_timeout: string }>('SHOW statement_timeout'))[0];
    assert.notEqual(after?.statement_timeout, '1234ms', 'the built-in setting leaked onto the pooled connection');
  });

  it('sessionContext: a value the server refuses names the setting and what was wrong', async () => {
    await assert.rejects(
      db.$transaction(async () => 'never', {
        sessionContext: { role: 'no_such_role_c90' },
        allowBuiltinSettings: ['role'],
      }),
      (err: unknown) => {
        e003(/sessionContext\["role"\] was refused by the server: .*the role must exist.*SQLSTATE 22023/)(err);
        assert.equal((err as { cause?: { code?: string } }).cause?.code, '22023');
        return true;
      },
    );
    await assert.rejects(
      db.$transaction(async () => 'never', {
        sessionContext: { no_such_setting_c90: 'x' },
        allowBuiltinSettings: ['no_such_setting_c90'],
      }),
      e003(/sessionContext\["no_such_setting_c90"\] was refused by the server: the server has no setting/),
    );
  });
});

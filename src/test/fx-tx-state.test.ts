/**
 * turbine-orm: what a transaction does after one of its statements failed, which
 * `tx` a statement came through, and which raw SQL a transaction accepts.
 *
 * Runs against a fake connection that keeps PostgreSQL's rule: once a statement
 * fails, every statement except a rollback to a savepoint is answered with
 * SQLSTATE 25P02 until one is accepted, and a COMMIT in that state is answered
 * with the command tag ROLLBACK. The fake logs everything it is sent, so a
 * statement Turbine refuses before sending is visible as one that never arrived.
 * `fx-tx-live.integration.test.ts` runs the same cases on a real server.
 *
 * No database.
 *
 * Run: npx tsx --test src/test/fx-tx-state.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { type PgCompatPool, type PgCompatPoolClient, type TransactionClient, TurbineClient } from '../client.js';
import {
  DeadlockError,
  LockNotAvailableError,
  SerializationFailureError,
  TransactionRolledBackError,
  ValidationError,
} from '../errors.js';
import { mysqlDialect } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: { items: mockTable('items', [{ name: 'id', field: 'id', pgType: 'int4' }]) },
  enums: {},
};

/** A pg server error as the driver throws it. */
function serverError(code: string, message = `pg ${code}`): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

interface Fake {
  pool: PgCompatPool;
  /** Every statement text the connection received, in order. */
  sent: string[];
  /** Whether the fake server currently considers the transaction aborted. */
  readonly aborted: boolean;
}

/**
 * A connection with PostgreSQL's abort rule (or none, `abortsOnError: false`,
 * which is how MySQL behaves). A statement containing `FAIL <code>` fails with
 * that SQLSTATE; one containing `CLIENTFAIL` fails without ever reaching the
 * server, as a value the driver cannot serialize does.
 */
function fakeServer(options: { abortsOnError?: boolean } = {}): Fake {
  const abortsOnError = options.abortsOnError ?? true;
  const sent: string[] = [];
  const savepoints: string[] = [];
  let aborted = false;
  const client = {
    async query(text: string | { text: string }) {
      const sql = typeof text === 'string' ? text : text.text;
      sent.push(sql);
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith('ROLLBACK TO')) {
        const name = sql.trim().split(/\s+/).pop() as string;
        if (!savepoints.includes(name)) throw serverError('3B001', 'no such savepoint');
        savepoints.length = savepoints.indexOf(name) + 1;
        aborted = false;
        return { rows: [], rowCount: 0, command: 'ROLLBACK' };
      }
      if (upper === 'COMMIT') {
        const rolledBack = aborted;
        aborted = false;
        return { rows: [], rowCount: 0, command: rolledBack ? 'ROLLBACK' : 'COMMIT' };
      }
      if (upper === 'ROLLBACK') {
        aborted = false;
        return { rows: [], rowCount: 0, command: 'ROLLBACK' };
      }
      if (aborted)
        throw serverError('25P02', 'current transaction is aborted, commands ignored until end of transaction block');
      if (upper.includes('CLIENTFAIL')) throw new Error('Do not know how to serialize a BigInt');
      const fail = /FAIL (\w{5})/i.exec(sql);
      if (fail) {
        if (abortsOnError) aborted = true;
        throw serverError(fail[1]!.toUpperCase());
      }
      const savepoint = /^SAVEPOINT (\w+)/i.exec(sql.trim());
      if (savepoint) savepoints.push(savepoint[1]!);
      return { rows: [], rowCount: 0, command: upper.split(/\s+/)[0] };
    },
    release() {},
    on() {},
    off() {},
    removeListener() {},
  } as unknown as PgCompatPoolClient;
  const pool = {
    connect: async () => client,
    query: (...args: unknown[]) => (client.query as (...a: unknown[]) => Promise<unknown>)(...args),
    end: async () => {},
  } as unknown as PgCompatPool;
  return {
    pool,
    sent,
    get aborted() {
      return aborted;
    },
  };
}

function clientOn(fake: Fake, dialect?: unknown): TurbineClient {
  return new TurbineClient({ pool: fake.pool, preparedStatements: false, dialect } as never, schema);
}

/** Statements a transaction sent, minus the BEGIN/COMMIT/ROLLBACK frame. */
const body = (fake: Fake): string[] =>
  fake.sent.filter((sql) => !/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim()) && !/^BEGIN/i.test(sql));

describe('a statement sent after a failed one (PostgreSQL)', () => {
  it('is refused before it is sent, as E019 with the failure that came first', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    const error = await db
      .$transaction(async (tx) => {
        await tx.rawUnsafe('SELECT FAIL 22012').catch(() => {});
        return tx.rawUnsafe('SELECT 2');
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    assert.ok(error instanceof TransactionRolledBackError, String(error));
    assert.equal(error.code, 'TURBINE_E019');
    assert.match(error.message, /This statement was not sent/);
    assert.match(error.message, /nested `tx\.\$transaction/);
    assert.equal((error.cause as { code?: string }).code, 'TURBINE_E003', 'the first failure, typed, is the cause');
    assert.deepEqual(body(fake), ['SELECT FAIL 22012'], 'the second statement never reached the server');
    await db.disconnect();
  });

  it('every path is refused the same way: accessor, raw, sql, a nested block', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db
      .$transaction(async (tx) => {
        await tx.rawUnsafe('SELECT FAIL 22012').catch(() => {});
        for (const [label, run] of [
          ['accessor', () => tx.table('items').findMany()],
          ['raw', () => tx.raw`SELECT 1`],
          ['rawUnsafe', () => tx.rawUnsafe('SELECT 1')],
          ['sql', () => tx.sql`SELECT 1`.then((rows) => rows)],
          ['rawQuery', () => tx.rawQuery('SELECT 1')],
          ['nested block', () => tx.$transaction(async () => 1)],
        ] as const) {
          await assert.rejects(
            Promise.resolve().then(run as () => Promise<unknown>),
            (err: unknown) => err instanceof TransactionRolledBackError,
            `${label} was not refused as E019`,
          );
        }
      })
      .catch((err: unknown) => {
        assert.ok(err instanceof TransactionRolledBackError, 'the COMMIT then answers ROLLBACK, also E019');
      });
    assert.ok(!fake.sent.includes('SELECT 1'), 'none of them was sent');
    assert.ok(!fake.sent.some((sql) => /^SAVEPOINT/.test(sql)), 'the nested block did not even set a savepoint');
    await db.disconnect();
  });

  for (const [code, Class, name] of [
    ['40P01', DeadlockError, 'DeadlockError'],
    ['40001', SerializationFailureError, 'SerializationFailureError'],
    ['55P03', LockNotAvailableError, 'LockNotAvailableError'],
  ] as const) {
    it(`a ${name} first failure keeps its class, so $retry runs the whole transaction again`, async () => {
      const fake = fakeServer();
      const db = clientOn(fake);
      let attempts = 0;
      const error = await db
        .$retry(
          () =>
            db.$transaction(async (tx) => {
              attempts++;
              await tx.rawUnsafe(`SELECT FAIL ${code}`).catch(() => {});
              return tx.rawUnsafe('SELECT 2');
            }),
          { maxAttempts: 3, baseDelay: 1 },
        )
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      assert.ok(error instanceof Class, String(error));
      assert.equal((error as { isRetryable?: boolean }).isRetryable, true);
      assert.equal(attempts, 3, 'retried until the attempts ran out');
      await db.disconnect();
    });
  }

  it('a nested block recovers: the failure inside it rolls back to its savepoint and the outer carries on', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    let inner: unknown;
    await db.$transaction(async (tx) => {
      await tx.rawUnsafe('SELECT before');
      await tx
        .$transaction(async (block) => {
          await block.rawUnsafe('SELECT FAIL 55P03');
        })
        .catch((err: unknown) => {
          inner = err;
        });
      await tx.rawUnsafe('SELECT after');
    });
    assert.ok(inner instanceof LockNotAvailableError, String(inner));
    assert.deepEqual(body(fake), [
      'SELECT before',
      'SAVEPOINT sp_1',
      'SELECT FAIL 55P03',
      'ROLLBACK TO SAVEPOINT sp_1',
      'SELECT after',
    ]);
    assert.equal(fake.sent.at(-1), 'COMMIT');
    await db.disconnect();
  });

  it('a block that swallows the failure is rolled back without a RELEASE, and the outer carries on', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    let inner: unknown;
    await db.$transaction(async (tx) => {
      await tx
        .$transaction(async (block) => {
          await block.rawUnsafe('SELECT FAIL 22012').catch(() => {});
        })
        .catch((err: unknown) => {
          inner = err;
        });
      await tx.rawUnsafe('SELECT after');
    });
    assert.ok(inner instanceof TransactionRolledBackError, String(inner));
    assert.match((inner as Error).message, /nested `\$transaction` block was rolled back, not released/);
    assert.ok(!fake.sent.some((sql) => /^RELEASE/.test(sql)), 'the doomed RELEASE was not sent');
    assert.ok(fake.sent.includes('SELECT after'));
    await db.disconnect();
  });

  it('a statement inside a block after a caught failure is refused, and the block still rolls back cleanly', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      await assert.rejects(
        tx.$transaction(async (block) => {
          await block.rawUnsafe('SELECT FAIL 22012').catch(() => {});
          await block.rawUnsafe('SELECT inside');
        }),
        (err: unknown) => err instanceof TransactionRolledBackError,
      );
      await tx.rawUnsafe('SELECT after');
    });
    assert.ok(!fake.sent.includes('SELECT inside'));
    assert.ok(fake.sent.includes('SELECT after'));
    await db.disconnect();
  });

  it('a client-side failure never reached the server, so it does not refuse what follows', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      await assert.rejects(tx.rawUnsafe('SELECT CLIENTFAIL'));
      assert.deepEqual(await tx.rawUnsafe('SELECT after'), []);
    });
    assert.ok(fake.sent.includes('SELECT after'));
    assert.equal(fake.sent.at(-1), 'COMMIT');
    await db.disconnect();
  });

  it('a client-side failure before the server one does not hide the class the retry decision needs', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    const error = await db
      .$transaction(async (tx) => {
        await tx.rawUnsafe('SELECT CLIENTFAIL').catch(() => {});
        await tx.rawUnsafe('SELECT FAIL 40P01').catch(() => {});
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    assert.ok(error instanceof DeadlockError, String(error));
    assert.equal(error.isRetryable, true);
    await db.disconnect();
  });

  it('MySQL keeps going after a failed statement: nothing is refused', async () => {
    const fake = fakeServer({ abortsOnError: false });
    const db = clientOn(fake, mysqlDialect);
    await db.$transaction(async (tx) => {
      await tx.rawUnsafe('SELECT FAIL 22012').catch(() => {});
      await tx.rawUnsafe('SELECT after');
    });
    assert.ok(fake.sent.includes('SELECT after'));
    assert.equal(fake.sent.at(-1), 'COMMIT');
    await db.disconnect();
  });

  it('transaction(): a retryable failure that came through the raw connection keeps its class', async () => {
    for (const [code, Class] of [
      ['40P01', DeadlockError],
      ['40001', SerializationFailureError],
      ['55P03', LockNotAvailableError],
    ] as const) {
      const fake = fakeServer();
      const db = clientOn(fake);
      const error = await db
        .transaction(async (client) => {
          await client.query(`SELECT FAIL ${code}`).catch(() => {});
        })
        .then(
          () => undefined,
          (err: unknown) => err,
        );
      assert.ok(error instanceof Class, `${code}: ${String(error)}`);
      assert.equal((error as { isRetryable?: boolean }).isRetryable, true);
      await db.disconnect();
    }
  });

  it('transaction(): refused too, except the rollback to a savepoint that recovers', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    const rejected = await db
      .transaction(async (client) => {
        await client.query('SELECT FAIL 22012').catch(() => {});
        await client.query('SELECT 2');
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    assert.ok(rejected instanceof TransactionRolledBackError, String(rejected));
    assert.match((rejected as Error).message, /ROLLBACK TO SAVEPOINT/);
    assert.ok(!fake.sent.includes('SELECT 2'));

    const fresh = fakeServer();
    const dbRecover = clientOn(fresh);
    const rows = await dbRecover.transaction(async (client) => {
      await client.query('SAVEPOINT s');
      await client.query('SELECT FAIL 22012').catch(() => {});
      await client.query('ROLLBACK TO SAVEPOINT s');
      return (await client.query('SELECT 3')).rows;
    });
    assert.deepEqual(rows, []);
    assert.equal(fresh.sent.at(-1), 'COMMIT', 'the transaction commits after the recovery');
    // And the next failure is detected again.
    const again = fakeServer();
    const dbAgain = clientOn(again);
    await assert.rejects(
      dbAgain.transaction(async (client) => {
        await client.query('SAVEPOINT s');
        await client.query('SELECT FAIL 22012').catch(() => {});
        await client.query('ROLLBACK TO SAVEPOINT s');
        await client.query('SELECT FAIL 22012').catch(() => {});
        await client.query('SELECT 4');
      }),
      (err: unknown) => err instanceof TransactionRolledBackError,
    );
    assert.ok(!again.sent.includes('SELECT 4'));
    await db.disconnect();
    await dbRecover.disconnect();
    await dbAgain.disconnect();
  });
});

describe('a statement through the outer tx from inside a nested block', () => {
  it('is refused as E003 naming the tx to use, and nothing is sent', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      await assert.rejects(
        tx.$transaction(async () => {
          await tx.rawUnsafe('SELECT outer');
        }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, String(err));
          assert.equal(err.code, 'TURBINE_E003');
          assert.match(
            err.message,
            /issued through the outer `tx` from inside one of its nested `\$transaction` blocks/,
          );
          assert.match(err.message, /inner\.users\.update/);
          return true;
        },
      );
    });
    assert.ok(!fake.sent.includes('SELECT outer'));
    await db.disconnect();
  });

  it('covers the accessor, raw, sql, a nested $transaction and $connection too', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      await tx.$transaction(async (block) => {
        for (const [label, run] of [
          ['accessor', () => tx.table('items').findMany()],
          ['raw', () => tx.raw`SELECT 1`],
          ['sql', () => tx.sql`SELECT 1`.then((rows) => rows)],
          ['nested', () => tx.$transaction(async () => 1)],
          ['connection', () => tx.$connection().query('SELECT 1')],
        ] as const) {
          await assert.rejects(
            Promise.resolve().then(run as () => Promise<unknown>),
            (err: unknown) => err instanceof ValidationError && /outer `tx`/.test(err.message),
            `${label} was not refused`,
          );
        }
        // The block's own handle is fine, at any depth.
        assert.deepEqual(await block.rawUnsafe('SELECT mine'), []);
        await block.$transaction(async (deeper) => {
          assert.deepEqual(await deeper.rawUnsafe('SELECT deeper'), []);
          await assert.rejects(block.rawUnsafe('SELECT middle'), /outer `tx`/);
        });
      });
    });
    assert.ok(fake.sent.includes('SELECT mine'));
    assert.ok(fake.sent.includes('SELECT deeper'));
    assert.ok(!fake.sent.includes('SELECT middle'));
    assert.ok(!fake.sent.includes('SELECT 1'));
    await db.disconnect();
  });

  it('leaves everything that is not a mistake alone', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      // Shadowing, the usual style: the inner `tx` is the block's own.
      await tx.$transaction(async (tx) => tx.$transaction(async (tx) => tx.rawUnsafe('SELECT shadowed')));
      // Side by side, from the outer level, with the outer handle.
      await Promise.all([
        tx.$transaction((a) => a.rawUnsafe('SELECT a')),
        tx.$transaction((b) => b.rawUnsafe('SELECT b')),
        tx.rawUnsafe('SELECT outer-while-blocks-run'),
      ]);
      // After a block, the outer handle works again.
      await tx.rawUnsafe('SELECT after');
      // A write that takes several statements gets a savepoint of its own and is still the caller's handle.
      await tx.table('items').findMany();
    });
    for (const sql of ['SELECT shadowed', 'SELECT a', 'SELECT b', 'SELECT outer-while-blocks-run', 'SELECT after']) {
      assert.ok(fake.sent.includes(sql), `${sql} was not sent`);
    }
    await db.disconnect();
  });

  it('does not refuse a context that outlived its block', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      let later!: Promise<unknown>;
      await tx.$transaction(async () => {
        // Created inside the block, runs after it: the async context is the block's, the block is gone.
        later = new Promise((resolve) => setTimeout(resolve, 20)).then(() => tx.rawUnsafe('SELECT late'));
      });
      await later;
    });
    assert.ok(fake.sent.includes('SELECT late'));
    await db.disconnect();
  });

  it('a handle is a TransactionClient bound to the same transaction', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      let seen!: TransactionClient;
      await tx.$transaction(async (block) => {
        seen = block;
      });
      assert.notEqual(seen, tx, 'the block gets a handle of its own');
      assert.equal(seen.schema, tx.schema);
    });
    await db.disconnect();
  });
});

describe('raw SQL that ends or reshapes the transaction', () => {
  const control: Array<[string, string]> = [
    ['COMMIT', 'COMMIT'],
    ['commit work', 'COMMIT'],
    ['END', 'END'],
    ['ROLLBACK', 'ROLLBACK'],
    ['ABORT', 'ABORT'],
    ['BEGIN', 'BEGIN'],
    ['START TRANSACTION', 'START TRANSACTION'],
    ['SAVEPOINT x', 'SAVEPOINT'],
    ['RELEASE x', 'RELEASE SAVEPOINT'],
    ['ROLLBACK TO x', 'ROLLBACK TO SAVEPOINT'],
    ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'SET TRANSACTION'],
    ['SELECT 1; COMMIT', 'COMMIT'],
    ['/* c */ COMMIT', 'COMMIT'],
  ];

  for (const [sql, label] of control) {
    it(`$transaction: ${JSON.stringify(sql)} is refused as E003 and not sent`, async () => {
      const fake = fakeServer();
      const db = clientOn(fake);
      await db.$transaction(async (tx) => {
        for (const [path, run] of [
          ['rawUnsafe', () => tx.rawUnsafe(sql)],
          ['rawQuery', () => tx.rawQuery(sql)],
          [
            'sql',
            () =>
              tx
                .sql(
                  Object.freeze(Object.assign([sql], { raw: Object.freeze([sql]) })) as unknown as TemplateStringsArray,
                )
                .then((rows) => rows),
          ],
          ['$connection().query', () => tx.$connection().query(sql)],
          [
            '$connection().query({ text })',
            () => (tx.$connection() as never as { query(c: unknown): Promise<unknown> }).query({ text: sql }),
          ],
        ] as const) {
          await assert.rejects(
            Promise.resolve().then(run as () => Promise<unknown>),
            (err: unknown) => {
              assert.ok(err instanceof ValidationError, `${path}: ${String(err)}`);
              assert.equal(err.code, 'TURBINE_E003');
              assert.ok(
                err.message.includes(`${label} cannot be sent inside a \`$transaction\` callback`),
                err.message,
              );
              return true;
            },
            path,
          );
        }
      });
      assert.deepEqual(body(fake), [], 'nothing reached the server');
      assert.equal(fake.sent.at(-1), 'COMMIT', 'the transaction itself committed once, at the end');
      assert.equal(fake.sent.filter((s) => s === 'COMMIT').length, 1);
      await db.disconnect();
    });
  }

  it('$transaction: the tagged template is screened too', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      await assert.rejects(tx.raw`COMMIT`, /COMMIT cannot be sent/);
    });
    assert.deepEqual(body(fake), []);
    await db.disconnect();
  });

  it('the message names what to do instead', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      await assert.rejects(tx.rawUnsafe('COMMIT'), /commits when the callback returns/);
      await assert.rejects(tx.rawUnsafe('ROLLBACK'), /Throw an error from the callback/);
      await assert.rejects(tx.rawUnsafe('BEGIN'), /tx\.\$transaction\(\.\.\.\)/);
      await assert.rejects(tx.rawUnsafe('SAVEPOINT a'), /nested `tx\.\$transaction/);
      await assert.rejects(tx.rawUnsafe('SET TRANSACTION READ ONLY'), /isolationLevel/);
    });
    await db.disconnect();
  });

  it('text that merely contains the words is sent', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      await tx.rawUnsafe("SELECT 'COMMIT; ROLLBACK' /* BEGIN */ -- SAVEPOINT");
      await tx.rawUnsafe('DO $$ BEGIN PERFORM 1; END $$');
      await tx.rawUnsafe('UPDATE items SET committed = true WHERE begin_at IS NULL');
      await tx.raw`SELECT ${'COMMIT'}::text`;
    });
    assert.equal(body(fake).length, 4);
    await db.disconnect();
  });

  it('transaction(): savepoints are the API there, everything else is refused', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.transaction(async (client) => {
      await client.query('SAVEPOINT a');
      await client.query('RELEASE a');
      await client.query('SAVEPOINT b');
      await client.query('ROLLBACK TO SAVEPOINT b');
      for (const sql of ['COMMIT', 'ROLLBACK', 'BEGIN', 'END', 'SET TRANSACTION READ ONLY', 'SELECT 1; COMMIT']) {
        await assert.rejects(
          client.query(sql),
          (err: unknown) =>
            err instanceof ValidationError && / cannot be sent inside a `transaction\(\)` callback/.test(err.message),
          sql,
        );
      }
    });
    assert.deepEqual(
      body(fake).filter((sql) => !/^(SAVEPOINT|RELEASE|ROLLBACK TO)/.test(sql)),
      [],
    );
    await db.disconnect();
  });

  it('the callback and submittable forms of query() are screened, and refused after the end', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.transaction(async (client) => {
      assert.throws(() => (client.query as (...a: unknown[]) => unknown)('COMMIT', [], () => {}), ValidationError);
      assert.throws(
        () => (client.query as (...a: unknown[]) => unknown)({ text: 'ROLLBACK', submit() {} }),
        ValidationError,
      );
    });
    assert.deepEqual(body(fake), []);
    await db.disconnect();
  });

  it('a stateless engine without SQL transaction control (no syntax) is not screened', async () => {
    const fake = fakeServer({ abortsOnError: false });
    // No statement syntax, so no lexer: PowDB's PowQL has its own statements.
    const db = clientOn(fake, {
      ...mysqlDialect,
      name: 'powdb',
      capabilities: { ...mysqlDialect.capabilities, statementSyntax: null },
    });
    await db
      .$transaction(async (tx) => {
        await tx.rawUnsafe('COMMIT');
      })
      .catch(() => {});
    assert.ok(fake.sent.includes('COMMIT'));
    await db.disconnect();
  });
});

describe('$connection() hands out a connection the callback cannot take away', () => {
  it('end() and connect() are refused, and the driver connection object is not reachable', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await db.$transaction(async (tx) => {
      const conn = tx.$connection() as unknown as Record<string, unknown>;
      // Named for the API the caller used, not the raw `transaction()` API.
      assert.throws(
        () => (conn.end as () => void)(),
        /\$connection\(\): the \$transaction callback must not end its client/,
      );
      assert.throws(() => (conn.connect as () => void)(), /\$connection\(\): .* must not connect its client/);
      assert.throws(() => (conn.release as () => void)(), /\$connection\(\): .* must not release its client/);
      assert.equal(conn.connection, undefined);
      assert.equal('connection' in conn, false);
    });
    await db.disconnect();
  });
});

describe('transaction options', () => {
  it('a timeout of NaN, Infinity, a bigint or a symbol is named as what it is', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    for (const [value, shown] of [
      [Number.NaN, 'NaN'],
      [Number.POSITIVE_INFINITY, 'Infinity'],
      [-5, '-5'],
      [5n, '5n'],
      ['5000', '"5000"'],
      [Symbol('s'), 'Symbol(s)'],
      [{}, 'an object'],
      [null, 'null'],
    ] as const) {
      await assert.rejects(
        db.$transaction(async () => 1, { timeout: value as never }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, String(err));
          assert.ok(err.message.includes(`received ${shown}.`), `${shown}: ${err.message}`);
          return true;
        },
      );
    }
    assert.deepEqual(fake.sent, [], 'refused before a connection was taken');
    await db.disconnect();
  });

  it('readOnly and isolationLevel quote what they were given', async () => {
    const fake = fakeServer();
    const db = clientOn(fake);
    await assert.rejects(
      db.$transaction(async () => 1, { readOnly: Number.NaN as never }),
      /received NaN\./,
    );
    await assert.rejects(
      db.$transaction(async () => 1, { isolationLevel: 5n as never }),
      /unknown isolationLevel 5n\./,
    );
    await db.disconnect();
  });

  it('a refusal by the server says what is wrong with THAT setting', async () => {
    for (const [name, value, expected, unexpected] of [
      ['role', 'nobody', /the role must exist/, undefined],
      ['ROLE', 'nobody', /the role must exist/, undefined],
      ['statement_timeout', 'abc', /the value is not valid for this setting \(SQLSTATE 22023\)/, /role/],
      ['app.limit', 'x', /not valid for this setting \(SQLSTATE 22023\)/, /role/],
    ] as const) {
      const pool = {
        connect: async () => ({
          async query(sql: string) {
            if (/set_config/.test(sql)) throw serverError('22023', 'invalid value for parameter');
            return { rows: [], rowCount: 0, command: 'SELECT' };
          },
          release() {},
          on() {},
          removeListener() {},
        }),
        query: async () => ({ rows: [], rowCount: 0 }),
        end: async () => {},
      } as unknown as PgCompatPool;
      const db = new TurbineClient({ pool, preparedStatements: false } as never, schema);
      await assert.rejects(
        db.$transaction(async () => 1, {
          sessionContext: { [name]: value },
          allowBuiltinSettings: ['role', 'statement_timeout'],
        }),
        (err: unknown) => {
          assert.ok(err instanceof ValidationError, String(err));
          assert.match(err.message, expected, err.message);
          if (unexpected !== undefined) assert.doesNotMatch(err.message, unexpected, err.message);
          return true;
        },
        `${name}=${value}`,
      );
      await db.disconnect();
    }
  });
});

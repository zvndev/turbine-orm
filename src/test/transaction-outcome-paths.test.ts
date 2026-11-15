/**
 * Transaction outcomes on the paths beyond a plain `$transaction` callback:
 * nested savepoint blocks whose rollback is not confirmed, and the
 * transactions Turbine opens on its own (a nested write, a lookup-first
 * upsert, a write split across statements, the sequential pipeline). Each is
 * held to the same rule: a rollback is claimed only on the server's word, a
 * COMMIT with no answer is TransactionOutcomeUnknownError (E021), and a
 * connection whose state is not confirmed is discarded.
 *
 * No database: a scripted connection plays the server. The live counterpart is
 * transaction-outcome-paths.integration.test.ts.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { TurbineClient, withRetry } from '../client.js';
import { type Dialect, postgresDialect } from '../dialect.js';
import {
  DeadlockError,
  SerializationFailureError,
  TimeoutError,
  TransactionOutcomeUnknownError,
  TransactionRolledBackError,
  UniqueConstraintError,
} from '../errors.js';
import { MssqlPool, mssqlDialect } from '../mssql.js';
import { MysqlPool, mysqlDialect } from '../mysql.js';
import { createRecovery } from '../neon-ws/recovery.js';
import type { PgCompatPool, TransactionRecovery } from '../pg-types.js';
import { PowdbPool, powdbDialect } from '../powdb.js';
import { unlockNestedWriteTx } from '../query/builder.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

interface Script {
  /** Answer or refuse one statement; `undefined` answers it normally. */
  on?: (sql: string) => unknown;
  /** A driver recovery policy on the connection (MySQL has one). */
  recovery?: TransactionRecovery;
}

/** A pool of one scripted connection, recording every statement and release. */
function scripted(script: Script = {}) {
  const wire: string[] = [];
  const raw = Object.assign(new EventEmitter(), {
    async query(text: string | { text: string }) {
      const sql = typeof text === 'string' ? text : text.text;
      wire.push(sql);
      const answer = await script.on?.(sql);
      if (answer !== undefined) return answer;
      // A row for every write and read, so a create that returns its row finds one.
      const rows =
        /^(INSERT|SELECT)/.test(sql) && !sql.includes('FOR UPDATE') ? [{ id: 1, name: 'a', status: null }] : [];
      return { rows, rowCount: 1, command: sql.split(' ')[0], insertId: 1 };
    },
    release(error?: unknown) {
      wire.push(error ? 'discard' : 'release');
    },
    ...(script.recovery ? { transactionRecovery: script.recovery } : {}),
  });
  const pool = { query: raw.query, connect: async () => raw, end: async () => {} };
  return { pool: pool as unknown as PgCompatPool, wire };
}

/** The statement kinds in `wire`, for comparing a sequence without its generated SQL. */
const kinds = (wire: string[]) => wire.map((sql) => sql.replace(/^(INSERT|SELECT|UPDATE)\b.*/, '$1'));

/** `named(id, name UNIQUE, status)`: an upsert whose `where` is not in `create` looks the row up first. */
function namedSchema(): SchemaMetadata {
  const named = mockTable('named', [
    { name: 'id', field: 'id', pgType: 'int4' },
    { name: 'name', field: 'name', pgType: 'text', unique: true },
    { name: 'status', field: 'status', pgType: 'text' },
  ]);
  return { tables: { named }, enums: {} } as unknown as SchemaMetadata;
}

/** A lookup-first upsert: Turbine opens a transaction of its own for it. */
function lookupFirstUpsert(db: TurbineClient): Promise<unknown> {
  return db.table('named').upsert({ where: { id: 5 }, create: { name: 'a' }, update: { status: 's' } });
}

/** A pool for {@link lookupFirstUpsert} whose lookup finds no row, so the upsert creates one. */
function upsertPool(on?: Script['on']) {
  return scripted({ on: (sql) => (sql.startsWith('SELECT') ? { rows: [], rowCount: 0 } : on?.(sql)) });
}

/** Refuse `prefix` statements before they are sent, the way a dead or closing client does. */
function refuse(prefix: string): Script['on'] {
  return (sql) => {
    if (sql.startsWith(prefix)) throw new Error(`injected: ${prefix} refused before dispatch`);
    return undefined;
  };
}

describe('a nested block whose ROLLBACK TO is not confirmed dooms the transaction', () => {
  it('the outer callback catches the block error and returns: no COMMIT, and the outer rolls back', async () => {
    const { pool, wire } = scripted({ on: refuse('ROLLBACK TO') });
    const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
    const inner = new Error('inner failed');
    let caught: unknown;
    const outcome = await db
      .$transaction(async (tx) => {
        try {
          await tx.$transaction(async (block) => {
            await block.rawUnsafe('INSERT INTO t VALUES (1)');
            throw inner;
          });
        } catch (err) {
          caught = err;
        }
        return 'returned';
      })
      .catch((err: unknown) => err);
    // The block reports its own failure, never a rollback it did not see.
    assert.equal(caught, inner);
    assert.ok(!wire.includes('COMMIT'), `COMMIT was sent after an unconfirmed ROLLBACK TO: ${wire.join(', ')}`);
    assert.deepEqual(wire, [
      'BEGIN',
      'SAVEPOINT sp_1',
      'INSERT INTO t VALUES (1)',
      'ROLLBACK TO SAVEPOINT sp_1',
      'ROLLBACK',
      'release',
    ]);
    // The outer ROLLBACK was acknowledged, so the rollback is claimed, with the block's failure as cause.
    assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
    assert.equal(outcome.cause, inner);
    assert.match(outcome.message, /ROLLBACK was sent instead of COMMIT and none of its writes were saved/);
    assert.match(outcome.message, /The first failure is attached as `cause`/);
  });

  it('a RELEASE with no answer and an unconfirmed ROLLBACK TO: the block may have merged, so no COMMIT', async () => {
    const lost = new Error('Query read timeout');
    const { pool, wire } = scripted({
      on: (sql) => {
        if (sql.startsWith('RELEASE')) throw lost;
        return refuse('ROLLBACK TO')!(sql);
      },
    });
    const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
    let caught: unknown;
    const outcome = await db
      .$transaction(async (tx) => {
        await tx
          .$transaction((block) => block.rawUnsafe('INSERT INTO t VALUES (1)'))
          .catch((err: unknown) => {
            caught = err;
          });
      })
      .catch((err: unknown) => err);
    assert.equal((caught as Error).cause ?? caught, lost);
    assert.ok(!wire.includes('COMMIT'), wire.join(', '));
    assert.ok(outcome instanceof TransactionRolledBackError);
  });

  it('a retryable failure keeps its class, so $retry still retries the whole transaction', async () => {
    const { pool, wire } = scripted({ on: refuse('ROLLBACK TO') });
    const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
    const conflict = new SerializationFailureError({ message: 'could not serialize access' });
    const outcome = await db
      .$transaction(async (tx) => {
        await tx
          .$transaction(async () => {
            throw conflict;
          })
          .catch(() => {});
      })
      .catch((err: unknown) => err);
    assert.ok(outcome instanceof SerializationFailureError, `got ${String(outcome)}`);
    assert.equal(outcome.cause, conflict);
    assert.ok(!wire.includes('COMMIT'));
  });

  it('an enclosing block whose ROLLBACK TO is acknowledged undoes the inner one too, and the outer commits', async () => {
    let refusals = 0;
    const { pool, wire } = scripted({
      on: (sql) => {
        // Only the inner block's rollback (sp_2) is refused.
        if (sql === 'ROLLBACK TO SAVEPOINT sp_2') {
          refusals++;
          throw new Error('injected: refused');
        }
        return undefined;
      },
    });
    const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
    const value = await db.$transaction(async (tx) => {
      await tx
        .$transaction(async (outer) => {
          await outer.$transaction(async () => {
            throw new Error('inner failed');
          });
        })
        .catch(() => {});
      return 'kept';
    });
    assert.equal(value, 'kept');
    assert.equal(refusals, 1);
    assert.deepEqual(wire.slice(-3), ['ROLLBACK TO SAVEPOINT sp_1', 'COMMIT', 'release']);
  });

  describe('whatever value the block rejects with', () => {
    // biome-ignore lint/suspicious/noThenProperty: a thenable rejection reason is one of the cases under test
    const thenable = { then: () => {} };
    const reasons: Array<[string, () => unknown]> = [
      ['undefined', () => undefined],
      ['null', () => null],
      ['0', () => 0],
      ["''", () => ''],
      ['false', () => false],
      ['a thenable', () => thenable],
      ['a frozen object', () => Object.freeze({ reason: 'frozen' })],
    ];
    for (const [label, reason] of reasons) {
      it(`${label}: the outer writes again and returns, and still gets no COMMIT`, async () => {
        const { pool, wire } = scripted({ on: refuse('ROLLBACK TO') });
        const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
        const thrown = reason();
        let caught: unknown = 'not caught';
        const outcome = await db
          .$transaction(async (tx) => {
            try {
              await tx.$transaction(async (block) => {
                await block.rawUnsafe('INSERT INTO t VALUES (1)');
                throw thrown;
              });
            } catch (err) {
              caught = err;
            }
            await tx.rawUnsafe('INSERT INTO t VALUES (2)');
            return 'returned';
          })
          .then(
            (value) => ({ value }),
            (err: unknown) => ({ err }),
          );
        assert.ok(Object.is(caught, thrown), `the block rejected with ${String(caught)}`);
        assert.deepEqual(wire, [
          'BEGIN',
          'SAVEPOINT sp_1',
          'INSERT INTO t VALUES (1)',
          'ROLLBACK TO SAVEPOINT sp_1',
          'INSERT INTO t VALUES (2)',
          'ROLLBACK',
          'release',
        ]);
        assert.ok('err' in outcome, 'the transaction reported success');
        assert.ok(outcome.err instanceof TransactionRolledBackError, `got ${String(outcome.err)}`);
      });
    }

    it('a thenable that rejects with undefined, returned from the block: no COMMIT either', async () => {
      const { pool, wire } = scripted({ on: refuse('ROLLBACK TO') });
      const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
      const outcome = await db
        .$transaction(async (tx) => {
          await tx
            .$transaction(async (block) => {
              await block.rawUnsafe('INSERT INTO t VALUES (1)');
              // An async function adopts a returned thenable, so the block rejects with its reason.
              return {
                // biome-ignore lint/suspicious/noThenProperty: the block returns a thenable that rejects
                then(_: unknown, reject: (reason: unknown) => void) {
                  reject(undefined);
                },
              } as unknown as undefined;
            })
            .catch(() => {});
          return 'returned';
        })
        .catch((err: unknown) => err);
      assert.ok(!wire.includes('COMMIT'), wire.join(', '));
      assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
    });

    it('two levels, undefined caught at the root: no COMMIT', async () => {
      const { pool, wire } = scripted({ on: refuse('ROLLBACK TO') });
      const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
      const outcome = await db
        .$transaction(async (tx) => {
          await tx
            .$transaction((outer) =>
              outer.$transaction(async (inner) => {
                await inner.rawUnsafe('INSERT INTO t VALUES (1)');
                throw undefined;
              }),
            )
            .catch(() => {});
        })
        .catch((err: unknown) => err);
      assert.ok(!wire.includes('COMMIT'), wire.join(', '));
      assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
    });

    it('undefined, and the outer ROLLBACK is not confirmed either: rejects with that value, discarded, no rollback claimed', async () => {
      const { pool, wire } = scripted({ on: refuse('ROLLBACK') });
      const logs: string[] = [];
      const db = new TurbineClient(
        { pool, logging: true, logger: { debug: (_message, entry) => logs.push(entry.code) } },
        { tables: {}, enums: {} },
      );
      let handle: { rawUnsafe(sql: string): Promise<unknown> } | undefined;
      const outcome = await db
        .$transaction(async (tx) => {
          handle = tx;
          await tx
            .$transaction(async () => {
              throw undefined;
            })
            .catch(() => {});
        })
        .then(
          () => ({ committed: true }),
          (err: unknown) => ({ err }),
        );
      assert.ok('err' in outcome, 'the transaction reported success');
      assert.equal(outcome.err, undefined);
      assert.ok(!wire.includes('COMMIT'), wire.join(', '));
      assert.equal(wire.at(-1), 'discard');
      assert.ok(logs.includes('transaction-outcome-unknown'), logs.join(', '));
      assert.ok(!logs.includes('transaction-rolled-back'), logs.join(', '));
      await assert.rejects(handle!.rawUnsafe('SELECT 1'), (err: Error) => !/rolled back/.test(err.message));
    });
  });

  it('without any refusal the block rolls back alone and the outer commits (control)', async () => {
    const { pool, wire } = scripted();
    const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
    const value = await db.$transaction(async (tx) => {
      await tx
        .$transaction(async () => {
          throw new Error('inner failed');
        })
        .catch(() => {});
      return 'kept';
    });
    assert.equal(value, 'kept');
    assert.deepEqual(wire, ['BEGIN', 'SAVEPOINT sp_1', 'ROLLBACK TO SAVEPOINT sp_1', 'COMMIT', 'release']);
  });
});

describe('a transaction Turbine opens for one call: the lookup-first upsert', () => {
  it('a COMMIT with no answer is E021: no ROLLBACK sent, the connection discarded', async () => {
    const lost = new Error('Query read timeout');
    const { pool, wire } = upsertPool((sql) => {
      if (sql === 'COMMIT') throw lost;
      return undefined;
    });
    const db = new TurbineClient({ pool, warnOnUnlimited: false }, namedSchema());
    const outcome = await lookupFirstUpsert(db).catch((err: unknown) => err);
    assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
    assert.equal(outcome.cause, lost);
    assert.ok(!('isRetryable' in outcome));
    assert.deepEqual(wire.slice(-2), ['COMMIT', 'discard']);
  });

  it('a COMMIT the driver rejects with its own TimeoutError is E021 too, never a claimed rollback', async () => {
    const { pool, wire } = upsertPool((sql) => {
      if (sql === 'COMMIT') throw new TimeoutError(50, 'Query');
      return undefined;
    });
    const db = new TurbineClient({ pool, warnOnUnlimited: false }, namedSchema());
    const outcome = await lookupFirstUpsert(db).catch((err: unknown) => err);
    assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
    assert.ok(outcome.cause instanceof TimeoutError);
    assert.deepEqual(wire.slice(-2), ['COMMIT', 'discard']);
  });

  it('a COMMIT the server answers with the ROLLBACK tag is a confirmed rollback, not a success', async () => {
    const { pool, wire } = upsertPool((sql) =>
      sql === 'COMMIT' ? { rows: [], rowCount: 0, command: 'ROLLBACK' } : undefined,
    );
    const db = new TurbineClient({ pool, warnOnUnlimited: false }, namedSchema());
    const outcome = await lookupFirstUpsert(db).catch((err: unknown) => err);
    assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
    assert.ok(!wire.includes('discard'));
  });

  it('a statement failure with the ROLLBACK acknowledged: the failure itself, the connection reused', async () => {
    const failed = Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' });
    const { pool, wire } = upsertPool((sql) => {
      if (sql.startsWith('INSERT')) throw failed;
      return undefined;
    });
    const db = new TurbineClient({ pool, warnOnUnlimited: false }, namedSchema());
    const outcome = await lookupFirstUpsert(db).catch((err: unknown) => err);
    assert.equal((outcome as Error).name, 'UniqueConstraintError');
    assert.deepEqual(wire.slice(-2), ['ROLLBACK', 'release']);
  });

  it('a statement failure whose ROLLBACK is refused: the failure itself, the connection discarded', async () => {
    const failed = Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' });
    const { pool, wire } = upsertPool((sql) => {
      if (sql.startsWith('INSERT')) throw failed;
      if (sql === 'ROLLBACK') throw new Error('injected: ROLLBACK refused before dispatch');
      return undefined;
    });
    const db = new TurbineClient({ pool, warnOnUnlimited: false }, namedSchema());
    const outcome = await lookupFirstUpsert(db).catch((err: unknown) => err);
    assert.equal((outcome as Error).name, 'UniqueConstraintError');
    assert.deepEqual(wire.slice(-2), ['ROLLBACK', 'discard']);
  });
});

describe("a write split across statements inside the caller's transaction, its deadline passing between them", () => {
  /** Two rows per statement, so three rows take two INSERTs inside the write's savepoint. */
  const chunked: Dialect = {
    ...postgresDialect,
    capabilities: { ...postgresDialect.capabilities, chunkBindParameters: 2, maxInsertRows: 2 },
  };

  async function deadlineBetweenChunks(refuseRollbackTo: boolean) {
    const { pool, wire } = scripted({ on: refuseRollbackTo ? refuse('ROLLBACK TO') : undefined });
    const db = new TurbineClient({ pool, dialect: chunked, warnOnUnlimited: false }, namedSchema());
    // The first INSERT answers at once; its query event then holds the thread
    // past the write's 30 ms deadline, so the second INSERT is never sent.
    let held = false;
    db.$on('query', (e) => {
      if (held || !e.sql.startsWith('INSERT')) return;
      held = true;
      const start = performance.now();
      while (performance.now() - start < 60) {}
    });
    let blockError: unknown;
    const outcome = await db
      .$transaction(async (tx) => {
        blockError = await tx
          .table('named')
          .createMany({
            data: [
              { id: 1, name: 'a' },
              { id: 2, name: 'b' },
              { id: 3, name: 'c' },
            ],
            timeout: 30,
          })
          .catch((err: unknown) => err);
        return 'returned';
      })
      .catch((err: unknown) => err);
    return { blockError, outcome, wire: kinds(wire) };
  }

  it('the savepoint rollback is not acknowledged: the timeout is outcome unknown and the transaction does not commit', async () => {
    const { blockError, outcome, wire } = await deadlineBetweenChunks(true);
    assert.ok(blockError instanceof TimeoutError, `got ${String(blockError)}`);
    assert.equal(blockError.outcome, 'unknown');
    assert.match(blockError.message, /passed before the next one was sent/);
    assert.doesNotMatch(blockError.message, /made no change|rolled back/);
    assert.deepEqual(wire, ['BEGIN', 'SAVEPOINT sp_1', 'INSERT', 'ROLLBACK TO SAVEPOINT sp_1', 'ROLLBACK', 'release']);
    assert.ok(outcome instanceof TransactionRolledBackError, `got ${String(outcome)}`);
    assert.equal(outcome.cause, blockError);
  });

  it('the savepoint rollback is acknowledged: not-executed, and the transaction commits without the write', async () => {
    const { blockError, outcome, wire } = await deadlineBetweenChunks(false);
    assert.ok(blockError instanceof TimeoutError, `got ${String(blockError)}`);
    assert.equal(blockError.outcome, 'not-executed');
    assert.match(blockError.message, /passed before the next one was sent/);
    assert.deepEqual(wire, ['BEGIN', 'SAVEPOINT sp_1', 'INSERT', 'ROLLBACK TO SAVEPOINT sp_1', 'COMMIT', 'release']);
    assert.equal(outcome, 'returned');
  });
});

describe("a nested write's timeout is one deadline for every statement it sends", () => {
  it('each statement gets what is left, and once none is left nothing more is sent: outcome unknown', async () => {
    const seen: unknown[] = [];
    const handle = {
      create: (args: Record<string, unknown>) => seen.push(args.timeout),
      findUnique: (args: Record<string, unknown>) => seen.push(args.timeout),
    };
    const tx = unlockNestedWriteTx({ table: (_name: string) => handle as Record<string, unknown> }, 50);
    const table = tx.table('posts') as typeof handle;
    table.create({ data: {} });
    const start = performance.now();
    while (performance.now() - start < 60) {}
    assert.throws(
      () => table.findUnique({ where: { id: 1 } }),
      (err: unknown) => err instanceof TimeoutError && err.outcome === 'unknown' && err.timeoutMs === 50,
    );
    assert.equal(seen.length, 1, 'a statement was sent after the deadline');
    assert.ok(typeof seen[0] === 'number' && seen[0] > 0 && seen[0] <= 50, `first statement got ${String(seen[0])}`);
  });

  it('without a timeout nothing is added to the statements', () => {
    const seen: Record<string, unknown>[] = [];
    const tx = unlockNestedWriteTx({
      table: (_name: string) => ({ create: (args: Record<string, unknown>) => seen.push(args) }),
    });
    (tx.table('posts') as { create(a: object): void }).create({ data: {} });
    assert.ok(!('timeout' in seen[0]!));
  });
});

describe('a write split across statements on an engine with a recovery policy (MySQL)', () => {
  /** MySQL's rule: a failed COMMIT is never settled by a later ROLLBACK. */
  function mysqlLikePolicy(calls: string[]): TransactionRecovery {
    let committing = false;
    return {
      assertTimeout: () => {},
      timeoutError: (timeout) => new TimeoutError(timeout, 'Transaction'),
      pendingMessage: '',
      sessionMessage: '',
      async rollback(running, send) {
        calls.push(`rollback(running=${running}, committing=${committing})`);
        if (running || committing) return false;
        return send().then(
          () => true,
          () => false,
        );
      },
      finish(state, clean, error) {
        calls.push(`finish(clean=${clean})`);
        state.end(clean ? 'was rolled back' : 'ended with an unknown outcome');
        return error;
      },
      // Not part of the contract: lets the script mark the COMMIT dispatched.
      set committing(value: boolean) {
        committing = value;
      },
    } as TransactionRecovery & { committing: boolean };
  }

  function mysqlCreate(on: Script['on'], calls: string[]) {
    const recovery = mysqlLikePolicy(calls) as TransactionRecovery & { committing: boolean };
    const script = scripted({
      recovery,
      on: (sql) => {
        if (sql === 'COMMIT') recovery.committing = true;
        if (/^SELECT/.test(sql) && !sql.includes('FOR UPDATE')) {
          const answer = on?.(sql);
          return answer ?? { rows: [{ id: 1, name: 'a', status: null }], rowCount: 1 };
        }
        return on?.(sql);
      },
    });
    const db = new TurbineClient({ pool: script.pool, dialect: mysqlDialect, warnOnUnlimited: false }, namedSchema());
    return { db, wire: script.wire };
  }

  it('a lost COMMIT goes to the policy: no ROLLBACK, the connection discarded, the driver error unchanged', async () => {
    const calls: string[] = [];
    const lost = new Error('Connection lost: The server closed the connection.');
    const { db, wire } = mysqlCreate((sql) => {
      if (sql === 'COMMIT') throw lost;
      return undefined;
    }, calls);
    const outcome = await db
      .table('named')
      .create({ data: { id: 1, name: 'a' } })
      .catch((err: unknown) => err);
    assert.equal((outcome as Error).cause ?? outcome, lost);
    assert.ok(!wire.includes('ROLLBACK'), wire.join(', '));
    assert.equal(wire.at(-1), 'discard');
    assert.deepEqual(calls, ['rollback(running=false, committing=true)', 'finish(clean=false)']);
  });

  it('a statement that timed out and settled, with the ROLLBACK acknowledged: a timeout, and a confirmed rollback', async () => {
    const calls: string[] = [];
    const { db, wire } = mysqlCreate((sql) => {
      if (/^SELECT \* FROM/.test(sql)) throw new TimeoutError(40, 'Query');
      return undefined;
    }, calls);
    const outcome = await db
      .table('named')
      .create({ data: { id: 1, name: 'a' } })
      .catch((err: unknown) => err);
    assert.ok(outcome instanceof TimeoutError, `got ${String(outcome)}`);
    assert.equal(outcome.outcome, 'not-executed');
    assert.match(outcome.message, /Query timed out after 40ms, and the transaction it ran in was rolled back/);
    assert.ok(!wire.includes('COMMIT'));
    assert.deepEqual(wire.slice(-2), ['ROLLBACK', 'release']);
  });

  it('the same timeout with the ROLLBACK refused: outcome unknown, no rollback claimed, discarded', async () => {
    const calls: string[] = [];
    const { db, wire } = mysqlCreate((sql) => {
      if (/^SELECT \* FROM/.test(sql)) throw new TimeoutError(40, 'Query');
      if (sql === 'ROLLBACK') throw new Error('injected: ROLLBACK refused');
      return undefined;
    }, calls);
    const outcome = await db
      .table('named')
      .create({ data: { id: 1, name: 'a' } })
      .catch((err: unknown) => err);
    assert.ok(outcome instanceof TimeoutError, `got ${String(outcome)}`);
    assert.equal(outcome.outcome, 'unknown');
    assert.match(outcome.message, /COMMIT was never sent[\s\S]*rollback is not confirmed/);
    assert.doesNotMatch(outcome.message, /was rolled back/);
    assert.equal(wire.at(-1), 'discard');
  });
});

describe('the sequential pipeline fallback', () => {
  const batch = (db: TurbineClient) => db.pipeline([db.table('named').buildCreate({ data: { id: 1, name: 'a' } })]);

  it('a COMMIT with no answer is E021: no ROLLBACK sent, the connection discarded', async () => {
    const lost = new Error('Query read timeout');
    const { pool, wire } = scripted({
      on: (sql) => {
        if (sql === 'COMMIT') throw lost;
        return undefined;
      },
    });
    const db = new TurbineClient({ pool, warnOnUnlimited: false }, namedSchema());
    const outcome = await batch(db).catch((err: unknown) => err);
    assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
    assert.equal(outcome.cause, lost);
    assert.deepEqual(kinds(wire), ['BEGIN', 'INSERT', 'COMMIT', 'discard']);
  });

  it('a transform that refuses its result rolls back before COMMIT, and the connection is reused', async () => {
    const { pool, wire } = scripted();
    const db = new TurbineClient({ pool, warnOnUnlimited: false }, namedSchema());
    const refused = new Error('transform refused');
    const outcome = await db
      .pipeline([
        {
          sql: 'INSERT INTO named VALUES (1)',
          params: [],
          tag: 'named.create',
          transform: () => {
            throw refused;
          },
        },
      ])
      .catch((err: unknown) => err);
    assert.equal(outcome, refused);
    assert.deepEqual(kinds(wire), ['BEGIN', 'INSERT', 'ROLLBACK', 'release']);
  });

  it('a failed BEGIN is not followed by ROLLBACK, and the connection is not reused', async () => {
    const { pool, wire } = scripted({
      on: (sql) => {
        if (sql === 'BEGIN') throw new Error('Query read timeout');
        return undefined;
      },
    });
    const db = new TurbineClient({ pool, warnOnUnlimited: false }, namedSchema());
    await assert.rejects(batch(db));
    assert.deepEqual(wire, ['BEGIN', 'discard']);
  });

  it('a statement failure whose ROLLBACK is refused: the failure itself, the connection discarded', async () => {
    const failed = Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' });
    const { pool, wire } = scripted({
      on: (sql) => {
        if (sql.startsWith('INSERT')) throw failed;
        if (sql === 'ROLLBACK') throw new Error('injected: refused');
        return undefined;
      },
    });
    const db = new TurbineClient({ pool, warnOnUnlimited: false }, namedSchema());
    const outcome = await batch(db).catch((err: unknown) => err);
    assert.equal((outcome as Error).name, 'UniqueConstraintError');
    assert.deepEqual(kinds(wire), ['BEGIN', 'INSERT', 'ROLLBACK', 'discard']);
  });
});

describe('a release that throws keeps the transaction outcome', () => {
  /** A connection whose COMMIT gets no answer and whose release throws after handing it back. */
  function throwingRelease() {
    const order: string[] = [];
    const raw = Object.assign(new EventEmitter(), {
      async query(text: string | { text: string }) {
        const sql = typeof text === 'string' ? text : text.text;
        order.push(sql);
        if (sql === 'COMMIT') throw new Error('Query read timeout');
        return { rows: [{ id: 1, name: 'a', status: null }], rowCount: 1, command: sql.split(' ')[0] };
      },
      release(error?: unknown) {
        order.push(error ? 'discard' : 'release');
        throw new Error('release failed');
      },
    });
    const pool = { query: raw.query, connect: async () => raw, end: async () => {} } as unknown as PgCompatPool;
    const db = new TurbineClient(
      { pool, logging: true, warnOnUnlimited: false, logger: { debug: (_m, entry) => order.push(entry.code) } },
      namedSchema(),
    );
    order.length = 0;
    return { db, order };
  }

  const calls: Record<string, (db: TurbineClient) => Promise<unknown>> = {
    transaction: (db) => db.transaction(async () => 1),
    $transaction: (db) => db.$transaction(async () => 1),
    batch: (db) => db.$transaction([{ sql: 'SELECT 1', params: [], tag: 'probe', transform: () => 1 }]),
    pipeline: (db) => db.pipeline([db.table('named').buildCreate({ data: { id: 1, name: 'a' } })]),
  };

  for (const [api, call] of Object.entries(calls)) {
    it(`${api}: E021 and its cause survive, and the connection was still discarded`, async () => {
      const { db, order } = throwingRelease();
      const outcome = await call(db).catch((err: unknown) => err);
      assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
      assert.equal((outcome.cause as Error).message, 'Query read timeout');
      assert.ok(order.includes('discard') && !order.includes('ROLLBACK'), order.join(', '));
    });
  }

  it('$transaction: the unknown outcome is still logged', async () => {
    const { db, order } = throwingRelease();
    await calls.$transaction!(db).catch(() => {});
    assert.deepEqual(order.slice(-2), ['discard', 'transaction-outcome-unknown']);
  });
});

describe('a server ERROR at COMMIT in a language other than English', () => {
  /** node-postgres's error for a server response with this SQLSTATE and (localized) severity word. */
  const answer = (code: string, severity: string) =>
    Object.assign(new Error(`server said ${code}`), { code, severity });

  function commitAnswering(code: string, severity: string, times = 1) {
    let left = times;
    return scripted({
      on: (sql) => {
        if (sql === 'COMMIT' && left-- > 0) throw answer(code, severity);
        return undefined;
      },
    });
  }

  for (const [code, name] of [
    ['40001', 'SerializationFailureError'],
    ['40P01', 'DeadlockError'],
    ['23505', 'UniqueConstraintError'],
    ['23503', 'ForeignKeyError'],
    ['57014', 'TimeoutError'],
  ] as const) {
    it(`${code} with severity FEHLER is the server's answer: ${name}, the ROLLBACK sent, the connection reused`, async () => {
      const { pool, wire } = commitAnswering(code, 'FEHLER');
      const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
      const outcome = await db.$transaction(async () => 1).catch((err: unknown) => err);
      assert.equal((outcome as Error).name, name, String(outcome));
      assert.ok(!(outcome instanceof TransactionOutcomeUnknownError));
      assert.deepEqual(wire.slice(-3), ['COMMIT', 'ROLLBACK', 'release']);
    });
  }

  it('a localized serialization failure at COMMIT is still retried by withRetry', async () => {
    const { pool } = commitAnswering('40001', 'ОШИБКА');
    const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
    let attempts = 0;
    const value = await withRetry(
      () => {
        attempts++;
        return db.$transaction(async () => 'saved');
      },
      { baseDelay: 1, maxDelay: 1 },
    );
    assert.equal(value, 'saved');
    assert.equal(attempts, 2);
  });

  for (const [code, severity] of [
    ['40001', 'FATAL'],
    ['23505', 'PANIC'],
    ['40003', 'FEHLER'],
    ['08006', 'FEHLER'],
    ['57P01', 'FEHLER'],
    ['XX000', 'ERREUR'],
  ] as const) {
    it(`${code} with severity ${severity} is not proof COMMIT failed: E021, no ROLLBACK, discarded`, async () => {
      const { pool, wire } = commitAnswering(code, severity);
      const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
      const outcome = await db.$transaction(async () => 1).catch((err: unknown) => err);
      assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
      assert.deepEqual(wire.slice(-2), ['COMMIT', 'discard']);
    });
  }
});

describe('a COMMIT answer that cannot be read is not a rollback', () => {
  it('a COMMIT result whose command cannot be read: E021, no ROLLBACK, nothing claims a rollback', async () => {
    const logs: string[] = [];
    const { pool, wire } = scripted({
      on: (sql) =>
        sql === 'COMMIT'
          ? Object.defineProperty({ rows: [], rowCount: 0 }, 'command', {
              get() {
                throw new Error('unreadable answer');
              },
            })
          : undefined,
    });
    const db = new TurbineClient(
      { pool, logging: true, logger: { debug: (_m, entry) => logs.push(entry.code) } },
      { tables: {}, enums: {} },
    );
    logs.length = 0;
    let handle: { rawUnsafe(sql: string): Promise<unknown> } | undefined;
    const outcome = await db
      .$transaction(async (tx) => {
        handle = tx;
      })
      .catch((err: unknown) => err);
    assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
    assert.ok(!wire.includes('ROLLBACK'), wire.join(', '));
    assert.deepEqual(wire.slice(-1), ['discard']);
    assert.deepEqual(logs, ['transaction-outcome-unknown']);
    await assert.rejects(handle!.rawUnsafe('SELECT 1'), /ended with an unknown outcome/);
  });
});

describe('the unknown-outcome error says only what is known', () => {
  it('a driver that refuses COMMIT before sending it: E021, worded without claiming COMMIT was sent', async () => {
    const order: string[] = [];
    const raw = {
      query(sql: string) {
        // Thrown synchronously: the driver may or may not have written it.
        if (sql === 'COMMIT') throw new Error('Client has encountered a connection error and is not queryable');
        order.push(sql);
        return Promise.resolve({ rows: [], rowCount: 0, command: sql });
      },
      release(error?: unknown) {
        order.push(error ? 'discard' : 'release');
      },
    };
    const pool = { query: raw.query, connect: async () => raw, end: async () => {} } as unknown as PgCompatPool;
    const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
    const outcome = await db.$transaction(async () => 1).catch((err: unknown) => err);
    assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
    assert.doesNotMatch(outcome.message, /was sent|answer arrived/);
    assert.match(outcome.message, /COMMIT got no answer Turbine could read/);
    // The retry advice never treats a missing row as proof.
    assert.doesNotMatch(outcome.message, /[Cc]heck the database/);
    assert.match(outcome.message, /unique key the database enforces/);
    assert.deepEqual(order, ['BEGIN', 'discard']);
  });
});

describe('which engines report an unanswered COMMIT as unknown: capabilities.classifiesCommitAnswer', () => {
  const lostCommit = () =>
    scripted({
      on: (sql) => {
        if (sql === 'COMMIT') throw new Error('Query read timeout');
        return undefined;
      },
    });
  const withCapabilities = (patch: Partial<Dialect['capabilities']>): Dialect => ({
    ...postgresDialect,
    capabilities: Object.freeze({ ...postgresDialect.capabilities, ...patch }),
  });

  it('the capability decides, not whether a failed statement aborts the transaction', async () => {
    const { pool } = lostCommit();
    const db = new TurbineClient(
      { pool, dialect: withCapabilities({ abortsTransactionOnError: false }) },
      { tables: {}, enums: {} },
    );
    const outcome = await db.$transaction(async () => 1).catch((err: unknown) => err);
    assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
  });

  it('false: the driver error is rethrown and a cleanup ROLLBACK follows', async () => {
    const { pool, wire } = lostCommit();
    const db = new TurbineClient(
      { pool, dialect: withCapabilities({ classifiesCommitAnswer: false }) },
      { tables: {}, enums: {} },
    );
    const outcome = await db.$transaction(async () => 1).catch((err: unknown) => err);
    assert.ok(!(outcome instanceof TransactionOutcomeUnknownError));
    assert.ok(wire.includes('ROLLBACK'));
  });

  it('pinned per engine: only PostgreSQL classifies the COMMIT answer', () => {
    assert.equal(postgresDialect.capabilities.classifiesCommitAnswer, true);
    for (const dialect of [mysqlDialect, mssqlDialect, powdbDialect]) {
      assert.equal(dialect.capabilities.classifiesCommitAnswer, false, dialect.name);
    }
  });
});

describe('a driver recovery policy settles an unanswered COMMIT, even where the dialect classifies COMMIT answers', () => {
  /**
   * A policy that records what it is asked and answers with its own error, so
   * the outcome shows whether the settlement went through it. `acknowledge`
   * decides whether its ROLLBACK is sent and confirmed.
   */
  function recordingPolicy(calls: string[], acknowledge: boolean, own: Error): TransactionRecovery {
    return {
      assertTimeout: () => {},
      timeoutError: (timeout) => new TimeoutError(timeout, 'Transaction'),
      pendingMessage: '',
      sessionMessage: '',
      async rollback(running, send) {
        calls.push(`rollback(running=${running})`);
        if (!acknowledge) return false;
        return send().then(
          () => true,
          () => false,
        );
      },
      finish(state, clean, error) {
        calls.push(`finish(clean=${clean}, error=${(error as Error).message})`);
        state.end(clean ? 'was rolled back' : 'ended with an unknown outcome');
        return own;
      },
    };
  }

  async function lostCommitThroughPolicy(acknowledge: boolean) {
    const calls: string[] = [];
    const own = new Error('the policy settled this transaction');
    const { pool, wire } = scripted({
      recovery: recordingPolicy(calls, acknowledge, own),
      on: (sql) => {
        if (sql === 'COMMIT') throw new Error('Query read timeout');
        return undefined;
      },
    });
    // postgresDialect classifies the COMMIT answer, which is the native-pg
    // unknown path a policy must take precedence over.
    assert.equal(postgresDialect.capabilities.classifiesCommitAnswer, true);
    const db = new TurbineClient({ pool }, { tables: {}, enums: {} });
    const outcome = await db.$transaction(async () => 1).catch((err: unknown) => err);
    return { outcome, own, calls, wire };
  }

  it("the policy is asked to roll back and its answer is the caller's error, not TransactionOutcomeUnknownError", async () => {
    const { outcome, own, calls, wire } = await lostCommitThroughPolicy(true);
    assert.deepEqual(calls, ['rollback(running=false)', 'finish(clean=true, error=Query read timeout)']);
    assert.ok(!(outcome instanceof TransactionOutcomeUnknownError), `got ${String(outcome)}`);
    assert.equal(outcome, own);
    // The policy confirmed the rollback, so the connection goes back to the pool.
    assert.deepEqual(wire, ['BEGIN', 'COMMIT', 'ROLLBACK', 'release']);
  });

  it('a policy that refuses the rollback still settles the outcome, and the connection is discarded', async () => {
    const { outcome, own, calls, wire } = await lostCommitThroughPolicy(false);
    assert.deepEqual(calls, ['rollback(running=false)', 'finish(clean=false, error=Query read timeout)']);
    assert.equal(outcome, own);
    assert.deepEqual(wire, ['BEGIN', 'COMMIT', 'discard']);
  });
});

describe('networked PowDB: a COMMIT whose answer was lost is not reported as rolled back', () => {
  it('the cleanup rollback is refused, not answered locally, so the outcome is unknown', async () => {
    let committed = false;
    const wire: string[] = [];
    const logs: string[] = [];
    // A driver connection whose commit takes effect and then loses its answer.
    const connection = {
      serverVersion: '0.20.0',
      async query(powql: string) {
        wire.push(powql);
        if (powql === 'commit') {
          committed = true;
          throw new Error('COMMIT acknowledgement lost');
        }
        return { kind: 'message', message: 'ok' };
      },
      close: async () => {},
    };
    const driver = {
      acquire: async () => connection,
      release: () => {},
      destroy: () => {},
      withClient: (fn: (c: unknown) => unknown) => fn(connection),
      close: async () => {},
    };
    const pool = new PowdbPool(driver as never);
    const db = new TurbineClient(
      { pool, dialect: powdbDialect, logging: true, logger: { debug: (_m, entry) => logs.push(entry.code) } },
      { tables: {}, enums: {} },
    );
    let handle: { rawUnsafe(sql: string): Promise<unknown> } | undefined;
    const outcome = await db
      .$transaction(async (tx) => {
        handle = tx;
      })
      .catch((err: unknown) => err);
    assert.equal(committed, true);
    assert.equal((outcome as Error).message.includes('COMMIT acknowledgement lost'), true, String(outcome));
    assert.deepEqual(wire, ['begin', 'commit']);
    assert.ok(!logs.includes('transaction-rolled-back'), logs.join(', '));
    assert.ok(logs.includes('transaction-outcome-unknown'), logs.join(', '));
    await assert.rejects(handle!.rawUnsafe('read anything'), /ended with an unknown outcome/);
  });
});

describe('SQL Server: a commit that failed after taking effect claims no rollback', () => {
  it("mssql's own Transaction refuses the rollback, so the outcome is logged as unknown", async () => {
    // Through the engine's own loader: `mssql` ships no declaration file, so a
    // bare `import('mssql')` fails `tsc` (TS7016).
    const { default: importOptionalPeer } = await import('../optional-peer-import.cjs');
    const loaded = (await importOptionalPeer('mssql')) as { default?: unknown };
    const mssql = loaded.default ?? loaded;
    const wire: string[] = [];
    const logs: string[] = [];
    let committed = false;
    const connection = Object.assign(new EventEmitter(), {
      beginTransaction(cb: () => void) {
        wire.push('BEGIN');
        setImmediate(cb);
      },
      commitTransaction(cb: (err?: Error) => void) {
        wire.push('COMMIT');
        committed = true;
        setImmediate(() => cb(new Error('network reset after commit')));
      },
      rollbackTransaction(cb: () => void) {
        wire.push('ROLLBACK');
        setImmediate(cb);
      },
    });
    const driver = {
      acquire(_requester: unknown, cb: (err: unknown, connection: unknown, config: unknown) => void) {
        cb(null, connection, {});
      },
      release() {},
      close: async () => {},
      request() {
        throw new Error('no statements in this test');
      },
      config: { options: {} },
    };
    const pool = new MssqlPool(driver as never, mssql as never);
    const db = new TurbineClient(
      { pool, dialect: mssqlDialect, logging: true, logger: { debug: (_m, entry) => logs.push(entry.code) } },
      { tables: {}, enums: {} },
    );
    const outcome = await db.$transaction(async () => 1).catch((err: unknown) => err);
    assert.equal(committed, true);
    assert.ok(outcome instanceof Error && !(outcome instanceof TransactionOutcomeUnknownError));
    assert.deepEqual(wire, ['BEGIN', 'COMMIT']);
    assert.ok(!logs.includes('transaction-rolled-back'), logs.join(', '));
  });
});

describe('MySQL and the Neon WebSocket driver: an unanswered COMMIT is TransactionOutcomeUnknownError', () => {
  /**
   * The real MySQL engine client over a scripted mysql2 connection whose COMMIT
   * rejects with `commitError`, and the transaction's outcome.
   */
  async function mysqlCommitFails(commitError: Error) {
    const wire: string[] = [];
    const logs: string[] = [];
    const conn = {
      connection: { destroy: () => wire.push('destroy') },
      async execute(sql: string) {
        wire.push(sql);
        if (sql === 'COMMIT') throw commitError;
        return [{ affectedRows: 0 }, []];
      },
      query(sql: string) {
        return this.execute(sql);
      },
      release: () => wire.push('release'),
      destroy: () => wire.push('destroy'),
    };
    const pool = new MysqlPool({
      getConnection: async () => conn,
      end: async () => {},
      execute: (sql: string) => conn.execute(sql),
      query: (sql: string) => conn.query(sql),
    } as never);
    const db = new TurbineClient(
      { pool, dialect: mysqlDialect, logging: true, logger: { debug: (_m, entry) => logs.push(entry.code) } },
      { tables: {}, enums: {} },
    );
    let handle: { rawUnsafe(sql: string): Promise<unknown> } | undefined;
    const outcome = await db
      .$transaction(async (tx) => {
        handle = tx;
      })
      .catch((err: unknown) => err);
    const late = await handle!.rawUnsafe('SELECT 1').catch((err: Error) => err.message);
    return { outcome, wire, logs, late };
  }

  it('MySQL, the connection lost under COMMIT: E021 with the driver error as cause, discarded, no ROLLBACK', async () => {
    const lost = Object.assign(new Error('Connection lost: The server closed the connection.'), {
      code: 'PROTOCOL_CONNECTION_LOST',
      fatal: true,
    });
    const { outcome, wire, logs, late } = await mysqlCommitFails(lost);
    assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
    assert.equal((outcome.cause as { cause?: unknown }).cause ?? outcome.cause, lost);
    assert.ok(!wire.includes('ROLLBACK'), wire.join(', '));
    assert.equal(wire.at(-1), 'destroy');
    assert.ok(logs.includes('transaction-outcome-unknown'), logs.join(', '));
    assert.ok(!logs.includes('transaction-rolled-back'), logs.join(', '));
    assert.doesNotMatch(String(late), /rolled back/);
  });

  it('MySQL, a server shutdown or a killed statement under COMMIT is no answer either', async () => {
    for (const errno of [1053, 1317, 1927]) {
      const { outcome } = await mysqlCommitFails(Object.assign(new Error(`errno ${errno}`), { errno, fatal: false }));
      assert.ok(outcome instanceof TransactionOutcomeUnknownError, `${errno}: got ${String(outcome)}`);
    }
  });

  it('MySQL, an error the server answered COMMIT with keeps its typed class', async () => {
    const deadlock = Object.assign(new Error('Deadlock found when trying to get lock'), {
      errno: 1213,
      sqlState: '40001',
      code: 'ER_LOCK_DEADLOCK',
      fatal: false,
    });
    const { outcome, wire } = await mysqlCommitFails(deadlock);
    assert.ok(outcome instanceof DeadlockError, `got ${String(outcome)}`);
    assert.ok(!(outcome instanceof TransactionOutcomeUnknownError));
    assert.ok(!wire.includes('ROLLBACK'), wire.join(', '));
  });

  /** The Neon WebSocket recovery policy on a scripted connection whose COMMIT rejects with `commitError`. */
  async function neonCommitFails(commitError: Error) {
    const wire: string[] = [];
    const logs: string[] = [];
    const policy = createRecovery(false);
    const client = {
      transactionRecovery: policy,
      async query(sql: string) {
        wire.push(sql);
        if (sql === 'COMMIT') {
          policy.commitSent();
          throw commitError;
        }
        return { rows: [], rowCount: 0, command: sql };
      },
      release: (err?: unknown) => wire.push(err ? 'discard' : 'release'),
    };
    const pool = { connect: async () => client, query: client.query, end: async () => {} };
    const db = new TurbineClient(
      { pool: pool as unknown as PgCompatPool, logging: true, logger: { debug: (_m, entry) => logs.push(entry.code) } },
      { tables: {}, enums: {} },
    );
    const outcome = await db.$transaction(async () => {}).catch((err: unknown) => err);
    return { outcome, wire, logs };
  }

  it('Neon WebSocket, a socket lost under COMMIT: E021 with the driver error as cause, discarded', async () => {
    const lost = new Error('WebSocket connection closed');
    const { outcome, wire, logs } = await neonCommitFails(lost);
    assert.ok(outcome instanceof TransactionOutcomeUnknownError, `got ${String(outcome)}`);
    assert.equal((outcome.cause as { cause?: unknown }).cause ?? outcome.cause, lost);
    assert.ok(!wire.includes('ROLLBACK'), wire.join(', '));
    assert.equal(wire.at(-1), 'discard');
    assert.ok(logs.includes('transaction-outcome-unknown'), logs.join(', '));
  });

  it('Neon WebSocket, an ERROR the server answered COMMIT with keeps its typed class', async () => {
    const unique = Object.assign(new Error('duplicate key value violates unique constraint "t_k_key"'), {
      code: '23505',
      severity: 'ERROR',
      constraint: 't_k_key',
    });
    const { outcome } = await neonCommitFails(unique);
    assert.ok(outcome instanceof UniqueConstraintError, `got ${String(outcome)}`);
  });
});

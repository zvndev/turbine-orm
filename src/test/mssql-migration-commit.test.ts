/** Real optional-driver Transaction, modeled physical transport; no live server claim. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { errorText } from '../cli/error-text.js';
import { type MssqlMigrationDriver, withMssqlMigrationSession } from '../cli/mssql-migrate-connection.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('mssql') as Pick<MssqlMigrationDriver, 'Transaction'>;
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(
  !native,
  'requires optional mssql driver (also used by MSSQL_URL native tests) for Transaction release controls',
);

interface TransactionPin {
  acquire(owner: unknown, callback: (error?: Error) => void): void;
  release(connection: unknown): void;
  _acquiredConnection: unknown;
}
function fixture(ackLost: boolean, closeFailure: boolean) {
  let committed: string[] = [];
  let draft: string[] = [];
  let rollbacks = 0;
  const events: string[] = [];
  class Physical extends EventEmitter {
    beginTransaction(callback: () => void) {
      draft = [...committed];
      callback();
    }
    commitTransaction(callback: (error?: Error) => void) {
      committed = [...draft];
      callback(ackLost ? new Error('lost COMMIT acknowledgement') : undefined);
    }
    rollbackTransaction(callback: () => void) {
      draft = [];
      callback();
    }
  }
  class Pool extends EventEmitter {
    connected = true;
    connection = new Physical();
    constructor(readonly config: unknown) {
      super();
    }
    async connect() {
      return this;
    }
    acquire(_owner: unknown, callback: (error: null, connection: Physical, config: unknown) => void) {
      events.push('acquire');
      callback(null, this.connection, this.config);
    }
    release(connection: unknown) {
      assert.equal(connection, this.connection);
      events.push('release');
    }
    async close() {
      if (closeFailure) throw new Error('pool close failed');
    }
  }
  class Transaction extends native!.Transaction {
    override async rollback() {
      rollbacks++;
      return super.rollback();
    }
  }
  class Request {
    constructor(readonly tx: TransactionPin) {}
    input() {
      return this;
    }
    cancel() {}
    async query(sql: string) {
      await new Promise<void>((resolve, reject) =>
        this.tx.acquire(this, (error) => (error ? reject(error) : resolve())),
      );
      try {
        if (sql.includes('XACT_STATE()')) return { recordset: [{ xactState: 1, transactionCount: 1, sessionId: 71 }] };
        if (sql.includes('sp_getapplock')) return { recordset: [{ lockResult: 0 }] };
        if (sql.startsWith('SET XACT_ABORT')) return { recordset: [] };
        throw new Error(`Unmodeled request: ${sql}`);
      } finally {
        this.tx.release(this.tx._acquiredConnection);
      }
    }
    async batch(sql: string) {
      await this.query('SET XACT_ABORT ON;');
      draft.push(sql);
      return {};
    }
  }
  return {
    driver: { ConnectionPool: Pool, Transaction, Request } as unknown as MssqlMigrationDriver,
    get committed() {
      return committed;
    },
    get rollbacks() {
      return rollbacks;
    },
    events,
  };
}

for (const closeFailure of [false, true]) {
  it(`keeps unknown COMMIT visible after the real driver releases its pin (close failure: ${closeFailure})`, async () => {
    const f = fixture(true, closeFailure);
    await assert.rejects(
      withMssqlMigrationSession(
        { server: 'fixture', database: 'disposable' },
        {},
        async (session) => {
          await session.batch('INSERT INTO dbo.items VALUES(31);');
        },
        async () => f.driver,
      ),
      (error: unknown) => {
        assert.match(errorText(error), /COMMIT.*outcome is unknown.*Inspect migration status before retrying/);
        if (closeFailure) {
          assert.ok(error instanceof Error && error.cause instanceof AggregateError);
          assert.equal(error.cause.errors.length, 2, 'only primary and genuine close failure; no expected ENOTBEGUN');
          assert.match(error.cause.errors[1].message, /pool close failed/);
        }
        return true;
      },
    );
    assert.deepEqual(f.committed, ['INSERT INTO dbo.items VALUES(31);']);
    assert.deepEqual(f.events, ['acquire', 'release']);
    assert.equal(f.rollbacks, 0, 'released native pin must not be rolled back');
  });
}

it('keeps confirmed COMMIT distinct when only pool close fails', async () => {
  const f = fixture(false, true);
  await assert.rejects(
    withMssqlMigrationSession(
      { server: 'fixture', database: 'disposable' },
      {},
      async (session) => {
        await session.batch('INSERT INTO dbo.items VALUES(32);');
      },
      async () => f.driver,
    ),
    /committed, but connection cleanup failed/,
  );
  assert.deepEqual(f.committed, ['INSERT INTO dbo.items VALUES(32);']);
  assert.equal(f.rollbacks, 0);
});

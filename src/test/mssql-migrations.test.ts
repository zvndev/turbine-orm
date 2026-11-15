import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import type { ResolvedConfig } from '../cli/config.js';
import type { CliArgs } from '../cli/index.js';
import { createMssqlMigrationRunner } from '../cli/mssql-migrate.js';
import { createMssqlMigrationCommand } from '../cli/mssql-migrate-command.js';
import {
  type MssqlMigrationConfig,
  type MssqlMigrationDriver,
  mssqlMigrationConfig,
  quoteMssqlMigrationIdentifier,
} from '../cli/mssql-migrate-connection.js';
import {
  assertMssqlMigrationSql,
  parseMssqlMigrationContent,
  scanMssqlMigrationDestructive,
  splitMssqlMigrationBatches,
} from '../cli/mssql-migrate-sql.js';
import { MigrationError } from '../errors.js';

const TARGET = { server: 'fixture', database: 'disposable', options: { encrypt: true } };
const FIRST = '20260101000000_first';
const SECOND = '20260102000000_second';
it('accepts ALTER TABLE column/constraint clauses with consent without widening later DDL heads', async (t) => {
  const f = fixture(t);
  for (const sql of [
    'ALTER TABLE dbo.items ALTER COLUMN value nvarchar(200) NULL;',
    'ALTER TABLE dbo.items DROP COLUMN value;',
    'ALTER TABLE dbo.items DROP CONSTRAINT items_value_unique;',
    'ALTER TABLE dbo.items DROP COLUMN a, b; ALTER TABLE dbo.items ALTER COLUMN c int NULL;',
  ]) {
    assert.doesNotThrow(() => assertMssqlMigrationSql(sql));
    f.migration(FIRST, sql);
    const n = nativeFixture();
    await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir), /DESTRUCTIVE/);
    assert.equal(n.state.exists, false);
    assert.equal((await n.runner.migrateMssqlUp(TARGET, f.dir, { allowDestructive: true })).applied.length, 1);
    assert.deepEqual(n.state.effects, [sql]);
  }
  for (const sql of [
    'DROP COLUMN value;',
    'ALTER TABLE dbo.items ADD value int; DROP CONSTRAINT other;',
    'ALTER TABLE dbo.items DROP COLUMN value; CREATE SCHEMA other;',
    'ALTER TABLE dbo.items DROP COLUMN value CREATE SCHEMA other;',
    'ALTER TABLE dbo.items ADD value int; BEGIN TRANSACTION;',
    'ALTER TABLE dbo.items ADD value int; SELECT 1; ALTER COLUMN value int;',
  ])
    assert.throws(() => assertMssqlMigrationSql(sql), /Unsupported|TABLE, INDEX and VIEW/);
});
interface State {
  exists: boolean;
  history: Record<string, unknown>[];
  effects: string[];
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mssql-migrations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const migration = (name: string, up: string, down = 'DROP TABLE dbo.items;') => {
    const path = join(dir, `${name}.sql`);
    writeFileSync(path, `-- UP\n${up}\n-- DOWN\n${down}\n`);
    return path;
  };
  return { dir, migration };
}
function hashLegacy(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

/** Transactional fault model: not SQL Server evidence. SQL execution has observable staged effects. */
function nativeFixture() {
  let state: State = { exists: false, history: [], effects: [] };
  const events: string[] = [];
  const configs: MssqlMigrationConfig[] = [];
  const waits: unknown[] = [];
  let loads = 0;
  let lockResult = 0;
  let xactState = 1;
  let transactionCount = 1;
  let objectType = 'U';
  let validHistory = 1;
  let triggers = false;
  let failQuery: RegExp | undefined;
  let failBatch: RegExp | undefined;
  let autoRollback = false;
  let failCommit = false;
  let failRollback = false;
  let failClose = false;
  let historyWrite = true;
  let schemaExists = true;
  let onBatch: ((sql: string) => void) | undefined;
  let onLock: (() => void) | undefined;
  let onRequest: ((sql: string, cancel: () => void) => Promise<void>) | undefined;
  let poolListener: ((error: unknown) => void) | undefined;
  class Pool {
    on(_event: 'error', listener: (error: unknown) => void) {
      poolListener = listener;
    }
    constructor(config: MssqlMigrationConfig) {
      configs.push(config);
      events.push('pool');
    }
    async connect() {
      events.push('connect');
    }
    async close() {
      events.push('close');
      if (failClose) throw new Error('close failed');
    }
  }
  class Transaction {
    draft: State = structuredClone(state);
    rollbackListener?: (aborted: boolean) => void;
    async begin() {
      events.push('begin');
    }
    async commit() {
      events.push('commit');
      if (failCommit) throw new Error('commit lost');
      state = this.draft;
    }
    async rollback() {
      events.push('rollback');
      if (failRollback) throw new Error('rollback failed');
    }
    on(_event: 'rollback', fn: (aborted: boolean) => void) {
      this.rollbackListener = fn;
    }
  }
  class Request {
    params: Record<string, unknown> = {};
    cancelled = false;
    readonly tx: Transaction;
    constructor(tx: ConstructorParameters<MssqlMigrationDriver['Request']>[0]) {
      assert.ok(tx instanceof Transaction, 'every request must be pinned to Transaction');
      this.tx = tx;
    }
    input(name: string, value: unknown) {
      this.params[name] = value;
      return this;
    }
    cancel() {
      this.cancelled = true;
      events.push('cancel');
    }
    async query(sql: string): Promise<{ recordset: Record<string, unknown>[] }> {
      events.push(`query:${sql}`);
      if (onRequest)
        await onRequest(sql, () => {
          this.cancelled = true;
        });
      if (this.cancelled) throw new Error('request cancelled');
      if (failQuery?.test(sql)) throw new Error('query failed');
      const result = (recordset: Record<string, unknown>[]) => ({ recordset });
      const draft = this.tx.draft;
      if (sql.includes('XACT_STATE()')) return result([{ xactState, transactionCount, sessionId: 71 }]);
      if (sql.includes('sp_getapplock')) {
        waits.push(this.params.wait);
        assert.equal(this.params.resource, 'turbine:migrations:v1');
        assert.match(sql, /@LockOwner='Transaction'/);
        onLock?.();
        // Simulate history becoming visible after a competing writer releases its lock.
        this.tx.draft = structuredClone(state);
        return result([{ lockResult }]);
      }
      if (sql.includes('SCHEMA_ID')) return result([{ schemaId: schemaExists ? 1 : null }]);
      if (sql.includes('FROM sys.objects')) return result(draft.exists ? [{ objectId: 21, objectType }] : []);
      if (sql.includes('END AS valid')) return result([{ valid: validHistory }]);
      if (sql.includes('AS migrationIdentifiers')) {
        assert.match(sql, /COLLATE DATABASE_DEFAULT/);
        const reserved = Object.entries(this.params).some(
          ([key, value]) =>
            key.startsWith('identifier') &&
            String(value).normalize('NFKD').replace(/\p{M}/gu, '').trimEnd().toUpperCase() === '_TURBINE_MIGRATIONS',
        );
        return result(reserved ? [{ reserved: 1 }] : []);
      }
      if (sql.includes('FROM sys.triggers')) return result(triggers ? [{ name: 'hidden_control' }] : []);
      if (sql.startsWith('SELECT id, name')) return result(structuredClone(draft.history));
      if (sql.startsWith('CREATE TABLE')) {
        draft.exists = true;
        return result([]);
      }
      if (sql.startsWith('INSERT INTO')) {
        if (!historyWrite) return result([]);
        const row = {
          id: draft.history.length + 1,
          name: this.params.name,
          checksum: this.params.checksum,
          applied_at: new Date(),
        };
        draft.history.push(row);
        return result([{ name: row.name, checksum: row.checksum }]);
      }
      if (sql.startsWith('DELETE FROM')) {
        const old = draft.history.find((r) => r.name === this.params.name);
        draft.history = draft.history.filter((r) => r.name !== this.params.name);
        return result(old ? [{ name: old.name }] : []);
      }
      if (sql.startsWith('UPDATE')) {
        const old = draft.history.find((r) => r.name === this.params.name && r.checksum === this.params.previous);
        if (old) old.checksum = this.params.checksum;
        return result(old ? [{ name: old.name, checksum: old.checksum }] : []);
      }
      if (sql.startsWith('SET XACT_ABORT')) return result([]);
      throw new Error(`Unmodeled trusted query: ${sql}`);
    }
    async batch(sql: string) {
      events.push(`batch:${sql}`);
      this.tx.draft.effects.push(sql);
      onBatch?.(sql);
      if (failBatch?.test(sql)) {
        if (autoRollback) this.tx.rollbackListener?.(true);
        throw new Error('native batch failure');
      }
      return {};
    }
  }
  const driver = { ConnectionPool: Pool, Transaction, Request } as MssqlMigrationDriver;
  return {
    runner: createMssqlMigrationRunner(async () => {
      loads++;
      return driver;
    }),
    events,
    configs,
    waits,
    emitPoolError: (error: unknown) => poolListener?.(error),
    get loads() {
      return loads;
    },
    get state() {
      return state;
    },
    set state(value: State) {
      state = value;
    },
    set lockResult(value: number) {
      lockResult = value;
    },
    set xactState(value: number) {
      xactState = value;
    },
    set transactionCount(value: number) {
      transactionCount = value;
    },
    set objectType(value: string) {
      objectType = value;
    },
    set validHistory(value: number) {
      validHistory = value;
    },
    set triggers(value: boolean) {
      triggers = value;
    },
    set failQuery(value: RegExp | undefined) {
      failQuery = value;
    },
    set failBatch(value: RegExp | undefined) {
      failBatch = value;
    },
    set autoRollback(value: boolean) {
      autoRollback = value;
    },
    set failCommit(value: boolean) {
      failCommit = value;
    },
    set failRollback(value: boolean) {
      failRollback = value;
    },
    set failClose(value: boolean) {
      failClose = value;
    },
    set historyWrite(value: boolean) {
      historyWrite = value;
    },
    set schemaExists(value: boolean) {
      schemaExists = value;
    },
    set onBatch(value: ((sql: string) => void) | undefined) {
      onBatch = value;
    },
    set onLock(value: (() => void) | undefined) {
      onLock = value;
    },
    set onRequest(value: ((sql: string, cancel: () => void) => Promise<void>) | undefined) {
      onRequest = value;
    },
  };
}

describe('SQL Server migration source preflight', () => {
  it('splits GO outside strings, escaped identifiers and nested comments, preserving exact batches', () => {
    const source = `SELECT N'first\nGO\n-- DOWN\nlast''value';\n/* outer\n/* GO */\nGO\n*/\nGO -- batch\nSELECT [a]]GO], "a""GO";\r\nGO\r\nSELECT 3;`;
    const batches = splitMssqlMigrationBatches(source);
    assert.equal(batches.length, 3);
    assert.match(batches[0]!, /-- DOWN/);
    assert.match(batches[0]!, /\/\* GO \*\//);
    assert.equal(batches[1], 'SELECT [a]]GO], "a""GO";');
    assert.equal(batches[2], 'SELECT 3;');
    assert.doesNotThrow(() => assertMssqlMigrationSql(source));
  });
  it('preserves section-like lines inside literals/nested comments and accepts shared marker spellings', () => {
    const parsed = parseMssqlMigrationContent(
      `-- header\n--up;\nSELECT '\n-- DOWN\n';\n/*\n-- DOWN\n*/\n-- down;\nSELECT 2;`,
    );
    assert.equal(parsed.up, "SELECT '\n-- DOWN\n';\n/*\n-- DOWN\n*/");
    assert.equal(parsed.down, 'SELECT 2;');
    assert.throws(() => parseMssqlMigrationContent('SELECT 1;'), /-- UP/);
    assert.throws(() => parseMssqlMigrationContent('-- DOWN\nSELECT 1;\n-- UP\nSELECT 2;'), /-- UP/);
    assert.throws(() => parseMssqlMigrationContent('-- UP\nSELECT 1;\n-- UP\nSELECT 2;'), /-- UP/);
  });
  for (const sql of [
    'SELECT 1;\nGO 2\nSELECT 2;',
    'SELECT 1; GO',
    'SELECT 1;\nGO;\n',
    "SELECT 'unfinished",
    'SELECT [unfinished',
    'SELECT "unfinished',
    '/* unfinished',
    'SELECT 1;\0COMMIT;',
    'SELECT 1; COMMIT;',
    'SELECT 1; ROLLBACK TRANSACTION;',
    'BEGIN TRAN; SELECT 1;',
    'SELECT 1; SAVE TRANSACTION s;',
    'SELECT 1; SET XACT_ABORT OFF;',
    "EXEC(N'COMMIT');",
    'SELECT 1; EXECUTE [sys].[sp_releaseapplock];',
    'CREATE PROCEDURE dbo.p AS SELECT 1;',
    'CREATE TRIGGER dbo.t ON dbo.x AFTER INSERT AS SELECT 1;',
    'ALTER DATABASE d SET SINGLE_USER;',
    'CREATE SYNONYM dbo.t FOR other.dbo.x;',
    'SELECT NEXT VALUE FOR dbo.seq;',
    'SELECT * FROM other.dbo.t;',
    'SELECT * FROM [other].[dbo].[t];',
    'SELECT * FROM other..t;',
    'SELECT * FROM dbo.[_turbine_migrations];',
    'SELECT * FROM "_turbine_migrations";',
    'SELECT $(variable);',
    ':r script.sql',
    '!! shell',
    '-- only a comment',
    'DECLARE @x int; SELECT @x;',
    'SELECT * INTO #scratch FROM dbo.x;',
  ])
    it(`refuses unsupported SQL before sending a batch: ${JSON.stringify(sql)}`, () => {
      assert.throws(() => assertMssqlMigrationSql(sql), /SQL Server|Unsupported|Unterminated/);
    });
  it('does not flag quoted keywords, inert comments or literal destructive SQL', () => {
    const safe = `CREATE TABLE [a]]b].[таблица] ([COMMIT] int, "DELETE" nvarchar(50));\nGO\nINSERT INTO [a]]b].[таблица] VALUES (1, N'GO; DROP TABLE dbo.items'); -- EXEC`;
    assert.doesNotThrow(() => assertMssqlMigrationSql(safe));
    assert.deepEqual(scanMssqlMigrationDestructive(safe), []);
    assert.doesNotThrow(() => assertMssqlMigrationSql("SELECT ':' WHERE '!' != '?';"));
    assert.doesNotThrow(() => assertMssqlMigrationSql('SELECT [.] AS [.] FROM [a.b].[x]; UPDATE [;] SET [.] = 1;'));
    assert.equal(scanMssqlMigrationDestructive('UPDATE dbo.items SET value=1 WHERE id=1;').length, 1);
  });
});

describe('native MSSQL migration lifecycle fault model', () => {
  it('uses one pinned transaction for lock, tracking and batches, with quoted namespace and owned TLS config', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    f.migration(FIRST, 'CREATE TABLE [a]]b].[items](id int);\nGO\nINSERT INTO [a]]b].[items] VALUES(1);');
    const result = await n.runner.migrateMssqlUp(TARGET, f.dir, { schema: 'a]b' });
    assert.equal(result.applied.length, 1);
    assert.equal(n.state.history.length, 1);
    assert.equal(n.state.effects.length, 2);
    assert.equal(n.events.filter((e) => e === 'pool').length, 1);
    assert.equal(n.events.filter((e) => e === 'begin').length, 1);
    assert.match(n.events.find((e) => e.startsWith('query:CREATE TABLE'))!, /\[a\]\]b\]\.\[_turbine_migrations\]/);
    assert.equal(n.configs[0]?.options?.encrypt, true);
    assert.equal(n.configs[0]?.options?.abortTransactionOnError, true);
    assert.deepEqual(n.configs[0]?.pool, { min: 0, max: 1 });
    assert.deepEqual(n.events.slice(-2), ['commit', 'close']);
    assert.deepEqual((await n.runner.migrateMssqlUp(TARGET, f.dir)).applied, []);
    assert.equal(n.state.effects.length, 2);
  });
  it('keeps inspect/status read-only, then supports step/deploy/down and reports out-of-order history', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    f.migration(SECOND, 'CREATE TABLE dbo.items(id int);');
    assert.equal((await n.runner.inspectMssqlMigrationDeploy(TARGET, f.dir)).pending.length, 1);
    assert.equal((await n.runner.migrateMssqlStatus(TARGET, f.dir))[0]?.applied, false);
    assert.equal(n.state.exists, false);
    await n.runner.migrateMssqlUp(TARGET, f.dir, { step: 1 });
    f.migration(FIRST, 'UPDATE dbo.items SET id=2;');
    const before = structuredClone(n.state);
    await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir), /DESTRUCTIVE/);
    assert.deepEqual(n.state, before);
    assert.equal((await n.runner.migrateMssqlDeploy(TARGET, f.dir)).outOfOrder[0]?.applied, `${FIRST}.sql`);
    assert.equal((await n.runner.planMssqlMigrationRollback(TARGET, f.dir)).files[0]?.name, FIRST);
    await assert.rejects(n.runner.migrateMssqlDown(TARGET, f.dir), /DESTRUCTIVE/);
    assert.equal(
      (await n.runner.migrateMssqlDown(TARGET, f.dir, { allowDestructive: true })).rolledBack[0]?.name,
      FIRST,
    );
    assert.equal(n.state.history.length, 1);
  });
  it('rolls back every selected file and its history after a later SQL failure, then retries once', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    f.migration(FIRST, 'CREATE TABLE dbo.items(id int);');
    f.migration(SECOND, 'INSERT INTO dbo.items VALUES(2);');
    n.failBatch = /INSERT/;
    await assert.rejects(n.runner.migrateMssqlDeploy(TARGET, f.dir), /native batch failure/);
    assert.deepEqual(n.state, { exists: false, history: [], effects: [] });
    assert.deepEqual(n.events.slice(-2), ['rollback', 'close']);
    n.failBatch = undefined;
    assert.equal((await n.runner.migrateMssqlDeploy(TARGET, f.dir)).applied.length, 2);
    assert.equal(n.state.history.length, 2);
    assert.equal(n.state.effects.length, 2);
  });
  it('preflights all selected sources before history creation and refuses no-transaction/empty DOWN', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    f.migration(FIRST, 'CREATE TABLE dbo.items(id int);');
    const second = f.migration(SECOND, 'COMMIT;');
    await assert.rejects(n.runner.migrateMssqlDeploy(TARGET, f.dir), /Unsupported/);
    assert.equal(
      n.events.some((e) => e.startsWith('batch:') || e.startsWith('query:CREATE TABLE')),
      false,
    );
    writeFileSync(second, '-- turbine:no-transaction\n-- UP\nSELECT 1;');
    await assert.rejects(n.runner.migrateMssqlDeploy(TARGET, f.dir), /no-transaction/);
    unlinkSync(second);
    const first = f.migration(FIRST, 'CREATE TABLE dbo.items(id int);', '-- irreversible');
    await n.runner.migrateMssqlDeploy(TARGET, f.dir);
    await assert.rejects(n.runner.migrateMssqlDown(TARGET, f.dir, { allowDestructive: true }), /executable/);
    assert.equal(n.state.history.length, 1);
    assert.ok(readFileSync(first, 'utf8').includes('irreversible'));
  });
  it('executes and hashes one immutable snapshot even if files change while waiting for the lock', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    const path = f.migration(FIRST, 'CREATE TABLE dbo.original(id int);');
    n.onLock = () => writeFileSync(path, '-- UP\nCREATE TABLE dbo.changed(id int);');
    await n.runner.migrateMssqlUp(TARGET, f.dir);
    assert.match(n.state.effects[0]!, /dbo.original/);
    assert.equal((await n.runner.migrateMssqlStatus(TARGET, f.dir))[0]?.checksumValid, false);
    await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir), /checksum drift/);
  });
  it('reports missing/drifted/invalid legacy hashes and upgrades only proven legacy hashes on writes', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    const path = f.migration(FIRST, 'CREATE TABLE dbo.items(id int);');
    await n.runner.migrateMssqlUp(TARGET, f.dir);
    n.state.history[0]!.checksum = hashLegacy(readFileSync(path, 'utf8'));
    const old = n.state.history[0]!.checksum;
    assert.equal((await n.runner.migrateMssqlStatus(TARGET, f.dir))[0]?.checksumValid, true);
    assert.equal(n.state.history[0]!.checksum, old);
    await n.runner.migrateMssqlUp(TARGET, f.dir);
    assert.match(String(n.state.history[0]!.checksum), /^[a-f0-9]{64}$/);
    for (const checksum of ['', 'incorrect', '0'.repeat(64)]) {
      n.state.history[0]!.checksum = checksum;
      assert.equal((await n.runner.migrateMssqlStatus(TARGET, f.dir))[0]?.checksumValid, false);
      await assert.rejects(n.runner.migrateMssqlDeploy(TARGET, f.dir), /checksum drift/);
    }
    unlinkSync(path);
    assert.equal((await n.runner.migrateMssqlStatus(TARGET, f.dir))[0]?.missingFile, true);
    assert.deepEqual((await n.runner.planMssqlMigrationRollback(TARGET, f.dir)).missing, [FIRST]);
    await assert.rejects(n.runner.migrateMssqlDown(TARGET, f.dir, { allowDestructive: true }), /missing files/);
  });
  for (const code of [-1, -2, -3, -999, 2])
    it(`fails closed on app-lock result ${code}, then succeeds after lock release`, async (t) => {
      const f = fixture(t);
      const n = nativeFixture();
      f.migration(FIRST, 'SELECT 1;');
      n.lockResult = code;
      await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir, { lockWaitMs: 30 }), /lock.*30ms/);
      assert.equal(n.state.exists, false);
      assert.equal(
        n.events.some((e) => e.startsWith('batch:')),
        false,
      );
      n.lockResult = 1;
      assert.equal((await n.runner.migrateMssqlUp(TARGET, f.dir)).applied.length, 1);
    });
  it('rereads committed history under the acquired lock', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    f.migration(FIRST, 'SELECT 1;');
    await n.runner.migrateMssqlUp(TARGET, f.dir);
    const committed = structuredClone(n.state);
    n.state = { exists: false, history: [], effects: [] };
    n.onLock = () => {
      n.state = committed;
    };
    assert.deepEqual((await n.runner.migrateMssqlUp(TARGET, f.dir)).applied, []);
    assert.equal(n.state.effects.length, 1);
  });
  it('refuses uncommittable/lost/nested transactions and does not commit after state changes', async (t) => {
    const f = fixture(t);
    f.migration(FIRST, 'SELECT 1;');
    for (const state of [-1, 0]) {
      const n = nativeFixture();
      n.xactState = state;
      await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir), /XACT_STATE/);
      assert.equal(n.state.exists, false);
    }
    const n = nativeFixture();
    n.onBatch = () => {
      n.transactionCount = 2;
    };
    await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir), /@@TRANCOUNT/);
    assert.equal(n.state.exists, false);
    assert.equal(n.events.includes('commit'), false);
  });
  it('handles automatic rollback without reusing its released transaction connection', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    f.migration(FIRST, 'SELECT 1;');
    n.failBatch = /SELECT/;
    n.autoRollback = true;
    await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir), /native batch failure/);
    assert.equal(n.events.includes('rollback'), false);
    assert.equal(n.events.at(-1), 'close');
    assert.equal(n.state.exists, false);
  });
  it('preserves primary and cleanup failures and labels ambiguous COMMIT outcomes', async (t) => {
    const f = fixture(t);
    f.migration(FIRST, 'SELECT 1;');
    const n = nativeFixture();
    n.failBatch = /SELECT/;
    n.failRollback = true;
    n.failClose = true;
    await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir), (error: unknown) => {
      assert.ok(error instanceof MigrationError);
      assert.ok(error.cause instanceof AggregateError);
      assert.deepEqual(
        error.cause.errors.map((e) => e.message),
        ['native batch failure', 'rollback failed', 'close failed'],
      );
      return true;
    });
    const c = nativeFixture();
    c.failCommit = true;
    await assert.rejects(c.runner.migrateMssqlUp(TARGET, f.dir), /outcome is unknown/);
    assert.equal(c.events.at(-1), 'close');
    const unknown = nativeFixture();
    unknown.failCommit = true;
    unknown.failClose = true;
    await assert.rejects(
      unknown.runner.migrateMssqlUp(TARGET, f.dir),
      /COMMIT.*outcome is unknown.*Inspect migration status/,
    );
    const committed = nativeFixture();
    committed.failClose = true;
    await assert.rejects(committed.runner.migrateMssqlUp(TARGET, f.dir), /committed, but connection cleanup failed/);
    assert.equal(committed.state.history.length, 1);
  });
  it('rejects invalid history shapes, schema absence, triggers and ignored tracking writes', async (t) => {
    const f = fixture(t);
    f.migration(FIRST, 'SELECT 1;');
    for (const flag of ['object', 'shape', 'schema', 'triggers', 'write']) {
      const n = nativeFixture();
      if (flag === 'object') {
        n.state.exists = true;
        n.objectType = 'V';
      }
      if (flag === 'shape') {
        n.state.exists = true;
        n.validHistory = 0;
      }
      if (flag === 'schema') n.schemaExists = false;
      if (flag === 'triggers') n.triggers = true;
      if (flag === 'write') n.historyWrite = false;
      await assert.rejects(
        n.runner.migrateMssqlUp(TARGET, f.dir),
        /tracking metadata|schema does not exist|triggers|history write/,
      );
      assert.deepEqual(n.state.effects, []);
    }
  });
  it('aborts before construction and during a native request, then rolls back before closing', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    f.migration(FIRST, 'SELECT 1;');
    const pre = new AbortController();
    pre.abort(new Error('pre-abort'));
    await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir, { signal: pre.signal }), /pre-abort/);
    assert.equal(n.loads, 0);
    const active = new AbortController();
    n.onRequest = async (sql) => {
      if (sql.includes('SCHEMA_ID')) active.abort(new Error('active-abort'));
    };
    await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir, { signal: active.signal }), /request cancelled/);
    assert.ok(n.events.includes('cancel'));
    assert.deepEqual(n.events.slice(-2), ['rollback', 'close']);
    assert.equal(n.state.exists, false);
  });
  it('validates config, limits and unsupported options before loading a driver', async (t) => {
    const f = fixture(t);
    const n = nativeFixture();
    f.migration(FIRST, 'SELECT 1;');
    for (const options of [
      { step: 0 },
      { step: 1.5 },
      { lockWaitMs: -1 },
      { lockWaitMs: 2147483648 },
      { schema: '' },
      { schema: 'x\0' },
      { allowDrift: true },
      { force: true },
      { noTransaction: true },
      { adapter: {} },
      { dialect: {} },
    ]) {
      await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir, options as never), /SQL Server/);
    }
    for (const url of [
      'postgresql://secret:private@host/db',
      'mssql://host/db?encrypt=true',
      'mssql://host/db#tls',
      'mssql://host/',
      'mssql://host/db/other',
      'mssql://secret:%zz@host/db',
    ]) {
      await assert.rejects(n.runner.migrateMssqlUp(url, f.dir), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /secret|private|%zz/);
        return true;
      });
    }
    assert.equal(n.loads, 0);
    assert.equal(quoteMssqlMigrationIdentifier('a]b."x'), '[a]]b."x]');
    const url = mssqlMigrationConfig('mssql://user:pw@host:1433/a%20b');
    assert.equal(url.database, 'a b');
    assert.equal(url.options?.encrypt, false);
    assert.throws(() => mssqlMigrationConfig({ ...TARGET, request() {} }), /borrowed pool/);
  });
});

it('connection errors are captured without an unhandled EventEmitter error and prevent commit', async (t) => {
  const f = fixture(t);
  const n = nativeFixture();
  f.migration(FIRST, 'SELECT 1;');
  n.onBatch = () => n.emitPoolError(new Error('native connection lost'));
  await assert.rejects(n.runner.migrateMssqlUp(TARGET, f.dir), /native connection lost/);
  assert.equal(n.state.exists, false);
  assert.deepEqual(n.events.slice(-2), ['rollback', 'close']);
});

describe('SQL Server migration command adapter', () => {
  function commandFixture(t: TestContext) {
    const f = fixture(t);
    const n = nativeFixture();
    const output: string[] = [];
    t.mock.method(console, 'log', (...values: unknown[]) => {
      output.push(values.join(' '));
    });
    t.mock.method(console, 'error', (...values: unknown[]) => {
      output.push(values.join(' '));
    });
    const config = {
      engine: 'mssql',
      url: 'mssql://user:secret@fixture/disposable',
      schema: 'dbo',
      migrationsDir: f.dir,
    } as unknown as ResolvedConfig;
    const run = createMssqlMigrationCommand(n.runner);
    const args = (subcommand: string, extra: Partial<CliArgs> = {}): CliArgs => ({
      command: 'migrate',
      subcommand,
      positional: [],
      ...extra,
    });
    return { ...f, n, output, config, run, args };
  }
  it('creates a shared-format SQL file offline and refuses unsupported flags before filesystem/driver effects', async (t) => {
    const f = commandFixture(t);
    await f.run(f.args('create', { positional: ['add_items'] }), { ...f.config, url: '' }, async () => false);
    const names = readdirSync(f.dir);
    assert.equal(names.length, 1);
    assert.match(names[0]!, /^\d{14}_add_items\.sql$/);
    assert.match(readFileSync(join(f.dir, names[0]!), 'utf8'), /-- UP/);
    for (const extra of [
      { recipe: 'backfill' },
      { auto: true },
      { force: true },
      { allowDrift: true },
      { fromDiff: true },
      { wait: 1 },
      { step: 1 },
      { dryRun: true },
      { exitCode: true },
    ]) {
      await assert.rejects(
        f.run(f.args('create', { positional: ['forbidden'], ...extra }), f.config, async () => true),
        /SQL Server|only applies/,
      );
    }
    assert.equal(readdirSync(f.dir).length, 1);
    assert.equal(f.n.loads, 0);
    await assert.rejects(
      f.run(f.args('up'), { ...f.config, engine: 'postgresql' }, async () => true),
      /engine/,
    );
    await assert.rejects(
      f.run(f.args('up'), { ...f.config, adapter: {} as never }, async () => true),
      /adapters/,
    );
    assert.equal(f.n.loads, 0);
  });
  it('dry-run shows actual selected SQL without writes and rejects unsupported source in its inventory', async (t) => {
    const f = commandFixture(t);
    const path = f.migration(FIRST, 'CREATE TABLE dbo.items(id int);');
    await f.run(f.args('up', { dryRun: true }), f.config, async () => {
      throw new Error('no prompt during dry-run');
    });
    assert.match(f.output.join('\n'), /CREATE TABLE dbo.items/);
    assert.match(f.output.join('\n'), /Dry run: 1 migration/);
    assert.equal(f.n.state.exists, false);
    writeFileSync(path, '-- UP\nCOMMIT;');
    await assert.rejects(
      f.run(f.args('up', { dryRun: true }), f.config, async () => true),
      /Unsupported/,
    );
    assert.equal(f.n.state.exists, false);
    assert.doesNotMatch(f.output.join('\n'), /secret/);
  });
  it('refuses ignored flags and missing or swallowed operands before loading the native driver', async (t) => {
    const f = commandFixture(t);
    f.migration(FIRST, 'CREATE TABLE dbo.items(id int);');
    for (const extra of [{ out: '--dry-run' }, { url: undefined }, { url: '' }, { schema: undefined }]) {
      await assert.rejects(
        f.run(f.args('up', extra), f.config, async () => true),
        /does not support|requires a value/,
      );
      assert.equal(f.n.loads, 0);
    }
    await assert.rejects(
      f.run(f.args('up', { url: f.config.url }), f.config, async () => true, [
        'migrate',
        'up',
        '--url',
        '--dry-run',
        '--url',
        f.config.url,
      ]),
      /requires a value/,
    );
    assert.equal(f.n.loads, 0);
    assert.equal(f.n.state.exists, false);
    assert.deepEqual(f.n.state.effects, []);
  });
  it('prompts only after a native destructive refusal and reruns the full locked validation after consent', async (t) => {
    const f = commandFixture(t);
    f.migration(FIRST, 'DELETE FROM dbo.items;');
    let prompts = 0;
    await assert.rejects(
      f.run(f.args('up'), f.config, async () => {
        prompts++;
        return false;
      }),
      /Aborted/,
    );
    assert.equal(prompts, 1);
    assert.equal(f.n.state.exists, false);
    await f.run(f.args('up'), f.config, async (report) => {
      prompts++;
      assert.match(report, /DESTRUCTIVE/);
      return true;
    });
    assert.equal(prompts, 2);
    assert.equal(f.n.state.history.length, 1);
    assert.match(f.output.join('\n'), /1 migration\(s\) applied/);
    await f.run(f.args('down', { allowDestructive: true }), f.config, async () => {
      throw new Error('already authorized');
    });
    assert.equal(f.n.state.history.length, 0);
  });
  it('deploy forwards the finite native lock wait and performs no confirmation', async (t) => {
    const f = commandFixture(t);
    f.migration(FIRST, 'DELETE FROM dbo.items;');
    await f.run(f.args('deploy', { wait: 2 }), f.config, async () => {
      throw new Error('deploy never prompts');
    });
    assert.equal(f.n.waits.at(-1), 2000);
    assert.equal(f.n.state.history.length, 1);
    for (const wait of [0, -1, 0.5, 2147484, Number.NaN])
      await assert.rejects(
        f.run(f.args('deploy', { wait }), f.config, async () => true),
        /--wait/,
      );
    await assert.rejects(
      f.run(f.args('deploy', { step: 1 }), f.config, async () => true),
      /--step/,
    );
  });
  it('status exit gates report pending, drifted, missing and misnamed files without mutating history', async (t) => {
    const f = commandFixture(t);
    const path = f.migration(FIRST, 'SELECT 1;');
    const initialExit = process.exitCode;
    t.after(() => {
      process.exitCode = initialExit;
    });
    await f.run(f.args('status', { exitCode: true }), f.config, async () => false);
    assert.equal(process.exitCode, 2);
    assert.equal(f.n.state.exists, false);
    await f.n.runner.migrateMssqlUp(TARGET, f.dir);
    const before = structuredClone(f.n.state);
    process.exitCode = 0;
    await f.run(f.args('status', { exitCode: true }), f.config, async () => false);
    assert.equal(process.exitCode, 0);
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n-- drift`);
    await f.run(f.args('status', { exitCode: true }), f.config, async () => false);
    assert.equal(process.exitCode, 2);
    assert.match(f.output.join('\n'), /Drifted/);
    unlinkSync(path);
    await f.run(f.args('list', { exitCode: true }), f.config, async () => false);
    assert.match(f.output.join('\n'), /Missing file/);
    assert.deepEqual(f.n.state, before);
    writeFileSync(join(f.dir, 'forgotten.sql'), '-- UP\nSELECT 1;');
    await f.run(f.args('status', { exitCode: true }), f.config, async () => false);
    assert.match(f.output.join('\n'), /Not a migration/);
    assert.equal(process.exitCode, 2);
  });
});

it('configures a native RPC timeout that allows the complete server lock wait on all supported driver majors', async (t) => {
  const f = fixture(t);
  f.migration(FIRST, 'SELECT 1;');
  for (const [requestTimeout, lockWaitMs, expected] of [
    [undefined, 0, 15000],
    [undefined, 20000, 21000],
    [500, 0, 500],
    [500, 3000, 4000],
    [0, 3000, 0],
    [undefined, 2147483647, 0],
  ] as const) {
    const n = nativeFixture();
    await n.runner.migrateMssqlUp({ ...TARGET, requestTimeout }, f.dir, { lockWaitMs });
    assert.equal(n.configs[0]?.requestTimeout, expected);
  }
  const n = nativeFixture();
  for (const requestTimeout of [-1, 0.5, Infinity, '15000']) {
    await assert.rejects(n.runner.migrateMssqlUp({ ...TARGET, requestTimeout }, f.dir), /requestTimeout/);
  }
  assert.equal(n.loads, 0);
});

it('uses native database collation to refuse trailing-space/accent/width aliases of protected history before any SQL effects', async (t) => {
  const f = fixture(t);
  for (const name of ['_turbine_migrations ', '_turbine_migrátions', '＿turbine_migrations']) {
    const n = nativeFixture();
    f.migration(FIRST, `CREATE TABLE dbo.items(id int); DELETE FROM dbo.[${name}];`);
    await assert.rejects(n.runner.migrateMssqlDeploy(TARGET, f.dir), /database collation/);
    assert.equal(n.state.exists, false);
    assert.equal(
      n.events.some((event) => event.startsWith('batch:') || event.startsWith('query:CREATE TABLE')),
      false,
    );
  }
});

it('deploy refuses a step limit before loading a driver instead of silently truncating the pending batch', async (t) => {
  const f = fixture(t);
  const n = nativeFixture();
  f.migration(FIRST, 'SELECT 1;');
  await assert.rejects(n.runner.migrateMssqlDeploy(TARGET, f.dir, { step: 1 } as never), /all pending migrations/);
  assert.equal(n.loads, 0);
});

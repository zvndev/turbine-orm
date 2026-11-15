/** Required-service SQL Server cases. Fault-model tests in the companion file are not native evidence. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { TestContext } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { ResolvedConfig } from '../cli/config.js';
import {
  createMssqlMigrationRunner,
  inspectMssqlMigrationDeploy,
  migrateMssqlDeploy,
  migrateMssqlDown,
  migrateMssqlStatus,
  migrateMssqlUp,
} from '../cli/mssql-migrate.js';
import { cmdMssqlMigrate } from '../cli/mssql-migrate-command.js';
import {
  MSSQL_MIGRATION_LOCK,
  type MssqlMigrationDriver,
  type MssqlMigrationRequest,
  mssqlMigrationConfig,
  quoteMssqlMigrationIdentifier as quote,
} from '../cli/mssql-migrate-connection.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import { skipGate } from './helpers.js';

const URL = process.env.MSSQL_TEST_URL ?? process.env.MSSQL_URL;
const gate = skipGate(!URL, 'requires MSSQL_URL pointing at a disposable SQL Server 2016+ database');
const FIRST = '20260101000000_first';
const SECOND = '20260102000000_second';
interface Result {
  recordset?: Record<string, unknown>[];
}
interface Request extends MssqlMigrationRequest {
  query(sql: string): Promise<Result>;
}
interface Pool {
  connect(): Promise<unknown>;
  close(): Promise<unknown>;
  request(): Request;
}
interface Transaction {
  begin(): Promise<unknown>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
}
interface Driver {
  ConnectionPool: new (config: unknown) => Pool;
  Transaction: new (pool: Pool) => Transaction;
  Request: new (target: Pool | Transaction) => Request;
}
async function fixture(t: TestContext) {
  const mod = (await importOptionalPeer('mssql')) as { default?: Driver } & Driver;
  const driver = mod.default ?? mod;
  const pool = new driver.ConnectionPool(mssqlMigrationConfig(URL!));
  await pool.connect();
  const schema = `tm_${process.pid}_${Math.random().toString(36).slice(2, 12)}] quoted`;
  const ns = quote(schema);
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mssql-native-migrations-'));
  const cleanup: Array<() => Promise<void>> = [];
  const query = async (sql: string, params: Record<string, unknown> = {}) => {
    const request = pool.request();
    for (const [name, value] of Object.entries(params)) request.input(name, value);
    return (await request.query(sql)).recordset ?? [];
  };
  t.after(async () => {
    try {
      for (const run of cleanup) await run();
      // Only objects inside this test's random namespace can be dropped.
      const objects = await query(
        `SELECT o.name,RTRIM(o.type) AS type FROM sys.objects o JOIN sys.schemas s ON s.schema_id=o.schema_id
        WHERE s.name=@schema AND o.type IN ('U','V') ORDER BY o.type DESC;`,
        { schema },
      );
      for (const object of objects)
        await query(`DROP ${object.type === 'V' ? 'VIEW' : 'TABLE'} ${ns}.${quote(String(object.name))};`);
      await query(`DROP SCHEMA ${ns};`);
    } finally {
      await pool.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  await query(`CREATE SCHEMA ${ns};`);
  const migration = (name: string, up: string, down = `DROP TABLE ${ns}.[items];`) => {
    const path = join(dir, `${name}.sql`);
    writeFileSync(path, `-- UP\n${up}\n-- DOWN\n${down}\n`);
    return path;
  };
  const options = { schema, lockWaitMs: 5000 };
  const exists = async (name: string) =>
    (
      await query(
        `SELECT COUNT(*) AS n FROM sys.objects o
    JOIN sys.schemas s ON s.schema_id=o.schema_id WHERE s.name=@schema AND o.name=@name;`,
        { schema, name },
      )
    )[0]?.n;
  return { driver, pool, schema, ns, dir, query, migration, options, exists, cleanup };
}

gate.it('native ALTER COLUMN and DROP COLUMN/CONSTRAINT preserve rows and require consent', async (t) => {
  const f = await fixture(t);
  f.migration(
    FIRST,
    `CREATE TABLE ${f.ns}.[items](id int PRIMARY KEY, value nvarchar(20), extra int, CONSTRAINT item_value_unique UNIQUE(value)); INSERT INTO ${f.ns}.[items] VALUES(1,N'kept',4);`,
  );
  await migrateMssqlUp(URL!, f.dir, f.options);
  f.migration(
    SECOND,
    `ALTER TABLE ${f.ns}.[items] DROP CONSTRAINT item_value_unique; ALTER TABLE ${f.ns}.[items] ALTER COLUMN value nvarchar(200) NULL; ALTER TABLE ${f.ns}.[items] DROP COLUMN extra;`,
  );
  await assert.rejects(migrateMssqlUp(URL!, f.dir, f.options), /DESTRUCTIVE/);
  assert.deepEqual(await f.query(`SELECT * FROM ${f.ns}.[items];`), [{ id: 1, value: 'kept', extra: 4 }]);
  assert.equal((await migrateMssqlUp(URL!, f.dir, { ...f.options, allowDestructive: true })).applied.length, 1);
  assert.deepEqual(await f.query(`SELECT * FROM ${f.ns}.[items];`), [{ id: 1, value: 'kept' }]);
  await f.query(`INSERT INTO ${f.ns}.[items] VALUES(2,N'kept');`);
  await f.query(`UPDATE ${f.ns}.[items] SET value=REPLICATE(N'x',100) WHERE id=2;`);
  assert.equal((await f.query(`SELECT LEN(value) AS n FROM ${f.ns}.[items] WHERE id=2;`))[0]!.n, 100);
  assert.equal((await migrateMssqlStatus(URL!, f.dir, f.options)).filter((file) => file.applied).length, 2);
});

gate.it(
  'native migrations preserve quoted schemas, real GO/literal batches, step/status/deploy/down and exact checksums',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const first = f.migration(
      FIRST,
      `CREATE TABLE ${f.ns}.[items](id int PRIMARY KEY, value nvarchar(200));
GO
CREATE VIEW ${f.ns}.[item_values] AS SELECT id,value FROM ${f.ns}.[items];
GO
INSERT INTO ${f.ns}.[items] VALUES(1,N'line one
GO
-- DOWN
line two');
/* outer
/* nested */
GO
*/`,
      `DROP VIEW ${f.ns}.[item_values];\nGO\nDROP TABLE ${f.ns}.[items];`,
    );
    assert.equal((await inspectMssqlMigrationDeploy(URL!, f.dir, f.options)).pending.length, 1);
    assert.equal(await f.exists('_turbine_migrations'), 0, 'inspect must not create tracking');
    assert.equal((await migrateMssqlStatus(URL!, f.dir, f.options))[0]?.applied, false);
    assert.equal(await f.exists('_turbine_migrations'), 0, 'status must not create tracking');
    f.migration(SECOND, `INSERT INTO ${f.ns}.[items] VALUES(2,N'second');`, `DELETE FROM ${f.ns}.[items] WHERE id=2;`);
    assert.equal((await migrateMssqlUp(URL!, f.dir, { ...f.options, step: 1 })).applied.length, 1);
    assert.deepEqual(await f.query(`SELECT id,value FROM ${f.ns}.[items];`), [
      { id: 1, value: 'line one\nGO\n-- DOWN\nline two' },
    ]);
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[item_values];`)).map((r) => r.id),
      [1],
    );
    assert.equal((await migrateMssqlDeploy(URL!, f.dir, f.options)).applied.length, 1);
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[items] ORDER BY id;`)).map((r) => r.id),
      [1, 2],
    );
    const rows = await f.query(`SELECT name,checksum,applied_at FROM ${f.ns}.[_turbine_migrations] ORDER BY id;`);
    assert.equal(rows.length, 2);
    assert.match(String(rows[0]?.checksum), /^[0-9a-f]{64}$/);
    assert.ok(rows[0]?.applied_at instanceof Date);
    assert.equal(
      (await migrateMssqlStatus(URL!, f.dir, f.options)).every((s) => s.applied && s.checksumValid),
      true,
    );
    assert.deepEqual((await migrateMssqlDeploy(URL!, f.dir, f.options)).applied, []);
    await assert.rejects(migrateMssqlDown(URL!, f.dir, f.options), /DESTRUCTIVE/);
    assert.equal((await migrateMssqlDown(URL!, f.dir, { ...f.options, allowDestructive: true })).rolledBack.length, 1);
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[items];`)).map((r) => r.id),
      [1],
    );
    writeFileSync(first, `${readFileSync(first, 'utf8')}\n-- changed`);
    assert.equal((await migrateMssqlStatus(URL!, f.dir, f.options))[0]?.checksumValid, false);
    await assert.rejects(migrateMssqlDeploy(URL!, f.dir, f.options), /checksum drift/);
    unlinkSync(first);
    assert.equal((await migrateMssqlStatus(URL!, f.dir, f.options)).find((s) => s.applied)?.missingFile, true);
    await assert.rejects(migrateMssqlDown(URL!, f.dir, { ...f.options, allowDestructive: true }), /missing files/);
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[items];`)).map((r) => r.id),
      [1],
    );
  },
);

gate.it(
  'native SQL failure rolls back transactional DDL, all selected files and history, then retries without duplicates',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    f.migration(FIRST, `CREATE TABLE ${f.ns}.[items](id int PRIMARY KEY); INSERT INTO ${f.ns}.[items] VALUES(1);`);
    const second = f.migration(SECOND, `INSERT INTO ${f.ns}.[items] VALUES(1);`);
    await assert.rejects(migrateMssqlDeploy(URL!, f.dir, f.options));
    assert.equal(await f.exists('items'), 0);
    assert.equal(await f.exists('_turbine_migrations'), 0);
    writeFileSync(
      second,
      `-- UP\nINSERT INTO ${f.ns}.[items] VALUES(2);\n-- DOWN\nDELETE FROM ${f.ns}.[items] WHERE id=2;`,
    );
    assert.equal((await migrateMssqlDeploy(URL!, f.dir, f.options)).applied.length, 2);
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[items] ORDER BY id;`)).map((r) => r.id),
      [1, 2],
    );
    assert.equal((await f.query(`SELECT COUNT(*) AS n FROM ${f.ns}.[_turbine_migrations];`))[0]?.n, 2);
  },
);

gate.it(
  'native preflight rejects later transaction/sqlcmd/history/control sources before the first DDL',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    f.migration(FIRST, `CREATE TABLE ${f.ns}.[items](id int);`);
    const second = f.migration(SECOND, 'SELECT 1; COMMIT;');
    for (const source of [
      '-- UP\nSELECT 1; COMMIT;',
      '-- UP\nSELECT 1;\nGO 2',
      `-- UP\nDELETE FROM ${f.ns}.[_turbine_migrations];`,
      `-- UP\nDELETE FROM ${f.ns}.[_turbine_migrations ];`,
      "-- UP\nEXEC(N'COMMIT');",
      '-- turbine:no-transaction\n-- UP\nSELECT 1;',
      '-- UP\nUSE master;',
    ]) {
      writeFileSync(second, source);
      await assert.rejects(migrateMssqlDeploy(URL!, f.dir, f.options), /SQL Server/);
      assert.equal(await f.exists('items'), 0);
      assert.equal(await f.exists('_turbine_migrations'), 0);
    }
  },
);

gate.it(
  'native history validates its shape and proves legacy hashes before upgrading, without read-side writes',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const path = f.migration(FIRST, `CREATE TABLE ${f.ns}.[items](id int);`);
    await f.query(`CREATE TABLE ${f.ns}.[_turbine_migrations](id int);`);
    await assert.rejects(migrateMssqlDeploy(URL!, f.dir, f.options), /tracking metadata/);
    assert.equal(await f.exists('items'), 0);
    await f.query(`DROP TABLE ${f.ns}.[_turbine_migrations];`);
    await migrateMssqlDeploy(URL!, f.dir, f.options);
    let hash = 0;
    const content = readFileSync(path, 'utf8');
    for (let i = 0; i < content.length; i++) hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
    const legacy = Math.abs(hash).toString(36);
    await f.query(`UPDATE ${f.ns}.[_turbine_migrations] SET checksum=@hash;`, { hash: legacy });
    assert.equal((await migrateMssqlStatus(URL!, f.dir, f.options))[0]?.checksumValid, true);
    assert.equal((await f.query(`SELECT checksum FROM ${f.ns}.[_turbine_migrations];`))[0]?.checksum, legacy);
    await migrateMssqlDeploy(URL!, f.dir, f.options);
    assert.match(
      String((await f.query(`SELECT checksum FROM ${f.ns}.[_turbine_migrations];`))[0]?.checksum),
      /^[a-f0-9]{64}$/,
    );
    await f.query(`UPDATE ${f.ns}.[_turbine_migrations] SET checksum='incorrect';`);
    await assert.rejects(migrateMssqlDeploy(URL!, f.dir, f.options), /checksum drift/);
    assert.equal((await f.query(`SELECT COUNT(*) AS n FROM ${f.ns}.[items];`))[0]?.n, 0);
  },
);

gate.it(
  'native application lock times out, cancels and waits on the pinned transaction, then rereads committed history',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    f.migration(FIRST, `CREATE TABLE ${f.ns}.[items](id int PRIMARY KEY);`);
    await migrateMssqlDeploy(URL!, f.dir, f.options);
    const second = f.migration(SECOND, `INSERT INTO ${f.ns}.[items] VALUES(2);`);
    const held = new f.driver.Transaction(f.pool);
    await held.begin();
    let released = false;
    f.cleanup.push(async () => {
      if (!released) await held.rollback();
    });
    const request = new f.driver.Request(held);
    request.input('resource', MSSQL_MIGRATION_LOCK);
    const lock = await request.query(`DECLARE @r int; EXEC @r=sys.sp_getapplock @Resource=@resource,
    @LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=0,@DbPrincipal='public'; SELECT @r AS code;`);
    assert.ok([0, 1].includes(Number(lock.recordset?.[0]?.code)));
    await assert.rejects(migrateMssqlDeploy(URL!, f.dir, { ...f.options, lockWaitMs: 40 }), /application lock/);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 80);
    try {
      await assert.rejects(migrateMssqlDeploy(URL!, f.dir, { ...f.options, signal: abort.signal }));
    } finally {
      clearTimeout(timer);
    }
    const crypto = await import('node:crypto');
    const write = new f.driver.Request(held);
    write
      .input('name', SECOND)
      .input('checksum', crypto.createHash('sha256').update(readFileSync(second)).digest('hex'));
    await write.query(`INSERT INTO ${f.ns}.[items] VALUES(2);
    INSERT INTO ${f.ns}.[_turbine_migrations](name,checksum,applied_at) VALUES(@name,@checksum,SYSUTCDATETIME());`);
    // Observe the actual pinned native lock request before scheduling its release.
    let started!: () => void;
    const lockStarted = new Promise<void>((resolveStart) => {
      started = resolveStart;
    });
    const BaseRequest = f.driver.Request;
    class WaitingRequest extends BaseRequest {
      override query(sql: string) {
        const result = super.query(sql);
        if (sql.includes('sys.sp_getapplock')) started();
        return result;
      }
    }
    const waitingRunner = createMssqlMigrationRunner(
      async () => ({ ...f.driver, Request: WaitingRequest }) as unknown as MssqlMigrationDriver,
    );
    const waiter = waitingRunner.migrateMssqlDeploy(URL!, f.dir, f.options);
    await Promise.race([
      lockStarted,
      waiter.then(() => {
        throw new Error('Runner never requested the application lock');
      }),
    ]);
    const waitStarted = performance.now();
    const committed = new Promise<void>((resolveCommit, rejectCommit) => {
      setTimeout(() => {
        held.commit().then(() => {
          released = true;
          resolveCommit();
        }, rejectCommit);
      }, 120);
    });
    try {
      const [result] = await Promise.all([waiter, committed]);
      assert.deepEqual(result.applied, []);
      assert.ok(performance.now() - waitStarted >= 80, 'native lock request waits for the competing transaction');
    } finally {
      await committed;
    }
    assert.equal(released, true);
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[items];`)).map((r) => r.id),
      [2],
    );
    assert.equal((await f.query(`SELECT COUNT(*) AS n FROM ${f.ns}.[_turbine_migrations];`))[0]?.n, 2);
  },
);

gate.it(
  'native cancellation after an actual DDL batch rolls it back and releases the lock for retry',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    f.migration(FIRST, `CREATE TABLE ${f.ns}.[items](id int);`);
    const abort = new AbortController();
    const BaseRequest = f.driver.Request;
    let executed = 0;
    class AbortingRequest extends BaseRequest {
      override async batch(sql: string) {
        const result = await super.batch(sql);
        executed++;
        abort.abort(new Error('cancel after actual native SQL'));
        return result;
      }
    }
    const runner = createMssqlMigrationRunner(
      async () => ({ ...f.driver, Request: AbortingRequest }) as unknown as MssqlMigrationDriver,
    );
    await assert.rejects(
      runner.migrateMssqlDeploy(URL!, f.dir, { ...f.options, signal: abort.signal }),
      /cancel after actual native SQL/,
    );
    assert.equal(executed, 1);
    assert.equal(await f.exists('items'), 0);
    assert.equal(await f.exists('_turbine_migrations'), 0);
    assert.equal((await migrateMssqlDeploy(URL!, f.dir, f.options)).applied.length, 1);
    assert.equal(await f.exists('items'), 1);
  },
);

gate.it(
  'native runner killed after executing DDL recovers its server transaction and retries with one history row',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    f.migration(FIRST, `CREATE TABLE ${f.ns}.[items](id int); INSERT INTO ${f.ns}.[items] VALUES(7);`);
    const script = join(f.dir, 'interrupted.mts');
    writeFileSync(
      script,
      `import {createRequire} from 'node:module';
    import {createMssqlMigrationRunner} from ${JSON.stringify(pathToFileURL(resolve('src/cli/mssql-migrate.ts')).href)};
    const require=createRequire(${JSON.stringify(resolve('package.json'))});
    const driver=require('mssql'); const Base=driver.Request;
    class Request extends Base { async batch(sql) { const value=await super.batch(sql);
      process.send('native-sql-executed'); await new Promise(()=>{}); return value; } }
    const runner=createMssqlMigrationRunner(async()=>({...driver,Request}));
    process.on('message',()=>{});
    await runner.migrateMssqlDeploy(process.env.MSSQL_TEST_URL ?? process.env.MSSQL_URL,process.argv[2],{schema:process.argv[3],lockWaitMs:5000});`,
    );
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href, script, f.dir, f.schema],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    let stderr = '';
    child.stderr!.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(child, 'exit');
    f.cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    });
    const message = await Promise.race([
      once(child, 'message'),
      exited.then(() => {
        throw new Error(`Runner exited before native SQL: ${stderr}`);
      }),
    ]);
    assert.equal(message[0], 'native-sql-executed');
    child.kill('SIGKILL');
    assert.equal((await exited)[1], 'SIGKILL');
    assert.equal((await migrateMssqlDeploy(URL!, f.dir, f.options)).applied.length, 1);
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[items];`)).map((r) => r.id),
      [7],
    );
    assert.equal((await f.query(`SELECT COUNT(*) AS n FROM ${f.ns}.[_turbine_migrations];`))[0]?.n, 1);
  },
);

gate.it(
  'native same-named tables and histories remain isolated in two quoted schemas',
  { timeout: 30000 },
  async (t) => {
    const a = await fixture(t);
    const b = await fixture(t);
    a.migration(FIRST, `CREATE TABLE ${a.ns}.[items](id int); INSERT INTO ${a.ns}.[items] VALUES(11);`);
    b.migration(FIRST, `CREATE TABLE ${b.ns}.[items](id int); INSERT INTO ${b.ns}.[items] VALUES(22);`);
    await migrateMssqlDeploy(URL!, a.dir, a.options);
    assert.equal((await migrateMssqlStatus(URL!, b.dir, b.options))[0]?.applied, false);
    await migrateMssqlDeploy(URL!, b.dir, b.options);
    assert.deepEqual(
      (await a.query(`SELECT id FROM ${a.ns}.[items];`)).map((r) => r.id),
      [11],
    );
    assert.deepEqual(
      (await b.query(`SELECT id FROM ${b.ns}.[items];`)).map((r) => r.id),
      [22],
    );
    await migrateMssqlDown(URL!, a.dir, { ...a.options, allowDestructive: true });
    assert.equal(await a.exists('items'), 0);
    assert.deepEqual(
      (await b.query(`SELECT id FROM ${b.ns}.[items];`)).map((r) => r.id),
      [22],
    );
    assert.equal((await migrateMssqlStatus(URL!, b.dir, b.options))[0]?.applied, true);
  },
);

gate.it(
  'native existing trigger refusal prevents hidden SQL before inserting any migration rows',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.query(`CREATE TABLE ${f.ns}.[items](id int PRIMARY KEY); INSERT INTO ${f.ns}.[items] VALUES(1);`);
    await f.query(
      `CREATE TRIGGER ${f.ns}.[hidden_delete] ON ${f.ns}.[items] AFTER INSERT AS DELETE FROM ${f.ns}.[items];`,
    );
    f.migration(FIRST, `INSERT INTO ${f.ns}.[items] VALUES(2);`);
    await assert.rejects(migrateMssqlDeploy(URL!, f.dir, f.options), /triggers/);
    assert.equal(await f.exists('_turbine_migrations'), 0);
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[items];`)).map((r) => r.id),
      [1],
    );
    await f.query(`DROP TRIGGER ${f.ns}.[hidden_delete];`);
    await migrateMssqlDeploy(URL!, f.dir, f.options);
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[items] ORDER BY id;`)).map((r) => r.id),
      [1, 2],
    );
  },
);

gate.it(
  'native command adapter drives dry-run, deploy, status exit gating and down with actual row effects',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    f.migration(FIRST, `CREATE TABLE ${f.ns}.[items](id int); INSERT INTO ${f.ns}.[items] VALUES(31);`);
    const config = { engine: 'mssql', url: URL!, schema: f.schema, migrationsDir: f.dir } as unknown as ResolvedConfig;
    const output: string[] = [];
    t.mock.method(console, 'log', (...values: unknown[]) => {
      output.push(values.join(' '));
    });
    t.mock.method(console, 'error', (...values: unknown[]) => {
      output.push(values.join(' '));
    });
    const args = { command: 'migrate', positional: [] };
    const previous = process.exitCode;
    f.cleanup.push(async () => {
      process.exitCode = previous;
    });
    await cmdMssqlMigrate({ ...args, subcommand: 'up', dryRun: true }, config, async () => false);
    assert.equal(await f.exists('_turbine_migrations'), 0);
    assert.equal(await f.exists('items'), 0);
    assert.match(output.join('\n'), /Dry run: 1 migration/);
    await cmdMssqlMigrate({ ...args, subcommand: 'status', exitCode: true }, config, async () => false);
    assert.equal(process.exitCode, 2);
    await cmdMssqlMigrate({ ...args, subcommand: 'deploy', wait: 5 }, config, async () => {
      throw new Error('deploy never prompts');
    });
    assert.deepEqual(
      (await f.query(`SELECT id FROM ${f.ns}.[items];`)).map((r) => r.id),
      [31],
    );
    process.exitCode = 0;
    await cmdMssqlMigrate({ ...args, subcommand: 'status', exitCode: true }, config, async () => false);
    assert.equal(process.exitCode, 0);
    await cmdMssqlMigrate({ ...args, subcommand: 'down', allowDestructive: true }, config, async () => {
      throw new Error('already authorized');
    });
    assert.equal(await f.exists('items'), 0);
    assert.equal((await f.query(`SELECT COUNT(*) AS n FROM ${f.ns}.[_turbine_migrations];`))[0]?.n, 0);
  },
);

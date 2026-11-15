/** Required native libSQL deployment controls. No mocked driver or fallback. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client/node';
import Database from 'libsql';
import type { CliArgs } from '../cli/index.js';
import { migrateLibsqlDeploy } from '../cli/libsql-migrate.js';
import { assertLibsqlMigrationArguments } from '../cli/libsql-migrate-command.js';
import { inspectLibsqlMigrations } from '../cli/libsql-migrate-status.js';

const first = '20260101000000_first';
const second = '20260102000000_second';
const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const native = (filename: string) =>
  createClient({ url: pathToFileURL(filename).href, intMode: 'bigint', concurrency: 1, timeout: 0 });
async function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'libsql-native-deploy-'));
  const migrations = join(root, 'migrations');
  mkdirSync(migrations);
  writeFileSync(join(root, 'NO-GIT-FIXTURE'), 'Owned native local deployment fixture.\n');
  const filename = join(root, 'existing ?#%.db');
  const client = native(filename);
  await client.executeMultiple(
    "CREATE TABLE retained(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO retained VALUES(1,'unchanged');",
  );
  t.after(() => {
    client.close();
    assert.equal(client.closed, true);
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  });
  const file = (name = first, up = 'CREATE TABLE added(id INTEGER PRIMARY KEY);', prefix = '') => {
    const content = `${prefix}-- UP\n${up}\n-- DOWN\nDROP TABLE retained;\n`;
    writeFileSync(join(migrations, `${name}.sql`), content);
    return content;
  };
  const query = async (sql: string) =>
    (await client.execute(sql)).rows.map((row) => Array.from({ length: row.length }, (_, i) => row[i]));
  const clean = async () => {
    assert.deepEqual(await query('SELECT * FROM retained'), [[1n, 'unchanged']]);
    assert.deepEqual(await query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name"), [
      ['retained'],
    ]);
    assert.equal((await inspectLibsqlMigrations(filename, migrations)).historyState, 'uninitialized');
  };
  return { root, filename, migrations, client, file, query, clean };
}

test('native write transaction actually prepares BEGIN IMMEDIATE and locks competing writers', async (t) => {
  const f = await fixture(t);
  const seen: string[] = [];
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (this: InstanceType<typeof Database>, sql: string) {
    seen.push(sql);
    return prepare.call(this, sql);
  } as typeof prepare;
  const peer = native(f.filename);
  try {
    const tx = await f.client.transaction('write');
    try {
      assert.ok(seen.includes('BEGIN IMMEDIATE'), JSON.stringify(seen));
      await assert.rejects(peer.execute("INSERT INTO retained VALUES(2,'blocked')"), /locked|busy/i);
      assert.equal(tx.closed, false);
    } finally {
      await tx.rollback();
      tx.close();
    }
    // A SQLITE_BUSY statement poisons native implicit retry state on this peer.
    // Reopen the caller-owned peer explicitly; deploy itself always opens fresh.
    await peer.reconnect();
    await peer.execute("INSERT INTO retained VALUES(2,'after release')");
    await f.client.reconnect();
    assert.deepEqual(await f.query('SELECT * FROM retained ORDER BY id'), [
      [1n, 'unchanged'],
      [2n, 'after release'],
    ]);
  } finally {
    Database.prototype.prepare = prepare;
    peer.close();
  }
});

test('ordered batch uses compatible SHA256 history, preserves scalar types/quoted names and retries without duplicate writes', async (t) => {
  const f = await fixture(t);
  const one = f.file(
    first,
    '\uFEFF/* leading ; COMMIT */ CREATE TABLE "odd;"" table"(id INTEGER PRIMARY KEY, big INTEGER, flag BOOLEAN, amount REAL, payload BLOB, note TEXT, missing TEXT);',
  );
  const two = f.file(
    second,
    `-- leading comment\nINSERT INTO "odd;"" table" VALUES(1,9007199254740993,true,1.25,x'00ff','literal ; -- COMMIT /* text */',null); CREATE UNIQUE INDEX [odd index] ON "odd;"" table"(id);`,
  );
  assert.deepEqual(await migrateLibsqlDeploy(f.filename, f.migrations), {
    applied: [first, second],
    scope: 'local-additive',
    atomic: true,
  });
  assert.deepEqual(
    await f.query('SELECT * FROM "odd;"" table"'),
    [[1n, 9007199254740993n, 1n, 1.25, new ArrayBuffer(2), 'literal ; -- COMMIT /* text */', null]].map((row) => {
      row[4] = Uint8Array.from([0, 255]).buffer;
      return row;
    }),
  );
  const status = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.deepEqual(
    status.history.map((row) => [row.id, row.name, row.checksum]),
    [
      [1, first, hash(one)],
      [2, second, hash(two)],
    ],
  );
  assert.ok(status.statuses.every((row) => row.applied && row.checksumValid));
  const before = readFileSync(f.filename);
  assert.deepEqual((await migrateLibsqlDeploy(f.filename, f.migrations)).applied, []);
  assert.deepEqual(readFileSync(f.filename), before);
  assert.equal(f.client.closed, false, 'Caller connection remains owned by caller');
});

test('all migration bytes are captured before the first await, and checksum is exactly the executed bytes', async (t) => {
  const f = await fixture(t);
  const original = f.file();
  const deployment = migrateLibsqlDeploy(f.filename, f.migrations);
  f.file(first, 'COMMIT; DROP TABLE retained;');
  assert.deepEqual((await deployment).applied, [first]);
  assert.deepEqual(await f.query('SELECT count(*) FROM added'), [[0n]]);
  assert.deepEqual(await f.query('SELECT name,checksum FROM _turbine_migrations'), [[first, hash(original)]]);
  assert.equal((await inspectLibsqlMigrations(f.filename, f.migrations)).statuses[0]!.checksumValid, false);
  writeFileSync(join(f.migrations, `${first}.sql`), original);
  assert.deepEqual((await migrateLibsqlDeploy(f.filename, f.migrations)).applied, []);
});

for (const suffix of ['-wal', '-shm', '-journal'])
  for (const kind of ['hardlink', 'symlink'])
    test(`migration inputs remain intact when a ${suffix} sidecar is a ${kind}`, async (t) => {
      const f = await fixture(t);
      const content = f.file();
      f.client.close();
      const sidecar = f.filename + suffix;
      const input = join(f.migrations, `${first}.sql`);
      const before = readFileSync(f.filename);
      if (kind === 'hardlink') linkSync(input, sidecar);
      else symlinkSync(input, sidecar);
      try {
        await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /sidecar|alias/);
        assert.equal(readFileSync(input, 'utf8'), content);
        assert.equal(readFileSync(sidecar, 'utf8'), content);
        assert.deepEqual(readFileSync(f.filename), before);
      } finally {
        rmSync(sidecar, { force: true });
      }
    });

test('literal VALUES preserves signed numbers, blobs, strings and multiple tuples', async (t) => {
  const f = await fixture(t);
  f.file(
    first,
    "CREATE TABLE literal_values(n, value); INSERT INTO literal_values VALUES(-1,'a''b'),(+2,x'00ff'),(-.5,NULL),(TRUE,FALSE);",
  );
  await migrateLibsqlDeploy(f.filename, f.migrations);
  assert.deepEqual(await f.query('SELECT * FROM literal_values'), [
    [-1n, "a'b"],
    [2n, Uint8Array.from([0, 255]).buffer],
    [-0.5, null],
    [1n, 0n],
  ]);
});

for (const value of ['1+1', '3-1', '((2))', '++2', "'a'-'b'", '-TRUE', 'NULL+1'])
  test(`literal-only VALUES refuses computed expression ${value}`, async (t) => {
    const f = await fixture(t);
    f.file(first, `INSERT INTO retained VALUES(${value},'computed');`);
    await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /scalar literal/);
    await f.clean();
  });

const refused = [
  'COMMIT; CREATE TABLE escaped(id);',
  '\uFEFF/* hi */END TRANSACTION;',
  '-- hi\nROLLBACK;',
  'SAVEPOINT escaped;',
  'RELEASE escaped;',
  'BEGIN IMMEDIATE;',
  "ATTACH ':memory:' AS escaped;",
  'PRAGMA writable_schema=ON;',
  'VACUUM;',
  'DROP TABLE retained;',
  'ALTER TABLE retained ADD COLUMN bad;',
  "UPDATE retained SET value='lost';",
  'DELETE FROM retained;',
  "REPLACE INTO retained VALUES(1,'lost');",
  "INSERT OR REPLACE INTO retained VALUES(1,'lost');",
  'CREATE TEMP TABLE escaped(id);',
  'CREATE VIRTUAL TABLE escaped USING fts5(value);',
  'CREATE VIEW escaped AS SELECT * FROM retained;',
  'CREATE TRIGGER escaped AFTER INSERT ON retained BEGIN DELETE FROM retained; END;',
  'CREATE TABLE escaped AS SELECT * FROM retained;',
  'SELECT 1;',
  "INSERT INTO retained SELECT 2,'bad';",
  "INSERT INTO retained VALUES(2,writefile('/must-not-write','bad'));",
  "CREATE TABLE escaped(value DEFAULT(writefile('/must-not-write','bad')));",
  'CREATE INDEX escaped ON retained("writefile"(\'/must-not-write\',value));',
  'CREATE TABLE escaped(value CHECK(load_extension(value)));',
  'CREATE TABLE escaped(value REFERENCES "_TuRbInE_MiGrAtIoNs"(id));',
  "INSERT INTO main.'_turbine_migrations' VALUES(1,'bad','bad','bad');",
  'CREATE INDEX escaped ON [_turbine_migrations](name);',
  'CREATE TABLE escaped(value REFERENCES sqlite_sequence(name));',
  'CREATE TABLE escaped(value TEXT ON CONFLICT REPLACE);',
  'CREATE TABLE escaped(id); /* outer /* nested */ COMMIT; */',
  'CREATE TABLE escaped(id); /* unterminated',
  "CREATE TABLE escaped(value DEFAULT('unterminated));",
  'CREATE TABLE escaped(id);\0COMMIT;',
  'CREATE TABLE escaped(id);\u00a0COMMIT;',
  'INSERT INTO retained VALUES(?,?);',
  '/* empty */',
];
for (const sql of refused)
  test(`complete pre-write admission refuses ${JSON.stringify(sql)}`, async (t) => {
    const f = await fixture(t);
    f.file(first, 'CREATE TABLE must_rollback(id);');
    f.file(second, sql);
    const before = readFileSync(f.filename);
    await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /refused/);
    await f.clean();
    assert.deepEqual(readFileSync(f.filename), before);
  });

test('no-transaction directive and ignored filenames refuse before journal creation', async (t) => {
  const f = await fixture(t);
  f.file(first, 'CREATE TABLE added(id);', '-- turbine:no-transaction\n');
  await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /no-transaction/);
  f.file();
  writeFileSync(join(f.migrations, 'forgotten.SQL'), '-- UP\nCREATE TABLE missed(id);');
  await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /ignored SQL/);
  await f.clean();
});

for (const ddl of [
  'CREATE TRIGGER danger AFTER INSERT ON retained BEGIN DELETE FROM retained; END;',
  'CREATE TABLE danger(value TEXT UNIQUE ON CONFLICT REPLACE);',
  "CREATE TABLE danger(value DEFAULT(writefile('bad-file','bad')));",
  "CREATE INDEX danger ON retained(writefile('bad-file',value));",
  'CREATE VIRTUAL TABLE danger USING fts5(value);',
  'CREATE VIEW danger AS SELECT * FROM retained;',
])
  test(`existing catalog under writer lock refuses ${ddl}`, async (t) => {
    const f = await fixture(t);
    // Some unsafe expressions are rejected by native SQLite itself at CREATE.
    try {
      await f.client.execute(ddl);
    } catch (error) {
      assert.match(String(error), /non-deterministic|unsafe|prohibited/);
      return;
    }
    f.file();
    const before = readFileSync(f.filename);
    await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /unsupported|refused/);
    assert.deepEqual(readFileSync(f.filename), before);
    assert.equal((await inspectLibsqlMigrations(f.filename, f.migrations)).historyState, 'uninitialized');
  });

test('native mid-batch constraint failure rolls back DDL, rows, journal creation and allows actual replay', async (t) => {
  const f = await fixture(t);
  f.file(first, 'CREATE TABLE added(id INTEGER PRIMARY KEY); INSERT INTO added VALUES(1);');
  f.file(second, 'CREATE TABLE later(id); INSERT INTO added VALUES(1);');
  await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /UNIQUE|constraint/);
  await f.clean();
  f.file(second, 'CREATE TABLE later(id); INSERT INTO added VALUES(2);');
  assert.deepEqual((await migrateLibsqlDeploy(f.filename, f.migrations)).applied, [first, second]);
  assert.deepEqual(await f.query('SELECT * FROM added ORDER BY id'), [[1n], [2n]]);
  assert.deepEqual((await migrateLibsqlDeploy(f.filename, f.migrations)).applied, []);
});

test('drift, missing files and applied/pending order refuse before any pending DDL, preserving legacy checksums', async (t) => {
  const f = await fixture(t);
  const original = f.file();
  await migrateLibsqlDeploy(f.filename, f.migrations);
  f.file(second, 'CREATE TABLE later(id);');
  f.file(first, 'CREATE TABLE rewritten(id);');
  await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /checksum drift/);
  unlinkSync(join(f.migrations, `${first}.sql`));
  await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /missing/);
  writeFileSync(join(f.migrations, `${first}.sql`), original);
  f.file('20250101000000_earlier', 'CREATE TABLE earlier(id);');
  await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /out of filename order/);
  unlinkSync(join(f.migrations, '20250101000000_earlier.sql'));
  let legacy = 0;
  for (const ch of original) legacy = ((legacy << 5) - legacy + ch.charCodeAt(0)) | 0;
  const checksum = Math.abs(legacy).toString(36);
  await f.client.execute({ sql: 'UPDATE _turbine_migrations SET checksum=?', args: [checksum] });
  await migrateLibsqlDeploy(f.filename, f.migrations);
  assert.deepEqual(await f.query('SELECT name,checksum FROM _turbine_migrations ORDER BY id'), [
    [first, checksum],
    [second, hash(readFileSync(join(f.migrations, `${second}.sql`), 'utf8'))],
  ]);
  await f.client.execute('UPDATE _turbine_migrations SET id=10 WHERE id=1');
  await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /out of filename order/);
});

test('held native writer refuses immediately without touching the caller transaction, then replay succeeds', async (t) => {
  const f = await fixture(t);
  f.file();
  const tx = await f.client.transaction('write');
  try {
    await tx.execute("INSERT INTO retained VALUES(2,'caller uncommitted')");
    await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /writer lock/);
    assert.equal(tx.closed, false);
    assert.equal((await tx.execute('SELECT count(*) FROM retained')).rows[0]![0], 2n);
  } finally {
    await tx.rollback();
    tx.close();
  }
  await f.clean();
  assert.deepEqual((await migrateLibsqlDeploy(f.filename, f.migrations)).applied, [first]);
});

test('held WAL reader retains its native snapshot while deployment commits and the caller stays usable', async (t) => {
  const f = await fixture(t);
  f.file();
  f.client.close();
  const reader = native(f.filename);
  await reader.execute('PRAGMA journal_mode=WAL');
  const tx = await reader.transaction('read');
  try {
    assert.equal((await tx.execute('SELECT count(*) FROM retained')).rows[0]![0], 1n);
    assert.deepEqual((await migrateLibsqlDeploy(f.filename, f.migrations)).applied, [first]);
    assert.equal(tx.closed, false);
    assert.equal((await tx.execute("SELECT count(*) FROM sqlite_schema WHERE name='added'")).rows[0]![0], 0n);
    assert.equal((await tx.execute('SELECT count(*) FROM retained')).rows[0]![0], 1n);
  } finally {
    await tx.rollback();
    tx.close();
    reader.close();
  }
  assert.deepEqual((await migrateLibsqlDeploy(f.filename, f.migrations)).applied, []);
});

test('database/migration aliases, missing database, remote URLs and malformed arguments refuse', async (t) => {
  const f = await fixture(t);
  f.file();
  await assert.rejects(migrateLibsqlDeploy(join(f.root, 'absent.db'), f.migrations), /ENOENT/);
  assert.equal(existsSync(join(f.root, 'absent.db')), false);
  await assert.rejects(migrateLibsqlDeploy('https://remote.example/db', f.migrations), /filename/);
  linkSync(f.filename, join(f.migrations, '20260103000000_alias.sql'));
  await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /alias/);
  for (const subcommand of ['create', 'up', 'down', 'repair', 'reset'])
    assert.throws(
      () => assertLibsqlMigrationArguments({ subcommand } as CliArgs, ['migrate', subcommand]),
      /bounded additive/,
    );
  for (const raw of [
    ['migrate', 'deploy', '--schema', '--engine', 'libsql'],
    ['migrate', 'deploy', '--url'],
    ['migrate', 'deploy', '--exit-code'],
    ['migrate', 'deploy', '--allow-destructive'],
  ])
    assert.throws(
      () => assertLibsqlMigrationArguments({ subcommand: 'deploy' } as CliArgs, raw),
      /Missing value|Unsupported|only/,
    );
});

test('native file I/O escapes SQL rollback, while closed function admission preserves the owned file', async (t) => {
  const f = await fixture(t);
  const ownedFile = join(f.root, 'owned-external.txt');
  writeFileSync(ownedFile, 'before');
  const tx = await f.client.transaction('write');
  try {
    await tx.execute({ sql: 'SELECT writefile(?,?)', args: [ownedFile, 'native side effect'] });
  } finally {
    await tx.rollback();
    tx.close();
  }
  assert.equal(
    readFileSync(ownedFile, 'utf8'),
    'native side effect',
    'Actual native control must demonstrate SQL rollback cannot undo file I/O',
  );
  writeFileSync(ownedFile, 'before');
  const literal = `'${ownedFile.replaceAll("'", "''")}'`;
  f.file(
    first,
    `CREATE TABLE danger(value CHECK(writefile(${literal},'must not write'))); INSERT INTO danger VALUES(1);`,
  );
  await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), /unsupported SQL function/);
  assert.equal(readFileSync(ownedFile, 'utf8'), 'before');
  await f.clean();
});

for (const thrown of [undefined, null, new Error('primary native execution failure')])
  test(`primary ${String(thrown)} survives all actual cleanup attempts`, async (t) => {
    const f = await fixture(t);
    f.file();
    const prototype = Object.getPrototypeOf(f.client) as typeof f.client;
    const transaction: (this: typeof f.client, mode: 'write') => ReturnType<typeof prototype.transaction> =
      prototype.transaction;
    const close = prototype.close;
    const attempts: string[] = [];
    const diagnostics: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      diagnostics.push(args);
    });
    t.mock.method(prototype, 'close', function (this: typeof f.client) {
      close.call(this);
      attempts.push('client close');
      throw new Error('client cleanup failure');
    });
    t.mock.method(
      prototype,
      'transaction',
      async function (this: typeof f.client, mode: Parameters<typeof transaction>[0]) {
        const tx = await transaction.call(this, mode);
        const execute = tx.execute.bind(tx),
          rollback = tx.rollback.bind(tx),
          txClose = tx.close.bind(tx);
        t.mock.method(tx, 'execute', async (...args: Parameters<typeof tx.execute>) => {
          const result = await execute(...args);
          if (typeof args[0] === 'string' && args[0].startsWith('CREATE TABLE added')) throw thrown;
          return result;
        });
        t.mock.method(tx, 'rollback', async () => {
          await rollback();
          attempts.push('rollback');
          throw new Error('rollback cleanup failure');
        });
        t.mock.method(tx, 'close', () => {
          txClose();
          attempts.push('transaction close');
          throw new Error('transaction cleanup failure');
        });
        return tx;
      },
    );
    let rejection: { error: unknown } | undefined;
    try {
      await migrateLibsqlDeploy(f.filename, f.migrations);
    } catch (error) {
      rejection = { error };
    } finally {
      t.mock.restoreAll();
    }
    assert.ok(rejection, 'A thrown undefined/null is still a primary rejection');
    assert.equal(rejection.error, thrown);
    assert.deepEqual(attempts, ['rollback', 'transaction close', 'client close']);
    assert.equal(diagnostics.length, 3);
    await f.clean();
  });

test('uncertain COMMIT remains primary when transaction/client close throw after native commit', async (t) => {
  const f = await fixture(t);
  f.file();
  const prototype = Object.getPrototypeOf(f.client) as typeof f.client;
  const transaction: (this: typeof f.client, mode: 'write') => ReturnType<typeof prototype.transaction> =
    prototype.transaction;
  const close = prototype.close;
  const attempts: string[] = [];
  t.mock.method(console, 'error', () => {});
  t.mock.method(prototype, 'close', function (this: typeof f.client) {
    close.call(this);
    attempts.push('client close');
    throw new Error('client cleanup failure');
  });
  t.mock.method(
    prototype,
    'transaction',
    async function (this: typeof f.client, mode: Parameters<typeof transaction>[0]) {
      const tx = await transaction.call(this, mode),
        commit = tx.commit.bind(tx),
        txClose = tx.close.bind(tx);
      t.mock.method(tx, 'commit', async () => {
        await commit();
        throw new Error('lost COMMIT acknowledgement');
      });
      t.mock.method(tx, 'close', () => {
        txClose();
        attempts.push('transaction close');
        throw new Error('transaction cleanup failure');
      });
      return tx;
    },
  );
  try {
    await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), (error: unknown) => {
      assert.match(String(error), /COMMIT did not acknowledge success.*uncertain/);
      assert.equal((error as { cleanupFailures: unknown[] }).cleanupFailures.length, 2);
      return true;
    });
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual(attempts, ['transaction close', 'client close']);
  assert.equal(
    (await inspectLibsqlMigrations(f.filename, f.migrations)).history.length,
    1,
    'Lost acknowledgement may still have a durable commit',
  );
  assert.deepEqual((await migrateLibsqlDeploy(f.filename, f.migrations)).applied, []);
});

test('cleanup-only failures preserve acknowledged COMMIT and attempt both closes', async (t) => {
  const f = await fixture(t);
  f.file();
  const prototype = Object.getPrototypeOf(f.client) as typeof f.client;
  const transaction: (this: typeof f.client, mode: 'write') => ReturnType<typeof prototype.transaction> =
    prototype.transaction;
  const close = prototype.close;
  const txFailure = new Error('transaction cleanup failure'),
    clientFailure = new Error('client cleanup failure');
  const attempts: string[] = [];
  t.mock.method(prototype, 'close', function (this: typeof f.client) {
    close.call(this);
    attempts.push('client close');
    throw clientFailure;
  });
  t.mock.method(
    prototype,
    'transaction',
    async function (this: typeof f.client, mode: Parameters<typeof transaction>[0]) {
      const tx = await transaction.call(this, mode),
        txClose = tx.close.bind(tx);
      t.mock.method(tx, 'close', () => {
        txClose();
        attempts.push('transaction close');
        throw txFailure;
      });
      return tx;
    },
  );
  try {
    await assert.rejects(migrateLibsqlDeploy(f.filename, f.migrations), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /COMMIT acknowledged success.*cleanup failed/);
      assert.deepEqual(error.errors, [txFailure, clientFailure]);
      return true;
    });
  } finally {
    t.mock.restoreAll();
  }
  assert.deepEqual(attempts, ['transaction close', 'client close']);
  assert.equal((await inspectLibsqlMigrations(f.filename, f.migrations)).history.length, 1);
  assert.deepEqual((await migrateLibsqlDeploy(f.filename, f.migrations)).applied, []);
});

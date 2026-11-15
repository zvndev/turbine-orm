import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client/node';
import { inspectLibsqlMigrations } from '../cli/libsql-migrate-status.js';
import { isChecksumValid } from '../cli/migrate.js';

// Required actual optional native driver. No skip, fallback, server or .git fixture.
const ddl = `CREATE TABLE _turbine_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;
const first = '20260101000000_first';
const second = '20260102000000_second';
const content = '-- UP\nCREATE TABLE must_never_execute(id INTEGER);\n-- DOWN\nDROP TABLE must_never_execute;\n';
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const native = (filename: string) =>
  createClient({ url: pathToFileURL(filename).href, intMode: 'bigint', concurrency: 1, timeout: 0 });

async function fixture(t: TestContext, schema: string | null = ddl) {
  const root = mkdtempSync(join(tmpdir(), 'libsql-status-'));
  t.after(() => {
    client.close();
    assert.equal(client.closed, true);
    rmSync(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
  });
  writeFileSync(join(root, 'FIXTURE.txt'), 'Owned local native libSQL migration inspection fixture. No .git.\n');
  const filename = join(root, 'existing ?#%.db');
  const migrations = join(root, 'migrations');
  mkdirSync(migrations);
  const client = native(filename);
  await client.execute('CREATE TABLE untouched(id INTEGER PRIMARY KEY, payload TEXT)');
  await client.execute("INSERT INTO untouched VALUES(1, 'preserved')");
  if (schema) await client.execute(schema);
  const file = (name = first, text = content) => writeFileSync(join(migrations, `${name}.sql`), text);
  const insert = async (name = first, checksum = hash(content), appliedAt = '2026-01-01 01:02:03') => {
    await client.execute({
      sql: 'INSERT INTO _turbine_migrations(name, checksum, applied_at) VALUES (?, ?, ?)',
      args: [name, checksum, appliedAt],
    });
  };
  return { root, filename, migrations, client, file, insert };
}

function tree(root: string): unknown {
  return readdirSync(root)
    .sort()
    .map((name) => {
      const path = join(root, name);
      // One open per entry: stat and bytes come from the same descriptor.
      const fd = openSync(path, 'r');
      try {
        const stat = fstatSync(fd);
        return {
          name,
          mode: stat.mode,
          value: stat.isDirectory()
            ? tree(path)
            : { bytes: hash(readFileSync(fd).toString('base64')), size: stat.size, mtime: stat.mtimeMs },
        };
      } finally {
        closeSync(fd);
      }
    });
}

test('native canonical fixture reports status/history/checksums without executing SQL or changing any bytes', async (t) => {
  const f = await fixture(t);
  f.file();
  f.file(second);
  await f.insert();
  f.client.close();
  chmodSync(f.filename, 0o444);
  const before = tree(f.root);
  const result = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.equal(result.historyState, 'initialized');
  assert.deepEqual(result.history, [
    { id: 1, name: first, checksum: hash(content), applied_at: new Date('2026-01-01T01:02:03Z') },
  ]);
  assert.deepEqual(
    result.statuses.map((s) => [s.file.name, s.applied, s.checksumValid]),
    [
      [first, true, true],
      [second, false, undefined],
    ],
  );
  assert.deepEqual(result.checksums, [
    { name: first, stored: hash(content), actual: hash(content), state: 'sha256-match' },
  ]);
  assert.deepEqual(result.outOfOrder, []);
  assert.deepEqual(tree(f.root), before);
  const peer = native(f.filename);
  try {
    t.diagnostic(
      `Node ${process.version}; native libSQL SQLite ${(await peer.execute('SELECT sqlite_version()')).rows[0]![0]}`,
    );
    assert.equal(
      (await peer.execute("SELECT count(*) FROM sqlite_schema WHERE name='must_never_execute'")).rows[0]![0],
      0n,
    );
    assert.deepEqual(
      (await peer.execute('SELECT * FROM untouched')).rows.map((r) => [r[0], r[1]]),
      [[1n, 'preserved']],
    );
  } finally {
    peer.close();
  }
});

test('absent database refuses without creation; absent tracking table and empty initialized history remain distinct', async (t) => {
  const f = await fixture(t, null);
  f.file();
  f.client.close();
  const absent = join(f.root, 'absent.db');
  const before = tree(f.root);
  await assert.rejects(inspectLibsqlMigrations(absent, f.migrations), /ENOENT/);
  assert.equal(existsSync(absent), false);
  const result = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.equal(result.historyState, 'uninitialized');
  assert.deepEqual(result.history, []);
  assert.equal(result.statuses[0]!.applied, false);
  assert.deepEqual(tree(f.root), before);
  const writer = native(f.filename);
  try {
    await writer.execute(ddl);
  } finally {
    writer.close();
  }
  const initialized = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.equal(initialized.historyState, 'initialized');
  assert.deepEqual(initialized.history, []);
});

test('missing files, drift, misnamed files and changed legacy files never receive a false checksum match', async (t) => {
  const f = await fixture(t);
  f.file();
  f.file(second, `${content}-- changed\n`);
  await f.insert();
  await f.insert(second);
  const missing = '20260103000000_missing';
  await f.insert(missing);
  writeFileSync(join(f.migrations, 'misnamed.sql'), content);
  f.client.close();
  const before = tree(f.root);
  let result = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.deepEqual(
    result.checksums.map((c) => [c.name, c.state]),
    [
      [first, 'sha256-match'],
      [second, 'modified'],
      [missing, 'missing'],
    ],
  );
  assert.equal(result.statuses.find((s) => s.file.name === missing)!.missingFile, true);
  assert.deepEqual(result.ignoredFiles, ['misnamed.sql']);
  assert.deepEqual(tree(f.root), before);
  writeFileSync(join(f.migrations, `${first}.sql`), `${content}-- changed after earlier inspection\n`);
  result = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.equal(result.checksums[0]!.state, 'modified');
  assert.equal(result.statuses[0]!.checksumValid, false);
});

test('matching legacy checksum is reported without upgrade and modified legacy content is drift', async (t) => {
  const f = await fixture(t);
  f.file();
  // Frozen pre-v0.6 rolling-hash fixture, independently checked by the shared validator.
  let rolling = 0;
  for (let i = 0; i < content.length; i++) rolling = ((rolling << 5) - rolling + content.charCodeAt(i)) | 0;
  const legacy = Math.abs(rolling).toString(36);
  assert.equal(isChecksumValid(legacy, content), true);
  await f.insert(first, legacy);
  f.client.close();
  const before = tree(f.root);
  assert.equal((await inspectLibsqlMigrations(f.filename, f.migrations)).checksums[0]!.state, 'legacy-match');
  assert.deepEqual(tree(f.root), before);
  f.file(first, `${content}-- changed\n`);
  assert.equal((await inspectLibsqlMigrations(f.filename, f.migrations)).checksums[0]!.state, 'modified');
  const peer = native(f.filename);
  try {
    assert.equal((await peer.execute('SELECT checksum FROM _turbine_migrations')).rows[0]![0], legacy);
  } finally {
    peer.close();
  }
});

test('history keeps native ID order and explicitly reports backward timestamp order', async (t) => {
  const f = await fixture(t);
  f.file();
  f.file(second);
  await f.insert(second);
  await f.insert();
  const result = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.deepEqual(
    result.history.map((r) => r.name),
    [second, first],
  );
  assert.deepEqual(result.outOfOrder, [{ applied: `${first}.sql`, newestPrior: `${second}.sql` }]);
});

const badSchemas = [
  ['view', 'CREATE VIEW _turbine_migrations AS SELECT 1 AS id'],
  ['case alias', ddl.replace('_turbine_migrations', '_TURBINE_MIGRATIONS')],
  ['missing checksum', ddl.replace('checksum TEXT NOT NULL,', '')],
  ['nullable text', ddl.replace('name TEXT NOT NULL UNIQUE', 'name TEXT UNIQUE')],
  ['no unique key', ddl.replace('name TEXT NOT NULL UNIQUE', 'name TEXT NOT NULL')],
  ['wrong id affinity', ddl.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'INT PRIMARY KEY')],
  ['descending non-rowid key', ddl.replace('INTEGER PRIMARY KEY AUTOINCREMENT', 'INTEGER PRIMARY KEY DESC')],
  ['without rowid', `${ddl.replace(' AUTOINCREMENT', '')} WITHOUT ROWID`],
  [
    'generated column',
    ddl.replace('checksum TEXT NOT NULL', "checksum TEXT NOT NULL GENERATED ALWAYS AS ('a') VIRTUAL"),
  ],
  ['extra column', ddl.replace('id INTEGER', 'extra TEXT, id INTEGER')],
  ['nonbinary name', ddl.replace('name TEXT NOT NULL UNIQUE', 'name TEXT NOT NULL COLLATE NOCASE UNIQUE')],
] as const;
for (const [name, schema] of badSchemas) {
  test(`refuses ${name} metadata and preserves it`, async (t) => {
    const f = await fixture(t, schema);
    f.client.close();
    const before = tree(f.root);
    await assert.rejects(inspectLibsqlMigrations(f.filename, f.migrations), /Invalid local libSQL migration history/);
    assert.deepEqual(tree(f.root), before);
  });
}

test('partial/expression/composite unique keys, history triggers and inbound foreign keys refuse', async (t) => {
  for (const sql of [
    'CREATE UNIQUE INDEX bad ON _turbine_migrations(name) WHERE id > 0',
    'CREATE UNIQUE INDEX bad ON _turbine_migrations(lower(name))',
    'CREATE UNIQUE INDEX bad ON _turbine_migrations(name,checksum)',
    'CREATE TRIGGER bad AFTER INSERT ON _turbine_migrations BEGIN SELECT 1; END',
    'CREATE TABLE child(history_id INTEGER REFERENCES _turbine_migrations(id))',
  ]) {
    const f = await fixture(
      t,
      sql.includes('INDEX') ? ddl.replace('name TEXT NOT NULL UNIQUE', 'name TEXT NOT NULL') : ddl,
    );
    await f.client.execute(sql);
    f.client.close();
    const before = tree(f.root);
    await assert.rejects(inspectLibsqlMigrations(f.filename, f.migrations), /Invalid local libSQL migration history/);
    assert.deepEqual(tree(f.root), before);
  }
});

test('invalid IDs, unsafe names, checksum values and timestamps refuse rather than silently passing', async (t) => {
  for (const [field, value] of [
    ['id', 0],
    ['id', -1],
    ['id', 9007199254740993n],
    ['name', '../escape'],
    ['name', 'ordinary'],
    ['name', '20260101000000_dir/file'],
    ['checksum', ''],
    ['checksum', 'X'.repeat(64)],
    ['checksum', new Uint8Array([1])],
    ['applied_at', 'not a date'],
    ['applied_at', '2026-02-30 00:00:00'],
    ['applied_at', '2026-01-01 25:00:00'],
  ] as const) {
    const f = await fixture(t);
    f.file();
    await f.insert();
    await f.client.execute({ sql: `UPDATE _turbine_migrations SET ${field} = ?`, args: [value] });
    f.client.close();
    const before = tree(f.root);
    await assert.rejects(inspectLibsqlMigrations(f.filename, f.migrations), /Invalid local libSQL migration history/);
    assert.deepEqual(tree(f.root), before);
  }
});

test('duplicate history names are refused even when the tracking table has plausible columns', async (t) => {
  const f = await fixture(t, ddl.replace('name TEXT NOT NULL UNIQUE', 'name TEXT NOT NULL'));
  await f.insert();
  await f.insert();
  await assert.rejects(inspectLibsqlMigrations(f.filename, f.migrations), /UNIQUE/);
});

test('malformed migration parser refuses without running SQL, including pending files', async (t) => {
  const f = await fixture(t);
  f.file(first, 'CREATE TABLE forbidden(id INTEGER); -- no UP marker');
  f.client.close();
  const before = tree(f.root);
  await assert.rejects(inspectLibsqlMigrations(f.filename, f.migrations), /no `-- UP` section marker/);
  assert.deepEqual(tree(f.root), before);
});

test('one native read snapshot survives a peer replacing catalog and history between reads', async (t) => {
  const f = await fixture(t);
  f.file();
  await f.insert();
  await f.client.execute('PRAGMA journal_mode=WAL');
  const prototype = Object.getPrototypeOf(f.client) as typeof f.client;
  const original: (this: typeof f.client, mode: 'read') => ReturnType<typeof prototype.transaction> =
    prototype.transaction;
  let committed = false;
  t.mock.method(prototype, 'transaction', async function (this: typeof f.client, mode: 'read') {
    const tx = await original.call(this, mode);
    const execute = tx.execute.bind(tx);
    t.mock.method(tx, 'execute', async (sql: Parameters<typeof tx.execute>[0]) => {
      const result = await execute(sql);
      if (!committed && typeof sql === 'string' && sql.startsWith('SELECT name, type FROM main.sqlite_schema')) {
        committed = true;
        await f.client.batch(
          ['DROP TABLE _turbine_migrations', 'CREATE TABLE _turbine_migrations(wrong TEXT)'],
          'write',
        );
      }
      return result;
    });
    return tx;
  });
  const result = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.equal(committed, true, 'writer must actually commit inside the reader transaction');
  assert.equal(result.history[0]!.name, first);
  assert.equal(result.statuses[0]!.checksumValid, true);
  t.mock.restoreAll();
  // Negative control: a later inspection must see and reject the committed malformed table.
  await assert.rejects(inspectLibsqlMigrations(f.filename, f.migrations), /Invalid local libSQL migration history/);
  assert.equal(f.client.closed, false);
  assert.equal((await f.client.execute('SELECT payload FROM untouched')).rows[0]![0], 'preserved');
});

test('an active WAL peer remains open and database/WAL bytes and file inventory are preserved', async (t) => {
  const f = await fixture(t);
  await f.client.execute('PRAGMA journal_mode=WAL');
  f.file();
  await f.insert();
  const inventory = readdirSync(f.root).sort();
  const digest = (path: string) => hash(readFileSync(path).toString('base64'));
  const before = [digest(f.filename), digest(`${f.filename}-wal`)];
  const shmBefore = digest(`${f.filename}-shm`);
  const result = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.equal(result.statuses[0]!.checksumValid, true);
  assert.deepEqual([digest(f.filename), digest(`${f.filename}-wal`)], before);
  assert.deepEqual(readdirSync(f.root).sort(), inventory);
  t.diagnostic(`SQLite shared-memory coordination bytes changed: ${digest(`${f.filename}-shm`) !== shmBefore}`);
  assert.equal(f.client.closed, false);
  assert.equal((await f.client.execute('SELECT 1')).rows[0]![0], 1n);
});

test('owned reader/transaction close on success, parser failure, and closed native transaction failure; peer stays usable', async (t) => {
  const f = await fixture(t);
  f.file();
  await f.insert();
  const prototype = Object.getPrototypeOf(f.client) as typeof f.client;
  const original: (this: typeof f.client, mode: 'read') => ReturnType<typeof prototype.transaction> =
    prototype.transaction;
  for (const failure of ['none', 'parser', 'closed'] as const) {
    let owned: typeof f.client | undefined;
    let transaction: Awaited<ReturnType<typeof original>> | undefined;
    t.mock.method(prototype, 'transaction', async function (this: typeof f.client, mode: 'read') {
      owned = this;
      transaction = await original.call(this, mode);
      if (failure === 'closed') transaction.close();
      return transaction;
    });
    f.file(first, failure === 'parser' ? 'invalid' : content);
    if (failure === 'none') await inspectLibsqlMigrations(f.filename, f.migrations);
    else
      await assert.rejects(
        inspectLibsqlMigrations(f.filename, f.migrations),
        failure === 'parser' ? /section marker/ : /closed/i,
      );
    assert.ok(owned && owned !== f.client);
    assert.equal(owned.closed, true);
    assert.equal(transaction!.closed, true);
    assert.equal(f.client.closed, false);
    assert.equal((await f.client.execute('SELECT 1')).rows[0]![0], 1n);
    t.mock.restoreAll();
  }
});

test('native mode=ro refuses a test-injected write; disappearing file is not recreated', async (t) => {
  const f = await fixture(t);
  f.file();
  await f.insert();
  f.client.close();
  // Own the prototype probe too; no borrowed application handle is used.
  const probe = native(f.filename);
  const prototype = Object.getPrototypeOf(probe) as typeof f.client;
  probe.close();
  const original: (this: typeof f.client, mode: 'read') => ReturnType<typeof prototype.transaction> =
    prototype.transaction;
  let readonlyRefusal = false;
  t.mock.method(prototype, 'transaction', async function (this: typeof f.client, mode: 'read') {
    const tx = await original.call(this, mode);
    await assert.rejects(tx.execute('CREATE TABLE forbidden(id INTEGER)'), (error: unknown) => {
      readonlyRefusal = /readonly/i.test(String(error));
      return readonlyRefusal;
    });
    return tx;
  });
  await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.equal(readonlyRefusal, true);
  t.mock.restoreAll();
  // The inspector synchronously completes stat, then awaits the peer import.
  // Remove the file in that gap to exercise native mode=ro, not just stat.
  const opening = inspectLibsqlMigrations(f.filename, f.migrations);
  unlinkSync(f.filename);
  await assert.rejects(opening, /Unable to open|SQLITE_CANTOPEN|ConnectionFailed/i);
  assert.equal(existsSync(f.filename), false);
});

test('a file changed after native history capture is compared using its newly captured content', async (t) => {
  const f = await fixture(t);
  f.file();
  await f.insert();
  const prototype = Object.getPrototypeOf(f.client) as typeof f.client;
  const original: (this: typeof f.client, mode: 'read') => ReturnType<typeof prototype.transaction> =
    prototype.transaction;
  let changed = false;
  t.mock.method(prototype, 'transaction', async function (this: typeof f.client, mode: 'read') {
    const tx = await original.call(this, mode);
    const execute = tx.execute.bind(tx);
    t.mock.method(tx, 'execute', async (sql: Parameters<typeof tx.execute>[0]) => {
      const result = await execute(sql);
      if (typeof sql === 'string' && sql.startsWith('SELECT id, name, applied_at, checksum')) {
        f.file(first, `${content}-- concurrent file edit\n`);
        changed = true;
      }
      return result;
    });
    return tx;
  });
  const result = await inspectLibsqlMigrations(f.filename, f.migrations);
  assert.equal(changed, true);
  assert.equal(result.checksums[0]!.actual, hash(`${content}-- concurrent file edit\n`));
  assert.equal(result.checksums[0]!.state, 'modified');
  assert.equal(result.statuses[0]!.checksumValid, false);
});

test('rollback failure still closes the actual native transaction and owned client', async (t) => {
  const f = await fixture(t);
  f.file();
  const prototype = Object.getPrototypeOf(f.client) as typeof f.client;
  const original: (this: typeof f.client, mode: 'read') => ReturnType<typeof prototype.transaction> =
    prototype.transaction;
  let owned: typeof f.client | undefined;
  let transaction: Awaited<ReturnType<typeof original>> | undefined;
  const failure = new Error('deliberate rollback failure');
  t.mock.method(prototype, 'transaction', async function (this: typeof f.client, mode: 'read') {
    owned = this;
    transaction = await original.call(this, mode);
    t.mock.method(transaction, 'rollback', async () => {
      throw failure;
    });
    return transaction;
  });
  await assert.rejects(inspectLibsqlMigrations(f.filename, f.migrations), (error) => error === failure);
  assert.equal(transaction!.closed, true);
  assert.equal(owned!.closed, true);
  assert.equal(f.client.closed, false);
  assert.equal((await f.client.execute('SELECT 1')).rows[0]![0], 1n);
});

test('rejects URLs, memory, non-files and malformed directory arguments without creating files', async (t) => {
  const f = await fixture(t);
  f.client.close();
  const before = tree(f.root);
  for (const filename of [':memory:', 'file:nope.db', 'libsql://remote', 'https://remote', '', 'a\0b'])
    await assert.rejects(inspectLibsqlMigrations(filename, f.migrations), /filesystem filename/);
  await assert.rejects(inspectLibsqlMigrations(f.root, f.migrations), /regular file/);
  await assert.rejects(inspectLibsqlMigrations(f.filename, ''), /migrations directory/);
  assert.deepEqual(tree(f.root), before);
});

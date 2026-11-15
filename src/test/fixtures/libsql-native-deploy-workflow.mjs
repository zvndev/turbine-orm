/** Extends the existing installed local project/seed/inspection admission. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
function snapshot(dir) {
  return Object.fromEntries(
    readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const file = join(dir, item.name);
      return item.isDirectory() ? Object.entries(snapshot(file)) : [[file, hash(file)]];
    }),
  );
}
export async function deployOmission({ consumer, bins, run, report, label }) {
  report.deployOmissions ??= [];
  for (const [index, bin] of bins.entries()) {
    const dir = join(consumer, `deploy-${label}-${index}`);
    mkdirSync(dir);
    mkdirSync(join(dir, 'migrations'));
    writeFileSync(join(dir, 'app.sqlite'), '');
    writeFileSync(
      join(dir, 'turbine.config.mjs'),
      "export default {engine:'libsql',url:'file:./app.sqlite',migrationsDir:'./migrations'};\n",
    );
    writeFileSync(join(dir, 'migrations/20260101000000_first.sql'), '-- UP\nCREATE TABLE should_not_run(id);');
    const before = snapshot(dir);
    assert.match(
      await run(dir, process.execPath, [bin, 'migrate', 'deploy'], 1),
      /optional @libsql\/client|native engine/,
    );
    assert.deepEqual(snapshot(dir), before, 'Missing native prerequisite must precede effects');
    report.deployOmissions.push({ label, bin: index, passed: true });
  }
}
export async function deployWorkflow({ consumer, bins, run, report }) {
  const { createClient } = await import(pathToFileURL(join(consumer, 'node_modules/@libsql/client/lib-esm/node.js')));
  const native = async (file, fn) => {
    const client = createClient({ url: pathToFileURL(file).href, intMode: 'bigint', concurrency: 1, timeout: 0 });
    try {
      return await fn(client);
    } finally {
      client.close();
      assert.equal(client.closed, true);
    }
  };
  report.nativeDeploy = [];
  for (const [index, bin] of bins.entries()) {
    const dir = join(consumer, `native-deploy-${index}`),
      migrations = join(dir, 'migrations'),
      database = join(dir, 'app.sqlite');
    mkdirSync(dir);
    mkdirSync(migrations);
    const config = { engine: 'libsql', url: 'file:./app.sqlite', migrationsDir: './migrations', out: './generated' };
    writeFileSync(join(dir, 'turbine.config.mjs'), `export default ${JSON.stringify(config)};\n`);
    await native(database, (db) =>
      db.executeMultiple(
        "CREATE TABLE retained(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO retained VALUES(1,'preserved');",
      ),
    );
    const first = '20260101000000_first',
      second = '20260102000000_second';
    const one =
      '\uFEFF-- UP\n/* ; END */ CREATE TABLE "quoted;table"(id INTEGER PRIMARY KEY, big INTEGER, flag BOOLEAN, payload BLOB, note TEXT); INSERT INTO "quoted;table" VALUES(1,9007199254740993,true,x\'00ff\',\'literal; --COMMIT\');\n-- DOWN\nDROP TABLE retained;\n';
    const two = '-- UP\nCREATE UNIQUE INDEX [quoted index] ON "quoted;table"(id);\n';
    writeFileSync(join(migrations, `${first}.sql`), one);
    writeFileSync(join(migrations, `${second}.sql`), two);
    const command = (args, code = 0) => run(dir, process.execPath, [bin, 'migrate', ...args], code);
    const before = snapshot(dir);
    assert.equal(JSON.parse(await command(['status', '--exit-code'], 2)).historyState, 'uninitialized');
    assert.deepEqual(snapshot(dir), before);
    assert.deepEqual(JSON.parse(await command(['deploy'])).applied, [first, second]);
    await native(database, async (db) => {
      const r = await db.execute('SELECT * FROM "quoted;table"');
      assert.equal(r.rows.length, 1);
      assert.equal(r.columns.length, 5);
      assert.deepEqual(
        [r.rows[0][0], r.rows[0][1], r.rows[0][2], Array.from(new Uint8Array(r.rows[0][3])), r.rows[0][4]],
        [1n, 9007199254740993n, 1n, [0, 255], 'literal; --COMMIT'],
      );
      assert.deepEqual(
        (await db.execute('SELECT name,checksum FROM _turbine_migrations ORDER BY id')).rows.map((r) => [r[0], r[1]]),
        [
          [first, hash(join(migrations, `${first}.sql`))],
          [second, hash(join(migrations, `${second}.sql`))],
        ],
      );
    });
    const after = snapshot(dir);
    const status = JSON.parse(await command(['list', '--exit-code']));
    assert.equal(status.scope, 'local-read-only');
    assert.equal(status.problems.length, 0);
    assert.deepEqual(JSON.parse(await command(['deploy'])).applied, []);
    assert.deepEqual(snapshot(dir), after);
    const pending = '20260103000000_pending';
    const pendingFile = join(migrations, `${pending}.sql`);
    writeFileSync(pendingFile, '-- UP\nCREATE TABLE must_not_run(id);');
    const refuse = async (args, regex) => {
      const previous = snapshot(dir);
      assert.match(await command(args, 1), regex);
      assert.deepEqual(snapshot(dir), previous, 'Refusal must preserve every project file');
    };
    writeFileSync(join(migrations, `${first}.sql`), `${one}-- drift\n`);
    await refuse(['deploy'], /checksum drift/);
    writeFileSync(join(migrations, `${first}.sql`), one);
    unlinkSync(join(migrations, `${second}.sql`));
    await refuse(['deploy'], /missing/);
    writeFileSync(join(migrations, `${second}.sql`), two);
    const earlier = join(migrations, '20250101000000_earlier.sql');
    writeFileSync(earlier, '-- UP\nCREATE TABLE earlier(id);');
    await refuse(['deploy'], /out of filename order/);
    unlinkSync(earlier);
    for (const [sql, regex] of [
      ['/* BOM */\uFEFFEND;', /unsupported/],
      ['CREATE TRIGGER bad AFTER INSERT ON retained BEGIN DELETE FROM retained; END;', /unsupported/],
      ['DROP TABLE retained;', /unsupported/],
      ["CREATE TABLE bad(value CHECK(writefile('must-not-write','bad')));", /unsupported SQL function/],
      ...['1+1', '3-1', '((2))', '++2', "'a'-'b'", '-TRUE', 'NULL+1'].map((value) => [
        `INSERT INTO retained VALUES(${value},'computed');`,
        /scalar literal/,
      ]),
    ]) {
      writeFileSync(pendingFile, `-- UP\n${sql}`);
      await refuse(['deploy'], regex);
    }
    writeFileSync(pendingFile, '-- UP\nCREATE TABLE pending_sidecar_control(id);');
    for (const suffix of ['-wal', '-shm', '-journal']) {
      for (const link of [linkSync, symlinkSync]) {
        const sidecar = database + suffix;
        link(pendingFile, sidecar);
        try {
          await refuse(['deploy'], /sidecar|alias/);
        } finally {
          rmSync(sidecar, { force: true });
        }
      }
    }
    for (const flags of [
      ['deploy', '--schema', '--engine', 'libsql'],
      ['deploy', '--schema'],
      ['deploy', '--allow-destructive'],
      ['repair'],
      ['down'],
      ['reset'],
    ])
      await refuse(flags, /Missing value|Unsupported|support/);
    await refuse(['deploy', '--url', 'libsql://not-local.invalid'], /local|file/);
    writeFileSync(
      pendingFile,
      '-- UP\nCREATE TABLE mid_batch(id INTEGER PRIMARY KEY); INSERT INTO mid_batch VALUES(1);',
    );
    const failing = '20260104000000_failure',
      failingFile = join(migrations, `${failing}.sql`);
    writeFileSync(failingFile, '-- UP\nCREATE TABLE later(id); INSERT INTO mid_batch VALUES(1);');
    await refuse(['deploy'], /UNIQUE|constraint/);
    await native(database, async (db) => {
      assert.equal(
        (await db.execute("SELECT count(*) FROM sqlite_schema WHERE name IN ('mid_batch','later')")).rows[0][0],
        0n,
      );
      assert.equal((await db.execute('SELECT count(*) FROM _turbine_migrations')).rows[0][0], 2n);
      assert.equal((await db.execute('SELECT value FROM retained')).rows[0][0], 'preserved');
    });
    writeFileSync(failingFile, '-- UP\nCREATE TABLE later(id); INSERT INTO mid_batch VALUES(2);');
    assert.deepEqual(JSON.parse(await command(['deploy'])).applied, [pending, failing]);
    assert.deepEqual(JSON.parse(await command(['deploy'])).applied, []);
    mkdirSync(join(dir, 'generated'));
    linkSync(database, join(dir, 'generated/metadata.ts'));
    await refuse(['deploy'], /alias project/);
    unlinkSync(join(dir, 'generated/metadata.ts'));
    rmSync(join(dir, 'generated'), { recursive: true });
    report.nativeDeploy.push({
      bin: index,
      installed: bin,
      passed: true,
      scalarRows: 1,
      scalarColumns: 5,
      historyRows: 4,
      negativeControls: 30,
    });
  }
}

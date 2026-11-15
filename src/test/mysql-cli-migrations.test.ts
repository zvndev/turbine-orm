import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(repo, 'src/cli/index.ts');
const loader = join(repo, 'node_modules/tsx/dist/loader.mjs');
const mysqlUrl = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const native = skipGate(!mysqlUrl, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a disposable MySQL 8 server');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const first = '20260101000000_first';
const second = '20260102000000_second';

async function run(cwd: string, args: string[], entry = cli, preload = true, nodeArgs: string[] = []) {
  const child = spawn(process.execPath, [...nodeArgs, ...(preload ? ['--import', loader] : []), entry, ...args], {
    cwd,
    env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 20_000,
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const [code, signal] = await once(child, 'close');
  assert.equal(signal, null, output);
  return { code, output };
}

async function fixture(
  body: (f: {
    dir: string;
    migrations: string;
    query: (sql: string, values?: string[]) => Promise<Record<string, unknown>[]>;
    write: (name: string, up: string, down?: string) => string;
    run: (args: string[]) => ReturnType<typeof run>;
  }) => Promise<void>,
) {
  const { createConnection } = await import('mysql2/promise');
  const url = new URL(mysqlUrl);
  const database = `turbine_mysql_cli_migrations_${randomBytes(6).toString('hex')}`;
  const admin = await createConnection({
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  });
  const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-cli-migrations-'));
  const migrations = join(dir, 'turbine/migrations');
  try {
    await admin.query(`CREATE DATABASE \`${database}\``);
    await admin.query(`USE \`${database}\``);
    url.pathname = `/${database}`;
    mkdirSync(migrations, { recursive: true });
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    writeFileSync(join(dir, '.env'), `DATABASE_URL=${url.href}\n`);
    writeFileSync(join(dir, 'turbine.config.ts'), "export default {engine: 'mysql', url: process.env.DATABASE_URL};\n");
    const pgGuard = join(dir, 'no-pg.cjs');
    writeFileSync(
      pgGuard,
      "const pg = require('pg'); pg.Pool = class { constructor() { throw new Error('PG DISPATCH FORBIDDEN'); } };\n",
    );
    const control = join(dir, 'pg-control.cjs');
    writeFileSync(control, "new (require('pg').Pool)();\n");
    const negative = await run(dir, [], control, false, ['--require', pgGuard]);
    assert.equal(negative.code, 1, negative.output);
    assert.match(negative.output, /PG DISPATCH FORBIDDEN/);
    const query = async (sql: string, values?: string[]) => {
      const [rows] = values ? await admin.execute(sql, values) : await admin.query(sql);
      return rows as Record<string, unknown>[];
    };
    await body({
      dir,
      migrations,
      query,
      write(name, up, down = '') {
        const file = join(migrations, `${name}.sql`);
        writeFileSync(file, `-- UP\n${up}\n-- DOWN\n${down}\n`);
        return file;
      },
      run: (args) => run(dir, ['migrate', ...args], cli, true, ['--require', pgGuard]),
    });
  } finally {
    try {
      await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    } finally {
      await admin.end();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

function expect(result: Awaited<ReturnType<typeof run>>, code: number, pattern?: RegExp) {
  assert.equal(result.code, code, result.output);
  if (pattern) assert.match(result.output, pattern);
}

describe('MySQL migration actual CLI boundary', () => {
  it('creates shared-format files at the default path without connecting and prints native help', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-create-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    expect(await run(dir, ['migrate', 'create', 'create_items', '--engine', 'mysql']), 0, /Created/);
    const files = readdirSync(join(dir, 'turbine/migrations'));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^\d{14}_create_items.sql$/);
    assert.match(readFileSync(join(dir, 'turbine/migrations', files[0]!), 'utf8'), /-- UP[\s\S]*-- DOWN/);
    expect(await run(dir, ['migrate', '--engine', 'mysql', '--help']), 0, /recover <name> <checksum>/);
    expect(await run(dir, ['migrate', 'up', '--engine', 'mysql']), 1, /need --url/);
    writeFileSync(
      join(dir, 'turbine.config.mjs'),
      "export default {engine: 'mysql', migrationsDir:'./custom/migrations'};",
    );
    expect(await run(dir, ['migrate', '--help']), 0, /MySQL SQL-first migrations/);
    expect(await run(dir, ['migration', 'create', 'custom']), 0, /Created/);
    assert.equal(readdirSync(join(dir, 'custom/migrations')).length, 1);
    expect(await run(dir, ['m', 'help']), 0, /MySQL SQL-first migrations/);
  });

  it('refuses unsupported/inert flags, code-first, malformed recovery and swallowed safety operands with zero sockets', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-mysql-refuse-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    let sockets = 0;
    const server = createServer((socket) => {
      sockets++;
      socket.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const url = `mysql://127.0.0.1:${(server.address() as AddressInfo).port}/test`;
    writeFileSync(join(dir, 'turbine.config.mjs'), `export default {engine: 'mysql', url: ${JSON.stringify(url)}};`);
    const cases = [
      ['up', '--force'],
      ['up', '--auto'],
      ['up', '--from-diff'],
      ['up', '--recipe', 'backfill'],
      ['up', '--allow-pending'],
      ['up', '--allow-pooler'],
      ['up', '--schema-file', './schema.ts'],
      ['up', '--out', '--dry-run'],
      ['up', '--out', './generated'],
      ['up', '--include', 'items'],
      ['up', '--exclude', 'items'],
      ['up', '--verbose'],
      ['up', '--url'],
      ['up', '--url', ''],
      ['up', '--url', '   '],
      ['up', '--url', '--dry-run'],
      ['up', '--schema'],
      ['up', '--schema', '--dry-run'],
      ['up', 'extra'],
      ['down', '--wait'],
      ['deploy', '--step', '1'],
      ['deploy', '--allow-drift'],
      ['deploy', '--wait=2147484'],
      ['status', '--allow-drift'],
      ['status', '--dry-run'],
      ['up', '--exit-code'],
      ['recover', first, 'a'.repeat(64), 'applied'],
      ['recover', first, 'bad', 'applied', '--acknowledge-partial-ddl'],
      ['recover', first, 'a'.repeat(64), 'unknown', '--acknowledge-partial-ddl'],
      ['recover', first, 'a'.repeat(64), 'applied', '--acknowledge-partial-ddl', '--dry-run'],
      ['up', '--acknowledge-partial-ddl'],
    ];
    for (const args of cases)
      expect(
        await run(dir, ['migrate', ...args]),
        1,
        /unsupported|requires|refuse|only applies|Usage|Unexpected|need --url|schema must match/i,
      );
    // Explicit raw engine selection is checked even if the legacy parser swallowed it.
    expect(await run(dir, ['migrate', 'up', '--url', '--engine', 'mysql']), 1, /non-flag operand/);
    writeFileSync(
      join(dir, 'turbine.config.mjs'),
      `export default {engine:'mysql',url:${JSON.stringify(url)},schemaFile:'./schema.ts'};`,
    );
    writeFileSync(join(dir, 'schema.ts'), "throw new Error('SCHEMA MUST NOT LOAD');");
    const schema = await run(dir, ['migrate', 'up', '--schema-file', './schema.ts']);
    expect(schema, 1, /schema-file/);
    assert.doesNotMatch(schema.output, /SCHEMA MUST NOT LOAD/);
    writeFileSync(
      join(dir, 'turbine.config.mjs'),
      `export default {engine:'mysql',url:${JSON.stringify(url)},adapter:{}};`,
    );
    expect(await run(dir, ['migrate', 'up']), 1, /adapters cannot/);
    for (const engine of ['postgresql', 'sqlite']) {
      unlinkSync(join(dir, 'turbine.config.mjs'));
      expect(
        await run(dir, ['migrate', 'up', '--engine', engine, '--acknowledge-partial-ddl']),
        1,
        /only applies to MySQL/,
      );
      writeFileSync(join(dir, 'turbine.config.mjs'), 'export default {};');
    }
    assert.equal(sockets, 0);
    const { connect } = await import('node:net');
    const control = connect((server.address() as AddressInfo).port, '127.0.0.1');
    await once(control, 'close');
    assert.equal(sockets, 1, 'negative control must observe a real socket');
  });
});

describe('MySQL migration native CLI lifecycle', () => {
  native.it(
    'loads .env/TypeScript config, previews read-only, applies steps, deploys all and executes DOWN in application order',
    async () =>
      fixture(async (f) => {
        const later = f.write(
          second,
          'CREATE TABLE items(id INT PRIMARY KEY); INSERT INTO items VALUES(2);',
          'DROP TABLE items;',
        );
        expect(await f.run(['status', '--exit-code']), 2, /Pending/);
        expect(await f.run(['up', '--dry-run']), 0, /not executed or certified/);
        assert.deepEqual(await f.query('SHOW TABLES'), []);
        // Invalid swallowed operands may not fall back to this configured live database.
        for (const args of [
          ['up', '--url'],
          ['up', '--out', '--dry-run'],
          ['up', '--url', '--dry-run'],
          ['up', '--schema', '--dry-run'],
        ]) {
          expect(await f.run(args), 1);
          assert.deepEqual(await f.query('SHOW TABLES'), []);
        }
        expect(await f.run(['up', '--step', '1']), 0, /1 migration/);
        assert.deepEqual(await f.query('SELECT * FROM items'), [{ id: 2 }]);
        f.write(first, 'INSERT INTO items VALUES(1);', 'DELETE FROM items WHERE id=1;');
        const third = '20260103000000_third';
        f.write(third, 'INSERT INTO items VALUES(3);', 'DELETE FROM items WHERE id=3;');
        expect(await f.run(['up', '--step', '1']), 0, /out of order/);
        expect(await f.run(['deploy']), 0, /1 migration/);
        assert.deepEqual(await f.query('SELECT * FROM items ORDER BY id'), [{ id: 1 }, { id: 2 }, { id: 3 }]);
        const preview = await f.run(['down', '--step', '3', '--dry-run']);
        expect(preview, 0);
        assert.ok(preview.output.indexOf(`${third}.sql`) < preview.output.indexOf(`${first}.sql`));
        assert.ok(preview.output.indexOf(`${first}.sql`) < preview.output.indexOf(`${second}.sql`));
        expect(await f.run(['down', '--step', '3']), 1, /allowDestructive/);
        assert.equal((await f.query('SELECT COUNT(*) AS n FROM _turbine_migrations'))[0]!.n, 3);
        expect(await f.run(['down', '--step', '3', '--allow-destructive']), 0, /3 migration/);
        assert.deepEqual(await f.query("SHOW TABLES LIKE 'items'"), []);
        assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
        assert.ok(readFileSync(later, 'utf8').includes('CREATE TABLE'));
      }),
  );

  native.it(
    'persists partial DDL, refuses retry even with absent failed file, and recovers manually without replay',
    async () =>
      fixture(async (f) => {
        const path = f.write(
          first,
          'CREATE TABLE items(id INT PRIMARY KEY); INSERT INTO items VALUES(1); INSERT INTO absent VALUES(7);',
          'DROP TABLE items;',
        );
        const original = readFileSync(path, 'utf8');
        const checksum = hash(original);
        expect(await f.run(['up']), 1, /No rollback is claimed/);
        assert.deepEqual(await f.query('SELECT * FROM items'), [{ id: 1 }]);
        expect(await f.run(['status', '--exit-code']), 2, /Dirty[\s\S]*2\/3 confirmed/);
        expect(await f.run(['up', '--allow-drift', '--allow-destructive']), 1, /Automatic retry is refused/);
        unlinkSync(path);
        const missing = await f.run(['list', '--exit-code']);
        expect(missing, 2, /Dirty/);
        assert.match(missing.output, new RegExp(checksum));
        for (const args of [['up'], ['deploy'], ['down', '--allow-destructive'], ['up', '--dry-run']])
          expect(await f.run(args), 1, /dirty|partial-DDL/i);
        const recover = ['recover', first, checksum, 'applied', '--acknowledge-partial-ddl'];
        expect(await f.run(recover), 1, /unchanged migration file/);
        writeFileSync(path, `${original}\n-- changed`);
        expect(await f.run(recover), 1, /unchanged migration file/);
        writeFileSync(path, original);
        expect(
          await f.run(['recover', first, 'b'.repeat(64), 'applied', '--acknowledge-partial-ddl']),
          1,
          /exact dirty/,
        );
        expect(await f.run(['recover', second, checksum, 'applied', '--acknowledge-partial-ddl']), 1, /exact dirty/);
        // Independently reconcile the one missing statement before asserting applied.
        await f.query('CREATE TABLE absent(id INT)');
        await f.query('INSERT INTO absent VALUES(7)');
        expect(await f.run(recover), 0, /no migration SQL was executed/);
        assert.deepEqual(await f.query('SELECT * FROM absent'), [{ id: 7 }]);
        assert.deepEqual(await f.query('SELECT * FROM items'), [{ id: 1 }]);
        expect(await f.run(['status', '--exit-code']), 0, /Applied/);
        expect(await f.run(['up']), 0, /0 migration/);
        assert.deepEqual(await f.query('SELECT * FROM _turbine_migration_state'), []);
        // A partial DOWN retains history; manual inverse completion can then remove it.
        writeFileSync(path, original.replace('DROP TABLE items;', 'DROP TABLE items; DROP TABLE missing;'));
        expect(await f.run(['down', '--allow-drift', '--allow-destructive']), 1, /No rollback is claimed/);
        expect(await f.run(['status', '--exit-code']), 2, /down, 1\/2/);
        const downHash = hash(readFileSync(path, 'utf8'));
        expect(await f.run(['recover', first, downHash, 'rolled-back', '--acknowledge-partial-ddl']), 0);
        assert.deepEqual(await f.query('SELECT * FROM _turbine_migrations'), []);
      }),
  );

  native.it(
    'gates drift/missing/ignored files, refuses deploy bypass, rebaselines explicitly and honors native locks',
    async () =>
      fixture(async (f) => {
        const path = f.write(first, 'CREATE TABLE items(id INT);', 'DROP TABLE items;');
        const database = (await f.query('SELECT DATABASE() AS name'))[0]!.name as string;
        const lock = `turbine:${hash(database).slice(0, 56)}`;
        await f.query('SELECT GET_LOCK(?,0)', [lock]);
        expect(await f.run(['up']), 1, /migration lock/);
        assert.deepEqual(await f.query('SHOW TABLES'), []);
        const waiting = f.run(['deploy', '--wait=1']);
        expect(await waiting, 1, /migration lock/);
        await f.query('SELECT RELEASE_LOCK(?)', [lock]);
        expect(await f.run(['deploy', '--wait=1']), 0);
        const original = readFileSync(path, 'utf8');
        writeFileSync(path, `${original}\n-- edit`);
        expect(await f.run(['status', '--exit-code']), 2, /Drifted/);
        for (const args of [['up'], ['deploy'], ['deploy', '--dry-run'], ['down', '--dry-run']])
          expect(await f.run(args), 1, /modified|checksum/i);
        expect(await f.run(['deploy', '--allow-drift']), 1, /only applies/);
        expect(await f.run(['up', '--allow-drift']), 0, /Re-baselined/);
        assert.deepEqual(await f.query('SELECT * FROM items'), []);
        assert.equal(
          (await f.query('SELECT checksum FROM _turbine_migrations'))[0]!.checksum,
          hash(readFileSync(path, 'utf8')),
        );
        unlinkSync(path);
        expect(await f.run(['status', '--exit-code']), 2, /Missing file/);
        for (const args of [['up', '--allow-drift'], ['down', '--allow-drift', '--allow-destructive'], ['deploy']])
          expect(await f.run(args), 1, /deleted from disk/);
        writeFileSync(path, `${original}\n-- edit`);
        writeFileSync(join(f.migrations, 'ignored.sql'), 'CREATE TABLE never_run(id INT);');
        expect(await f.run(['status', '--exit-code']), 2, /will never run|Not a migration/);
        assert.deepEqual(await f.query("SHOW TABLES LIKE 'never_run'"), []);
      }),
  );
});

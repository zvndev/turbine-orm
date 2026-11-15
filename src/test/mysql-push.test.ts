import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createMigration } from '../cli/migrate.js';
import {
  inspectMysqlMigrationDeploy,
  migrateMysqlUp,
  recoverMysqlMigration,
  withMysqlMigrationWorkspace,
} from '../cli/mysql-migrate.js';
import { pushMysqlSchema } from '../cli/mysql-push.js';
import { assertMysqlPushArguments } from '../cli/mysql-push-command.js';
import { defineSchema } from '../schema-builder.js';
import { skipGate } from './helpers.js';
import { pushFixture, pushRepo, pushUrl, stageMysqlPush } from './mysql-push-helpers.js';

const native = skipGate(!pushUrl, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a disposable MySQL 8 server');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let stage: string;
before(() => {
  stage = stageMysqlPush();
});
after(() => rmSync(stage, { recursive: true, force: true }));
const simple = () =>
  defineSchema({ users: { id: { type: 'serial', primaryKey: true }, label: { type: 'varchar', maxLength: 40 } } });
const related = () =>
  defineSchema({
    parents: { id: { type: 'serial', primaryKey: true } },
    children: {
      id: { type: 'serial', primaryKey: true },
      parentId: { type: 'integer', references: { target: 'parents.id' } },
    },
  });
const files = (dir: string) => (existsSync(dir) ? readdirSync(dir).sort() : []);
function ok(r: { code: number | null; output: string }, code = 0, pattern?: RegExp) {
  assert.ok(r.output.trim(), 'actual process must print output');
  assert.equal(r.code, code, r.output);
  if (pattern) assert.match(r.output, pattern);
}
async function cli(dir: string, args: string[], preload?: string, env: Record<string, string> = {}) {
  const child = spawn(
    process.execPath,
    [
      ...(preload ? ['--require', preload] : []),
      '--import',
      join(pushRepo, 'node_modules/tsx/dist/loader.mjs'),
      join(stage, 'src/cli/index.ts'),
      ...args,
    ],
    {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: '', NODE_OPTIONS: '', NO_COLOR: '1', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    },
  );
  let output = '';
  child.stdout.on('data', (c) => {
    output += c;
  });
  child.stderr.on('data', (c) => {
    output += c;
  });
  const [code, signal] = await once(child, 'close');
  return { code: code as number | null, signal, output };
}
function fault(dir: string, code: string) {
  const file = join(dir, 'fault.cjs');
  writeFileSync(
    file,
    `const driver=require(${JSON.stringify(join(pushRepo, 'node_modules/mysql2/promise'))});const original=driver.createConnection;driver.createConnection=async function(config){const c=await original(config);const query=c.query.bind(c),execute=c.execute.bind(c);let ddl=0;c.query=async(sql,...rest)=>{const result=await query(sql,...rest);if(/^(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX) \\x60(?!_turbine)/.test(sql)){ddl++;${code}}return result;};return c;};`,
  );
  return file;
}

describe('MySQL push safety boundary', () => {
  it('requires explicit apply or preview and rejects swallowed operands before effects', async () => {
    assert.throws(() => assertMysqlPushArguments({ command: 'push', positional: [] }, ['push']), /exactly one/);
    await assert.rejects(pushMysqlSchema('mysql://127.0.0.1:1/x', 'unused', simple(), {}), /exactly one/);
    const dir = mkdtempSync(join(tmpdir(), 'turbine-push-args-'));
    const server = createServer();
    let accepts = 0;
    server.on('connection', (socket) => {
      accepts++;
      socket.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const port = (server.address() as { port: number }).port;
    try {
      writeFileSync(
        join(dir, 'turbine.config.mjs'),
        `export default {engine:'mysql',url:'mysql://127.0.0.1:${port}/unused',schemaFile:'./schema.mjs'};`,
      );
      writeFileSync(
        join(dir, 'schema.mjs'),
        "import {writeFileSync} from 'node:fs';writeFileSync('imported','unsafe');export default {tables:{},enums:{}};",
      );
      for (const args of [
        ['push', '--engine', 'mysql'],
        ['push', '--engine', 'mysql', '--yes', '--dry-run'],
        ...['--url', '--schema', '--schema-file', '--out'].map((flag) => [
          'push',
          flag,
          '--dry-run',
          '--yes',
          '--engine',
          'mysql',
        ]),
        ['push', '--schema-file', '--dry-run'],
        ['push', '--engine', 'mysql', '--yes', '--exit-code'],
        ['push', '--engine', 'mysql', '--engine', 'postgresql', '--yes'],
        ['push', '--engine', 'mysql', '--engine', 'sqlite', '--yes'],
        ['push', '--engine', 'mysql', '--yes', '--force'],
        ['push', '--engine', 'mysql', '--yes', '--allow-pending'],
      ]) {
        ok(await cli(dir, args), 1);
        assert.equal(existsSync(join(dir, 'imported')), false);
      }
      assert.equal(accepts, 0, 'malformed commands must not open a socket');
      const { connect } = await import('node:net');
      const positive = connect(port, '127.0.0.1');
      await once(positive, 'connect');
      positive.destroy();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(accepts, 1, 'socket control is live');
      ok(await cli(dir, ['push', '--engine', 'mysql', '--help']), 0, /DDL is not atomic/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('MySQL push native journal lifecycle', () => {
  native.it('previews without writes, applies a shared-format file, preserves rows and every ALTER consent', async () =>
    pushFixture(async (f) => {
      const guard = join(f.dir, 'no-pg.cjs');
      writeFileSync(
        guard,
        `require(${JSON.stringify(join(pushRepo, 'node_modules/pg'))}).Pool=class{constructor(){throw Error('PG DISPATCH FORBIDDEN')}};`,
      );
      const trap = spawn(
        process.execPath,
        ['--require', guard, '-e', `new (require(${JSON.stringify(join(pushRepo, 'node_modules/pg'))}).Pool)()`],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let trapText = '';
      trap.stderr.on('data', (c) => {
        trapText += c;
      });
      const [trapCode] = await once(trap, 'close');
      assert.notEqual(trapCode, 0);
      assert.match(trapText, /PG DISPATCH FORBIDDEN/);
      f.schema(simple());
      ok(await cli(f.dir, ['push', '--dry-run', '--exit-code'], guard), 2, /CREATE TABLE `users`/);
      assert.deepEqual(await f.query('SHOW TABLES'), []);
      assert.equal(existsSync(f.migrations), false);
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes'], guard), 0, /Applied journaled migration/);
      const original = files(f.migrations);
      assert.equal(original.length, 1);
      const content = readFileSync(join(f.migrations, original[0]!), 'utf8');
      assert.match(content, /-- UP\nCREATE TABLE/);
      assert.match(content, /-- DOWN\nDROP TABLE/);
      assert.deepEqual(await f.query('SELECT checksum FROM _turbine_migrations'), [{ checksum: sha(content) }]);
      await f.query("INSERT INTO users(label) VALUES('kept')");
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']), 0, /No supported schema changes/);
      assert.deepEqual(files(f.migrations), original);
      const changed = defineSchema({
        users: {
          id: { type: 'serial', primaryKey: true },
          label: { type: 'varchar', maxLength: 40 },
          enabled: { type: 'boolean', notNull: true, default: true },
        },
      });
      f.schema(changed);
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']), 1, /Every MySQL ALTER/);
      assert.deepEqual(files(f.migrations), original);
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--dry-run']), 0, /ADD COLUMN/);
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes', '--allow-destructive']), 0, /Applied journaled/);
      assert.deepEqual(await f.query('SELECT id,label,enabled FROM users'), [{ id: 1, label: 'kept', enabled: 1 }]);
      assert.equal((await f.query('SELECT * FROM _turbine_migration_state')).length, 0);
      ok(await cli(f.dir, ['migrate', 'down', '--engine', 'mysql', '--allow-destructive']), 0, /1 migration/);
      assert.deepEqual(await f.query('SELECT id,label FROM users'), [{ id: 1, label: 'kept' }]);
    }),
  );
  native.it('push previews as a no-op against the table the mysql init starter migration creates', async () =>
    pushFixture(async (f) => {
      rmSync(join(f.dir, 'turbine.config.mjs'), { force: true });
      symlinkSync(join(pushRepo, 'node_modules'), join(f.dir, 'node_modules'), 'dir');
      ok(await cli(f.dir, ['init', '--engine', 'mysql', '--yes', '-u', f.url]), 0);
      ok(await cli(f.dir, ['migrate', 'up', '--engine', 'mysql']), 0);
      f.schema(
        defineSchema({
          users: {
            id: { type: 'serial', primaryKey: true },
            email: { type: 'varchar', maxLength: 255, notNull: true, unique: true },
            display_name: { type: 'varchar', maxLength: 255 },
          },
        }),
      );
      ok(
        await cli(f.dir, ['push', '--engine', 'mysql', '--dry-run', '--exit-code', '--schema-file', './schema.mjs']),
        0,
      );
    }),
  );
  native.it(
    'refuses pending, ignored, drifted and missing files in both preview and apply before new effects',
    async () =>
      pushFixture(async (f) => {
        f.schema(simple());
        const pending = createMigration(f.migrations, 'unrelated', {
          up: 'CREATE TABLE unrelated(id INT);',
          down: 'DROP TABLE unrelated;',
        });
        for (const flag of ['--dry-run', '--yes'])
          ok(await cli(f.dir, ['push', '--engine', 'mysql', flag]), 1, /clean migration history/);
        assert.deepEqual(await f.query('SHOW TABLES'), []);
        assert.deepEqual(files(f.migrations), [pending.filename]);
        rmSync(pending.path);
        writeFileSync(join(f.migrations, 'ignored.SQL'), 'CREATE TABLE bad(id INT)');
        for (const flag of ['--dry-run', '--yes'])
          ok(await cli(f.dir, ['push', '--engine', 'mysql', flag]), 1, /ignored SQL/);
        rmSync(join(f.migrations, 'ignored.SQL'));
        ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']));
        const file = files(f.migrations)[0]!;
        const path = join(f.migrations, file);
        const original = readFileSync(path, 'utf8');
        writeFileSync(path, `${original}\n-- changed`);
        for (const flag of ['--dry-run', '--yes'])
          ok(await cli(f.dir, ['push', '--engine', 'mysql', flag]), 1, /clean migration history/);
        rmSync(path);
        for (const flag of ['--dry-run', '--yes'])
          ok(await cli(f.dir, ['push', '--engine', 'mysql', flag]), 1, /clean migration history/);
        assert.equal((await f.query('SELECT * FROM _turbine_migrations')).length, 1);
        assert.deepEqual(files(f.migrations), []);
      }),
  );
  native.it('refuses unsupported and incomplete schema/catalog cases without files or metadata', async () =>
    pushFixture(async (f) => {
      for (const schema of [
        defineSchema({ bad: { id: { type: 'uuid' } } }),
        defineSchema({ bad: { id: { type: 'integer', default: 'random()' } } }),
      ]) {
        f.schema(schema);
        for (const flag of ['--dry-run', '--yes']) ok(await cli(f.dir, ['push', '--engine', 'mysql', flag]), 1);
        assert.deepEqual(await f.query('SHOW TABLES'), []);
        assert.equal(existsSync(f.migrations), false);
      }
      await f.query('CREATE TABLE native_only(id INT)');
      f.schema(defineSchema({}));
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']), 1, /omitted native object/);
      assert.equal(existsSync(f.migrations), false);
      f.schema(defineSchema({ nativeOnly: { id: { type: 'integer' } } }));
      await f.query('ALTER TABLE native_only ADD INDEX partial(id) INVISIBLE');
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']), 1, /invisible or unsupported index/);
      assert.equal(existsSync(f.migrations), false);
    }),
  );
  native.it('holds the existing cooperative lock and refuses a second Turbine runner', async () =>
    pushFixture(async (f) => {
      f.schema(simple());
      await withMysqlMigrationWorkspace(f.url, f.migrations, {}, async () => {
        ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']), 1, /migration lock/);
        await assert.rejects(migrateMysqlUp(f.url, f.migrations), /migration lock/);
        assert.equal(existsSync(f.migrations), false);
        assert.deepEqual(await f.query('SHOW TABLES'), []);
      });
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']));
    }),
  );
  native.it('detects concurrent migration files after persistence and never runs unrelated pending SQL', async () =>
    pushFixture(async (f) => {
      f.schema(simple());
      const hook = join(f.dir, 'files.cjs');
      writeFileSync(
        hook,
        `const fs=require('node:fs');const sync=fs.fsyncSync;let done=false;fs.fsyncSync=function(fd){const r=sync(fd);if(!done){done=true;const path=require('node:path');const dir=path.join(process.cwd(),'turbine/migrations');fs.writeFileSync(path.join(dir,'20990101000000_unrelated.sql'),'-- UP\\nCREATE TABLE unrelated(id INT);\\n-- DOWN\\nDROP TABLE unrelated;');}return r;};`,
      );
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes'], hook), 1, /unrelated pending files/);
      assert.equal(files(f.migrations).length, 2);
      assert.deepEqual(await f.query('SHOW TABLES'), []);
    }),
  );
  native.it('freezes scaffold bytes before fsync and refuses concurrent SQL edits before metadata creation', async () =>
    pushFixture(async (f) => {
      f.schema(simple());
      const hook = join(f.dir, 'edit.cjs');
      writeFileSync(
        hook,
        `const fs=require('node:fs'),path=require('node:path');const sync=fs.fsyncSync;let done=false;fs.fsyncSync=function(fd){const result=sync(fd);if(!done){done=true;const dir=path.join(process.cwd(),'turbine/migrations'),file=path.join(dir,fs.readdirSync(dir)[0]);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('\\n-- DOWN\\n','\\nCREATE TABLE injected(id INT);\\n-- DOWN\\n'));}return result;};`,
      );
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes'], hook), 1, /unchanged pending migration/);
      assert.equal(files(f.migrations).length, 1);
      assert.match(readFileSync(join(f.migrations, files(f.migrations)[0]!), 'utf8'), /CREATE TABLE injected/);
      assert.deepEqual(await f.query('SHOW TABLES'), []);
    }),
  );
  native.it('keeps the scaffold if persistence fails and executes no database writes', async () =>
    pushFixture(async (f) => {
      f.schema(simple());
      const hook = join(f.dir, 'sync.cjs');
      writeFileSync(hook, "require('node:fs').fsyncSync=()=>{throw Error('PERSISTENCE FAULT')};");
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes'], hook), 1, /PERSISTENCE FAULT/);
      assert.equal(files(f.migrations).length, 1);
      assert.deepEqual(await f.query('SHOW TABLES'), []);
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']), 1, /pending/);
    }),
  );
  native.it('detects observed catalog drift before persistence with no scaffold', async () =>
    pushFixture(async (f) => {
      f.schema(simple());
      const hook = join(f.dir, 'drift.cjs');
      writeFileSync(
        hook,
        `const d=require(${JSON.stringify(join(pushRepo, 'node_modules/mysql2/promise'))});const original=d.createConnection;let catalogs=0;d.createConnection=async function(config){const c=await original(config);const query=c.query.bind(c);c.query=async function(sql,...rest){const r=await query(sql,...rest);if(sql==='ROLLBACK'&&++catalogs===1){const other=await original(config);try{await other.query('CREATE TABLE intruder(id INT)');}finally{await other.end();}}return r;};return c;};`,
      );
      ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes'], hook), 1, /catalog changed before persistence/);
      assert.equal(existsSync(f.migrations), false);
      assert.equal((await f.query('SHOW TABLES')).length, 1);
    }),
  );
  native.it('detects drift between DDL steps and preserves the ordinary dirty journal', async () =>
    pushFixture(async (f) => {
      f.schema(related());
      const hook = fault(
        f.dir,
        "if(ddl===1){const other=await original(config);try{await other.query('CREATE TABLE intruder(id INT)');}finally{await other.end();}}",
      );
      ok(
        await cli(f.dir, ['push', '--engine', 'mysql', '--yes', '--allow-destructive'], hook),
        1,
        /partial|omitted native object/i,
      );
      const plan = await inspectMysqlMigrationDeploy(f.url, f.migrations);
      assert.equal(plan.dirty?.completedStatements, 1);
      assert.equal(plan.dirty?.totalStatements, 3);
      assert.equal((await f.query('SELECT * FROM _turbine_migrations')).length, 0);
      const preserved = readFileSync(plan.pending[0]!.path, 'utf8');
      for (const flag of ['--dry-run', '--yes']) ok(await cli(f.dir, ['push', '--engine', 'mysql', flag]), 1, /dirty/);
      assert.equal(readFileSync(plan.pending[0]!.path, 'utf8'), preserved);
    }),
  );
  for (const boundary of ['journal', 'ddl1', 'ddl2', 'ddl3', 'confirmed1', 'confirmed2', 'confirmed3', 'commit']) {
    native.it(`preserves native effects and exact recovery after process loss at ${boundary}`, async () =>
      pushFixture(async (f) => {
        f.schema(related());
        const hook = join(f.dir, 'kill.cjs');
        // Driver path and kill boundary travel in environment variables, so
        // the preload source is one fixed string for every boundary.
        writeFileSync(
          hook,
          "const d=require(process.env.TURBINE_MYSQL_PUSH_KILL_DRIVER);const boundary=process.env.TURBINE_MYSQL_PUSH_KILL_BOUNDARY;const original=d.createConnection;d.createConnection=async function(config){const c=await original(config),query=c.query.bind(c),execute=c.execute.bind(c);let n=0;c.query=async(sql,...a)=>{const r=await query(sql,...a);if(/^(?:CREATE TABLE|ALTER TABLE|CREATE (?:UNIQUE )?INDEX) \\x60(?!_turbine)/.test(sql)&&++n===(Number(boundary.slice(3))||0)&&boundary.startsWith('ddl'))process.kill(process.pid,'SIGKILL');if(sql==='COMMIT'&&boundary==='commit')process.kill(process.pid,'SIGKILL');return r;};c.execute=async(sql,values)=>{const r=await execute(sql,values);if((boundary==='journal'&&sql.startsWith('INSERT INTO \\x60_turbine_migration_state'))||(boundary.startsWith('confirmed')&&sql.startsWith('UPDATE \\x60_turbine_migration_state')&&values[0]===(Number(boundary.slice(9))||0)))process.kill(process.pid,'SIGKILL');return r;};return c;};",
        );
        const r = await cli(f.dir, ['push', '--engine', 'mysql', '--yes', '--allow-destructive'], hook, {
          TURBINE_MYSQL_PUSH_KILL_DRIVER: join(pushRepo, 'node_modules/mysql2/promise'),
          TURBINE_MYSQL_PUSH_KILL_BOUNDARY: boundary,
        });
        assert.equal(r.signal, 'SIGKILL', r.output);
        const plan = await inspectMysqlMigrationDeploy(f.url, f.migrations);
        const names = files(f.migrations);
        assert.equal(names.length, 1);
        const path = join(f.migrations, names[0]!);
        const content = readFileSync(path, 'utf8');
        if (boundary === 'commit') {
          assert.equal(plan.dirty, null);
          assert.equal(plan.pending.length, 0);
          assert.deepEqual(await f.query('SELECT checksum FROM _turbine_migrations'), [{ checksum: sha(content) }]);
        } else {
          const expected =
            boundary === 'journal'
              ? 0
              : boundary.startsWith('ddl')
                ? Number(boundary.slice(3)) - 1
                : Number(boundary.slice(9));
          assert.equal(plan.dirty?.completedStatements, expected);
          assert.equal(plan.dirty?.totalStatements, 3);
          assert.equal(plan.dirty?.checksum, sha(content));
          assert.equal((await f.query('SELECT * FROM _turbine_migrations')).length, 0);
          const userTables = await f.query(
            "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('parents','children')",
          );
          const effects =
            boundary === 'journal'
              ? 0
              : boundary.startsWith('ddl')
                ? Number(boundary.slice(3))
                : Number(boundary.slice(9));
          assert.equal(userTables.length, Math.min(effects, 2));
          for (const flag of ['--dry-run', '--yes'])
            ok(await cli(f.dir, ['push', '--engine', 'mysql', flag]), 1, /dirty/);
          await assert.rejects(
            recoverMysqlMigration(f.url, f.migrations, {
              name: plan.dirty!.name,
              checksum: '0'.repeat(64),
              outcome: 'rolled-back',
              acknowledgePartialDdl: true,
            }),
            /checksum|exact|match/,
          );
          if (effects === 3) {
            await recoverMysqlMigration(f.url, f.migrations, {
              name: plan.dirty!.name,
              checksum: sha(content),
              outcome: 'applied',
              acknowledgePartialDdl: true,
            });
          } else {
            await f.query('DROP TABLE IF EXISTS children');
            await f.query('DROP TABLE IF EXISTS parents');
            await recoverMysqlMigration(f.url, f.migrations, {
              name: plan.dirty!.name,
              checksum: sha(content),
              outcome: 'rolled-back',
              acknowledgePartialDdl: true,
            });
            ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']), 1, /pending/);
            const applied = await migrateMysqlUp(f.url, f.migrations, { allowDestructive: true });
            assert.equal(applied.errors.length, 0);
            assert.equal(applied.applied.length, 1);
          }
        }
        ok(await cli(f.dir, ['push', '--engine', 'mysql', '--yes']), 0, /No supported schema changes/);
        assert.equal(readFileSync(path, 'utf8'), content);
        await assert.rejects(f.query('INSERT INTO children(parent_id) VALUES(999)'), /foreign key constraint/);
      }),
    );
  }
});

/** Execute SQLite project workflows through the actual CLI entrypoint. */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { describe, it as runtimeIt } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(repo, 'src/cli/index.ts');
const loader = join(repo, 'node_modules/tsx/dist/loader.mjs');
const Database: typeof NativeDatabase | undefined = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();
const [major, minor] = process.versions.node.split('.').map(Number);
const sqlite = skipGate(
  !Database || major! < 22 || (major === 22 && minor! < 12),
  'SQLite CLI commands require node:sqlite (Node >= 22.12)',
);
const migrationSupported = (() => {
  if (!Database) return false;
  const db = new Database(':memory:');
  try {
    const capabilities = db as unknown as { isTransaction?: unknown; setAuthorizer?: unknown };
    return typeof capabilities.isTransaction === 'boolean' && typeof capabilities.setAuthorizer === 'function';
  } finally {
    db.close();
  }
})();
const writer = skipGate(
  !migrationSupported,
  'SQLite migration writer requires isTransaction and setAuthorizer (Node >= 24.10)',
);

function run(dir: string, args: string[]) {
  const child = spawnSync(process.execPath, ['--import', loader, cli, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' },
  });
  return { status: child.status, output: `${child.stdout}\n${child.stderr}\n${child.error ?? ''}` };
}

function ok(dir: string, args: string[]): string {
  const result = run(dir, args);
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.output}`);
  return result.output;
}

function fixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-cli-'));
  try {
    // Match the documented consumer prerequisite: tsx is installed in the project.
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('SQLite actual CLI project commands', () => {
  sqlite.it('generate and pull opt into filtered read-only views without changing the database', () => {
    fixture((dir) => {
      const path = join(dir, 'app.sqlite');
      const db = new Database!(path);
      try {
        db.exec(`CREATE TABLE records(id INTEGER PRIMARY KEY, payload JSON, active BOOLEAN);
          INSERT INTO records VALUES(1, '{"ok":true}', 1);
          CREATE VIEW record_views AS SELECT * FROM records;
          CREATE VIEW excluded_views AS SELECT id FROM records;`);
      } finally {
        db.close();
      }
      const before = readFileSync(path);
      writeFileSync(
        join(dir, 'turbine.config.mjs'),
        "export default { engine: 'sqlite', url: './app.sqlite', out: './client', include: ['record_views', 'excluded_views'], exclude: ['excluded_views'] };\n",
      );
      const omitted = run(dir, ['generate', '--no-timestamp']);
      assert.equal(omitted.status, 1, omitted.output);
      assert.match(omitted.output, /0 tables/);
      for (const command of ['generate', 'pull']) {
        ok(dir, [command, '--include-views', '--no-timestamp']);
        const metadata = readFileSync(join(dir, 'client/metadata.ts'), 'utf8');
        assert.match(metadata, /record_views/);
        assert.match(metadata, /isView: true/);
        assert.doesNotMatch(metadata, /excluded_views|records: \{/);
        assert.deepEqual(readFileSync(path), before);
      }
      const entry = join(dir, 'client/index.ts');
      writeFileSync(
        entry,
        readFileSync(entry, 'utf8').replace("'turbine-orm/sqlite'", JSON.stringify(join(repo, 'src/sqlite.ts'))),
      );
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(dir, 'check.ts'),
        `
        import assert from 'node:assert/strict';
        import { turbine } from './client/index.ts';
        import { ValidationError } from '${join(repo, 'src/errors.ts')}';
        const db = turbine('./app.sqlite', { logger: {} });
        try {
          assert.deepEqual(await db.recordViews.findMany(), [{ id: 1, payload: { ok: true }, active: true }]);
          for (const write of [
            () => db.recordViews.create({ data: { id: 2 } }),
            () => db.recordViews.update({ where: { id: 1 }, data: { active: false } }),
            () => db.recordViews.delete({ where: { id: 1 } }),
          ]) await assert.rejects(write, (error: unknown) => error instanceof ValidationError && error.code === 'TURBINE_E003');
        } finally { await db.disconnect(); }
      `,
      );
      const checked = spawnSync(process.execPath, ['--import', loader, join(dir, 'check.ts')], {
        cwd: dir,
        encoding: 'utf8',
        timeout: 30_000,
      });
      assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
    });
  });

  runtimeIt('refuses an unreadable config before connecting to an inherited PostgreSQL URL', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-unreadable-config-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, 'turbine.config.mjs'),
      "throw new Error('config failed'); export default { engine: 'sqlite' };\n",
    );
    let connections = 0;
    const server = createServer((socket) => {
      connections++;
      socket.destroy();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise<void>((done) => server.close(() => done())));
    const port = (server.address() as AddressInfo).port;
    const child = spawn(process.execPath, ['--import', loader, cli, 'migrate', 'deploy'], {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: `postgres://127.0.0.1:${port}/test`, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    const [code] = await once(child, 'close');
    assert.equal(code, 1, output);
    assert.match(output, /Refusing to select a database engine/);
    assert.equal(connections, 0, output);
  });

  writer.it('reports history drift and missing files with real process exit codes without mutating status', () => {
    fixture((dir) => {
      ok(dir, ['init', '--engine', 'sqlite', '--url', './app.sqlite', '--yes']);
      assert.equal(run(dir, ['migrate', 'status', '--exit-code']).status, 2);
      ok(dir, ['migrate', 'deploy']);
      const database = join(dir, 'app.sqlite');
      const original = readFileSync(database);
      ok(dir, ['migrate', 'status', '--exit-code']);
      assert.deepEqual(readFileSync(database), original);
      const file = join(dir, 'turbine/migrations', readdirSync(join(dir, 'turbine/migrations'))[0]!);
      const sql = readFileSync(file, 'utf8');
      writeFileSync(file, `${sql}\n-- changed after application\n`);
      const drift = run(dir, ['migrate', 'status', '--exit-code']);
      assert.equal(drift.status, 2, drift.output);
      assert.match(drift.output, /Drifted/);
      assert.deepEqual(readFileSync(database), original);
      assert.equal(run(dir, ['migrate', 'deploy']).status, 1);
      const rebaseline = ok(dir, ['migrate', 'up', '--allow-drift']);
      assert.match(rebaseline, /Re-baselined/);
      ok(dir, ['migrate', 'status', '--exit-code']);
      rmSync(file);
      const missing = run(dir, ['migrate', 'status', '--exit-code']);
      assert.equal(missing.status, 2, missing.output);
      assert.match(missing.output, /Missing file/);
      assert.equal(run(dir, ['migrate', 'deploy', '--allow-drift']).status, 1);
    });
  });

  writer.it('creates explicit SQL files, previews without writes and rolls back an entire failed batch', () => {
    fixture((dir) => {
      ok(dir, ['init', '--engine', 'sqlite', '--url', './app.sqlite', '--yes']);
      const database = join(dir, 'app.sqlite');
      const before = readFileSync(database);
      assert.match(ok(dir, ['migrate', 'up', '--dry-run']), /CREATE TABLE users/);
      assert.deepEqual(readFileSync(database), before);
      ok(dir, ['migrate', 'create', 'bad_sql']);
      const migrations = join(dir, 'turbine/migrations');
      const created = readdirSync(migrations).find((name) => name.endsWith('_bad_sql.sql'))!;
      assert.ok(created);
      rmSync(join(migrations, created));
      const bad = join(migrations, '99990101000000_bad_sql.sql');
      writeFileSync(
        bad,
        '-- UP\nCREATE TABLE after_starter (id INTEGER);\nINSERT INTO absent VALUES (1);\n-- DOWN\nDROP TABLE after_starter;',
      );
      const failed = run(dir, ['migrate', 'deploy']);
      assert.equal(failed.status, 1, failed.output);
      assert.match(failed.output, /batch rolled back/);
      assert.deepEqual(readFileSync(database), before);
      writeFileSync(bad, '-- UP\nCREATE TABLE after_starter (id INTEGER);\n-- DOWN\nDROP TABLE after_starter;');
      ok(dir, ['migrate', 'up', '--step', '1']);
      assert.equal(run(dir, ['migrate', 'status', '--exit-code']).status, 2);
      ok(dir, ['migrate', 'deploy', '--wait=1']);
      ok(dir, ['migrate', 'status', '--exit-code']);
      const applied = readFileSync(database);
      assert.match(ok(dir, ['migrate', 'down', '--step', '2', '--dry-run']), /DROP TABLE/);
      assert.deepEqual(readFileSync(database), applied);
      const refused = run(dir, ['migrate', 'down', '--step', '2']);
      assert.equal(refused.status, 1, refused.output);
      assert.match(refused.output, /DESTRUCTIVE/);
      assert.deepEqual(readFileSync(database), applied);
      ok(dir, ['migrate', 'down', '--step', '2', '--allow-destructive']);
      assert.match(ok(dir, ['migrate', 'status']), /0 applied, 2 pending/);
    });
  });

  sqlite.it('refuses unsupported migration options before writing files and exposes SQLite help', () => {
    fixture((dir) => {
      const base = ['--engine', 'sqlite', '--url', './missing.sqlite'];
      for (const command of [
        ['migrate', 'create', 'test', '--auto'],
        ['migrate', 'create', 'test', '--from-diff'],
        ['migrate', 'create', 'test', '--recipe', 'backfill'],
        ['migrate', 'create', 'test', '--dry-run'],
        ['migrate', 'up', '--allow-pooler'],
        ['migrate', 'up', '--schema-file', './schema.ts'],
        ['migrate', 'deploy', '--step', '1'],
        ['migrate', 'status', '--wait=1'],
        ['migrate', 'up', '--force'],
      ]) {
        const result = run(dir, [...command, ...base]);
        assert.equal(result.status, 1, `${command.join(' ')}\n${result.output}`);
        assert.equal(existsSync(join(dir, 'missing.sqlite')), false);
        assert.equal(existsSync(join(dir, 'turbine/migrations')), false);
      }
      const help = ok(dir, ['migrate', '--engine', 'sqlite', '--help']);
      assert.match(help, /Native migration writes require Node >=24.10/);
      assert.match(help, /not supported/);
      assert.match(ok(dir, ['--help']), /use migrate --engine sqlite --help for its workflow/);
      writeFileSync(join(dir, 'turbine.config.mjs'), "export default { url: 'postgres://localhost/test' };\n");
      const mixed = run(dir, ['init', ...base, '--yes']);
      assert.equal(mixed.status, 1, mixed.output);
      assert.match(mixed.output, /different database engine/);
      assert.equal(existsSync(join(dir, 'missing.sqlite')), false);
    });
  });

  writer.it('runs fresh init, migration up/status/down/deploy and pull across independent processes', () => {
    fixture((dir) => {
      const initialized = ok(dir, ['init', '--engine', 'sqlite', '--url', './app.sqlite', '--yes']);
      assert.match(initialized, /SQL migrations/);
      assert.equal(existsSync(join(dir, 'app.sqlite')), true);
      assert.match(readFileSync(join(dir, 'turbine.config.ts'), 'utf8'), /engine: 'sqlite'/);
      const migrations = readdirSync(join(dir, 'turbine/migrations'));
      assert.equal(migrations.length, 1);
      ok(dir, ['migrate', 'status']);
      ok(dir, ['migrate', 'up']);
      ok(dir, ['pull', '--no-timestamp']);
      const client = readFileSync(join(dir, 'generated/turbine/index.ts'), 'utf8');
      assert.match(client, /turbine-orm\/sqlite/);
      assert.match(client, /readonly users:/);
      assert.match(ok(dir, ['status']), /users/);
      ok(dir, ['migrate', 'up']);
      ok(dir, ['migrate', 'down', '--allow-destructive']);
      const db = new Database!(join(dir, 'app.sqlite'), { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'users'").get()!.n, 0);
      } finally {
        db.close();
      }
      ok(dir, ['migrate', 'deploy']);
      ok(dir, ['generate', '--no-timestamp']);
      assert.equal(readFileSync(join(dir, 'generated/turbine/index.ts'), 'utf8'), client);
    });
  });

  sqlite.it('forwards exact native integer config and flag through actual pull and generate', () => {
    fixture((dir) => {
      const db = new Database!(join(dir, 'integers.sqlite'));
      try {
        db.exec(
          'CREATE TABLE numbers(id BIGINT PRIMARY KEY, value _INT NOT NULL); INSERT INTO numbers VALUES(9007199254740993, 9007199254740995)',
        );
      } finally {
        db.close();
      }
      const config = (value: string) =>
        writeFileSync(
          join(dir, 'turbine.config.mjs'),
          `export default { engine: 'sqlite', url: './integers.sqlite', exactNativeIntegers: ${value} };`,
        );
      const types = () => readFileSync(join(dir, 'generated/turbine/types.ts'), 'utf8');
      config('false');
      ok(dir, ['pull', '--no-timestamp']);
      const original = types();
      assert.doesNotMatch(original, /id\??: number \| string/);
      config('true');
      ok(dir, ['pull', '--no-timestamp']);
      const exact = types();
      assert.match(exact, /id\??: number \| string/);
      assert.match(exact, /id\??: number \| string \| bigint/);
      assert.match(exact, /value: number \| string;/);
      assert.match(exact, /value\??: number \| string \| bigint;/);
      config('false');
      ok(dir, ['generate', '--exact-native-integers', '--no-timestamp']);
      assert.equal(types(), exact);
      ok(dir, ['generate', '--no-timestamp']);
      assert.equal(types(), original);
      config("'invalid'");
      assert.notEqual(run(dir, ['pull']).status, 0);
      assert.equal(types(), original);
    });
  });

  sqlite.it('honors the configured unique-FK legacy opt-out through pull and native relation reads', () => {
    fixture((dir) => {
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
      const filename = join(dir, 'relations.sqlite');
      const db = new Database!(filename);
      try {
        db.exec(`CREATE TABLE parents(id INTEGER PRIMARY KEY);
          CREATE TABLE profiles(id INTEGER PRIMARY KEY, parent_id INTEGER UNIQUE REFERENCES parents(id), label TEXT);
          INSERT INTO parents VALUES(1),(2); INSERT INTO profiles VALUES(7,1,'one');`);
      } finally {
        db.close();
      }
      for (const legacy of [false, true]) {
        writeFileSync(
          join(dir, 'turbine.config.mjs'),
          `export default { engine: 'sqlite', url: './relations.sqlite'${legacy ? ', legacyToManyUniques: true' : ''} };`,
        );
        ok(dir, ['pull', '--no-timestamp']);
        const types = readFileSync(join(dir, 'generated/turbine/types.ts'), 'utf8');
        assert.match(
          types,
          legacy ? /profiles: RelationDescriptor<.*'hasMany'/ : /profile: RelationDescriptor<.*'hasOne'/,
        );
        // The to-one is named with the singular; the opt-out keeps the plural array.
        const relation = legacy ? 'profiles' : 'profile';
        const probe = spawnSync(
          process.execPath,
          [
            '--import',
            loader,
            '--input-type=module',
            '-e',
            `
          import { turbineSqlite } from ${JSON.stringify(pathToFileURL(join(repo, 'src/sqlite.ts')).href)};
          import { SCHEMA } from ${JSON.stringify(pathToFileURL(join(dir, 'generated/turbine/metadata.ts')).href)};
          const client = turbineSqlite(${JSON.stringify(filename)}, SCHEMA, { logger: {}, warnOnUnlimited: false });
          try { console.log(JSON.stringify({ names: Object.keys(SCHEMA.tables.parents.relations),
            rows: await client.table('parents').findMany({ with: { ${relation}: true }, orderBy: { id: 'asc' } }) })); }
          finally { await client.disconnect(); }
        `,
          ],
          { cwd: dir, encoding: 'utf8', timeout: 30_000 },
        );
        assert.equal(probe.status, 0, probe.stderr);
        const result = JSON.parse(probe.stdout);
        assert.deepEqual(result.names, [relation]);
        const profile = { id: 7, parentId: 1, label: 'one' };
        assert.deepEqual(result.rows, [
          { id: 1, [relation]: legacy ? [profile] : profile },
          { id: 2, [relation]: legacy ? [] : null },
        ]);
      }
    });
  });

  sqlite.it('initializes and pulls an existing schema using config URL, ESM and CommonJS projects', () => {
    for (const type of ['module', 'commonjs']) {
      fixture((dir) => {
        writeFileSync(join(dir, 'package.json'), JSON.stringify({ type }));
        const path = join(dir, 'existing.sqlite');
        const db = new Database!(path);
        try {
          db.exec('CREATE TABLE things (id INTEGER PRIMARY KEY, display_name TEXT NOT NULL)');
        } finally {
          db.close();
        }
        ok(dir, ['init', '--engine', 'sqlite', '--url', pathToFileURL(path).href, '--yes']);
        assert.match(readFileSync(join(dir, 'generated/turbine/types.ts'), 'utf8'), /interface Thing/);
        ok(dir, ['pull', '--no-timestamp', '--import-ext', 'js']);
        assert.match(readFileSync(join(dir, 'generated/turbine/index.ts'), 'utf8'), /from '\.\/metadata\.js'/);
        assert.match(ok(dir, ['info']), /things/);
        const before = readFileSync(join(dir, 'turbine.config.ts'), 'utf8');
        ok(dir, ['init', '--yes', '--force']);
        assert.equal(readFileSync(join(dir, 'turbine.config.ts'), 'utf8'), before);
      });
    }
  });

  sqlite.it('refuses missing databases, unsupported commands, engine typos and PostgreSQL URL mixing', () => {
    fixture((dir) => {
      for (const command of ['generate', 'pull', 'status']) {
        const result = run(dir, [command, '--engine', 'sqlite', '--url', './missing.sqlite']);
        assert.notEqual(result.status, 0);
        assert.match(result.output, /does not exist/);
        assert.equal(existsSync(join(dir, 'missing.sqlite')), false);
      }
      for (const args of [
        ['generate', '--engine', 'sqltie', '--url', './missing.sqlite'],
        ['generate', '--engine', 'sqlite', '--url', 'postgres://localhost/db'],
        ['generate', '--url', './missing.sqlite'],
      ]) {
        const result = run(dir, args);
        assert.notEqual(result.status, 0, result.output);
        assert.match(
          result.output,
          /not supported for SQLite|Unknown.*engine|PostgreSQL connection string|requires engine "sqlite"/,
        );
        assert.equal(existsSync(join(dir, 'missing.sqlite')), false);
      }
    });
  });
});

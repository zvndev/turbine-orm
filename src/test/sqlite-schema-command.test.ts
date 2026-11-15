/** Run fresh/alter/rebuild workflows through the real CLI process. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { describe, type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { skipGate } from './helpers.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(
  !native || !('setAuthorizer' in native.DatabaseSync.prototype),
  'SQLite migration writer requires setAuthorizer/isTransaction (Node >= 24.10)',
);
function fixture(t: TestContext, type: string = 'module') {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-schema-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type }));
  writeFileSync(join(dir, 'turbine.config.mjs'), "export default { engine: 'sqlite', url: './app.sqlite' };\n");
  return { dir, file: join(dir, 'app.sqlite') };
}
function source(dir: string, fields = "name: { type: 'text' }", idType = 'serial') {
  writeFileSync(
    join(dir, 'schema.mjs'),
    `import { defineSchema } from ${JSON.stringify(pathToFileURL(join(repo, 'src/schema-builder.ts')).href)};\nexport default defineSchema({items: {id: {type:${JSON.stringify(idType)},primaryKey:true}, ${fields}}});\n`,
  );
}
function run(dir: string, args: string[]) {
  const child = spawnSync(
    process.execPath,
    ['--import', join(repo, 'node_modules/tsx/dist/loader.mjs'), join(repo, 'src/cli/index.ts'), ...args],
    { cwd: dir, encoding: 'utf8', timeout: 30000, env: { ...process.env, DATABASE_URL: '', NO_COLOR: '1' } },
  );
  return { code: child.status, output: `${child.stdout}\n${child.stderr}\n${child.error ?? ''}` };
}
function ok(dir: string, args: string[]) {
  const result = run(dir, args);
  assert.equal(result.code, 0, result.output);
  return result.output;
}
function db<T>(file: string, run: (db: DatabaseSync) => T) {
  const c = new native!.DatabaseSync(file);
  try {
    return run(c);
  } finally {
    c.close();
  }
}
const PUSH = ['push', '--schema-file', './schema.mjs'];

describe('SQLite schema CLI workflows', () => {
  for (const mode of ['STRICT', 'WITHOUT ROWID', 'STRICT, WITHOUT ROWID', 'WITHOUT ROWID, STRICT']) {
    it(`previews and applies existing native table modes without changing rows: ${mode}`, (t) => {
      const f = fixture(t);
      const withoutRowid = mode.includes('WITHOUT');
      db(f.file, (c) =>
        c.exec(
          `CREATE TABLE items(id INTEGER PRIMARY KEY${withoutRowid ? '' : ' AUTOINCREMENT'}, name TEXT) ${mode}; INSERT INTO items VALUES(70,'kept')`,
        ),
      );
      source(
        f.dir,
        "name: {type:'text',notNull:true,default:\"'new'\"}, extra: {type:'integer',default:7}",
        withoutRowid ? 'integer' : 'serial',
      );
      const before = readFileSync(f.file);
      const preview = run(f.dir, [...PUSH, '--dry-run', '--exit-code']);
      assert.equal(preview.code, 2, preview.output);
      assert.match(preview.output, /rebuild: items/);
      assert.ok(preview.output.includes(`) ${mode}`), preview.output);
      assert.deepEqual(readFileSync(f.file), before);
      assert.match(ok(f.dir, PUSH), /one transaction/);
      db(f.file, (c) => {
        assert.equal(c.prepare('SELECT name FROM items WHERE id=70').get()!.name, 'kept');
        assert.equal(c.prepare('SELECT extra FROM items WHERE id=70').get()!.extra, 7);
        assert.deepEqual(
          { ...c.prepare("SELECT wr,strict FROM pragma_table_list WHERE name='items'").get() },
          { wr: withoutRowid ? 1 : 0, strict: mode.includes('STRICT') ? 1 : 0 },
        );
        if (withoutRowid) {
          assert.throws(() => c.exec('INSERT INTO items DEFAULT VALUES'), /NOT NULL/);
          assert.throws(() => c.prepare('SELECT rowid FROM items'), /no such column/);
        }
        if (mode.includes('STRICT'))
          assert.throws(() => c.exec("INSERT INTO items(id) VALUES('text')"), /datatype mismatch|cannot store/);
      });
      assert.equal(run(f.dir, [...PUSH, '--dry-run', '--exit-code']).code, 0);
    });
  }

  it('previews fresh, applies, adds and rebuilds with rows, then generates an actual SQLite consumer', (t) => {
    const f = fixture(t);
    source(f.dir);
    const diff = run(f.dir, [...PUSH, '--dry-run', '--exit-code']);
    assert.equal(diff.code, 2, diff.output);
    assert.equal(existsSync(f.file), false);
    assert.match(diff.output, /CREATE TABLE/);
    assert.match(ok(f.dir, PUSH), /one transaction/);
    db(f.file, (c) => c.exec("INSERT INTO items(name) VALUES('kept')"));
    source(f.dir, "name: {type:'text'}, extra: {type:'integer',default:4}");
    assert.match(ok(f.dir, [...PUSH, '--dry-run']), /ADD COLUMN/);
    ok(f.dir, PUSH);
    source(f.dir, "name: {type:'text',notNull:true,default:\"'new'\"}, extra: {type:'integer',default:4}");
    const before = readFileSync(f.file);
    assert.match(ok(f.dir, [...PUSH, '--dry-run']), /rebuild: items/);
    assert.deepEqual(readFileSync(f.file), before);
    ok(f.dir, PUSH);
    db(f.file, (c) => {
      assert.equal(c.prepare('SELECT name FROM items').get()!.name, 'kept');
      c.exec('INSERT INTO items DEFAULT VALUES');
      assert.equal(c.prepare('SELECT count(*) AS n FROM items').get()!.n, 2);
      assert.throws(() => c.exec('INSERT INTO items(name) VALUES(NULL)'), /NOT NULL/);
      assert.equal(c.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='_turbine_migrations'").get()!.n, 0);
    });
    assert.equal(run(f.dir, [...PUSH, '--dry-run', '--exit-code']).code, 0);
    ok(f.dir, ['generate', '--no-timestamp']);
    assert.match(readFileSync(join(f.dir, 'generated/turbine/index.ts'), 'utf8'), /turbine-orm\/sqlite/);
  });

  it('refuses unsupported flags/filters/config before a missing file can be created', (t) => {
    const f = fixture(t);
    source(f.dir);
    for (const args of [
      [...PUSH, '--force'],
      [...PUSH, '--allow-destructive'],
      [...PUSH, '--exit-code'],
      [...PUSH, '--include', 'items'],
      [...PUSH, '--schema', 'public'],
    ]) {
      const result = run(f.dir, args);
      assert.equal(result.code, 1, result.output);
      assert.equal(existsSync(f.file), false);
    }
    writeFileSync(
      join(f.dir, 'turbine.config.mjs'),
      "export default { engine:'sqlite', url:'postgres://localhost/must-not-connect' };\n",
    );
    const mixed = run(f.dir, PUSH);
    assert.equal(mixed.code, 1, mixed.output);
    assert.match(mixed.output, /PostgreSQL connection string/);
    assert.equal(existsSync(f.file), false);
  });

  for (const type of ['module', 'commonjs']) {
    it(`rejects malformed push operands before loading schema or writing a database (${type})`, (t) => {
      const f = fixture(t, type);
      const loaded = join(f.dir, 'schema-loaded');
      const malformed = [
        [...PUSH, '--out', '--dry-run'],
        [...PUSH, '-o', '--dry-run'],
        [...PUSH, '--out', './ignored'],
        [...PUSH, '--url'],
        [...PUSH, '-u'],
        [...PUSH, '--url', ''],
        [...PUSH, '--url', '--dry-run'],
        [...PUSH, '--schema-file'],
        [...PUSH, '--schema-file', '--dry-run'],
        [...PUSH, '--schema'],
        [...PUSH, '--schema', '--dry-run'],
        [...PUSH, '--url', '--dry-run', '--url', './app.sqlite'],
        [...PUSH, '--schema-file', '--dry-run', '--schema-file', './schema.mjs'],
        ['push', 'unexpected', '--schema-file', './schema.mjs'],
        [...PUSH, 'unexpected'],
      ];
      for (const existing of [false, true]) {
        source(f.dir, existing ? "name: {type:'text'}, extra: {type:'integer'}" : undefined);
        writeFileSync(
          join(f.dir, 'schema.mjs'),
          `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(loaded)}, 'loaded');\n${readFileSync(join(f.dir, 'schema.mjs'), 'utf8')}`,
        );
        const before = existing ? readFileSync(f.file) : undefined;
        for (const args of malformed) {
          const result = run(f.dir, args);
          assert.equal(result.code, 1, `${JSON.stringify(args)}: ${result.output}`);
          assert.equal(existsSync(loaded), false, `schema loaded for ${JSON.stringify(args)}`);
          if (before) assert.deepEqual(readFileSync(f.file), before, JSON.stringify(args));
          else assert.equal(existsSync(f.file), false, JSON.stringify(args));
        }
        // The same schema and config remain usable for intentional preview and apply.
        assert.match(ok(f.dir, [...PUSH, '--dry-run']), /Dry run, no changes applied/);
        if (before) assert.deepEqual(readFileSync(f.file), before);
        else assert.equal(existsSync(f.file), false);
        rmSync(loaded);
        ok(f.dir, PUSH);
        rmSync(loaded);
      }
    });
  }

  it('rolls back a failing batch across real processes and refuses unsafe plans without changing bytes', (t) => {
    const f = fixture(t, 'commonjs');
    source(f.dir);
    ok(f.dir, PUSH);
    db(f.file, (c) => c.exec("INSERT INTO items(name) VALUES('same'),('same')"));
    source(f.dir, "name:{type:'text',notNull:true}, indexes:[{name:'unique_name',columns:['name'],unique:true}]");
    const original = readFileSync(f.file);
    const failed = run(f.dir, PUSH);
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, /UNIQUE/);
    assert.deepEqual(readFileSync(f.file), original);
    source(f.dir, "name:{type:'integer'}");
    const refused = run(f.dir, PUSH);
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /type, key/);
    assert.deepEqual(readFileSync(f.file), original);
    source(f.dir, "name:{type:'text',notNull:true}");
    ok(f.dir, PUSH);
    db(f.file, (c) => assert.equal(c.prepare('SELECT count(*) AS n FROM items').get()!.n, 2));
  });
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  type CliOverrides,
  configTemplate,
  loadConfigResult,
  normalizeSqlitePath,
  resolveCliEngine,
  resolveConfig,
  type TurbineCliConfig,
  validateCliEngineUrl,
} from '../cli/config.js';

function withoutEnv(fn: () => void): void {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    fn();
  } finally {
    if (saved === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = saved;
  }
}

describe('CLI engine and SQLite target resolution', () => {
  it('defaults to PostgreSQL and retains its URI and keyword connection strings', () => {
    withoutEnv(() => {
      assert.equal(resolveConfig({}, {}).engine, 'postgresql');
      assert.equal(resolveConfig({}, {}).schema, 'public');
      for (const url of [
        'postgres://localhost/data.db',
        'postgresql://localhost/data.sqlite',
        'host=/tmp dbname=data.db',
        '/var/run/postgresql turbine',
      ]) {
        assert.equal(resolveConfig({ url }, {}).url, url);
        assert.equal(resolveConfig({ engine: 'postgresql', url }, {}).url, url);
      }
    });
  });

  it('validates misspellings and invalid runtime values rather than silently defaulting', () => {
    for (const engine of ['sqltie', 'postgres', '', 'SQLite', null, false, 1]) {
      assert.throws(() => resolveCliEngine(engine), /Unknown CLI engine/);
      assert.throws(() => resolveConfig({ engine } as unknown as TurbineCliConfig, {}), /Unknown CLI engine/);
      assert.throws(() => resolveConfig({}, { engine } as unknown as CliOverrides), /Unknown CLI engine/);
    }
    assert.equal(resolveCliEngine(undefined), 'postgresql');
  });

  it('honors explicit engine overrides and URL precedence with a main SQLite schema', () => {
    withoutEnv(() => {
      const config = resolveConfig(
        { engine: 'postgresql', url: 'postgres://localhost/db' },
        { engine: 'sqlite', url: './app.sqlite' },
      );
      assert.equal(config.engine, 'sqlite');
      assert.equal(config.schema, 'main');
      assert.equal(config.url, resolve('app.sqlite'));
      process.env.DATABASE_URL = './env.db';
      assert.equal(resolveConfig({ engine: 'sqlite', url: './config.db' }, {}).url, resolve('env.db'));
      assert.equal(resolveConfig({ engine: 'sqlite' }, { url: './flag.db' }).url, resolve('flag.db'));
    });
  });

  it('refuses engine/URL, namespace, and PostgreSQL adapter mixing', () => {
    withoutEnv(() => {
      for (const url of ['./data', '/tmp/data', 'file:///tmp/data.db', 'sqlite:./data.db', ':memory:', 'app.sqlite']) {
        assert.throws(() => resolveConfig({ url }, {}), /requires engine "sqlite"/);
      }
      for (const url of ['postgres://localhost/db', 'postgresql://localhost/db', 'host=localhost dbname=app']) {
        assert.throws(() => resolveConfig({ engine: 'sqlite', url }, {}), /PostgreSQL connection string/);
      }
      assert.throws(() => resolveConfig({ engine: 'sqlite', schema: 'public' }, {}), /schema "main"/);
      assert.throws(() => resolveConfig({ engine: 'sqlite', adapter: {} as never }, {}), /adapters/);
      process.env.DATABASE_URL = 'postgres://localhost/accidental';
      assert.throws(
        () => resolveConfig({ engine: 'sqlite', url: './configured.sqlite' }, {}),
        /PostgreSQL connection string/,
      );
    });
  });

  it('normalizes native paths and local file URLs without creating files', () => {
    const cwd = '/tmp/sqlite-path-tests';
    for (const value of ['./app.sqlite', 'app.sqlite', 'sqlite:./app.sqlite', 'file:./app.sqlite']) {
      assert.equal(normalizeSqlitePath(value, cwd), join(cwd, 'app.sqlite'));
    }
    assert.equal(normalizeSqlitePath('file:///tmp/a%20b.sqlite', cwd), '/tmp/a b.sqlite');
    assert.equal(normalizeSqlitePath('sqlite:///tmp/a%20b.sqlite', cwd), '/tmp/a b.sqlite');
    assert.equal(normalizeSqlitePath(pathToFileURL('/tmp/a#b.sqlite').href, cwd), '/tmp/a#b.sqlite');
    assert.doesNotThrow(() => validateCliEngineUrl('postgresql', 'postgres://localhost/app.db'));
  });

  it('recognizes a SQLite path by its extension, in linear time', () => {
    const refused = (url: string) => {
      try {
        validateCliEngineUrl('postgresql', url);
        return false;
      } catch (err) {
        if (/requires engine "sqlite"/.test((err as Error).message)) return true;
        throw err;
      }
    };
    // The previous expression is the oracle wherever no line break is involved.
    const before = /^(?:file:|sqlite:|:memory:|\.{0,2}[/\\]|[a-z]:[/\\])|\.(?:db|sqlite3?)(?:[?#].*)?$/i;
    const pieces = ['.', 'db', 'DB', 'sqlite', 'Sqlite3', '3', '?', '#', 'x', '/', '\\', ':', 'c:', 'file:', '-'];
    let seed = 7;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return (t ^ (t >>> 14)) >>> 0;
    };
    let matches = 0;
    for (let i = 0; i < 4000; i++) {
      let url = '';
      for (let n = 1 + (next() % 8); n > 0; n--) url += pieces[next() % pieces.length];
      assert.equal(refused(url), before.test(url), JSON.stringify(url));
      if (before.test(url)) matches++;
    }
    assert.ok(matches > 400 && matches < 3600, `${matches} of 4000 matched`);
    for (const url of ['app.db', 'app.sqlite3?mode=ro', 'app.sqlite#x', 'APP.DB', 'a.bak.db']) {
      assert.equal(refused(url), true, url);
    }
    for (const url of ['app.dbx', 'app.sqlite4', 'app.db/x', 'a.db.bak?x', 'postgres://localhost/app.db']) {
      assert.equal(refused(url), false, url);
    }
    // A line break after the query or fragment no longer hides the extension.
    assert.equal(refused('app.db?mode=ro\nx'), true);
    const started = performance.now();
    assert.equal(refused(`${'.db#'.repeat(50_000)}\nx`), true);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 1000, `took ${elapsed.toFixed(0)} ms`);
  });

  it('refuses transient, remote and ambiguous URI targets', () => {
    for (const value of [
      '',
      ' ',
      ':memory:',
      'sqlite::memory:',
      'file::memory:',
      'file:./db?mode=memory',
      'file:./db#fragment',
      'file://remote/db',
      'sqlite://remote/db',
      'https://host/db',
      'file:%00.db',
      'sqlite:',
      '\0',
    ]) {
      assert.throws(() => normalizeSqlitePath(value), /SQLite|PostgreSQL/);
    }
  });

  it('loads engine config through ESM and CommonJS interop', async () => {
    for (const [filename, source] of [
      ['turbine.config.mjs', "export default { engine: 'sqlite', url: './app.sqlite' };"],
      ['turbine.config.js', "module.exports = { engine: 'sqlite', url: './app.sqlite' };"],
    ]) {
      const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-config-'));
      try {
        writeFileSync(
          join(dir, 'package.json'),
          JSON.stringify({ type: filename!.endsWith('.mjs') ? 'module' : 'commonjs' }),
        );
        writeFileSync(join(dir, filename!), source!);
        const loaded = await loadConfigResult(dir);
        assert.equal(loaded.loadError, undefined);
        assert.equal(loaded.config.engine, 'sqlite');
        assert.equal(loaded.config.url, './app.sqlite');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('keeps the compact PostgreSQL scaffold and its default values stable', () => {
    const source = configTemplate();
    // Comment removal preserves every emitted field.
    assert.match(source, /url: process\.env\.DATABASE_URL/);
    assert.match(source, /schema: 'public'/);
    assert.match(source, /schemaFile: '\.\/turbine\/schema\.ts'/);
    assert.match(source, /seedFile: '\.\/turbine\/seed\.ts'/);
    assert.equal(
      createHash('sha256').update(source).digest('hex'),
      'bb7bc4888418949d5f8c85e6bac496cc0871cce96e74395ca7cb61e0d4ac1ab1',
    );
  });
});

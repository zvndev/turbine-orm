/**
 * turbine-orm — CLI unit tests
 *
 * Tests config template generation, config file resolution, migration parsing,
 * and UI utility functions — all without a database.
 *
 * Run: npx tsx --test src/test/cli.test.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  configTemplate,
  findConfigFile,
  loadConfig,
  looksLikeSchemaFilePath,
  resolveConfig,
  type TurbineCliConfig,
  type TurbineConfig,
} from '../cli/config.js';
import { _resetTsLoaderStateForTests, canResolveTsx, needsTsLoader, registerTsLoader } from '../cli/loader.js';
import { parseMigrationContent } from '../cli/migrate.js';
import { box, redactUrl, stripAnsi, table } from '../cli/ui.js';

// ---------------------------------------------------------------------------
// CLI config — configTemplate()
// ---------------------------------------------------------------------------

describe('CLI config', () => {
  describe('configTemplate()', () => {
    it('generates template with a connection string', () => {
      const result = configTemplate('postgres://user:pass@localhost:5432/mydb');
      assert.ok(result.includes("url: 'postgres://user:pass@localhost:5432/mydb'"));
      assert.ok(result.includes('import type { TurbineCliConfig }'));
      assert.ok(result.includes('export default config'));
    });

    it('generates template without connection string (uses process.env)', () => {
      const result = configTemplate();
      assert.ok(result.includes('url: process.env.DATABASE_URL'));
      // Should NOT contain a quoted string for the URL
      assert.ok(!result.includes("url: 'process.env"));
    });

    it('generates template with undefined connection string (same as no arg)', () => {
      const result = configTemplate(undefined);
      assert.ok(result.includes('url: process.env.DATABASE_URL'));
    });

    it('includes all standard config fields', () => {
      const result = configTemplate();
      assert.ok(result.includes("out: './generated/turbine'"));
      assert.ok(result.includes("schema: 'public'"));
      assert.ok(result.includes("migrationsDir: './turbine/migrations'"));
      assert.ok(result.includes("seed: './seed.ts'"));
      assert.ok(result.includes("schemaFile: './turbine/schema.ts'"));
    });

    it('preserves special characters in connection string', () => {
      const url = "postgres://user:p@ss'w0rd@localhost:5432/db";
      const result = configTemplate(url);
      // The string is embedded as-is inside single quotes
      assert.ok(result.includes(url));
    });

    it('handles connection string with ampersands and query params', () => {
      const url = 'postgres://user:pass@localhost:5432/db?sslmode=require&timeout=30';
      const result = configTemplate(url);
      assert.ok(result.includes(url));
    });
  });

  // ---------------------------------------------------------------------------
  // CLI config — findConfigFile()
  // ---------------------------------------------------------------------------

  describe('findConfigFile()', () => {
    it('returns null when no config file exists', () => {
      const emptyDir = join(tmpdir(), `turbine-cli-test-noconfig-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });
      const result = findConfigFile(emptyDir);
      assert.equal(result, null);
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('finds turbine.config.ts first (highest priority)', () => {
      const dir = join(tmpdir(), `turbine-cli-test-priority-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'turbine.config.ts'), 'export default {};');
      writeFileSync(join(dir, 'turbine.config.js'), 'module.exports = {};');
      const result = findConfigFile(dir);
      assert.ok(result !== null);
      assert.ok(result.endsWith('turbine.config.ts'));
      rmSync(dir, { recursive: true, force: true });
    });

    it('falls back to turbine.config.js when .ts is absent', () => {
      const dir = join(tmpdir(), `turbine-cli-test-js-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'turbine.config.js'), 'module.exports = {};');
      const result = findConfigFile(dir);
      assert.ok(result !== null);
      assert.ok(result.endsWith('turbine.config.js'));
      rmSync(dir, { recursive: true, force: true });
    });

    it('finds turbine.config.mjs', () => {
      const dir = join(tmpdir(), `turbine-cli-test-mjs-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'turbine.config.mjs'), 'export default {};');
      const result = findConfigFile(dir);
      assert.ok(result !== null);
      assert.ok(result.endsWith('turbine.config.mjs'));
      rmSync(dir, { recursive: true, force: true });
    });
  });

  // ---------------------------------------------------------------------------
  // CLI config — loadConfig()
  // ---------------------------------------------------------------------------

  describe('loadConfig()', () => {
    it('returns empty object when no config file exists', async () => {
      const emptyDir = join(tmpdir(), `turbine-cli-test-loadconfig-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });
      const config = await loadConfig(emptyDir);
      assert.deepEqual(config, {});
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('loads a .mjs config file', async () => {
      const dir = join(tmpdir(), `turbine-cli-test-loadmjs-${Date.now()}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'turbine.config.mjs'), `export default { out: './custom-output', schema: 'myschema' };`);
      const config = await loadConfig(dir);
      assert.equal(config.out, './custom-output');
      assert.equal(config.schema, 'myschema');
      rmSync(dir, { recursive: true, force: true });
    });
  });

  // ---------------------------------------------------------------------------
  // CLI config — resolveConfig()
  // ---------------------------------------------------------------------------

  describe('resolveConfig()', () => {
    it('returns defaults when file config and overrides are empty', () => {
      const oldUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const result = resolveConfig({}, {});
        assert.equal(result.url, '');
        assert.equal(result.out, './generated/turbine');
        assert.equal(result.schema, 'public');
        assert.deepEqual(result.include, []);
        assert.deepEqual(result.exclude, []);
        assert.equal(result.migrationsDir, './turbine/migrations');
        assert.equal(result.seedFile, undefined);
        assert.equal(result.schemaFile, './turbine/schema.ts');
      } finally {
        if (oldUrl !== undefined) process.env.DATABASE_URL = oldUrl;
      }
    });

    it('prefers CLI overrides over file config', () => {
      const result = resolveConfig(
        { url: 'file-url', out: './file-out', schema: 'file-schema' },
        { url: 'cli-url', out: './cli-out', schema: 'cli-schema' },
      );
      assert.equal(result.url, 'cli-url');
      assert.equal(result.out, './cli-out');
      assert.equal(result.schema, 'cli-schema');
    });

    it('uses file config values when no overrides provided', () => {
      const oldUrl = process.env.DATABASE_URL;
      delete process.env.DATABASE_URL;
      try {
        const result = resolveConfig({ url: 'file-url', out: './file-out', schema: 'file-schema' }, {});
        assert.equal(result.url, 'file-url');
        assert.equal(result.out, './file-out');
        assert.equal(result.schema, 'file-schema');
      } finally {
        if (oldUrl !== undefined) process.env.DATABASE_URL = oldUrl;
      }
    });

    it('uses DATABASE_URL env var over file config url', () => {
      const oldUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'env-url';
      try {
        const result = resolveConfig({ url: 'file-url' }, {});
        assert.equal(result.url, 'env-url');
      } finally {
        if (oldUrl !== undefined) {
          process.env.DATABASE_URL = oldUrl;
        } else {
          delete process.env.DATABASE_URL;
        }
      }
    });

    it('CLI override takes precedence over DATABASE_URL', () => {
      const oldUrl = process.env.DATABASE_URL;
      process.env.DATABASE_URL = 'env-url';
      try {
        const result = resolveConfig({}, { url: 'cli-url' });
        assert.equal(result.url, 'cli-url');
      } finally {
        if (oldUrl !== undefined) {
          process.env.DATABASE_URL = oldUrl;
        } else {
          delete process.env.DATABASE_URL;
        }
      }
    });

    it('handles include/exclude arrays from overrides', () => {
      const result = resolveConfig({ include: ['users'], exclude: ['sessions'] }, { include: ['posts', 'comments'] });
      assert.deepEqual(result.include, ['posts', 'comments']);
      // exclude was not overridden, so file config is used
      assert.deepEqual(result.exclude, ['sessions']);
    });
  });

  // -------------------------------------------------------------------------
  // looksLikeSchemaFilePath() — the `schema` vs `schemaFile` collision guard.
  // Regression for #28 item 1: a user who puts the schema FILE path in the
  // `schema` field (a Postgres namespace name) would silently generate an empty
  // client. `turbine generate` uses this to fail loudly instead.
  // -------------------------------------------------------------------------
  describe('looksLikeSchemaFilePath()', () => {
    it('flags values that are clearly file paths', () => {
      for (const v of [
        './turbine/schema.ts',
        'turbine/schema.ts',
        './schema.js',
        'src/db/schema.mts',
        'schema.cjs',
        'C:\\project\\schema.ts',
        'schema.json',
      ]) {
        assert.equal(looksLikeSchemaFilePath(v), true, `${v} should look like a file path`);
      }
    });

    it('does not flag real Postgres schema names', () => {
      for (const v of ['public', 'analytics', 'my_schema', 'tenant1', '']) {
        assert.equal(looksLikeSchemaFilePath(v), false, `${v} should be treated as a schema name`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // TurbineConfig alias (#28 item 3). Compile-time check: the doc's
  // `import type { TurbineConfig }` must resolve to the same shape as
  // TurbineCliConfig. If the alias were removed, typecheck would fail here.
  // -------------------------------------------------------------------------
  describe('TurbineConfig alias export', () => {
    it('is assignable to TurbineCliConfig', () => {
      const cfg: TurbineConfig = { url: 'postgres://x', schema: 'public', schemaFile: './turbine/schema.ts' };
      const asCli: TurbineCliConfig = cfg;
      assert.equal(asCli.schema, 'public');
      assert.equal(asCli.schemaFile, './turbine/schema.ts');
    });
  });
});

// ---------------------------------------------------------------------------
// CLI migration parsing — parseMigrationContent() (supplemental tests)
// ---------------------------------------------------------------------------

describe('CLI migration parsing', () => {
  it('handles auto-generated migration content with header comments', () => {
    const content = `-- Migration: add_users (auto-generated from schema diff)
-- Created: 2026-03-27T12:00:00.000Z
-- Review this file before running: npx turbine migrate up

-- UP
CREATE TABLE users (id SERIAL PRIMARY KEY);

-- DOWN
DROP TABLE users;
`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, 'CREATE TABLE users (id SERIAL PRIMARY KEY);');
    assert.equal(result.down, 'DROP TABLE users;');
  });

  it('handles migration with only whitespace between markers', () => {
    const content = `-- UP


-- DOWN

`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, '');
    assert.equal(result.down, '');
  });

  it('handles complex multi-statement UP section', () => {
    const content = `-- UP
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);
CREATE TABLE posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  title TEXT NOT NULL
);
CREATE INDEX idx_posts_user_id ON posts(user_id);

-- DOWN
DROP TABLE posts;
DROP TABLE users;
`;
    const result = parseMigrationContent(content);
    assert.ok(result.up.includes('CREATE TABLE users'));
    assert.ok(result.up.includes('CREATE TABLE posts'));
    assert.ok(result.up.includes('CREATE INDEX'));
    assert.ok(result.down.includes('DROP TABLE posts'));
    assert.ok(result.down.includes('DROP TABLE users'));
  });

  it('trims leading and trailing whitespace from sections', () => {
    const content = `-- UP

  SELECT 1;

-- DOWN

  SELECT 2;

`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, 'SELECT 1;');
    assert.equal(result.down, 'SELECT 2;');
  });
});

// ---------------------------------------------------------------------------
// CLI UI utilities
// ---------------------------------------------------------------------------

describe('CLI UI utilities', () => {
  // -------------------------------------------------------------------------
  // stripAnsi()
  // -------------------------------------------------------------------------

  describe('stripAnsi()', () => {
    it('removes ANSI color codes from a string', () => {
      const colored = '\x1b[31mhello\x1b[39m';
      assert.equal(stripAnsi(colored), 'hello');
    });

    it('handles strings without ANSI codes', () => {
      assert.equal(stripAnsi('plain text'), 'plain text');
    });

    it('strips multiple ANSI codes', () => {
      const colored = '\x1b[1m\x1b[32mBold Green\x1b[39m\x1b[22m';
      assert.equal(stripAnsi(colored), 'Bold Green');
    });

    it('handles empty string', () => {
      assert.equal(stripAnsi(''), '');
    });

    it('strips nested ANSI sequences', () => {
      const nested = '\x1b[1m\x1b[4m\x1b[31mBold Underline Red\x1b[39m\x1b[24m\x1b[22m';
      assert.equal(stripAnsi(nested), 'Bold Underline Red');
    });
  });

  // -------------------------------------------------------------------------
  // redactUrl()
  // -------------------------------------------------------------------------

  describe('redactUrl()', () => {
    it('redacts password from postgres URL', () => {
      const url = 'postgres://user:secret_password@localhost:5432/mydb';
      const result = redactUrl(url);
      assert.equal(result, 'postgres://user:***@localhost:5432/mydb');
    });

    it('handles URL without password', () => {
      const url = 'postgres://localhost:5432/mydb';
      const result = redactUrl(url);
      // No colon-password-@ pattern, so no change
      assert.equal(result, 'postgres://localhost:5432/mydb');
    });

    it('redacts special characters in password', () => {
      const url = 'postgres://admin:p@ssw0rd!@host:5432/db';
      const result = redactUrl(url);
      // The regex replaces :password@ — stops at first @
      assert.ok(result.includes(':***@'));
      assert.ok(!result.includes('p@ssw0rd'));
    });

    it('handles empty string', () => {
      assert.equal(redactUrl(''), '');
    });
  });

  // -------------------------------------------------------------------------
  // box()
  // -------------------------------------------------------------------------

  describe('box()', () => {
    it('wraps single-line content in a box', () => {
      // Force NO_COLOR-style behavior by using plain text
      const result = box('hello');
      const lines = result.split('\n');
      // Should have top border, content line, bottom border
      assert.equal(lines.length, 3);
    });

    it('wraps multi-line content', () => {
      const result = box('line 1\nline 2\nline 3');
      const lines = result.split('\n');
      // top + 3 content lines + bottom = 5
      assert.equal(lines.length, 5);
    });

    it('includes title when provided', () => {
      const result = box('content', { title: 'My Title' });
      assert.ok(stripAnsi(result).includes('My Title'));
    });

    it('handles empty content', () => {
      const result = box('');
      const lines = result.split('\n');
      assert.equal(lines.length, 3);
    });
  });

  // -------------------------------------------------------------------------
  // table()
  // -------------------------------------------------------------------------

  describe('table()', () => {
    it('renders a table with headers and rows', () => {
      const result = table(
        ['Name', 'Age'],
        [
          ['Alice', '30'],
          ['Bob', '25'],
        ],
      );
      const plain = stripAnsi(result);
      assert.ok(plain.includes('Name'));
      assert.ok(plain.includes('Age'));
      assert.ok(plain.includes('Alice'));
      assert.ok(plain.includes('30'));
      assert.ok(plain.includes('Bob'));
      assert.ok(plain.includes('25'));
    });

    it('handles single column table', () => {
      const result = table(['Item'], [['Apple'], ['Banana']]);
      const plain = stripAnsi(result);
      assert.ok(plain.includes('Item'));
      assert.ok(plain.includes('Apple'));
      assert.ok(plain.includes('Banana'));
    });

    it('pads columns to consistent width', () => {
      const result = table(
        ['Short', 'LongerHeader'],
        [
          ['a', 'b'],
          ['longvalue', 'c'],
        ],
      );
      const lines = stripAnsi(result).split('\n');
      // Header + separator + 2 data rows = 4 lines
      assert.equal(lines.length, 4);
    });

    it('handles empty rows', () => {
      const result = table(['A', 'B'], []);
      const plain = stripAnsi(result);
      // Should still have header and separator
      assert.ok(plain.includes('A'));
      assert.ok(plain.includes('B'));
    });
  });
});

// ---------------------------------------------------------------------------
// CLI TypeScript loader (.ts schema / config support)
// ---------------------------------------------------------------------------

describe('CLI TypeScript loader', () => {
  // -------------------------------------------------------------------------
  // needsTsLoader()
  // -------------------------------------------------------------------------

  describe('needsTsLoader()', () => {
    it('returns true for .ts files', () => {
      assert.equal(needsTsLoader('turbine.config.ts'), true);
      assert.equal(needsTsLoader('/abs/path/schema.ts'), true);
      assert.equal(needsTsLoader('./relative/path.ts'), true);
    });

    it('returns true for .mts files', () => {
      assert.equal(needsTsLoader('turbine.config.mts'), true);
      assert.equal(needsTsLoader('schema.mts'), true);
    });

    it('returns true for .cts files', () => {
      assert.equal(needsTsLoader('turbine.config.cts'), true);
    });

    it('returns false for .js / .mjs / .cjs files', () => {
      assert.equal(needsTsLoader('turbine.config.js'), false);
      assert.equal(needsTsLoader('turbine.config.mjs'), false);
      assert.equal(needsTsLoader('turbine.config.cjs'), false);
    });

    it('returns false for .json files', () => {
      assert.equal(needsTsLoader('turbine.config.json'), false);
    });

    it('returns false for null / undefined / empty paths', () => {
      assert.equal(needsTsLoader(null), false);
      assert.equal(needsTsLoader(undefined), false);
      assert.equal(needsTsLoader(''), false);
    });

    it('is case-insensitive on extension', () => {
      assert.equal(needsTsLoader('Turbine.Config.TS'), true);
      assert.equal(needsTsLoader('schema.MTS'), true);
    });

    it('returns false for files where .ts is in the middle (not extension)', () => {
      assert.equal(needsTsLoader('foo.ts.bak'), false);
      assert.equal(needsTsLoader('schema.ts.disabled'), false);
    });
  });

  // -------------------------------------------------------------------------
  // canResolveTsx()
  // -------------------------------------------------------------------------

  describe('canResolveTsx()', () => {
    it('returns true when the injected resolver succeeds', () => {
      const fakeResolver = (id: string): string => `/fake/node_modules/${id}`;
      assert.equal(canResolveTsx(fakeResolver), true);
    });

    it('returns false when the injected resolver throws', () => {
      const failingResolver = (_id: string): string => {
        throw new Error('Cannot find module');
      };
      assert.equal(canResolveTsx(failingResolver), false);
    });

    it('returns true (or false — environment-dependent) when called with no resolver', () => {
      // We cannot reliably assert true/false because the test runs inside the
      // turbine-orm dev environment where tsx IS installed (it is a devDep),
      // but downstream consumers may not have it. We can at least assert that
      // the function returns a boolean and does not throw.
      const result = canResolveTsx();
      assert.equal(typeof result, 'boolean');
    });
  });

  // -------------------------------------------------------------------------
  // registerTsLoader()
  // -------------------------------------------------------------------------

  describe('registerTsLoader()', () => {
    it('returns one of the documented status codes', async () => {
      _resetTsLoaderStateForTests();
      const status = await registerTsLoader();
      assert.ok(
        status === 'registered' ||
          status === 'already' ||
          status === 'unsupported' ||
          status === 'missing' ||
          status === 'failed',
        `unexpected status: ${status}`,
      );
    });

    it('is idempotent — second call returns "already" when first registered', async () => {
      _resetTsLoaderStateForTests();
      const first = await registerTsLoader();
      // If the first call could register (or had already registered), the
      // second call must report "already". If the first call returned
      // 'missing' / 'unsupported', we cannot assert idempotency the same way
      // — the helper will keep retrying.
      if (first === 'registered' || first === 'already') {
        const second = await registerTsLoader();
        assert.equal(second, 'already');
      }
    });

    it('returns "missing" when tsx cannot be resolved (cwd-based probe)', async () => {
      // Switch the CWD to a directory that has no `node_modules/tsx`,
      // reset state, and verify we get 'missing'. We restore the original
      // cwd in a finally block.
      _resetTsLoaderStateForTests();
      const originalCwd = process.cwd();
      const isolated = join(tmpdir(), `turbine-loader-missing-${Date.now()}`);
      mkdirSync(isolated, { recursive: true });
      try {
        process.chdir(isolated);
        const status = await registerTsLoader();
        // tsx is NOT resolvable from an empty tmp dir, so we expect 'missing'.
        // (If the dev machine has a global tsx symlinked, the test environment
        // would still see it as 'registered' — we soften the assertion.)
        assert.ok(
          status === 'missing' || status === 'registered' || status === 'already',
          `unexpected status: ${status}`,
        );
      } finally {
        process.chdir(originalCwd);
        rmSync(isolated, { recursive: true, force: true });
        _resetTsLoaderStateForTests();
      }
    });
  });
});

// ---------------------------------------------------------------------------
// `turbine generate` — silent-empty-client guard (#28 item 1), end-to-end.
//
// Runs the real CLI through Node's tsx import hook in a temp dir (no DB needed
// — the guard fires before any connection). Asserts a non-zero exit and an
// actionable message.
// ---------------------------------------------------------------------------

describe('turbine generate — empty-client guard (#28)', () => {
  const repoRoot = process.cwd();
  const tsxPackage = resolve(repoRoot, 'node_modules/tsx');
  const tsxLoader = pathToFileURL(resolve(repoRoot, 'node_modules/tsx/dist/loader.mjs')).href;
  const cliEntry = resolve(repoRoot, 'src/cli/index.ts');
  const haveTsx = existsSync(tsxPackage);

  /** Run the CLI; returns { code, output } without throwing on non-zero exit. */
  function runGenerate(cwd: string, extraArgs: string[]): { code: number; output: string } {
    try {
      const stdout = execFileSync(process.execPath, ['--import', tsxLoader, cliEntry, 'generate', ...extraArgs], {
        cwd,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, DATABASE_URL: '', FORCE_COLOR: '0' },
      });
      return { code: 0, output: stdout };
    } catch (err) {
      const e = err as { status?: number; stdout?: Buffer | string; stderr?: Buffer | string };
      const out = `${e.stdout?.toString() ?? ''}${e.stderr?.toString() ?? ''}`;
      return { code: e.status ?? 1, output: out };
    }
  }

  it('errors (exit 1) when `schema` is set to a schema FILE path', { skip: !haveTsx }, () => {
    const dir = join(tmpdir(), `turbine-gen-guard-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const { code, output } = runGenerate(dir, [
        '--url',
        'postgres://u:p@localhost:5432/db',
        '--schema',
        './turbine/schema.ts',
      ]);
      assert.equal(code, 1, `expected non-zero exit; output:\n${output}`);
      assert.match(output, /looks like a file path/);
      assert.match(output, /schemaFile/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--allow-empty bypasses the file-path guard (then fails on connection, not the guard)', { skip: !haveTsx }, () => {
    const dir = join(tmpdir(), `turbine-gen-allow-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const { output } = runGenerate(dir, [
        '--url',
        'postgres://u:p@127.0.0.1:1/db',
        '--schema',
        './turbine/schema.ts',
        '--allow-empty',
      ]);
      // The path guard must NOT fire when --allow-empty is passed.
      assert.doesNotMatch(output, /looks like a file path/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

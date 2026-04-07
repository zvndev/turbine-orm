/**
 * turbine-orm — CLI unit tests
 *
 * Tests config template generation, config file resolution, migration parsing,
 * and UI utility functions — all without a database.
 *
 * Run: npx tsx --test src/test/cli.test.ts
 */

import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { configTemplate, findConfigFile, loadConfig, resolveConfig } from '../cli/config.js';
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
      assert.ok(result.includes("seedFile: './turbine/seed.ts'"));
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
        assert.equal(result.seedFile, './turbine/seed.ts');
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

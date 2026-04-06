/**
 * turbine-orm — Migration system unit tests
 *
 * Tests parseMigrationContent(), sanitizeName(), formatTimestamp(),
 * parseMigrationFilename(), listMigrationFiles(), createMigration(),
 * and getPendingMigrations() — all without a database.
 *
 * Run: node --test --experimental-strip-types src/test/migrate.test.ts
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  createMigration,
  formatTimestamp,
  getPendingMigrations,
  listMigrationFiles,
  parseMigrationContent,
  parseMigrationFilename,
  sanitizeName,
} from '../cli/migrate.js';

// ---------------------------------------------------------------------------
// parseMigrationContent
// ---------------------------------------------------------------------------

describe('parseMigrationContent', () => {
  it('parses basic UP and DOWN sections', () => {
    const content = `-- UP
CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);

-- DOWN
DROP TABLE users;
`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, 'CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT);');
    assert.equal(result.down, 'DROP TABLE users;');
  });

  it('handles multi-line SQL in each section', () => {
    const content = `-- UP
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_users_email ON users (email);

-- DOWN
DROP INDEX idx_users_email;
DROP TABLE users;
`;
    const result = parseMigrationContent(content);
    assert.ok(result.up.includes('CREATE TABLE users'));
    assert.ok(result.up.includes('CREATE INDEX idx_users_email'));
    assert.ok(result.down.includes('DROP INDEX idx_users_email'));
    assert.ok(result.down.includes('DROP TABLE users'));
  });

  it('ignores content before -- UP marker', () => {
    const content = `-- Migration: add_users
-- Created: 2026-03-27T12:00:00.000Z

-- UP
CREATE TABLE users (id SERIAL);

-- DOWN
DROP TABLE users;
`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, 'CREATE TABLE users (id SERIAL);');
    assert.equal(result.down, 'DROP TABLE users;');
  });

  it('returns empty strings when markers are missing', () => {
    const content = `CREATE TABLE users (id SERIAL);`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, '');
    assert.equal(result.down, '');
  });

  it('returns empty down when only UP is present', () => {
    const content = `-- UP
CREATE TABLE users (id SERIAL);
`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, 'CREATE TABLE users (id SERIAL);');
    assert.equal(result.down, '');
  });

  it('returns empty up when only DOWN is present', () => {
    const content = `-- DOWN
DROP TABLE users;
`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, '');
    assert.equal(result.down, 'DROP TABLE users;');
  });

  it('handles -- UP and -- DOWN with varying whitespace', () => {
    const content = `  -- UP
SELECT 1;
  -- DOWN
SELECT 2;
`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, 'SELECT 1;');
    assert.equal(result.down, 'SELECT 2;');
  });

  it('is case-insensitive for markers', () => {
    const content = `-- up
SELECT 1;
-- down
SELECT 2;
`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, 'SELECT 1;');
    assert.equal(result.down, 'SELECT 2;');
  });

  it('handles empty migration (just markers)', () => {
    const content = `-- UP
-- DOWN
`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, '');
    assert.equal(result.down, '');
  });

  it('handles comments within sections', () => {
    const content = `-- UP
-- This creates the users table
CREATE TABLE users (id SERIAL);

-- DOWN
-- This drops the users table
DROP TABLE users;
`;
    const result = parseMigrationContent(content);
    assert.ok(result.up.includes('-- This creates the users table'));
    assert.ok(result.up.includes('CREATE TABLE users'));
    assert.ok(result.down.includes('-- This drops the users table'));
    assert.ok(result.down.includes('DROP TABLE users'));
  });
});

// ---------------------------------------------------------------------------
// sanitizeName
// ---------------------------------------------------------------------------

describe('sanitizeName', () => {
  it('lowercases the name', () => {
    assert.equal(sanitizeName('AddUsersTable'), 'adduserstable');
  });

  it('replaces spaces with underscores', () => {
    assert.equal(sanitizeName('add users table'), 'add_users_table');
  });

  it('replaces special characters with underscores', () => {
    assert.equal(sanitizeName('add-users-table!'), 'add_users_table');
  });

  it('collapses multiple underscores', () => {
    assert.equal(sanitizeName('add___users___table'), 'add_users_table');
  });

  it('trims leading and trailing underscores', () => {
    assert.equal(sanitizeName('_add_users_'), 'add_users');
  });

  it('handles mixed special characters', () => {
    assert.equal(sanitizeName('Add Users & Posts!!!'), 'add_users_posts');
  });

  it('preserves numbers', () => {
    assert.equal(sanitizeName('add_v2_users'), 'add_v2_users');
  });

  it('handles already-clean names', () => {
    assert.equal(sanitizeName('create_posts'), 'create_posts');
  });

  it('handles single character names', () => {
    assert.equal(sanitizeName('x'), 'x');
  });

  it('handles all-special-chars input', () => {
    assert.equal(sanitizeName('---'), '');
  });
});

// ---------------------------------------------------------------------------
// formatTimestamp
// ---------------------------------------------------------------------------

describe('formatTimestamp', () => {
  it('formats a date as YYYYMMDDHHMMSS', () => {
    const date = new Date('2026-03-27T14:05:09.000Z');
    const result = formatTimestamp(date);
    // Note: result depends on timezone, so we just check format
    assert.match(result, /^\d{14}$/);
  });

  it('pads single-digit months and days', () => {
    // Use a specific UTC date and check via the Date constructor
    const date = new Date(2026, 0, 5, 3, 7, 2); // Jan 5, 03:07:02 local time
    const result = formatTimestamp(date);
    assert.match(result, /^\d{14}$/);
    // Year should be 2026
    assert.equal(result.substring(0, 4), '2026');
    // Month should be 01
    assert.equal(result.substring(4, 6), '01');
    // Day should be 05
    assert.equal(result.substring(6, 8), '05');
    // Hours should be 03
    assert.equal(result.substring(8, 10), '03');
    // Minutes should be 07
    assert.equal(result.substring(10, 12), '07');
    // Seconds should be 02
    assert.equal(result.substring(12, 14), '02');
  });

  it('returns 14-character string', () => {
    const result = formatTimestamp(new Date());
    assert.equal(result.length, 14);
  });
});

// ---------------------------------------------------------------------------
// parseMigrationFilename
// ---------------------------------------------------------------------------

describe('parseMigrationFilename', () => {
  it('parses valid YYYYMMDDHHMMSS_name.sql filename', () => {
    const result = parseMigrationFilename('20260327140500_create_users.sql');
    assert.ok(result);
    assert.equal(result.filename, '20260327140500_create_users.sql');
    assert.equal(result.name, '20260327140500_create_users');
    assert.equal(result.timestamp, '20260327140500');
  });

  it('returns null for non-matching filenames', () => {
    assert.equal(parseMigrationFilename('not_a_migration.sql'), null);
    assert.equal(parseMigrationFilename('readme.md'), null);
    assert.equal(parseMigrationFilename('.gitkeep'), null);
  });

  it('returns null for old-style YYYYMMDD_NNN_name.sql format', () => {
    // Old format had 8-digit date + 3-digit sequence = 11 digits before underscore
    assert.equal(parseMigrationFilename('20260327_001_create_users.sql'), null);
  });

  it('returns null for files without .sql extension', () => {
    assert.equal(parseMigrationFilename('20260327140500_create_users.txt'), null);
  });

  it('handles names with multiple underscores', () => {
    const result = parseMigrationFilename('20260327140500_add_user_email_index.sql');
    assert.ok(result);
    assert.equal(result.name, '20260327140500_add_user_email_index');
  });

  it('sets path to empty string (caller sets it)', () => {
    const result = parseMigrationFilename('20260327140500_test.sql');
    assert.ok(result);
    assert.equal(result.path, '');
  });
});

// ---------------------------------------------------------------------------
// listMigrationFiles (filesystem tests)
// ---------------------------------------------------------------------------

describe('listMigrationFiles', () => {
  const testDir = join(tmpdir(), `turbine-test-migrations-${Date.now()}`);

  before(() => {
    mkdirSync(testDir, { recursive: true });
    // Create test migration files (out of order to test sorting)
    writeFileSync(join(testDir, '20260327140500_create_users.sql'), '-- UP\n-- DOWN\n');
    writeFileSync(join(testDir, '20260327140600_create_posts.sql'), '-- UP\n-- DOWN\n');
    writeFileSync(join(testDir, '20260326100000_init.sql'), '-- UP\n-- DOWN\n');
    // Non-migration files that should be ignored
    writeFileSync(join(testDir, '.gitkeep'), '');
    writeFileSync(join(testDir, 'readme.md'), '# Migrations');
    writeFileSync(join(testDir, 'not_matching.sql'), 'SELECT 1;');
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns migration files sorted by name (timestamp order)', () => {
    const files = listMigrationFiles(testDir);
    assert.equal(files.length, 3);
    assert.equal(files[0]!.filename, '20260326100000_init.sql');
    assert.equal(files[1]!.filename, '20260327140500_create_users.sql');
    assert.equal(files[2]!.filename, '20260327140600_create_posts.sql');
  });

  it('sets absolute path for each file', () => {
    const files = listMigrationFiles(testDir);
    for (const file of files) {
      assert.ok(file.path.startsWith(testDir));
      assert.ok(file.path.endsWith('.sql'));
    }
  });

  it('ignores non-migration files', () => {
    const files = listMigrationFiles(testDir);
    const filenames = files.map((f) => f.filename);
    assert.ok(!filenames.includes('.gitkeep'));
    assert.ok(!filenames.includes('readme.md'));
    assert.ok(!filenames.includes('not_matching.sql'));
  });

  it('returns empty array for non-existent directory', () => {
    const files = listMigrationFiles('/tmp/does_not_exist_turbine_test');
    assert.deepEqual(files, []);
  });

  it('returns empty array for empty directory', () => {
    const emptyDir = join(tmpdir(), `turbine-test-empty-${Date.now()}`);
    mkdirSync(emptyDir, { recursive: true });
    const files = listMigrationFiles(emptyDir);
    assert.deepEqual(files, []);
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// getPendingMigrations (filesystem tests)
// ---------------------------------------------------------------------------

describe('getPendingMigrations', () => {
  const testDir = join(tmpdir(), `turbine-test-pending-${Date.now()}`);

  before(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, '20260326100000_init.sql'), '-- UP\n-- DOWN\n');
    writeFileSync(join(testDir, '20260327140500_create_users.sql'), '-- UP\n-- DOWN\n');
    writeFileSync(join(testDir, '20260327140600_create_posts.sql'), '-- UP\n-- DOWN\n');
  });

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns all files when none are applied', () => {
    const pending = getPendingMigrations(testDir, []);
    assert.equal(pending.length, 3);
  });

  it('excludes applied migrations', () => {
    const applied = ['20260326100000_init'];
    const pending = getPendingMigrations(testDir, applied);
    assert.equal(pending.length, 2);
    assert.equal(pending[0]!.name, '20260327140500_create_users');
    assert.equal(pending[1]!.name, '20260327140600_create_posts');
  });

  it('returns empty when all are applied', () => {
    const applied = ['20260326100000_init', '20260327140500_create_users', '20260327140600_create_posts'];
    const pending = getPendingMigrations(testDir, applied);
    assert.equal(pending.length, 0);
  });

  it('returns files in timestamp order', () => {
    const pending = getPendingMigrations(testDir, []);
    assert.equal(pending[0]!.timestamp, '20260326100000');
    assert.equal(pending[1]!.timestamp, '20260327140500');
    assert.equal(pending[2]!.timestamp, '20260327140600');
  });
});

// ---------------------------------------------------------------------------
// createMigration (filesystem tests)
// ---------------------------------------------------------------------------

describe('createMigration', () => {
  const testDir = join(tmpdir(), `turbine-test-create-${Date.now()}`);

  after(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('creates a migration file with correct naming', () => {
    const result = createMigration(testDir, 'add users table');
    assert.ok(existsSync(result.path));
    assert.match(result.filename, /^\d{14}_add_users_table\.sql$/);
    assert.equal(result.timestamp.length, 14);
  });

  it('sanitizes the migration name in the filename', () => {
    const result = createMigration(testDir, 'Add Posts & Comments!!!');
    assert.match(result.filename, /^\d{14}_add_posts_comments\.sql$/);
  });

  it('includes Migration header and Created date in file content', () => {
    const result = createMigration(testDir, 'test headers');
    const content = readFileSync(result.path, 'utf-8');
    assert.ok(content.includes('-- Migration: test headers'));
    assert.ok(content.includes('-- Created:'));
    assert.ok(content.includes('-- UP'));
    assert.ok(content.includes('-- DOWN'));
  });

  it('creates the migrations directory if it does not exist', () => {
    const newDir = join(testDir, 'nested', 'migrations');
    const result = createMigration(newDir, 'init');
    assert.ok(existsSync(newDir));
    assert.ok(existsSync(result.path));
  });

  it('produces parseable migration file content', () => {
    const result = createMigration(testDir, 'parseable test');
    const content = readFileSync(result.path, 'utf-8');
    const parsed = parseMigrationContent(content);
    // Template has comment placeholders, so UP section should have the comment
    assert.ok(parsed.up.includes('Write your migration SQL here'));
    assert.ok(parsed.down.includes('Write your rollback SQL here'));
  });

  it('file is detectable by listMigrationFiles', () => {
    const isolatedDir = join(testDir, 'isolated');
    createMigration(isolatedDir, 'detectable');
    const files = listMigrationFiles(isolatedDir);
    assert.equal(files.length, 1);
    assert.ok(files[0]!.filename.includes('detectable'));
  });
});

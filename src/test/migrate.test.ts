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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  type AppliedMigration,
  canUpgradeLegacyChecksum,
  createMigration,
  formatTimestamp,
  getPendingMigrations,
  isChecksumValid,
  listMigrationFiles,
  type MigrationTxClient,
  parseMigrationContent,
  parseMigrationFilename,
  planMigrationDeploy,
  runMigrationInTransaction,
  sanitizeName,
  splitSqlStatements,
  validateChecksums,
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
// parseMigrationContent - no-transaction directive
// ---------------------------------------------------------------------------

describe('parseMigrationContent - no-transaction directive', () => {
  it('defaults noTransaction to false', () => {
    const result = parseMigrationContent('-- UP\nCREATE TABLE t (id int);\n-- DOWN\nDROP TABLE t;');
    assert.equal(result.noTransaction, false);
  });

  it('detects the directive in the header before -- UP', () => {
    const content = `-- Migration: add index
-- turbine:no-transaction

-- UP
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_t_x ON t (x);

-- DOWN
DROP INDEX CONCURRENTLY IF EXISTS idx_t_x;`;
    const result = parseMigrationContent(content);
    assert.equal(result.noTransaction, true);
    assert.ok(result.up.includes('CREATE INDEX CONCURRENTLY'));
    // The directive line itself is not part of the UP body.
    assert.ok(!result.up.includes('turbine:no-transaction'));
  });

  it('is case-insensitive and tolerant of spacing', () => {
    const result = parseMigrationContent('--   TURBINE:NO-TRANSACTION\n-- UP\nSELECT 1;');
    assert.equal(result.noTransaction, true);
  });

  it('does NOT honor the directive when it appears in the DOWN section', () => {
    const content = `-- UP
SELECT 1;
-- DOWN
-- turbine:no-transaction
SELECT 2;`;
    const result = parseMigrationContent(content);
    assert.equal(result.noTransaction, false);
  });
});

// ---------------------------------------------------------------------------
// splitSqlStatements - the no-transaction tokenizer (production-destroying if wrong)
// ---------------------------------------------------------------------------

describe('splitSqlStatements', () => {
  it('splits simple statements on semicolons', () => {
    assert.deepEqual(splitSqlStatements('SELECT 1; SELECT 2;'), ['SELECT 1', 'SELECT 2']);
  });

  it('trims and drops empty fragments and a missing trailing semicolon', () => {
    assert.deepEqual(splitSqlStatements('  SELECT 1 ;;;  SELECT 2  '), ['SELECT 1', 'SELECT 2']);
  });

  it('keeps a semicolon inside a single-quoted string', () => {
    assert.deepEqual(splitSqlStatements(`INSERT INTO t VALUES ('a;b'); SELECT 1;`), [
      `INSERT INTO t VALUES ('a;b')`,
      'SELECT 1',
    ]);
  });

  it('handles a doubled single quote (escaped) inside a string', () => {
    assert.deepEqual(splitSqlStatements(`SELECT 'it''s; fine'; SELECT 2;`), [`SELECT 'it''s; fine'`, 'SELECT 2']);
  });

  it('keeps a semicolon inside a double-quoted identifier', () => {
    assert.deepEqual(splitSqlStatements(`CREATE INDEX ON t ("we;ird"); SELECT 1;`), [
      `CREATE INDEX ON t ("we;ird")`,
      'SELECT 1',
    ]);
  });

  it('keeps a semicolon inside a dollar-quoted body', () => {
    const sql = `CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 2;`;
    assert.deepEqual(splitSqlStatements(sql), [
      `CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql`,
      'SELECT 2',
    ]);
  });

  it('keeps a semicolon inside a tagged dollar-quoted body', () => {
    const sql = `SELECT $tag$ a; b $tag$; SELECT 2;`;
    assert.deepEqual(splitSqlStatements(sql), [`SELECT $tag$ a; b $tag$`, 'SELECT 2']);
  });

  it('does not mistake a $1 parameter placeholder for a dollar quote', () => {
    assert.deepEqual(splitSqlStatements('UPDATE t SET x = $1 WHERE id = $2; SELECT 3;'), [
      'UPDATE t SET x = $1 WHERE id = $2',
      'SELECT 3',
    ]);
  });

  it('keeps a semicolon inside a line comment', () => {
    const sql = `SELECT 1; -- a comment; with a semicolon\nSELECT 2;`;
    assert.deepEqual(splitSqlStatements(sql), ['SELECT 1', '-- a comment; with a semicolon\nSELECT 2']);
  });

  it('keeps a semicolon inside a block comment (and nests)', () => {
    const sql = `SELECT 1; /* outer; /* inner; */ still; */ SELECT 2;`;
    assert.deepEqual(splitSqlStatements(sql), ['SELECT 1', '/* outer; /* inner; */ still; */ SELECT 2']);
  });

  it('drops a comment-only fragment', () => {
    assert.deepEqual(splitSqlStatements('-- just a note\n; SELECT 1;'), ['SELECT 1']);
    assert.deepEqual(splitSqlStatements('/* only a block comment */'), []);
  });

  it('splits multiple CREATE INDEX CONCURRENTLY statements', () => {
    const sql = `CREATE INDEX CONCURRENTLY IF NOT EXISTS a ON t (x);\nCREATE INDEX CONCURRENTLY IF NOT EXISTS b ON t (y);`;
    const out = splitSqlStatements(sql);
    assert.equal(out.length, 2);
    assert.ok(out[0]!.includes('a ON t (x)'));
    assert.ok(out[1]!.includes('b ON t (y)'));
  });

  // E-strings (E'...') treat a backslash as an escape character. Closing such a
  // string on the `\'` merges the following statements into one, which Postgres
  // then runs as an implicit transaction: fatal for a no-transaction migration.
  it('keeps an escaped quote inside an E-string from ending the string', () => {
    const sql = `UPDATE a SET x = E'p\\'q';\nUPDATE b SET y = E'r\\'s';\nDROP TABLE c;`;
    assert.deepEqual(splitSqlStatements(sql), [
      `UPDATE a SET x = E'p\\'q'`,
      `UPDATE b SET y = E'r\\'s'`,
      'DROP TABLE c',
    ]);
  });

  it('keeps a semicolon inside an E-string', () => {
    assert.deepEqual(splitSqlStatements(`INSERT INTO t VALUES (E'a;b\\'c'); SELECT 1;`), [
      `INSERT INTO t VALUES (E'a;b\\'c')`,
      'SELECT 1',
    ]);
  });

  it('handles a lowercase e prefix', () => {
    assert.deepEqual(splitSqlStatements(`SELECT e'x\\';y'; SELECT 2;`), [`SELECT e'x\\';y'`, 'SELECT 2']);
  });

  it('mixes E-strings and ordinary strings in one script', () => {
    const sql = `INSERT INTO t VALUES ('plain;one', E'esc\\';two'); SELECT 'three;';`;
    assert.deepEqual(splitSqlStatements(sql), [`INSERT INTO t VALUES ('plain;one', E'esc\\';two')`, `SELECT 'three;'`]);
  });

  it('handles a doubled quote inside an E-string', () => {
    assert.deepEqual(splitSqlStatements(`SELECT E'it''s; fine'; SELECT 2;`), [`SELECT E'it''s; fine'`, 'SELECT 2']);
  });

  it('handles an escaped backslash at the end of an E-string', () => {
    assert.deepEqual(splitSqlStatements(`SELECT E'path\\\\'; SELECT 2;`), [`SELECT E'path\\\\'`, 'SELECT 2']);
  });

  it('does not treat a backslash as an escape in an ordinary string', () => {
    // standard_conforming_strings = on: 'a\' is a COMPLETE string, so the
    // statement ends at the following semicolon.
    assert.deepEqual(splitSqlStatements(`SELECT 'a\\'; SELECT 2;`), [`SELECT 'a\\'`, 'SELECT 2']);
  });

  it('does not treat an identifier ending in e as an E-string prefix', () => {
    assert.deepEqual(splitSqlStatements(`SELECT * FROM t WHERE code='a\\'; SELECT 2;`), [
      `SELECT * FROM t WHERE code='a\\'`,
      'SELECT 2',
    ]);
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

// ---------------------------------------------------------------------------
// Legacy checksum auto-upgrade
// ---------------------------------------------------------------------------

/** The pre-v0.6 checksum algorithm, reimplemented here as the contract. */
function legacyHash(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    hash = ((hash << 5) - hash + content.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

describe('legacy checksum auto-upgrade', () => {
  const dir = join(tmpdir(), `turbine-legacy-checksum-${Date.now()}`);
  const NAME = '20260101000000_create_users';
  const CONTENT = '-- UP\nCREATE TABLE users (id SERIAL PRIMARY KEY);\n\n-- DOWN\nDROP TABLE users;\n';

  before(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${NAME}.sql`), CONTENT, 'utf-8');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const appliedWith = (checksum: string): AppliedMigration[] => [
    { id: 1, name: NAME, applied_at: new Date(), checksum },
  ];

  it('upgrades a legacy row whose file content is unchanged', () => {
    assert.equal(canUpgradeLegacyChecksum(legacyHash(CONTENT), CONTENT), true);
    const plan = planMigrationDeploy(dir, appliedWith(legacyHash(CONTENT)));
    assert.deepEqual(plan.mismatches, []);
  });

  it('refuses to bless a legacy row whose file content CHANGED', () => {
    // A legacy hash of some OTHER content: the stored value can no longer be
    // reproduced from the file, so this is genuine drift, not a hash upgrade.
    const stale = legacyHash(`${CONTENT}-- ALTER TABLE users ADD COLUMN email TEXT;\n`);
    assert.equal(canUpgradeLegacyChecksum(stale, CONTENT), false);
    const plan = planMigrationDeploy(dir, appliedWith(stale));
    assert.equal(plan.mismatches.length, 1);
    assert.equal(plan.mismatches[0]!.type, 'modified');
    assert.equal(plan.mismatches[0]!.name, NAME);
  });

  it('reports an unchanged legacy row as valid, a drifted one as invalid', () => {
    const sha = createHash('sha256').update(CONTENT, 'utf-8').digest('hex');

    // What `migrate status` asks. A current SHA-256 row is valid.
    assert.equal(isChecksumValid(sha, CONTENT), true);
    // An unchanged pre-v0.6 row is valid too: `migrate up` upgrades it in place,
    // so status must not contradict up by calling the same file drifted.
    assert.equal(isChecksumValid(legacyHash(CONTENT), CONTENT), true);

    // Genuine drift still reports invalid, in both hash generations.
    const changed = `${CONTENT}-- ALTER TABLE users ADD COLUMN email TEXT;\n`;
    assert.equal(isChecksumValid(sha, changed), false);
    assert.equal(isChecksumValid(legacyHash(changed), CONTENT), false);
    assert.equal(isChecksumValid('', CONTENT), false);
  });

  it('never treats an empty stored checksum as legacy', () => {
    assert.equal(canUpgradeLegacyChecksum('', CONTENT), false);
    const plan = planMigrationDeploy(dir, appliedWith(''));
    assert.equal(plan.mismatches.length, 1);
    assert.equal(plan.mismatches[0]!.type, 'modified');
  });

  /**
   * A stand-in for the `pg.Client` validateChecksums() runs against: serves the
   * applied rows and records every statement so the test can prove whether the
   * checksum-upgrade UPDATE was issued.
   */
  function fakeChecksumClient(applied: AppliedMigration[]) {
    const statements: string[] = [];
    const client = {
      async query(sql: string): Promise<unknown> {
        statements.push(sql);
        return { rows: /select/i.test(sql) ? applied : [] };
      },
    };
    return { statements, client: client as unknown as Parameters<typeof validateChecksums>[0] };
  }

  it('validateChecksums() rewrites the stored hash only for an unchanged legacy row', async () => {
    const fake = fakeChecksumClient(appliedWith(legacyHash(CONTENT)));
    const mismatches = await validateChecksums(fake.client, dir);
    assert.deepEqual(mismatches, []);
    assert.ok(
      fake.statements.some((s) => /update/i.test(s)),
      'an unchanged legacy row should be upgraded to SHA-256',
    );
  });

  it('validateChecksums() flags a changed legacy row instead of blessing it', async () => {
    const stale = legacyHash(`${CONTENT}-- drifted\n`);
    const fake = fakeChecksumClient(appliedWith(stale));
    const mismatches = await validateChecksums(fake.client, dir);
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0]!.type, 'modified');
    assert.ok(
      !fake.statements.some((s) => /update/i.test(s)),
      'a drifted legacy row must never have its stored checksum rewritten',
    );
  });

  it('leaves a matching SHA-256 row alone', () => {
    const sha = createHash('sha256').update(CONTENT, 'utf-8').digest('hex');
    const plan = planMigrationDeploy(dir, appliedWith(sha));
    assert.deepEqual(plan.mismatches, []);
  });
});

// ---------------------------------------------------------------------------
// Transactional migration body
// ---------------------------------------------------------------------------

/** A fake client that fails the statements named in `failOn`. */
function fakeClient(failOn: Record<string, string>): MigrationTxClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async query(sql: string): Promise<unknown> {
      calls.push(sql);
      const failure = failOn[sql];
      if (failure) throw new Error(failure);
      return { rows: [] };
    },
  };
}

describe('runMigrationInTransaction', () => {
  const tracking = { sql: 'INSERT INTO _turbine_migrations', params: ['m1', 'hash'] };

  it('commits and reports no failure on success', async () => {
    const client = fakeClient({});
    const failure = await runMigrationInTransaction(client, 'CREATE TABLE t (id INT)', tracking);
    assert.equal(failure, null);
    assert.deepEqual(client.calls, ['BEGIN', 'CREATE TABLE t (id INT)', 'INSERT INTO _turbine_migrations', 'COMMIT']);
  });

  it('rolls back and reports the statement error', async () => {
    const client = fakeClient({ 'CREATE TABLE t (id INT)': 'syntax error at or near "TABLE"' });
    const failure = await runMigrationInTransaction(client, 'CREATE TABLE t (id INT)', tracking);
    assert.match(failure ?? '', /syntax error/);
    assert.ok(client.calls.includes('ROLLBACK'));
  });

  it('surfaces the ORIGINAL error when the ROLLBACK also fails', async () => {
    const client = fakeClient({
      'CREATE TABLE t (id INT)': 'relation "t" already exists',
      ROLLBACK: 'Connection terminated unexpectedly',
    });
    const failure = await runMigrationInTransaction(client, 'CREATE TABLE t (id INT)', tracking);
    assert.match(failure ?? '', /relation "t" already exists/);
    assert.doesNotMatch(failure ?? '', /Connection terminated/);
  });
});

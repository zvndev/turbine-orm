/**
 * turbine-orm, Migration system unit tests
 *
 * Tests parseMigrationContent(), sanitizeName(), formatTimestamp(),
 * parseMigrationFilename(), listMigrationFiles(), createMigration(),
 * and getPendingMigrations(), all without a database.
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
  assertNoEmbeddedTransactions,
  canUpgradeLegacyChecksum,
  createMigration,
  findTransactionControlStatements,
  formatTimestamp,
  getPendingMigrations,
  headerSafeName,
  isChecksumValid,
  listMigrationFiles,
  type MigrationFile,
  type MigrationTxClient,
  parseMigrationContent,
  parseMigrationFilename,
  planMigrationDeploy,
  rollbackMigrations,
  runMigrationInTransaction,
  sanitizeName,
  splitSqlStatements,
  validateChecksums,
} from '../cli/migrate.js';
import { stripCommentsAndStrings, tokenizeSql } from '../cli/sql-statements.js';

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

  it('throws when the -- UP marker is missing entirely', () => {
    // Returning { up: '', down: '' } here meant the whole file was treated as
    // preamble: nothing ran, and the migration was still recorded as applied.
    assert.throws(() => parseMigrationContent(`CREATE TABLE users (id SERIAL);`), /no `-- UP` section marker/);
  });

  it('names the file in the missing-marker error when a source is given', () => {
    assert.throws(
      () => parseMigrationContent('SELECT 1;', '/tmp/20260101000000_broken.sql'),
      /20260101000000_broken\.sql/,
    );
  });

  it('returns empty down when only UP is present', () => {
    const content = `-- UP
CREATE TABLE users (id SERIAL);
`;
    const result = parseMigrationContent(content);
    assert.equal(result.up, 'CREATE TABLE users (id SERIAL);');
    assert.equal(result.down, '');
  });

  it('throws when only a DOWN marker is present (no UP)', () => {
    assert.throws(() => parseMigrationContent(`-- DOWN\nDROP TABLE users;\n`), /no `-- UP` section marker/);
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

  // Requiring the EXACT strings `-- UP` / `-- DOWN` meant these spellings read
  // as ordinary comments and folded the whole DOWN section into UP, where it
  // RAN. `migrate up` was partly shielded by the destructive gate, but
  // `migrate deploy` passes allowDestructive unconditionally, so a
  // create-then-drop pair applied as one "successful" migration.
  it('recognizes the loose spellings of the section markers', () => {
    for (const [up, down] of [
      ['--UP', '--DOWN'],
      ['--  UP', '--  DOWN'],
      ['-- UP;', '-- DOWN;'],
      ['--\tUP', '--\tDOWN'],
      ['-- up ;', '-- Down'],
    ]) {
      const result = parseMigrationContent(`${up}\nCREATE TABLE t (id int);\n${down}\nDROP TABLE t;\n`);
      assert.equal(result.up, 'CREATE TABLE t (id int);', `UP for ${up}/${down}`);
      assert.equal(result.down, 'DROP TABLE t;', `DOWN for ${up}/${down}`);
    }
  });

  it('does not mistake a comment that merely starts with UP/DOWN for a marker', () => {
    const result = parseMigrationContent(`-- UP\n-- UPDATE the widgets table below\nSELECT 1;\n-- DOWN\nSELECT 2;`);
    assert.match(result.up, /UPDATE the widgets table below/);
    assert.equal(result.down, 'SELECT 2;');
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
// tokenizeSql - the ONE lexer both the runner and the destructive guard use
// ---------------------------------------------------------------------------

describe('tokenizeSql', () => {
  it('hands back the verbatim source AND the stripped source for one statement', () => {
    const [stmt] = tokenizeSql(`/* note */ INSERT INTO t (a) VALUES ('x;y'); -- trailing`);
    assert.equal(stmt!.raw, `/* note */ INSERT INTO t (a) VALUES ('x;y')`);
    assert.equal(stmt!.stripped, `INSERT INTO t (a) VALUES ('')`);
    assert.equal(stmt!.commentOnly, false);
  });

  it('slices `raw` out of the source rather than rebuilding it', () => {
    // A rebuilt statement can silently differ from what the author wrote, and
    // `raw` is what gets EXECUTED. Round-trip a script full of every construct.
    const sql = [
      `CREATE FUNCTION f() RETURNS int AS $body$ BEGIN; RETURN 1; END; $body$ LANGUAGE plpgsql`,
      `INSERT INTO t VALUES (E'a\\'b', 'c''d', "we;ird")`,
      `-- lead\n/* outer /* inner */ still */ SELECT 1`,
    ];
    assert.deepEqual(
      splitSqlStatements(`${sql.join(';\n')};`),
      sql.map((s) => s.trim()),
    );
  });

  it('reports a comment-only fragment instead of dropping it', () => {
    const stmts = tokenizeSql('-- just a note\n; /* and a block */ ; SELECT 1;');
    assert.deepEqual(
      stmts.map((s) => s.commentOnly),
      [true, true, false],
    );
    // The executor's view drops them; the guard's view ignores them.
    assert.deepEqual(splitSqlStatements('-- just a note\n; /* and a block */ ; SELECT 1;'), ['SELECT 1']);
  });

  it('treats a NESTED block comment as one comment', () => {
    // The guard's old lexer ended at the first `*/` and read ` c */ DROP ...`
    // as code; the runner's counted depth. They disagreed about the file.
    const stmts = tokenizeSql('/* a /* b */ c */ DROP TABLE users;');
    assert.equal(stmts.length, 1);
    assert.equal(stmts[0]!.stripped, 'DROP TABLE users');
    assert.equal(
      tokenizeSql('/* a /* b */ c */').every((s) => s.commentOnly),
      true,
    );
  });

  it('collects each statement OWN dollar-quoted bodies', () => {
    const stmts = tokenizeSql(`DO $$ SELECT 1; $$; DO $x$ SELECT 2; $x$;`);
    assert.deepEqual(
      stmts.map((s) => s.blocks),
      [[' SELECT 1; '], [' SELECT 2; ']],
    );
  });

  it('handles a doubled quote inside an identifier, and unterminated quotes', () => {
    assert.deepEqual(splitSqlStatements(`SELECT "a""b;c" FROM t; SELECT 2;`), [`SELECT "a""b;c" FROM t`, 'SELECT 2']);
    // Unterminated constructs consume to end of input rather than looping.
    assert.deepEqual(splitSqlStatements(`SELECT "unterminated`), ['SELECT "unterminated']);
    assert.deepEqual(splitSqlStatements(`SELECT 'unterminated`), [`SELECT 'unterminated`]);
    assert.deepEqual(splitSqlStatements(`DO $$ unterminated`), ['DO $$ unterminated']);
  });

  it('stripCommentsAndStrings blanks comments and literals, keeping identifiers', () => {
    assert.equal(
      stripCommentsAndStrings(`-- note\nDELETE FROM "my;table" WHERE k = 'v'; /* x */ SELECT $tag$body$tag$;`),
      `DELETE FROM "my;table" WHERE k = ''; SELECT ''`,
    );
  });

  it('agrees with the executor about how many statements a script has', () => {
    // The property that matters: the guard cannot inventory a different set of
    // statements than the runner executes, because there is only one walk.
    for (const sql of [
      '/* a /* b */ c */ DROP TABLE users;',
      'DROP TABLE "we;ird"; DELETE FROM t;',
      `SELECT 'a;b'; SELECT E'c\\';d'; SELECT $tag$ e; f $tag$;`,
      '-- x\nSELECT 1;\n/* y */ SELECT 2;',
    ]) {
      assert.equal(
        tokenizeSql(sql).filter((s) => !s.commentOnly).length,
        splitSqlStatements(sql).length,
        `statement count disagreed for: ${sql}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Embedded transaction control (the runner already wraps each file in one)
// ---------------------------------------------------------------------------

describe('findTransactionControlStatements', () => {
  it('finds a COMMIT, a ROLLBACK, and a BEGIN', () => {
    assert.deepEqual(findTransactionControlStatements('BEGIN;\nSELECT 1;\nCOMMIT;'), ['BEGIN', 'COMMIT']);
    assert.deepEqual(findTransactionControlStatements('SELECT 1; ROLLBACK;'), ['ROLLBACK']);
    assert.deepEqual(findTransactionControlStatements('START TRANSACTION; SELECT 1;'), ['START TRANSACTION']);
    assert.deepEqual(findTransactionControlStatements('ABORT;'), ['ABORT']);
  });

  it('finds nothing in a clean migration body', () => {
    assert.deepEqual(
      findTransactionControlStatements('ALTER TABLE t RENAME COLUMN a TO b;\nALTER TABLE t RENAME COLUMN c TO a;'),
      [],
    );
  });

  it('ignores a COMMIT inside a comment or a string literal', () => {
    // The shared tokenizer is what makes this possible; a keyword scan over the
    // raw text would flag all four of these.
    assert.deepEqual(findTransactionControlStatements('-- COMMIT;\nSELECT 1;'), []);
    assert.deepEqual(findTransactionControlStatements('/* BEGIN; COMMIT; */ SELECT 1;'), []);
    assert.deepEqual(findTransactionControlStatements(`INSERT INTO log (msg) VALUES ('COMMIT;');`), []);
    assert.deepEqual(findTransactionControlStatements(`DO $$ BEGIN PERFORM 1; END $$;`), []);
  });

  it('allows ROLLBACK TO SAVEPOINT, which leaves the wrapper open', () => {
    assert.deepEqual(findTransactionControlStatements('SAVEPOINT s; SELECT 1; ROLLBACK TO SAVEPOINT s;'), []);
    assert.deepEqual(findTransactionControlStatements('ROLLBACK TO s;'), []);
  });

  it('does not flag the bare END a BEGIN ATOMIC function body leaves behind', () => {
    // PG14+ `CREATE FUNCTION ... BEGIN ATOMIC SELECT 1; END;` splits at its
    // inner semicolon, so a rule that refused `END` would break working files.
    assert.deepEqual(
      findTransactionControlStatements('CREATE FUNCTION f() RETURNS int LANGUAGE SQL BEGIN ATOMIC SELECT 1; END;'),
      [],
    );
  });
});

describe('assertNoEmbeddedTransactions', () => {
  const dir = join(tmpdir(), `turbine-embedded-tx-${Date.now()}`);
  before(() => mkdirSync(dir, { recursive: true }));
  after(() => rmSync(dir, { recursive: true, force: true }));

  function write(name: string, content: string): { filename: string; path: string; name: string; timestamp: string } {
    const filename = `${name}.sql`;
    const path = join(dir, filename);
    writeFileSync(path, content);
    return { filename, path, name, timestamp: name.slice(0, 14) };
  }

  it('refuses a migration whose UP body commits the runner transaction', () => {
    const file = write(
      '20260101000000_swap',
      '-- UP\nBEGIN;\n  ALTER TABLE t RENAME COLUMN a TO b;\nCOMMIT;\n-- DOWN\nSELECT 1;\n',
    );
    assert.throws(
      () => assertNoEmbeddedTransactions([file], 'up'),
      (err: unknown) => {
        const msg = (err as Error).message;
        assert.match(msg, /manage transactions themselves \(UP section\)/);
        assert.match(msg, /20260101000000_swap\.sql/);
        assert.match(msg, /- BEGIN/);
        assert.match(msg, /- COMMIT/);
        assert.match(msg, /turbine:no-transaction/);
        return true;
      },
    );
  });

  it('refuses one in the DOWN section too', () => {
    const file = write('20260101000100_down', '-- UP\nSELECT 1;\n-- DOWN\nBEGIN;\nSELECT 2;\nCOMMIT;\n');
    assert.throws(() => assertNoEmbeddedTransactions([file], 'down'), /\(DOWN section\)/);
    // ...and the same file's UP is clean, so the UP direction passes.
    assertNoEmbeddedTransactions([file], 'up');
  });

  it('exempts a -- turbine:no-transaction migration, which owns its own', () => {
    const file = write(
      '20260101000200_manual',
      '-- turbine:no-transaction\n-- UP\nBEGIN;\nSELECT 1;\nCOMMIT;\n-- DOWN\nSELECT 1;\n',
    );
    assertNoEmbeddedTransactions([file], 'up');
  });

  it('passes a clean batch', () => {
    const file = write('20260101000300_clean', '-- UP\nCREATE TABLE t (id int);\n-- DOWN\nDROP TABLE t;\n');
    assertNoEmbeddedTransactions([file], 'up');
    assertNoEmbeddedTransactions([file], 'down');
  });
});

// ---------------------------------------------------------------------------
// headerSafeName
// ---------------------------------------------------------------------------

describe('headerSafeName', () => {
  it('collapses every newline form so the name cannot escape its comment line', () => {
    assert.equal(headerSafeName('add\nusers'), 'add users');
    assert.equal(headerSafeName('add\r\nusers'), 'add users');
    assert.equal(headerSafeName('add users'), 'add users');
    assert.equal(headerSafeName('  add   users  '), 'add users');
  });

  it('leaves an ordinary readable name alone', () => {
    assert.equal(headerSafeName('Add Users & Posts'), 'Add Users & Posts');
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

  // `sanitizeName` was applied to the FILENAME only; the raw argument went into
  // the `-- Migration: ${name}` header, which sits ABOVE the `-- UP` marker. A
  // newline in it ends the comment, so the rest of the argument became file
  // content: both an execution directive and executable SQL, in a migration the
  // user never wrote.
  const INJECTION = 'evil\n-- turbine:no-transaction\n-- UP\nDROP TABLE users;\n-- x';

  it('cannot be made to inject SQL or a directive through the migration name', () => {
    for (const options of [undefined, { recipe: 'backfill' }]) {
      const result = createMigration(testDir, INJECTION, undefined, options);
      const content = readFileSync(result.path, 'utf-8');
      const parsed = parseMigrationContent(content);

      assert.equal(parsed.noTransaction, false, 'the payload must not set the no-transaction directive');
      assert.ok(!parsed.up.includes('DROP TABLE users'), `payload SQL leaked into UP:\n${parsed.up}`);
      // The whole payload survives, as documentation, on ONE comment line.
      assert.match(content, /^-- Migration: evil -- turbine:no-transaction -- UP DROP TABLE users; -- x/m);
    }
  });

  it('cannot be made to inject through the name on the auto-generated template', () => {
    const result = createMigration(testDir, INJECTION, { up: 'SELECT 1;', down: 'SELECT 2;' });
    const parsed = parseMigrationContent(readFileSync(result.path, 'utf-8'));
    assert.equal(parsed.noTransaction, false);
    assert.equal(parsed.up, 'SELECT 1;');
    assert.equal(parsed.down, 'SELECT 2;');
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

  /**
   * `CREATE TABLE IF NOT EXISTS` is not race-free: concurrent sessions can both
   * pass the existence check, and the loser gets a hard error instead of a
   * no-op. `migrate status` and the deploy inspector reach it WITHOUT the
   * migration lock, so 12 concurrent status calls on a fresh database left 11
   * crashed. Driven through validateChecksums, which is the exported path that
   * calls ensureTrackingTable.
   */
  function racingTrackingTableClient(failFirstWith: string) {
    const creates: string[] = [];
    let thrown = false;
    const client = {
      async query(sql: string): Promise<unknown> {
        if (/create table/i.test(sql)) {
          creates.push(sql);
          if (!thrown) {
            thrown = true;
            throw Object.assign(new Error('lost the create race'), { code: failFirstWith });
          }
          return { rows: [] };
        }
        return { rows: [] };
      },
    };
    return { creates, client: client as unknown as Parameters<typeof validateChecksums>[0] };
  }

  for (const code of ['23505', '42P07']) {
    it(`retries the tracking-table create once when a concurrent session wins (${code})`, async () => {
      const fake = racingTrackingTableClient(code);
      const mismatches = await validateChecksums(fake.client, dir);
      assert.deepEqual(mismatches, []);
      assert.equal(fake.creates.length, 2, 'the create should be retried exactly once');
    });
  }

  it('does not swallow an unrelated CREATE TABLE failure', async () => {
    const fake = racingTrackingTableClient('42501'); // insufficient_privilege
    await assert.rejects(() => validateChecksums(fake.client, dir), /lost the create race/);
    assert.equal(fake.creates.length, 1, 'a non-race failure must not be retried');
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

// ---------------------------------------------------------------------------
// rollbackMigrations - a rollback batch is LIFO with NO GAPS
// ---------------------------------------------------------------------------

describe('rollbackMigrations', () => {
  const dir = join(tmpdir(), `turbine-rollback-batch-${Date.now()}`);
  const DELETE_APPLIED = 'DELETE FROM _turbine_migrations WHERE name = $1';

  before(() => mkdirSync(dir, { recursive: true }));
  after(() => rmSync(dir, { recursive: true, force: true }));

  /** Write a migration file and return its MigrationFile record. */
  function migration(name: string, up: string, down: string): MigrationFile {
    const filename = `${name}.sql`;
    const path = join(dir, filename);
    writeFileSync(path, `-- UP\n${up}\n\n-- DOWN\n${down}\n`);
    return { filename, path, name, timestamp: name.slice(0, 14) };
  }

  /**
   * Three migrations. Newest first, exactly as migrateDown orders them, with
   * the MIDDLE one missing its DOWN section.
   */
  function threeWithMiddleGap(): {
    files: MigrationFile[];
    fileMap: Map<string, MigrationFile>;
    batch: Array<{ name: string }>;
  } {
    const files = [
      migration('20260101000001_first', 'CREATE TABLE a (id int);', 'DROP TABLE a;'),
      migration('20260101000002_seed', 'INSERT INTO a VALUES (1);', ''),
      migration('20260101000003_third', 'CREATE TABLE c (id int);', 'DROP TABLE c;'),
    ];
    const fileMap = new Map(files.map((f) => [f.name, f]));
    // Newest first: third, seed, first.
    return { files, fileMap, batch: [...files].reverse().map((f) => ({ name: f.name })) };
  }

  /**
   * A migration whose DOWN section cannot run STOPS the batch. It used to
   * `continue`, so a `--step 3` rolled back 3 and then 1: `DROP TABLE a` ran
   * even though the data migration 2 had seeded into `a` was never reversed,
   * and the tracking table was left claiming migration 2 alone was applied.
   * The next `migrate up` then re-ran 1 and 3 and never re-ran 2.
   */
  it('stops at a migration with no DOWN section instead of skipping past it', async () => {
    const { files, fileMap, batch } = threeWithMiddleGap();
    const client = fakeClient({});

    const result = await rollbackMigrations(client, batch, fileMap, DELETE_APPLIED);

    // Only the NEWEST rolled back.
    assert.deepEqual(
      result.rolledBack.map((f) => f.name),
      [files[2]!.name],
    );
    // The error names the migration that stopped the batch.
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]!.file.name, files[1]!.name);
    assert.match(result.errors[0]!.error, /No DOWN section/);
    // ...and the OLDEST migration's DOWN was never executed. This is the
    // assertion that fails without the fix: `DROP TABLE a` would have run.
    assert.ok(
      !client.calls.some((sql) => sql.includes('DROP TABLE a')),
      `the older migration's DOWN must not run across a gap, got: ${JSON.stringify(client.calls)}`,
    );
    // Nor was its tracking row deleted, so history still says it is applied.
    assert.equal(client.calls.filter((sql) => sql === DELETE_APPLIED).length, 1);
  });

  it('stops at a migration whose file is missing from disk', async () => {
    const { files, fileMap } = threeWithMiddleGap();
    fileMap.delete(files[1]!.name);
    const client = fakeClient({});

    const result = await rollbackMigrations(
      client,
      [...files].reverse().map((f) => ({ name: f.name })),
      fileMap,
      DELETE_APPLIED,
    );

    assert.deepEqual(
      result.rolledBack.map((f) => f.name),
      [files[2]!.name],
    );
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0]!.error, /Migration file not found/);
    assert.ok(!client.calls.some((sql) => sql.includes('DROP TABLE a')));
  });

  it('rolls the whole batch back, newest first, when every DOWN is present', async () => {
    const files = [
      migration('20260102000001_one', 'CREATE TABLE p (id int);', 'DROP TABLE p;'),
      migration('20260102000002_two', 'CREATE TABLE q (id int);', 'DROP TABLE q;'),
    ];
    const fileMap = new Map(files.map((f) => [f.name, f]));
    const client = fakeClient({});

    const result = await rollbackMigrations(
      client,
      [...files].reverse().map((f) => ({ name: f.name })),
      fileMap,
      DELETE_APPLIED,
    );

    assert.equal(result.errors.length, 0);
    assert.deepEqual(
      result.rolledBack.map((f) => f.name),
      [files[1]!.name, files[0]!.name],
    );
    assert.deepEqual(
      client.calls.filter((sql) => sql.startsWith('DROP TABLE')),
      ['DROP TABLE q;', 'DROP TABLE p;'],
    );
  });

  it('stops at the first DOWN that fails, exactly as it always has', async () => {
    const files = [
      migration('20260103000001_one', 'CREATE TABLE p (id int);', 'DROP TABLE p;'),
      migration('20260103000002_two', 'CREATE TABLE q (id int);', 'DROP TABLE q;'),
    ];
    const fileMap = new Map(files.map((f) => [f.name, f]));
    const client = fakeClient({ 'DROP TABLE q;': 'cannot drop table q' });

    const result = await rollbackMigrations(
      client,
      [...files].reverse().map((f) => ({ name: f.name })),
      fileMap,
      DELETE_APPLIED,
    );

    assert.equal(result.rolledBack.length, 0);
    assert.equal(result.errors.length, 1);
    assert.ok(!client.calls.includes('DROP TABLE p;'));
  });
});

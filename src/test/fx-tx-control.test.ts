/**
 * turbine-orm: finding transaction-control SQL in text the caller wrote.
 *
 * The scan in `src/transaction-control.ts` decides which statements of a piece
 * of raw SQL are `COMMIT`, `ROLLBACK`, `BEGIN`, `SAVEPOINT` and the rest. It
 * must (a) classify the family on every engine, (b) never see one inside a
 * literal, a quoted identifier, a dollar-quoted body or a comment, and (c)
 * agree with the one SQL tokenizer the repo ships (`cli/sql-statements.ts`)
 * about where statements start. (c) is what keeps a second lexer from drifting.
 *
 * No database.
 *
 * Run: npx tsx --test src/test/fx-tx-control.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { tokenizeSql } from '../cli/sql-statements.js';
import {
  type ControlKind,
  type ControlSyntax,
  findTransactionControl,
  leadingWords,
  mayHoldTransactionControl,
} from '../transaction-control.js';

const kinds = (sql: string, syntax: ControlSyntax = 'postgresql'): ControlKind[] =>
  findTransactionControl(sql, syntax).map((s) => s.kind);

describe('transaction control: what counts', () => {
  const positive: Array<[string, ControlKind]> = [
    ['COMMIT', 'commit'],
    ['commit;', 'commit'],
    ['  COMMIT WORK', 'commit'],
    ['COMMIT AND CHAIN', 'commit'],
    ['END', 'commit'],
    ['END TRANSACTION', 'commit'],
    ['ROLLBACK', 'rollback'],
    ['rollback work', 'rollback'],
    ['ABORT', 'rollback'],
    ['BEGIN', 'begin'],
    ['BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'begin'],
    ['begin read only', 'begin'],
    ['START TRANSACTION', 'begin'],
    ['SAVEPOINT s1', 'savepoint'],
    ['RELEASE s1', 'release'],
    ['RELEASE SAVEPOINT s1', 'release'],
    ['ROLLBACK TO s1', 'rollback-to'],
    ['ROLLBACK TO SAVEPOINT s1', 'rollback-to'],
    ['ROLLBACK WORK TO SAVEPOINT s1', 'rollback-to'],
    ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'set-transaction'],
    ["PREPARE TRANSACTION 'x'", 'prepare'],
    ["COMMIT PREPARED 'x'", 'commit'],
    ['/* note */ COMMIT', 'commit'],
    ['-- note\nCOMMIT', 'commit'],
    ['/* a /* nested */ still comment */ ROLLBACK', 'rollback'],
  ];
  for (const [sql, kind] of positive) {
    it(`postgresql: ${JSON.stringify(sql)} is ${kind}`, () => {
      assert.deepEqual(kinds(sql), [kind]);
    });
  }

  const negative = [
    'SELECT 1',
    "SELECT 'COMMIT'",
    "SELECT 'it''s; COMMIT'",
    "SELECT E'it\\'s; COMMIT' AS x",
    'SELECT "commit" FROM t',
    'SELECT 1 /* ; COMMIT */',
    'SELECT 1 -- ; COMMIT',
    'SELECT $$ ; COMMIT ; $$',
    'SELECT $tag$ ; ROLLBACK ; $tag$',
    'DO $$ BEGIN PERFORM 1; COMMIT; END $$',
    'INSERT INTO t (commit_at) VALUES ($1)',
    'UPDATE t SET committed = true',
    'SELECT x$y$ FROM t',
    'SET LOCAL statement_timeout = 5',
    'SET search_path TO public',
    'EXPLAIN SELECT 1',
    'WITH c AS (SELECT 1) SELECT * FROM c',
    'BEGIN ATOMIC',
    'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END',
    'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 ELSE 2 END; END; SELECT 1',
    'COPY t FROM STDIN',
    'LOCK TABLE t',
    'DECLARE c CURSOR FOR SELECT 1',
    'FETCH 1 FROM c',
  ];
  for (const sql of negative) {
    it(`postgresql: ${JSON.stringify(sql)} is not control`, () => {
      // A bare `BEGIN ATOMIC` is not a valid statement start; the point is that it is not read as BEGIN.
      assert.deepEqual(kinds(sql), sql === 'BEGIN ATOMIC' ? [] : []);
    });
  }

  it('finds every control statement in a multi-statement text, in order', () => {
    assert.deepEqual(kinds('UPDATE t SET a = 1; COMMIT; SELECT 2; ROLLBACK TO s; BEGIN'), [
      'commit',
      'rollback-to',
      'begin',
    ]);
  });

  it('a control word after a quoted semicolon is not a statement start', () => {
    assert.deepEqual(kinds(`SELECT 'a;'; COMMIT`), ['commit']);
    assert.deepEqual(kinds(`SELECT 'a; COMMIT'`), []);
    assert.deepEqual(kinds(`SELECT "a;b" FROM t; ROLLBACK`), ['rollback']);
  });

  it('an unterminated literal swallows the rest instead of inventing a statement', () => {
    assert.deepEqual(kinds(`SELECT 'oops; COMMIT`), []);
    assert.deepEqual(kinds('SELECT /* oops; COMMIT'), []);
    assert.deepEqual(kinds('SELECT $$ oops; COMMIT'), []);
  });

  it('labels name what was sent', () => {
    assert.equal(findTransactionControl('START TRANSACTION', 'mysql')[0]?.label, 'START TRANSACTION');
    assert.equal(findTransactionControl('abort', 'postgresql')[0]?.label, 'ABORT');
    assert.equal(findTransactionControl('rollback to s', 'postgresql')[0]?.label, 'ROLLBACK TO SAVEPOINT');
  });
});

describe('transaction control: the other engines', () => {
  it('mysql: backslash escapes, backticks, # and -- comments', () => {
    assert.deepEqual(kinds('COMMIT', 'mysql'), ['commit']);
    assert.deepEqual(kinds('START TRANSACTION', 'mysql'), ['begin']);
    assert.deepEqual(kinds('RELEASE SAVEPOINT a', 'mysql'), ['release']);
    assert.deepEqual(kinds("SELECT 'it\\'s; COMMIT'", 'mysql'), [], 'a backslash escapes the quote');
    assert.deepEqual(kinds('SELECT `a;commit` FROM t', 'mysql'), []);
    assert.deepEqual(kinds('SELECT 1 # ; COMMIT\n', 'mysql'), []);
    assert.deepEqual(kinds('SELECT 1 -- ; COMMIT\n', 'mysql'), []);
    assert.deepEqual(kinds('SELECT 1 --; COMMIT', 'mysql'), ['commit'], '-- with no space after is not a comment');
    assert.deepEqual(kinds('ABORT', 'mysql'), [], 'ABORT is PostgreSQL only');
    assert.deepEqual(kinds('END', 'mysql'), [], 'END is PostgreSQL and SQLite only');
  });

  it('sqlite: BEGIN modes, END, bracket and backtick identifiers', () => {
    assert.deepEqual(kinds('BEGIN IMMEDIATE', 'sqlite'), ['begin']);
    assert.deepEqual(kinds('BEGIN DEFERRED TRANSACTION', 'sqlite'), ['begin']);
    assert.deepEqual(kinds('END', 'sqlite'), ['commit']);
    assert.deepEqual(kinds('SELECT [a;commit] FROM t', 'sqlite'), []);
    assert.deepEqual(kinds('SELECT 1; RELEASE a', 'sqlite'), ['release']);
    assert.deepEqual(kinds('SELECT $$ ; COMMIT', 'sqlite'), ['commit'], '$$ is not a quote on SQLite');
  });

  it('mssql: transaction statements, and BEGIN as a block is not one', () => {
    assert.deepEqual(kinds('BEGIN TRAN', 'mssql'), ['begin']);
    assert.deepEqual(kinds('BEGIN TRANSACTION t1', 'mssql'), ['begin']);
    assert.deepEqual(kinds('COMMIT TRAN', 'mssql'), ['commit']);
    assert.deepEqual(kinds('ROLLBACK TRANSACTION', 'mssql'), ['rollback']);
    assert.deepEqual(kinds('SAVE TRANSACTION s', 'mssql'), ['savepoint']);
    assert.deepEqual(kinds('BEGIN TRY SELECT 1 END TRY BEGIN CATCH SELECT 2 END CATCH', 'mssql'), []);
    assert.deepEqual(kinds('SELECT [a;commit] FROM t', 'mssql'), []);
    assert.deepEqual(kinds('END', 'mssql'), [], 'END closes a block on SQL Server');
  });

  it('the cheap pre-check misses nothing the scan finds', () => {
    for (const sql of ['commit', 'x; Rollback', 'SET TRANSACTION READ ONLY', 'RELEASE a', 'save tran a', 'abort']) {
      assert.ok(mayHoldTransactionControl(sql), sql);
    }
    assert.equal(mayHoldTransactionControl('SELECT * FROM users WHERE id = $1'), false);
  });
});

describe('transaction control: statement starts agree with cli/sql-statements.ts', () => {
  /** What the repo's one tokenizer says each statement starts with: its first word, or `?` when it is not a word. */
  function referenceStarts(sql: string): string[] {
    return tokenizeSql(sql)
      .filter((s) => !s.commentOnly)
      .map((s) => {
        const first = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(s.stripped)?.[0];
        return first === undefined ? '?' : first.toLowerCase();
      });
  }
  const ours = (sql: string): string[] => leadingWords(sql, 'postgresql').map((words) => words[0] ?? '?');

  const corpus: string[] = [
    'SELECT 1',
    'SELECT 1; SELECT 2;',
    "SELECT 'a;b'; COMMIT",
    "SELECT E'a\\';b'; ROLLBACK",
    "SELECT 'it''s'; BEGIN",
    'SELECT "a;b" FROM t; SAVEPOINT s',
    'SELECT "a""; COMMIT" FROM t; RELEASE s',
    'SELECT $$ ; $$; COMMIT',
    'SELECT $q$ ; $$ ; $q$; ROLLBACK',
    'SELECT $1, $2; COMMIT',
    'SELECT x$y$ FROM t; DROP TABLE users',
    'DO $do1$ BEGIN PERFORM 1; END $do1$; COMMIT',
    'SELECT 1 /* ; */; COMMIT',
    'SELECT 1 /* a /* ; */ ; */; ROLLBACK',
    'SELECT 1 -- ; COMMIT\n; ROLLBACK',
    '-- leading\nCOMMIT; -- trailing',
    '/* a */ /* b */ BEGIN;',
    'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; SELECT 2; END; COMMIT',
    'CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 ELSE 2 END; END; ROLLBACK',
    "CREATE FUNCTION f() RETURNS text LANGUAGE sql BEGIN ATOMIC SELECT 'end;'; END; SAVEPOINT s",
    'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); COMMIT',
    "SELECT U&'d\\0061t\\+000061'; COMMIT",
    "SELECT B'1010'; COMMIT",
    ';;; COMMIT ;;',
    "SELECT 'COMMIT'",
    'SELECT 1 /* COMMIT */',
    'SELECT 1 -- ROLLBACK',
    'SELECT $$ROLLBACK$$',
    'SELECT "commit" FROM t',
    'DO $x$ BEGIN COMMIT; END $x$',
    "SELECT 'unterminated; COMMIT",
    'SELECT 1 /* unterminated; COMMIT',
  ];
  for (const sql of corpus) {
    it(`same statement starts: ${JSON.stringify(sql).slice(0, 80)}`, () => {
      assert.deepEqual(ours(sql), referenceStarts(sql));
    });
  }

  it('and the corpus is not vacuous: it contains statements the scan sees and ones it hides', () => {
    const seen = corpus.filter((sql) => ours(sql).includes('commit') || ours(sql).includes('rollback'));
    assert.ok(seen.length >= 10, `only ${seen.length} corpus entries hold a visible control statement`);
    const hidden = corpus.filter(
      (sql) => /commit|rollback/i.test(sql) && !ours(sql).some((w) => w === 'commit' || w === 'rollback'),
    );
    assert.ok(hidden.length >= 5, `only ${hidden.length} corpus entries hide one in a literal or comment`);
  });
});

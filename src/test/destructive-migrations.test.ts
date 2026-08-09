import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanDestructiveSql } from '../cli/destructive.js';
import { findTransactionControlStatements, migrateDown, migrateUp } from '../cli/migrate.js';
import { splitSqlStatements } from '../cli/sql-statements.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Scanner, pure unit tests
// ---------------------------------------------------------------------------

test('flags every destructive statement kind', () => {
  const hits = scanDestructiveSql(`
    DROP TABLE users;
    DROP TABLE IF EXISTS "public"."orders";
    DROP SCHEMA legacy;
    TRUNCATE TABLE events;
    ALTER TABLE posts DROP COLUMN body;
    ALTER TABLE posts ALTER COLUMN price TYPE integer;
    DELETE FROM sessions WHERE expired = true;
    UPDATE accounts SET balance = 0;
  `);
  assert.deepEqual(
    hits.map((h) => [h.kind, h.target]),
    [
      ['drop-table', 'users'],
      ['drop-table', 'public.orders'],
      ['drop-schema', 'legacy'],
      ['truncate', 'events'],
      ['drop-column', 'posts.body'],
      ['alter-column-type', 'posts.price'],
      ['delete', 'sessions'],
      ['update-without-where', 'accounts'],
    ],
  );
});

test('does not flag safe DDL and DML', () => {
  const hits = scanDestructiveSql(`
    CREATE TABLE users (id uuid PRIMARY KEY, name text);
    ALTER TABLE users ADD COLUMN email text;
    CREATE INDEX idx_users_email ON users (email);
    DROP INDEX IF EXISTS idx_users_email;
    ALTER TABLE users DROP CONSTRAINT users_email_key;
    ALTER TABLE users ALTER COLUMN email SET NOT NULL;
    ALTER TABLE users ALTER COLUMN email SET DEFAULT '';
    INSERT INTO users (id, name) VALUES (gen_random_uuid(), 'x');
    UPDATE users SET name = 'y' WHERE id = '00000000-0000-0000-0000-000000000000';
  `);
  assert.deepEqual(hits, []);
});

test('ignores destructive keywords inside comments and string literals', () => {
  const hits = scanDestructiveSql(`
    -- DROP TABLE users;
    /* TRUNCATE events; DELETE FROM sessions; */
    INSERT INTO audit_log (note) VALUES ('ran DROP TABLE users last week');
    INSERT INTO snippets (body) VALUES ($tag$DELETE FROM everything$tag$);
    CREATE TABLE drop_table_log (id serial);
  `);
  assert.deepEqual(hits, []);
});

test('an E-string literal cannot hide the statements that follow it', () => {
  // `E'a\'b'` is ONE literal: inside an E-string a backslash escapes the next
  // character. A scanner that ends the literal at the backslash-quote reads the
  // rest of the file as part of a string and flags nothing at all.
  const hits = scanDestructiveSql(String.raw`
    INSERT INTO notes (body) VALUES (E'it\'s fine');
    DROP TABLE users;
  `);
  assert.deepEqual(
    hits.map((h) => [h.kind, h.target]),
    [['drop-table', 'users']],
  );
});

test('an E-string still shields its own contents, and `e` is accepted too', () => {
  assert.deepEqual(scanDestructiveSql(String.raw`INSERT INTO t (b) VALUES (e'\'DROP TABLE users;');`), []);
  // A trailing `e` that is part of an identifier must NOT start an E-string.
  assert.deepEqual(
    scanDestructiveSql(`INSERT INTO some_table VALUES ('plain'); DROP TABLE users;`).map((h) => h.kind),
    ['drop-table'],
  );
});

test('an apostrophe inside a quoted identifier cannot blind the scanner', () => {
  assert.deepEqual(
    scanDestructiveSql(`CREATE TABLE "customer's_orders" (id int); DROP TABLE users;`).map((h) => [h.kind, h.target]),
    [['drop-table', 'users']],
  );
});

test('a dollar-quote tag containing digits still hides its body from the top level', () => {
  // `$do1$` is a valid tag; a letters-only tag regex reads the body as code.
  assert.deepEqual(
    scanDestructiveSql('DO $do1$ BEGIN DROP TABLE users; END $do1$;').map((h) => h.kind),
    ['drop-table'],
  );
});

test('a leading CTE list does not hide a top-level DELETE or UPDATE', () => {
  assert.deepEqual(
    scanDestructiveSql('WITH c AS (SELECT 1) DELETE FROM users;').map((h) => [h.kind, h.target]),
    [['delete', 'users']],
  );
  assert.deepEqual(
    scanDestructiveSql('WITH a AS (SELECT 1), b AS (SELECT 2) UPDATE users SET x = 1;').map((h) => h.kind),
    ['update-without-where'],
  );
  // A read-only CTE followed by a SELECT stays clean.
  assert.deepEqual(scanDestructiveSql('WITH c AS (SELECT 1) SELECT * FROM c;'), []);
});

test('schema-qualified targets are reported qualified, not truncated to the schema', () => {
  assert.deepEqual(
    scanDestructiveSql('DELETE FROM public.users;').map((h) => h.target),
    ['public.users'],
  );
});

test('flags DROP DATABASE, DROP OWNED BY, and DROP MATERIALIZED VIEW', () => {
  assert.deepEqual(
    scanDestructiveSql(`
      DROP DATABASE IF EXISTS analytics;
      DROP OWNED BY reporting;
      DROP MATERIALIZED VIEW daily_totals;
    `).map((h) => [h.kind, h.target]),
    [
      ['drop-database', 'analytics'],
      ['drop-owned', 'reporting'],
      ['drop-matview', 'daily_totals'],
    ],
  );
});

test('flags the optional-COLUMN drop shorthand', () => {
  const hits = scanDestructiveSql('ALTER TABLE users DROP email;');
  assert.deepEqual(
    hits.map((h) => [h.kind, h.target]),
    [['drop-column', 'users.email']],
  );
  // ...and the IF EXISTS / quoted / ONLY spellings of the same shorthand.
  assert.deepEqual(
    scanDestructiveSql('ALTER TABLE ONLY users DROP IF EXISTS "email";').map((h) => [h.kind, h.target]),
    [['drop-column', 'users.email']],
  );
});

test('does not confuse the other ALTER TABLE ... DROP sub-actions for a column drop', () => {
  const hits = scanDestructiveSql(`
    ALTER TABLE users DROP CONSTRAINT users_pkey;
    ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
    ALTER TABLE users ALTER COLUMN email DROP DEFAULT;
    ALTER TABLE users ALTER COLUMN id DROP IDENTITY IF EXISTS;
    ALTER TABLE users ALTER COLUMN total DROP EXPRESSION;
  `);
  assert.deepEqual(hits, []);
});

test('flags a data-modifying CTE', () => {
  assert.deepEqual(
    scanDestructiveSql('WITH d AS (DELETE FROM users RETURNING *) SELECT * FROM d;').map((h) => [h.kind, h.target]),
    [['delete', 'users']],
  );
  // The OUTER query's WHERE does not restrict the CTE's UPDATE.
  assert.deepEqual(
    scanDestructiveSql('WITH u AS (UPDATE users SET tier = 0 RETURNING *) SELECT * FROM u WHERE id = 1;').map((h) => [
      h.kind,
      h.target,
    ]),
    [['update-without-where', 'users']],
  );
  // A read-only CTE stays clean.
  assert.deepEqual(scanDestructiveSql('WITH d AS (SELECT * FROM users) SELECT * FROM d;'), []);
});

test('flags dynamic SQL inside a DO block', () => {
  const hits = scanDestructiveSql(`DO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$;`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.kind, 'drop-table');
  assert.equal(hits[0]?.target, 'users');
  assert.match(hits[0]?.statement ?? '', /in block: DROP TABLE users/);
  // A procedural block with no destructive SQL stays clean.
  assert.deepEqual(scanDestructiveSql('DO $$ BEGIN PERFORM 1; END $$;'), []);
});

test('scopes the UPDATE WHERE check to the top level', () => {
  assert.deepEqual(
    scanDestructiveSql(`UPDATE users SET tier = (SELECT t FROM defaults WHERE k = 'x');`).map((h) => [
      h.kind,
      h.target,
    ]),
    [['update-without-where', 'users']],
  );
  // A real top-level WHERE still suppresses the rule, subquery or not.
  assert.deepEqual(
    scanDestructiveSql(`UPDATE users SET tier = (SELECT t FROM defaults WHERE k = 'x') WHERE id = 2;`),
    [],
  );
});

test('flags MERGE ... THEN DELETE', () => {
  assert.deepEqual(
    scanDestructiveSql('MERGE INTO users u USING staged s ON u.id = s.id WHEN MATCHED THEN DELETE;').map((h) => [
      h.kind,
      h.target,
    ]),
    [['merge-delete', 'users']],
  );
  // An insert-only MERGE removes nothing.
  assert.deepEqual(
    scanDestructiveSql('MERGE INTO users u USING staged s ON u.id = s.id WHEN NOT MATCHED THEN INSERT VALUES (s.id);'),
    [],
  );
});

test('multi-statement files report each offender once', () => {
  const hits = scanDestructiveSql('CREATE TABLE a (id int); DROP TABLE b; CREATE TABLE c (id int); TRUNCATE d;');
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.kind, 'drop-table');
  assert.equal(hits[1]?.kind, 'truncate');
});

// ---------------------------------------------------------------------------
// Shared tokenizer: the guard used to carry its own, and it was the wrong one
// ---------------------------------------------------------------------------

test('a NESTED block comment cannot hide the statement that follows it', () => {
  // The guard ended a block comment at the FIRST `*/`, so `/* a /* b */ c */`
  // reopened as code at ` c */` and the scanner resynchronised mid-file. The
  // executor's tokenizer counted nesting depth and ran the DROP TABLE, so the
  // two disagreed about what the file contained, and the guard was the wrong
  // one. Postgres nests block comments.
  assert.deepEqual(
    scanDestructiveSql('/* a /* b */ c */ DROP TABLE users;').map((h) => [h.kind, h.target]),
    [['drop-table', 'users']],
  );
  // Two levels deep, same answer.
  assert.deepEqual(
    scanDestructiveSql('/* x /* y /* z */ */ */ TRUNCATE events;').map((h) => h.kind),
    ['truncate'],
  );
});

test('a commented-out block containing a comment does not truncate the inventory', () => {
  // The worst measured shape: the guard reported ONLY the DELETE, so the
  // operator confirmed an inventory of one statement and the unlisted DROP
  // TABLE ran under that confirmation.
  const sql = [
    '/* disabled for now',
    '  ... /* slow */',
    '*/',
    'DROP TABLE legacy_users;',
    'DELETE FROM audit_log;',
  ].join('\n');
  assert.deepEqual(
    scanDestructiveSql(sql).map((h) => [h.kind, h.target]),
    [
      ['drop-table', 'legacy_users'],
      ['delete', 'audit_log'],
    ],
  );
});

test('a semicolon inside a quoted identifier does not split a statement in half', () => {
  // `split(';')` cut this into `DROP TABLE "we` and `ird"`, neither of which
  // matched any rule, so a DROP TABLE was invisible to the guard.
  assert.deepEqual(
    scanDestructiveSql('DROP TABLE "we;ird";').map((h) => [h.kind, h.target]),
    [['drop-table', 'we;ird']],
  );
  assert.deepEqual(
    scanDestructiveSql('CREATE TABLE "a;b" (id int); DELETE FROM audit;').map((h) => h.kind),
    ['delete'],
  );
});

// ---------------------------------------------------------------------------
// Lexical agreement with the server. Every disagreement fails open, because the
// guard then reads a file the server will not execute and the server executes a
// file the guard never read. Each case below was verified BOTH ways: the wrong
// inventory here, and the statement really running on PostgreSQL 16.14.
// ---------------------------------------------------------------------------

test('a `$` inside an identifier does not open a dollar-quoted body', () => {
  // Postgres allows `$` in an identifier and lexes by longest match, so `x$y$`
  // is ONE identifier and its `$` never reaches the dollar-quoting rule.
  // Reading `$y$` as an opener starts a body whose tag never recurs, which
  // swallows the rest of the file: the guard reported (none) for this input
  // while the server returned the `x$y$` column and then dropped the table.
  assert.deepEqual(
    scanDestructiveSql('SELECT x$y$ FROM t;\nDROP TABLE users;').map((h) => [h.kind, h.target]),
    [['drop-table', 'users']],
  );
  // Collapsing the file to ONE statement also breaks the
  // one-statement-per-round-trip contract `-- turbine:no-transaction`
  // migrations depend on, so the split is pinned alongside the inventory.
  assert.deepEqual(splitSqlStatements('SELECT x$y$ FROM t;\nDROP TABLE users;'), [
    'SELECT x$y$ FROM t',
    'DROP TABLE users',
  ]);
  // Repeated `$`, and a run that merely looks like a keyword followed by a
  // body: the server names each of these as one identifier token.
  assert.deepEqual(
    scanDestructiveSql('SELECT a$$b FROM t; DROP TABLE users;').map((h) => h.kind),
    ['drop-table'],
  );
  assert.deepEqual(splitSqlStatements('SELECT$$x$$; DROP TABLE users;'), ['SELECT$$x$$', 'DROP TABLE users']);
});

test('under-splitting hides transaction control from the refusal gate too', () => {
  // The tokenizer has a THIRD consumer: findTransactionControlStatements (in
  // migrate.ts), which refuses a migration file carrying its own BEGIN/COMMIT/
  // ROLLBACK. Collapsing the file to one statement left that gate looking at a
  // single statement headed SELECT, so the embedded COMMIT was invisible and
  // the file was ACCEPTED. That commits the runner's OWN wrapper mid-file:
  // everything before the COMMIT becomes durable, everything after runs
  // unprotected, and the migration is recorded nowhere, so every rerun fails
  // on "already exists". Under-splitting is a silent accept in both
  // directions, and this is the second one.
  assert.deepEqual(findTransactionControlStatements('SELECT x$y$ FROM t;\nCOMMIT;\nDROP TABLE users;\n'), ['COMMIT']);
  // The same file without the `$` identifier was always caught, which is what
  // isolates the cause to the lexing rather than to anything about COMMIT.
  assert.deepEqual(findTransactionControlStatements('SELECT 1;\nCOMMIT;\nDROP TABLE users;\n'), ['COMMIT']);
});

test('a non-ASCII identifier carries a `$` the same way', () => {
  // ident_cont is `[A-Za-z\200-\377_0-9$]`, so every non-ASCII character is an
  // identifier character. `naïve$col$` is one identifier: asked for it, the
  // server answers `column "naïve$col$" does not exist`, naming the whole run.
  assert.deepEqual(
    scanDestructiveSql('SELECT naïve$col$ FROM t; DROP TABLE users;').map((h) => [h.kind, h.target]),
    [['drop-table', 'users']],
  );
});

test('a `$` that starts a token still opens a body', () => {
  // The converse, and the reason the rule is stated as Postgres states it
  // rather than as "ignore a `$` that follows anything": a digit cannot START
  // an identifier, so `1$$...$$` IS a dollar-quoted string (the server reports
  // its syntax error at `$$x$$`, the string, not at the number). These bodies
  // are DATA, held by a non-procedural statement, and must stay out of the
  // inventory or the guard cries wolf on every seed file.
  assert.deepEqual(scanDestructiveSql('INSERT INTO t VALUES (1$$DROP TABLE users$$);'), []);
  assert.deepEqual(scanDestructiveSql('INSERT INTO t VALUES ($y$DROP TABLE users$y$);'), []);
  // Such a body hides its own semicolons too, so this is ONE statement and
  // nothing inside it is ever offered to the rules. Widening the identifier
  // rule to swallow `$` after a DIGIT as well would split here instead.
  assert.deepEqual(splitSqlStatements('SELECT 1$$; DROP TABLE users; $$;'), ['SELECT 1$$; DROP TABLE users; $$']);
  // An identifier ending in `$`, followed by a real dollar-quoted string.
  assert.deepEqual(
    scanDestructiveSql('SELECT f$($$DROP TABLE users$$); DROP TABLE audit;').map((h) => h.target),
    ['audit'],
  );
  // A bind placeholder is not a tag: its first character is a digit.
  assert.deepEqual(splitSqlStatements('UPDATE t SET x = $1 WHERE id = $2; DROP TABLE users;'), [
    'UPDATE t SET x = $1 WHERE id = $2',
    'DROP TABLE users',
  ]);
});

test('a comment inside a procedural body is removed by the tokenizer, not by a regex', () => {
  // The candidate scanner used to strip a body's comments with two regexes,
  // the exact hand-written lexer this guard was rewritten to delete, left one
  // level down on the path that exists specifically to catch dynamic SQL.
  // Neither pattern respects string literals, so ONE earlier literal holding a
  // comment marker blanked every destructive statement after it. Both of these
  // reported an empty inventory and dropped the table on the real server.
  assert.deepEqual(
    scanDestructiveSql(`DO $$ DECLARE s text := 'x --'; BEGIN EXECUTE 'DROP TABLE users'; END $$;`).map((h) => [
      h.kind,
      h.target,
    ]),
    [['drop-table', 'users']],
  );
  assert.deepEqual(
    scanDestructiveSql(
      `DO $$ DECLARE s text := 'a /*'; BEGIN EXECUTE 'DROP TABLE users'; RAISE NOTICE '% b */', s; END $$;`,
    ).map((h) => [h.kind, h.target]),
    [['drop-table', 'users']],
  );
  // The `--` shape is the one that is reachable by ACCIDENT rather than by
  // malice: any single-line body whose earlier literal contains a `--` (a date
  // range, a separator, a placeholder) hid everything that followed it.
});

test('a genuinely commented-out statement inside a body stays out of the inventory', () => {
  // Comments still have to come out, and the NESTING rule applies inside a body
  // exactly as it does outside one. The lazy regex ended the block comment at
  // the first `*/` and exposed the DROP, which is the tolerated direction but
  // is still the guard describing a file the server does not see.
  assert.deepEqual(scanDestructiveSql('DO $$ BEGIN -- DROP TABLE users\n PERFORM 1; END $$;'), []);
  assert.deepEqual(scanDestructiveSql('DO $$ BEGIN /* a /* b */ DROP TABLE users; */ PERFORM 1; END $$;'), []);
});

test('a BEGIN ATOMIC routine body is one statement, and its contents are scanned', () => {
  // A PG14+ SQL-standard body holds its own semicolons. Splitting there left
  // the first fragment headed `CREATE FUNCTION`, which matches no rule, and the
  // rest headless, so a function whose entire job is to empty a table reported
  // a clean inventory (it creates, runs, and leaves zero rows on the server).
  const sql = 'CREATE FUNCTION purge() RETURNS void LANGUAGE SQL BEGIN ATOMIC DELETE FROM users; END;';
  assert.deepEqual(splitSqlStatements(sql), [sql.slice(0, -1)]);
  const hits = scanDestructiveSql(sql);
  assert.deepEqual(
    hits.map((h) => [h.kind, h.target]),
    [['delete', 'users']],
  );
  assert.match(hits[0]?.statement ?? '', /in block: DELETE FROM users/);
});

test('a CASE inside a BEGIN ATOMIC body does not end it early', () => {
  // `CASE ... END` is the only other `END` a SQL-standard body can hold, and it
  // nests, so the body's own `END` is found by counting rather than by taking
  // the first one. Ending early would hand the rules headless fragments again.
  const sql =
    'CREATE OR REPLACE PROCEDURE p() LANGUAGE SQL BEGIN ATOMIC ' +
    'SELECT CASE WHEN true THEN CASE WHEN false THEN 1 ELSE 2 END ELSE 3 END; ' +
    'DELETE FROM users; END; DROP TABLE audit;';
  assert.equal(splitSqlStatements(sql).length, 2);
  assert.deepEqual(
    scanDestructiveSql(sql).map((h) => [h.kind, h.target]),
    [
      ['delete', 'users'],
      ['drop-table', 'audit'],
    ],
  );
});

test('a BEGIN ATOMIC body that never closes is still handed to the scanner', () => {
  // A file that ends mid-routine. Dropping the body would be the fail-open
  // direction: it is executable SQL and no other path scans it, whereas keeping
  // it costs at most a confirmation prompt on a file that cannot run anyway.
  assert.deepEqual(
    scanDestructiveSql('CREATE FUNCTION purge() RETURNS void LANGUAGE SQL BEGIN ATOMIC DELETE FROM users;').map((h) => [
      h.kind,
      h.target,
    ]),
    [['delete', 'users']],
  );
});

test('BEGIN and ATOMIC mean a body only when adjacent, and only after CREATE FUNCTION', () => {
  // Both words are UNRESERVED: `RETURNS TABLE (begin int, atomic int)` is a
  // legal header, verified on the server. Entering body mode there would stop
  // treating semicolons as terminators until the next `END` and swallow every
  // statement in between, which is the fail-OPEN direction. The guard for that
  // is adjacency (whitespace and comments aside) plus the statement head.
  const header =
    'CREATE FUNCTION hdr() RETURNS TABLE (begin int, atomic int) LANGUAGE sql AS $$ SELECT 1, 2 $$; DROP TABLE users;';
  assert.equal(splitSqlStatements(header).length, 2);
  assert.deepEqual(
    scanDestructiveSql(header).map((h) => h.kind),
    ['drop-table'],
  );
  // ...and a statement that is not a routine definition never enters body mode
  // however its words happen to line up.
  assert.deepEqual(
    scanDestructiveSql('SELECT begin ATOMIC FROM t; DROP TABLE users;').map((h) => h.kind),
    ['drop-table'],
  );
});

// ---------------------------------------------------------------------------
// Widened rule set
// ---------------------------------------------------------------------------

test('flags DROP <object> ... CASCADE, which takes dependent columns with it', () => {
  assert.deepEqual(
    scanDestructiveSql(`
      DROP TYPE order_status CASCADE;
      DROP DOMAIN us_postal_code CASCADE;
      DROP EXTENSION postgis CASCADE;
      DROP SEQUENCE order_seq CASCADE;
      DROP FUNCTION calc(int) CASCADE;
      DROP ROUTINE helper CASCADE;
      DROP AGGREGATE median(numeric) CASCADE;
      DROP PROCEDURE nightly() CASCADE;
    `).map((h) => [h.kind, h.target]),
    [
      ['drop-cascade', 'TYPE order_status'],
      ['drop-cascade', 'DOMAIN us_postal_code'],
      ['drop-cascade', 'EXTENSION postgis'],
      ['drop-cascade', 'SEQUENCE order_seq'],
      ['drop-cascade', 'FUNCTION calc'],
      ['drop-cascade', 'ROUTINE helper'],
      ['drop-cascade', 'AGGREGATE median'],
      ['drop-cascade', 'PROCEDURE nightly'],
    ],
  );
});

test('does NOT flag the same drops without CASCADE', () => {
  // Without CASCADE, Postgres refuses the drop while a dependency exists, so
  // nothing can be lost. The presence of CASCADE is the entire rule.
  assert.deepEqual(
    scanDestructiveSql(`
      DROP TYPE order_status;
      DROP SEQUENCE order_seq RESTRICT;
      DROP FUNCTION IF EXISTS calc(int);
    `),
    [],
  );
});

test('flags ALTER TABLE ... DETACH PARTITION', () => {
  assert.deepEqual(
    scanDestructiveSql('ALTER TABLE orders DETACH PARTITION orders_2024;').map((h) => [h.kind, h.target]),
    [['detach-partition', 'orders.orders_2024']],
  );
  // ATTACH adds rows rather than removing them.
  assert.deepEqual(scanDestructiveSql('ALTER TABLE orders ATTACH PARTITION orders_2026 FOR VALUES IN (2026);'), []);
});

test('flags EXPLAIN ANALYZE of a DML statement, which really executes it', () => {
  assert.deepEqual(
    scanDestructiveSql(`
      EXPLAIN ANALYZE DELETE FROM users;
      EXPLAIN (ANALYZE, BUFFERS) TRUNCATE events;
      EXPLAIN ANALYZE VERBOSE UPDATE accounts SET balance = 0;
      EXPLAIN ANALYSE DELETE FROM sessions;
    `).map((h) => [h.kind, h.target]),
    [
      ['delete', 'users'],
      ['truncate', 'events'],
      ['update-without-where', 'accounts'],
      ['delete', 'sessions'],
    ],
  );
  // The inventory shows the operator what they actually wrote.
  assert.match(scanDestructiveSql('EXPLAIN ANALYZE DELETE FROM users;')[0]?.statement ?? '', /^EXPLAIN ANALYZE DELETE/);
});

test('does NOT flag a plain EXPLAIN, which only plans', () => {
  assert.deepEqual(
    scanDestructiveSql(`
      EXPLAIN DELETE FROM users;
      EXPLAIN (COSTS OFF) UPDATE accounts SET balance = 0;
      EXPLAIN SELECT * FROM users;
    `),
    [],
  );
});

test('flags a table or column RENAME', () => {
  assert.deepEqual(
    scanDestructiveSql(`
      ALTER TABLE my_table RENAME COLUMN old_col TO old_col_retired;
      ALTER TABLE my_table RENAME new_col TO old_col;
      ALTER TABLE ONLY public.my_table RENAME TO my_table_v2;
    `).map((h) => [h.kind, h.target]),
    [
      ['rename', 'my_table.old_col'],
      ['rename', 'my_table.new_col'],
      ['rename', 'public.my_table'],
    ],
  );
});

test('does NOT flag RENAME CONSTRAINT, which no query names', () => {
  assert.deepEqual(scanDestructiveSql('ALTER TABLE my_table RENAME CONSTRAINT ck_old TO ck_new;'), []);
});

test('an ADD COLUMN whose name contains "drop" is not a column drop', () => {
  // A quoted identifier is kept verbatim in the stripped text, so the lazy
  // wildcard could start its `DROP ` match INSIDE the name and report
  // `t.me`: a pure false positive on a statement that only adds a column.
  assert.deepEqual(scanDestructiveSql('ALTER TABLE t ADD COLUMN "drop me" int;'), []);
  assert.deepEqual(scanDestructiveSql('ALTER TABLE t ADD COLUMN "alter this type" text;'), []);
  // A real DROP COLUMN alongside one is still caught.
  assert.deepEqual(
    scanDestructiveSql('ALTER TABLE t ADD COLUMN "drop me" int, DROP COLUMN real_col;').map((h) => [h.kind, h.target]),
    [['drop-column', 't.real_col']],
  );
});

// ---------------------------------------------------------------------------
// migrate up/down gate, integration (local scratch database ONLY; the suite
// is skipped entirely unless DATABASE_URL is set by the runner)
// ---------------------------------------------------------------------------

const DB_URL = process.env.DATABASE_URL;
const gated = skipGate(!DB_URL, 'DATABASE_URL not set');

/** Reset migration-tracking state between tests (each test uses throwaway temp files). */
async function resetTracking(): Promise<void> {
  const pg = (await import('pg')).default;
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  try {
    await client.query('DROP TABLE IF EXISTS _turbine_migrations');
  } finally {
    await client.end();
  }
}

gated.it('migrateUp refuses destructive migrations by default, applies with allowDestructive', async () => {
  await resetTracking();
  const dir = mkdtempSync(join(tmpdir(), 'turbine-destructive-'));
  try {
    writeFileSync(
      join(dir, '20260101000000_create_widgets.sql'),
      '-- UP\nCREATE TABLE _turbine_guard_widgets (id serial PRIMARY KEY, name text);\n\n-- DOWN\nDROP TABLE _turbine_guard_widgets;\n',
    );
    // First file is safe, applies fine.
    const first = await migrateUp(DB_URL!, dir);
    assert.equal(first.applied.length, 1);
    assert.equal(first.errors.length, 0);

    // Second file is destructive, must be refused by default...
    writeFileSync(
      join(dir, '20260101000001_drop_widgets.sql'),
      '-- UP\nDROP TABLE _turbine_guard_widgets;\n\n-- DOWN\n-- nothing\n',
    );
    await assert.rejects(() => migrateUp(DB_URL!, dir), /DESTRUCTIVE/);

    // ...and the refusal must have applied NOTHING (still pending).
    const retry = await migrateUp(DB_URL!, dir, { allowDestructive: true });
    assert.equal(retry.applied.length, 1);
    assert.equal(retry.applied[0]?.filename, '20260101000001_drop_widgets.sql');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

gated.it('migrateDown refuses destructive DOWN sections by default', async () => {
  await resetTracking();
  const dir = mkdtempSync(join(tmpdir(), 'turbine-destructive-down-'));
  try {
    writeFileSync(
      join(dir, '20260102000000_create_gadgets.sql'),
      '-- UP\nCREATE TABLE _turbine_guard_gadgets (id serial PRIMARY KEY);\n\n-- DOWN\nDROP TABLE _turbine_guard_gadgets;\n',
    );
    const up = await migrateUp(DB_URL!, dir);
    assert.equal(up.applied.length, 1);

    // DOWN contains DROP TABLE, refused by default, succeeds with the opt-in.
    await assert.rejects(() => migrateDown(DB_URL!, dir), /DESTRUCTIVE/);
    const down = await migrateDown(DB_URL!, dir, { allowDestructive: true });
    assert.equal(down.rolledBack.length, 1);
    assert.equal(down.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Runtime-assembled dynamic DDL
//
// The rules all need a parseable object name, and dynamic SQL has none until it
// runs, so a procedural body that BUILDS its statement matched nothing and the
// operator was shown a clean inventory. All three shapes below were executed on
// PostgreSQL 16 during the review that found this: the table was gone and the
// guard had reported nothing. That is the module's defining failure, the
// operator confirming what they were shown while something else runs under the
// confirmation, so these are reported with an explicit unknown target.
//
// The gate is evidence of runtime ASSEMBLY (`||`, `format(`, `quote_ident(`, a
// `%I` placeholder), not the verb alone. That is complete rather than
// heuristic: a destructive statement with a literal object name already matches
// a rule, so being dynamic REQUIRES concatenating or formatting. The negative
// cases below are the reason the gate exists at all, since a guard that fires
// on `RAISE NOTICE 'DROP the mic'` teaches operators to confirm without reading.
// ---------------------------------------------------------------------------

test('dynamic DDL: format() with an %I placeholder is reported', () => {
  const hits = scanDestructiveSql(`DO $$ BEGIN EXECUTE format('DROP TABLE %I', 'users'); END $$;`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, 'drop-table');
  assert.match(hits[0]!.target, /run time/);
});

test('dynamic DDL: string concatenation is reported', () => {
  const hits = scanDestructiveSql(`DO $$ BEGIN EXECUTE 'DROP TABLE ' || quote_ident('users'); END $$;`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, 'drop-table');
});

test('dynamic DDL: a split verb reports the honest kind, not drop-cascade', () => {
  // `'DROP ' || 'TABLE users'` hides the object KEYWORD in the expression, so
  // what is dropped is unknowable. It must not borrow `drop-cascade`, whose
  // label claims dependent objects go too: that would be a false factual claim
  // about the operator's migration on a safety prompt.
  const hits = scanDestructiveSql(`DO $$ BEGIN EXECUTE 'DROP ' || 'TABLE users'; END $$;`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, 'dynamic-destructive');
});

test('dynamic DDL: a statement assembled into a variable before EXECUTE is reported', () => {
  const hits = scanDestructiveSql(`DO $$ DECLARE s text; BEGIN s := 'DROP TABLE ' || 'users'; EXECUTE s; END $$;`);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.kind, 'drop-table');
});

test('dynamic DDL: TRUNCATE and DELETE are covered too', () => {
  assert.equal(scanDestructiveSql(`DO $$ BEGIN EXECUTE format('TRUNCATE %I', 't'); END $$;`)[0]?.kind, 'truncate');
  assert.equal(
    scanDestructiveSql(`DO $$ BEGIN EXECUTE 'DELETE FROM ' || quote_ident('t'); END $$;`)[0]?.kind,
    'delete',
  );
});

test('dynamic DDL: a literal object name still names its target exactly', () => {
  // The control. The unknown-target path must never take over a case a rule can
  // answer precisely, or every inventory degrades to "something, somewhere".
  const hits = scanDestructiveSql(`DO $$ BEGIN EXECUTE 'DROP TABLE users'; END $$;`);
  assert.equal(hits.length, 1);
  assert.deepEqual([hits[0]!.kind, hits[0]!.target], ['drop-table', 'users']);
});

test('dynamic DDL: non-destructive and non-SQL uses of the verbs stay silent', () => {
  for (const sql of [
    `DO $$ BEGIN RAISE NOTICE 'DROP the mic'; END $$;`,
    `DO $$ BEGIN EXECUTE format('SELECT * FROM %I', 'users'); END $$;`,
    `DO $$ BEGIN EXECUTE 'REFRESH MATERIALIZED VIEW ' || quote_ident('mv'); END $$;`,
    `DO $$ BEGIN EXECUTE 'UPDATE t SET a=1 WHERE id=' || 1; END $$;`,
    `INSERT INTO t VALUES ($$DROP TABLE users$$);`,
  ]) {
    assert.deepEqual(scanDestructiveSql(sql), [], `should not flag: ${sql}`);
  }
});

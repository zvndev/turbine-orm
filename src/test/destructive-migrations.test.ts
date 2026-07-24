import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { scanDestructiveSql } from '../cli/destructive.js';
import { migrateDown, migrateUp } from '../cli/migrate.js';
import { skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Scanner — pure unit tests
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
// migrate up/down gate — integration (local scratch database ONLY; the suite
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
    // First file is safe — applies fine.
    const first = await migrateUp(DB_URL!, dir);
    assert.equal(first.applied.length, 1);
    assert.equal(first.errors.length, 0);

    // Second file is destructive — must be refused by default...
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

    // DOWN contains DROP TABLE — refused by default, succeeds with the opt-in.
    await assert.rejects(() => migrateDown(DB_URL!, dir), /DESTRUCTIVE/);
    const down = await migrateDown(DB_URL!, dir, { allowDestructive: true });
    assert.equal(down.rolledBack.length, 1);
    assert.equal(down.errors.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

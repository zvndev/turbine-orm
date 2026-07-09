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

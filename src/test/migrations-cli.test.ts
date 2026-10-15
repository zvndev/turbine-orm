/**
 * The migration commands, through the real CLI entry point (a subprocess), against
 * a live Postgres:
 *
 *   - `push --dry-run --exit-code` and `migrate status --exit-code` exit 2 on drift
 *     and keep their old exit codes without the flag
 *   - `migrate create --auto` / `--from-diff` refuse while migrations are pending
 *   - migration filenames are UTC in any time zone
 *   - a lossless widening applies without the destructive prompt; a narrowing does not
 *   - a dropped column's DOWN says it cannot be restored, and `migrate down` says so too
 *   - `migrate deploy --wait` waits for the advisory lock and then finds nothing left to do
 *   - "in sync" lists what was not compared
 *
 * Each describe works in its own Postgres schema (`schema` in the project's
 * config), so nothing outside it is read or written. The advisory lock is per
 * database, so the lock test must not run beside another migrate run on the
 * same database: this repo's `npm test` runs files one at a time.
 *
 * Run: DATABASE_URL=... npx tsx --test --test-concurrency=1 src/test/migrations-cli.test.ts
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { deriveLockId } from '../cli/migrate.js';
import { stripAnsi } from '../cli/ui.js';
import { CLI_ENTRY, makeProject, type Project, REPO_ROOT, SRC } from './codegen-cli-fixture.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const live = skipGate(!DATABASE_URL, 'requires DATABASE_URL');
const TSX_LOADER = pathToFileURL(join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const SUFFIX = `${process.pid}_${Date.now().toString(36)}`;

interface Fixture {
  pgSchema: string;
  pool: pg.Pool;
  project: Project;
  /** Write turbine/schema.ts from a table body (columns, one per line). */
  schema(usersBody: string, extraTables?: string): void;
  /** Write a migration file and return its path. */
  migration(name: string, up: string, down?: string): string;
  migrationFiles(): string[];
  cleanup(): Promise<void>;
}

async function fixture(tag: string): Promise<Fixture> {
  const pgSchema = `mig_cli_${tag}_${SUFFIX}`;
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
  await pool.query(`CREATE SCHEMA "${pgSchema}"`);
  const project = makeProject(`mig-${tag}`, { databaseUrl: DATABASE_URL });
  project.write('turbine.config.js', `export default { schema: ${JSON.stringify(pgSchema)} };\n`);
  const dir = join(project.dir, 'turbine', 'migrations');
  return {
    pgSchema,
    pool,
    project,
    schema(usersBody, extraTables = '') {
      project.write(
        'turbine/schema.ts',
        `import { defineSchema } from ${JSON.stringify(SRC.schemaBuilder)};\n` +
          `export default defineSchema({\n  users: {\n${usersBody}\n  },\n${extraTables}});\n`,
      );
    },
    migration(name, up, down = '-- (none)') {
      const file = join(dir, name);
      project.write(`turbine/migrations/${name}`, `-- UP\n${up}\n\n-- DOWN\n${down}\n`);
      return file;
    },
    migrationFiles: () =>
      existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.sql'))
            .sort()
        : [],
    async cleanup() {
      await pool.query(`DROP SCHEMA IF EXISTS "${pgSchema}" CASCADE`);
      await pool.end();
      project.cleanup();
    },
  };
}

const ID = `    id: { type: 'serial', primaryKey: true },`;
const EMAIL = `    email: { type: 'text', notNull: true },`;

// ---------------------------------------------------------------------------
// push --dry-run --exit-code
// ---------------------------------------------------------------------------

describe('turbine push --dry-run --exit-code', () => {
  let f: Fixture;

  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('push');
    f.schema(`${ID}\n${EMAIL}`);
  });
  after(async () => {
    await f?.cleanup();
  });

  live.it('exits 2 when the database differs from the schema file', () => {
    const run = f.project.cli(['push', '--dry-run', '--exit-code']);
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /Dry run, no changes applied/);
    assert.match(run.output, /differs from the schema file/);
  });

  live.it('keeps exit 0 for the same drift when the flag is absent', () => {
    const run = f.project.cli(['push', '--dry-run']);
    assert.equal(run.status, 0, run.output);
  });

  live.it('refuses --exit-code without --dry-run, and changes nothing', async () => {
    const run = f.project.cli(['push', '--exit-code']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /--exit-code.*needs.*--dry-run/);
    const tables = await f.pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [f.pgSchema]);
    assert.equal(tables.rowCount, 0, 'the refused run must not have pushed');
  });

  live.it('exits 0 once the database matches, and says what it did not compare', () => {
    const push = f.project.cli(['push']);
    assert.equal(push.status, 0, push.output);
    const run = f.project.cli(['push', '--dry-run', '--exit-code']);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /already in sync/);
    assert.match(run.output, /Not compared/);
    assert.match(run.output, /primary keys, multi-column UNIQUE constraints/);
  });

  live.it('an index that exists but is not listed is named under "Not compared"', async () => {
    await f.pool.query(`CREATE INDEX hand_made ON "${f.pgSchema}".users (lower(email))`);
    const run = f.project.cli(['push', '--dry-run', '--exit-code']);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /indexes on "users" \(hand_made\)/);
    await f.pool.query(`DROP INDEX "${f.pgSchema}".hand_made`);
  });

  live.it('a difference push cannot apply is not called "in sync", and fails the gate', async () => {
    f.schema(`${ID}\n${EMAIL}\n    indexes: [{ columns: ['email'], name: 'users_email_lookup' }],`);
    assert.equal(f.project.cli(['push']).status, 0);
    await f.pool.query(`DROP INDEX "${f.pgSchema}".users_email_lookup`);
    await f.pool.query(`CREATE UNIQUE INDEX users_email_lookup ON "${f.pgSchema}".users (email)`);
    const run = f.project.cli(['push', '--dry-run', '--exit-code']);
    assert.equal(run.status, 2, run.output);
    assert.doesNotMatch(run.output, /already in sync/);
    assert.match(run.output, /not fully in sync/);
    assert.match(run.output, /users_email_lookup/);
    await f.pool.query(`DROP INDEX "${f.pgSchema}".users_email_lookup`);
    f.schema(`${ID}\n${EMAIL}`);
  });

  live.it('an extra table in the database is a difference', async () => {
    f.schema(`${ID}\n${EMAIL}`);
    await f.pool.query(`CREATE TABLE "${f.pgSchema}".leftover (id int)`);
    const run = f.project.cli(['push', '--dry-run', '--exit-code']);
    assert.equal(run.status, 2, run.output);
    assert.match(run.output, /leftover/);
    await f.pool.query(`DROP TABLE "${f.pgSchema}".leftover`);
  });

  live.it('the tracking table Turbine itself creates is not an extra table', async () => {
    const status = f.project.cli(['migrate', 'status']);
    assert.equal(status.status, 0, status.output);
    f.migration('20260101000001_noop.sql', 'SELECT 1;');
    assert.equal(f.project.cli(['migrate', 'up']).status, 0);
    const run = f.project.cli(['push', '--dry-run', '--exit-code']);
    assert.equal(run.status, 0, run.output);
    assert.doesNotMatch(run.output, /_turbine_migrations/);
  });
});

// ---------------------------------------------------------------------------
// migrate status --exit-code
// ---------------------------------------------------------------------------

describe('turbine migrate status --exit-code', () => {
  let f: Fixture;
  let one: string;
  let two: string;

  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('status');
    one = f.migration('20260101000001_one.sql', 'CREATE TABLE one (id int);', 'DROP TABLE one;');
    two = f.migration('20260101000002_two.sql', 'CREATE TABLE two (id int);', 'DROP TABLE two;');
  });
  after(async () => {
    await f?.cleanup();
  });

  live.it('pending migrations: exit 2 with the flag, exit 0 without it', () => {
    const gate = f.project.cli(['migrate', 'status', '--exit-code']);
    assert.equal(gate.status, 2, gate.output);
    assert.match(gate.output, /2 pending/);
    const plain = f.project.cli(['migrate', 'status']);
    assert.equal(plain.status, 0, plain.output);
  });

  live.it('a clean history exits 0 with the flag', () => {
    const up = f.project.cli(['migrate', 'up']);
    assert.equal(up.status, 0, up.output);
    const gate = f.project.cli(['migrate', 'status', '--exit-code']);
    assert.equal(gate.status, 0, gate.output);
  });

  live.it('an applied file modified afterwards: exit 2 with the flag, exit 0 without it', () => {
    const original = readFileSync(one, 'utf-8');
    writeFileSync(one, `${original}\n-- edited after it was applied\n`);
    try {
      const gate = f.project.cli(['migrate', 'status', '--exit-code']);
      assert.equal(gate.status, 2, gate.output);
      assert.match(gate.output, /modified after being applied/);
      const plain = f.project.cli(['migrate', 'status']);
      assert.equal(plain.status, 0, plain.output);
    } finally {
      writeFileSync(one, original);
    }
  });

  live.it('an applied file deleted afterwards: exit 2 with the flag, exit 0 without it', () => {
    const original = readFileSync(two, 'utf-8');
    rmSync(two);
    try {
      const gate = f.project.cli(['migrate', 'status', '--exit-code']);
      assert.equal(gate.status, 2, gate.output);
      assert.match(gate.output, /missing from disk/);
      const plain = f.project.cli(['migrate', 'status']);
      assert.equal(plain.status, 0, plain.output);
    } finally {
      writeFileSync(two, original);
    }
  });

  live.it('restored, it is clean again', () => {
    assert.equal(f.project.cli(['migrate', 'status', '--exit-code']).status, 0);
  });

  live.it('is refused on subcommands it would do nothing on', () => {
    for (const sub of ['up', 'deploy', 'down']) {
      const run = f.project.cli(['migrate', sub, '--exit-code']);
      assert.equal(run.status, 1, `${sub}: ${run.output}`);
      assert.match(run.output, /--exit-code.*only applies to.*migrate status/);
    }
  });
});

// ---------------------------------------------------------------------------
// migrate create --auto while migrations are pending
// ---------------------------------------------------------------------------

describe('turbine migrate create --auto with pending migrations', () => {
  let f: Fixture;

  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('pending');
    f.schema(`${ID}\n${EMAIL}`);
    assert.equal(f.project.cli(['push']).status, 0);
  });
  after(async () => {
    await f?.cleanup();
  });

  live.it("refuses while a teammate's migration is pending, and writes nothing", () => {
    // A teammate added `bio`: the schema file has it, their migration is in the
    // folder, and this database has not run it yet.
    f.migration(
      '20260101000001_add_bio.sql',
      'ALTER TABLE users ADD COLUMN bio text;',
      'ALTER TABLE users DROP COLUMN bio;',
    );
    f.schema(`${ID}\n${EMAIL}\n    bio: { type: 'text' },\n    avatar: { type: 'text' },`);

    for (const flag of ['--auto', '--from-diff']) {
      const run = f.project.cli(['migrate', 'create', 'add_avatar', flag]);
      assert.equal(run.status, 1, `${flag}: ${run.output}`);
      assert.match(run.output, /Refusing to create a migration with/);
      assert.match(run.output, /20260101000001_add_bio\.sql/);
      assert.match(run.output, /npx turbine migrate up/);
      assert.match(run.output, /--allow-pending/);
      assert.deepEqual(f.migrationFiles(), ['20260101000001_add_bio.sql'], `${flag} must not write a file`);
    }
  });

  live.it('--allow-pending proceeds, and the file repeats the pending change (the hazard it warns about)', () => {
    const run = f.project.cli(['migrate', 'create', 'add_avatar', '--auto', '--allow-pending']);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /--allow-pending is set/);
    const created = f.migrationFiles().find((n) => n.endsWith('_add_avatar.sql'));
    assert.ok(created, f.migrationFiles().join(', '));
    const sql = readFileSync(join(f.project.dir, 'turbine', 'migrations', created), 'utf-8');
    assert.match(sql, /ADD COLUMN "bio"/);
    assert.match(sql, /ADD COLUMN "avatar"/);
    rmSync(join(f.project.dir, 'turbine', 'migrations', created));
  });

  live.it('once the pending migration is applied, --auto writes only what is new', () => {
    assert.equal(f.project.cli(['migrate', 'up']).status, 0);
    const run = f.project.cli(['migrate', 'create', 'add_avatar', '--auto']);
    assert.equal(run.status, 0, run.output);
    const created = f.migrationFiles().find((n) => n.endsWith('_add_avatar.sql'));
    assert.ok(created);
    const sql = readFileSync(join(f.project.dir, 'turbine', 'migrations', created), 'utf-8');
    assert.match(sql, /ADD COLUMN "avatar"/);
    assert.doesNotMatch(sql, /ADD COLUMN "bio"/);
    // The generated file now applies cleanly on top of the teammate's.
    assert.equal(f.project.cli(['migrate', 'up']).status, 0);
  });

  live.it('--allow-pending on its own (no --auto) is refused as meaningless', () => {
    const run = f.project.cli(['migrate', 'create', 'plain', '--allow-pending']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /--allow-pending.*only applies to.*--auto/);
  });

  live.it('with no pending migrations and no difference it says "in sync", listing what it did not compare', () => {
    const run = f.project.cli(['migrate', 'create', 'nothing', '--auto']);
    assert.equal(run.status, 0, run.output);
    assert.match(run.output, /already in sync: nothing to migrate/);
    assert.match(run.output, /Not compared/);
  });

  live.it('a difference it cannot write a statement for is reported as such, and no file is written', async () => {
    f.schema(
      `${ID}\n${EMAIL}\n    bio: { type: 'text' },\n    avatar: { type: 'text' },\n    indexes: [{ columns: ['email'], name: 'users_email_lookup' }],`,
    );
    assert.equal(f.project.cli(['push']).status, 0);
    await f.pool.query(`DROP INDEX "${f.pgSchema}".users_email_lookup`);
    await f.pool.query(`CREATE UNIQUE INDEX users_email_lookup ON "${f.pgSchema}".users (email)`);
    const before = f.migrationFiles();
    for (const flag of ['--auto', '--from-diff']) {
      const run = f.project.cli(['migrate', 'create', 'cannot', flag]);
      assert.equal(run.status, 0, `${flag}: ${run.output}`);
      assert.doesNotMatch(run.output, /already in sync/, flag);
      assert.match(run.output, /not fully in sync/, flag);
      assert.match(run.output, /users_email_lookup/, flag);
    }
    assert.deepEqual(f.migrationFiles(), before);
  });
});

// ---------------------------------------------------------------------------
// UTC filenames
// ---------------------------------------------------------------------------

describe('migration filenames are UTC in any time zone', () => {
  let f: Fixture;

  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('utc');
  });
  after(async () => {
    await f?.cleanup();
  });

  live.it('the filename stamp equals the UTC time in the header, from zones 19 hours apart', () => {
    const stamps: string[] = [];
    for (const [i, tz] of ['Pacific/Auckland', 'America/Los_Angeles'].entries()) {
      const run = f.project.cli(['migrate', 'create', `zone${i}`], { TZ: tz });
      assert.equal(run.status, 0, run.output);
      const file = f.migrationFiles().find((n) => n.endsWith(`_zone${i}.sql`));
      assert.ok(file, f.migrationFiles().join(', '));
      const stamp = file.slice(0, 14);
      const header = readFileSync(join(f.project.dir, 'turbine', 'migrations', file), 'utf-8').match(
        /-- Created: (\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/,
      );
      assert.ok(header, 'no Created header');
      assert.equal(stamp, header.slice(1, 7).join(''), `${tz}: the filename and the UTC header disagree`);
      stamps.push(stamp);
    }
    // Created seconds apart, so their stamps are seconds apart, not 19 hours.
    const [a, b] = stamps.map((s) => Number(s.slice(0, 10)));
    assert.ok(Math.abs(a! - b!) <= 1, `stamps ${stamps.join(' and ')} are not within the same hour`);
  });
});

// ---------------------------------------------------------------------------
// Widenings and the destructive gate, DROP COLUMN notes
// ---------------------------------------------------------------------------

describe('diff-generated migrations through migrate up / down', () => {
  let f: Fixture;
  const dir = () => join(f.project.dir, 'turbine', 'migrations');
  const newest = (suffix: string) => {
    const name = f.migrationFiles().find((n) => n.endsWith(suffix));
    assert.ok(name, `no ${suffix} in ${f.migrationFiles().join(', ')}`);
    return join(dir(), name);
  };
  const columnType = async (column: string) =>
    (
      await f.pool.query<{ t: string }>(
        `SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'users' AND a.attname = $2`,
        [f.pgSchema, column],
      )
    ).rows[0]?.t;

  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('diff');
    f.schema(`${ID}\n    qty: { type: 'integer' },\n    bio: { type: 'text' },`);
    assert.equal(f.project.cli(['push']).status, 0);
    await f.pool.query(`INSERT INTO "${f.pgSchema}".users (qty, bio) VALUES (7, 'hello')`);
  });
  after(async () => {
    await f?.cleanup();
  });

  live.it('a widening is marked, not flagged, and migrate up runs it with no confirmation', async () => {
    f.schema(`${ID}\n    qty: { type: 'bigint' },\n    bio: { type: 'text' },`);
    const create = f.project.cli(['migrate', 'create', 'widen', '--auto']);
    assert.equal(create.status, 0, create.output);
    // Only the reverse (BIGINT back to INTEGER) narrows, so UP is not flagged.
    assert.doesNotMatch(create.output, /UP\s+\[alter-column-type\]/);
    assert.match(create.output, /Only the DOWN section is destructive/);
    const sql = readFileSync(newest('_widen.sql'), 'utf-8');
    const upSection = sql.slice(0, sql.indexOf('-- DOWN'));
    assert.match(
      upSection,
      /-- turbine:widening INTEGER -> BIGINT\nALTER TABLE "users" ALTER COLUMN "qty" TYPE BIGINT;/,
    );
    assert.doesNotMatch(upSection, /-- !! DESTRUCTIVE/);
    assert.match(upSection, /Only the DOWN section is destructive/);

    // stdin is not a terminal here, so a destructive migration would be refused.
    const up = f.project.cli(['migrate', 'up']);
    assert.equal(up.status, 0, up.output);
    assert.equal(await columnType('qty'), 'bigint');
    const row = await f.pool.query(`SELECT qty::text FROM "${f.pgSchema}".users`);
    assert.equal(row.rows[0].qty, '7');
  });

  live.it('a narrowing is flagged, and migrate up refuses it', async () => {
    f.schema(`${ID}\n    qty: { type: 'smallint' },\n    bio: { type: 'text' },`);
    const create = f.project.cli(['migrate', 'create', 'narrow', '--auto']);
    assert.equal(create.status, 0, create.output);
    assert.match(create.output, /DESTRUCTIVE/);
    const up = f.project.cli(['migrate', 'up']);
    assert.equal(up.status, 1, up.output);
    assert.match(up.output, /alter-column-type/);
    assert.equal(await columnType('qty'), 'bigint');
  });

  live.it('a hand-added marker cannot excuse a narrowing', async () => {
    const file = newest('_narrow.sql');
    const sql = readFileSync(file, 'utf-8');
    writeFileSync(
      file,
      sql.replace(
        /(ALTER TABLE "users" ALTER COLUMN "qty" TYPE SMALLINT;)/,
        '-- turbine:widening BIGINT -> SMALLINT\n$1',
      ),
    );
    const up = f.project.cli(['migrate', 'up']);
    assert.equal(up.status, 1, up.output);
    assert.match(up.output, /alter-column-type/);
    writeFileSync(
      file,
      sql.replace(
        /(ALTER TABLE "users" ALTER COLUMN "qty" TYPE SMALLINT;)/,
        '-- turbine:widening INTEGER -> BIGINT\n$1',
      ),
    );
    const up2 = f.project.cli(['migrate', 'up']);
    assert.equal(up2.status, 1, `a marker that does not match the statement excused it: ${up2.output}`);
    rmSync(file);
    f.schema(`${ID}\n    qty: { type: 'bigint' },\n    bio: { type: 'text' },`);
  });

  live.it('a dropped column has an IRREVERSIBLE DOWN, and rolling it back says nothing was restored', async () => {
    f.schema(`${ID}\n    qty: { type: 'bigint' },`);
    const create = f.project.cli(['migrate', 'create', 'drop_bio', '--auto']);
    assert.equal(create.status, 0, create.output);
    const file = newest('_drop_bio.sql');
    const sql = readFileSync(file, 'utf-8');
    const down = sql.slice(sql.indexOf('-- DOWN'));
    assert.match(down, /-- IRREVERSIBLE: this migration drops "users"\."bio"/);
    assert.match(down, /-- ALTER TABLE "users" ADD COLUMN "bio" TEXT;/);

    const up = f.project.cli(['migrate', 'up', '--allow-destructive']);
    assert.equal(up.status, 0, up.output);
    assert.equal(await columnType('bio'), undefined);

    const rollback = f.project.cli(['migrate', 'down']);
    assert.equal(rollback.status, 0, rollback.output);
    assert.match(rollback.output, /DOWN section that runs no SQL/);
    assert.match(rollback.output, /20\d{12}_drop_bio\.sql/);
    assert.equal(await columnType('bio'), undefined, 'the column really was not restored');
  });
});

// ---------------------------------------------------------------------------
// migrate deploy --wait
// ---------------------------------------------------------------------------

describe('turbine migrate deploy --wait', () => {
  let f: Fixture;
  let holder: pg.Client;
  let lockId: number;

  /** Start the CLI without blocking, so the test can act while it runs. */
  function spawnCli(args: string[]) {
    const { NODE_TEST_CONTEXT: _omit, ...inherited } = process.env;
    const child = spawn(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, ...args], {
      cwd: f.project.dir,
      env: { ...inherited, DATABASE_URL },
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    const exit = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
    return { output: () => stripAnsi(out), exit, child };
  }

  async function until(condition: () => boolean, what: string, ms = 30_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const tableExists = async (name: string) =>
    (await f.pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [`"${f.pgSchema}"."${name}"`])).rows[0]
      .present;

  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('wait');
    holder = new pg.Client({ connectionString: DATABASE_URL });
    await holder.connect();
    const db = (await holder.query<{ current_database: string }>('SELECT current_database()')).rows[0]!
      .current_database;
    lockId = deriveLockId(db);
  });
  after(async () => {
    await holder?.end().catch(() => {});
    await f?.cleanup();
  });

  const holdLock = async () => {
    const r = await holder.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [lockId]);
    assert.equal(r.rows[0]!.locked, true, 'the test could not take the lock itself');
  };
  const releaseLock = async () => {
    await holder.query('SELECT pg_advisory_unlock($1)', [lockId]);
  };

  live.it('without --wait, a held lock still fails at once with exit 1', async () => {
    f.migration('20260101000001_first.sql', 'CREATE TABLE first_t (id int);');
    await holdLock();
    try {
      const run = f.project.cli(['migrate', 'deploy']);
      assert.equal(run.status, 1, run.output);
      assert.match(run.output, /another migration is already running/);
      assert.equal(await tableExists('first_t'), false);
    } finally {
      await releaseLock();
    }
  });

  live.it('waits for the lock, then applies what is still pending', async () => {
    await holdLock();
    const run = spawnCli(['migrate', 'deploy', '--wait=60']);
    try {
      await until(() => /holds the lock/.test(run.output()), 'the waiting notice');
      await new Promise((r) => setTimeout(r, 1500));
      assert.equal(run.child.exitCode, null, `it gave up instead of waiting:\n${run.output()}`);
      assert.equal(await tableExists('first_t'), false, 'nothing may run while the lock is held');
    } finally {
      await releaseLock();
    }
    assert.equal(await run.exit, 0, run.output());
    assert.equal(await tableExists('first_t'), true);
    assert.match(run.output(), /1 applied/);
  });

  live.it('if the holder did the work meanwhile, the waiter finds nothing pending and does not repeat it', async () => {
    const file = f.migration('20260101000002_second.sql', 'CREATE TABLE second_t (id int);');
    await holdLock();
    const run = spawnCli(['migrate', 'deploy', '--wait=60']);
    try {
      await until(() => /holds the lock/.test(run.output()), 'the waiting notice');
      // The holder applies the same migration itself, by hand, while it holds the lock.
      const hash = createHash('sha256').update(readFileSync(file, 'utf-8'), 'utf-8').digest('hex');
      await holder.query(`CREATE TABLE "${f.pgSchema}".second_t (id int)`);
      await holder.query(`INSERT INTO "${f.pgSchema}"._turbine_migrations (name, checksum) VALUES ($1, $2)`, [
        '20260101000002_second',
        hash,
      ]);
    } finally {
      await releaseLock();
    }
    assert.equal(await run.exit, 0, `the waiter re-ran a migration the holder applied:\n${run.output()}`);
    assert.match(run.output(), /0 applied|up to date/);
  });

  live.it('gives up after the wait, naming it', async () => {
    f.migration('20260101000003_third.sql', 'CREATE TABLE third_t (id int);');
    await holdLock();
    try {
      const started = Date.now();
      const run = spawnCli(['migrate', 'deploy', '--wait=2']);
      const code = await run.exit;
      assert.equal(code, 1, run.output());
      assert.match(run.output(), /within 2s/);
      assert.ok(Date.now() - started >= 2000, 'it did not wait the 2 seconds it was given');
      assert.equal(await tableExists('third_t'), false);
    } finally {
      await releaseLock();
    }
  });

  live.it('--wait is refused on subcommands that take no lock wait', () => {
    for (const sub of ['up', 'down', 'status']) {
      const run = f.project.cli(['migrate', sub, '--wait=5']);
      assert.equal(run.status, 1, `${sub}: ${run.output}`);
      assert.match(run.output, /--wait.*only applies to.*migrate deploy/);
    }
  });

  live.it('a bad --wait value is a usage error', () => {
    const run = f.project.cli(['migrate', 'deploy', '--wait=soon']);
    assert.equal(run.status, 1, run.output);
    assert.match(run.output, /positive whole number of seconds/);
  });
});

// ---------------------------------------------------------------------------
// The config file's adapter reaches the migration runner
// ---------------------------------------------------------------------------

describe('turbine migrate uses the config file adapter', () => {
  let f: Fixture;
  let lockLog: string;

  before(async () => {
    if (!DATABASE_URL) return;
    f = await fixture('adapter');
    lockLog = join(f.project.dir, 'lock.log');
    const adapters = join(REPO_ROOT, 'src', 'adapters', 'index.ts');
    // A recording adapter over the PostgreSQL one: it takes the same lock and
    // writes one line per call, so the test can see which adapter the CLI used.
    f.project.write(
      'turbine.config.js',
      `import { appendFileSync } from 'node:fs';\n` +
        `import { postgresql } from ${JSON.stringify(adapters)};\n` +
        `const log = (m) => appendFileSync(${JSON.stringify(lockLog)}, m + '\\n');\n` +
        `export default {\n` +
        `  schema: ${JSON.stringify(f.pgSchema)},\n` +
        `  adapter: {\n` +
        `    ...postgresql,\n` +
        `    name: 'recording',\n` +
        `    async acquireLock(client, id) { log('acquire'); return postgresql.acquireLock(client, id); },\n` +
        `    async releaseLock(client, id) { log('release'); return postgresql.releaseLock(client, id); },\n` +
        `  },\n` +
        `};\n`,
    );
  });
  after(async () => {
    await f?.cleanup();
  });

  const calls = (): string[] => (existsSync(lockLog) ? readFileSync(lockLog, 'utf-8').trim().split('\n') : []);

  live.it('migrate up, deploy and down each lock through it', () => {
    f.migration('20260101000001_first.sql', 'CREATE TABLE adapter_one (id int);', 'DROP TABLE adapter_one;');
    const up = f.project.cli(['migrate', 'up']);
    assert.equal(up.status, 0, up.output);
    assert.deepEqual(calls(), ['acquire', 'release'], 'migrate up did not use the configured adapter');

    f.migration('20260101000002_second.sql', 'CREATE TABLE adapter_two (id int);', 'DROP TABLE adapter_two;');
    const deploy = f.project.cli(['migrate', 'deploy']);
    assert.equal(deploy.status, 0, deploy.output);
    assert.deepEqual(calls().slice(2), ['acquire', 'release'], 'migrate deploy did not use the configured adapter');

    const down = f.project.cli(['migrate', 'down', '--allow-destructive']);
    assert.equal(down.status, 0, down.output);
    assert.deepEqual(calls().slice(4), ['acquire', 'release'], 'migrate down did not use the configured adapter');
  });
});

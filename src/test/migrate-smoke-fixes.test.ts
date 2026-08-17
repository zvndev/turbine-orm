/**
 * turbine-orm regression coverage for the migrations smoke-audit fixes.
 *
 * Pure tests always run. Live tests are gated on DATABASE_URL via skipGate and
 * manage their own scratch tables + tracking table so they never touch fixtures.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/migrate-smoke-fixes.test.ts
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { buildMigrateDeployOptions, parseArgs } from '../cli/index.js';
import {
  buildDiffMigrationBody,
  collectUpDestructive,
  createMigration,
  formatChecksumMismatchError,
  listMigrationFiles,
  migrateDeploy,
  migrateDown,
  migrateStatus,
  migrateUp,
  migrationTimestamp,
} from '../cli/migrate.js';
import { defineSchema } from '../schema-builder.js';
import { DestructivePushRefusal, schemaDiff, schemaPush } from '../schema-sql.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;

// ---------------------------------------------------------------------------
// Pure tests
// ---------------------------------------------------------------------------

describe('migrations smoke fixes (pure)', () => {
  it('fix #8: migrationTimestamp extracts the 14-digit prefix', () => {
    assert.equal(migrationTimestamp('20260722120000_add_users'), '20260722120000');
    assert.equal(migrationTimestamp('not_a_migration'), null);
    assert.equal(migrationTimestamp('2026_short'), null);
  });

  it('fix #4: buildDiffMigrationBody flags a DROP COLUMN in the UP direction', () => {
    // A destructive-only diff (a column removed from the schema) now carries the
    // DROP COLUMN in `statements`, so --auto/--from-diff both flag it inline.
    const body = buildDiffMigrationBody({
      statements: ['ALTER TABLE "users" DROP COLUMN "age";'],
      reverseStatements: [],
    });
    assert.equal(body.destructiveUp.length, 1);
    assert.equal(body.destructiveUp[0]!.kind, 'drop-column');
    assert.match(body.up, /!! DESTRUCTIVE \[drop-column\]/);
    assert.match(body.up, /ALTER TABLE "users" DROP COLUMN "age";/);
    // No reverse is derivable → the documented irreversible placeholder.
    assert.match(body.down, /irreversible/i);
  });

  it('fix #7: collectUpDestructive finds destructive UP statements across files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-collect-'));
    try {
      writeFileSync(join(dir, '20260101000000_safe.sql'), '-- UP\nCREATE TABLE t (id int);\n-- DOWN\nDROP TABLE t;\n');
      writeFileSync(join(dir, '20260101000100_drop.sql'), '-- UP\nDROP TABLE legacy;\n-- DOWN\n');
      const files = listMigrationFiles(dir);
      const offenders = collectUpDestructive(files);
      assert.equal(offenders.length, 1);
      assert.equal(offenders[0]!.file, '20260101000100_drop.sql');
      assert.equal(offenders[0]!.hits[0]!.kind, 'drop-table');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fix #8: drift remedy special-cases deleted files (no impossible roll-back)', () => {
    const missingOnly = formatChecksumMismatchError([
      { name: '20260101000000_x', expected: 'a', actual: '', type: 'missing' },
    ]);
    assert.match(missingOnly, /deleted files cannot be rolled back/);
    // With no modified files, the plain "roll back" line must NOT appear.
    assert.doesNotMatch(missingOnly, /Roll back the affected migrations with `npx turbine migrate down`, OR/);

    const modifiedOnly = formatChecksumMismatchError([
      { name: '20260101000000_y', expected: 'a', actual: 'b', type: 'modified' },
    ]);
    assert.match(modifiedOnly, /modified files only/);
    assert.doesNotMatch(modifiedOnly, /deleted files cannot be rolled back/);
  });

  it('fix #3: buildMigrateDeployOptions honors --allow-drift', () => {
    assert.equal(buildMigrateDeployOptions(parseArgs(['migrate', 'deploy'])).allowDrift, false);
    assert.equal(buildMigrateDeployOptions(parseArgs(['migrate', 'deploy', '--allow-drift'])).allowDrift, true);
  });
});

// ---------------------------------------------------------------------------
// Live tests
// ---------------------------------------------------------------------------

describe('migrations smoke fixes (live database)', () => {
  const { it: dbIt } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

  async function withClient<T>(fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
    const pg = await import('pg');
    const client = new pg.default.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }

  // Fresh tracking table per test so applied history never leaks between cases.
  async function resetTracking(): Promise<void> {
    await withClient(async (c) => {
      await c.query('DROP TABLE IF EXISTS _turbine_migrations');
    });
  }

  function freshDir(tag: string): string {
    const dir = mkdtempSync(join(tmpdir(), `turbine-fix-${tag}-`));
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  dbIt('fix #2: push surfaces a DROP COLUMN to the destructive gate', async () => {
    const table = `sf_push_${Date.now()}`;
    await withClient((c) => c.query(`CREATE TABLE "${table}" (id serial primary key, name text, legacy_col text)`));
    try {
      const schema = defineSchema({
        [table]: {
          id: { type: 'serial', primaryKey: true },
          name: { type: 'text' },
        },
      });

      // The DROP COLUMN is now IN the diff statements (not silently withheld).
      const diff = await schemaDiff(schema, DATABASE_URL!);
      assert.ok(
        diff.statements.some((s) => /DROP COLUMN "legacy_col"/.test(s)),
        `expected DROP COLUMN in statements, got:\n${diff.statements.join('\n')}`,
      );

      // Without opt-in, push refuses loudly instead of reporting "in sync".
      await assert.rejects(schemaPush(schema, DATABASE_URL!, { precomputedDiff: diff }), (err: unknown) => {
        assert.ok(err instanceof DestructivePushRefusal);
        assert.equal(err.destructive[0]!.kind, 'drop-column');
        return true;
      });

      // Column still present; the refusal applied nothing.
      const before = await withClient((c) =>
        c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'legacy_col'`, [
          table,
        ]),
      );
      assert.equal(before.rowCount, 1);

      // With opt-in, the drop actually runs.
      await schemaPush(schema, DATABASE_URL!, { allowDestructive: true, precomputedDiff: diff });
      const after = await withClient((c) =>
        c.query(`SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'legacy_col'`, [
          table,
        ]),
      );
      assert.equal(after.rowCount, 0);
    } finally {
      await withClient((c) => c.query(`DROP TABLE IF EXISTS "${table}"`));
    }
  });

  dbIt('fix #3: migrate deploy honors --allow-drift on a modified applied file', async () => {
    await resetTracking();
    const dir = freshDir('drift');
    try {
      const m1 = createMigration(dir, 'first', { up: 'SELECT 1;', down: 'SELECT 1;' });
      await migrateDeploy(DATABASE_URL!, dir);

      // Modify the applied file on disk → drift.
      writeFileSync(m1.path, '-- UP\nSELECT 2;\n-- DOWN\nSELECT 2;\n');
      createMigration(dir, 'second', { up: 'SELECT 3;', down: 'SELECT 3;' });

      // Without --allow-drift, deploy is blocked.
      await assert.rejects(migrateDeploy(DATABASE_URL!, dir), /drift/i);

      // With --allow-drift, the pending migration applies.
      const res = await migrateDeploy(DATABASE_URL!, dir, { allowDrift: true });
      assert.equal(res.applied.length, 1);
      assert.match(res.applied[0]!.filename, /_second\.sql$/);
    } finally {
      await resetTracking();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  dbIt('fix #6: migrate status lists applied migrations whose file was deleted', async () => {
    await resetTracking();
    const dir = freshDir('status');
    try {
      const m1 = createMigration(dir, 'keeper', { up: 'SELECT 1;', down: 'SELECT 1;' });
      const m2 = createMigration(dir, 'gone', { up: 'SELECT 1;', down: 'SELECT 1;' });
      await migrateDeploy(DATABASE_URL!, dir);

      // Delete one applied file from disk.
      unlinkSync(m2.path);

      const statuses = await migrateStatus(DATABASE_URL!, dir);
      const missing = statuses.filter((s) => s.missingFile);
      assert.equal(missing.length, 1);
      assert.equal(missing[0]!.file.name, m2.name);
      assert.equal(missing[0]!.applied, true);
      // The surviving file is still a normal applied entry.
      assert.ok(statuses.some((s) => s.file.name === m1.name && s.applied && !s.missingFile));
    } finally {
      await resetTracking();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  dbIt('fix #7: migrate deploy reports the destructive statements it runs', async () => {
    await resetTracking();
    const dir = freshDir('notice');
    try {
      await withClient((c) => c.query('CREATE TABLE IF NOT EXISTS sf_notice_target (id int)'));
      createMigration(dir, 'drop_it', { up: 'DROP TABLE sf_notice_target;', down: '' });

      const res = await migrateDeploy(DATABASE_URL!, dir);
      // Deploy proceeds by design, but the destructive statement is surfaced.
      assert.equal(res.applied.length, 1);
      assert.equal(res.destructive.length, 1);
      assert.equal(res.destructive[0]!.hits[0]!.kind, 'drop-table');
    } finally {
      await withClient((c) => c.query('DROP TABLE IF EXISTS sf_notice_target'));
      await resetTracking();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * A rollback batch is LIFO with no gaps. The middle migration has no DOWN
   * section, so the batch must stop after the newest and leave the OLDEST
   * migration's table standing. Before the fix it skipped the gap and rolled
   * back the oldest too, dropping a table whose rows the skipped migration had
   * seeded, and left the tracking table claiming only the middle one applied.
   */
  dbIt('migrate down stops at a gap instead of rolling back past it', async () => {
    await resetTracking();
    const dir = freshDir('down-gap');
    const base = `sf_gap_${Date.now()}`;
    try {
      writeFileSync(
        join(dir, '20260401000001_first.sql'),
        `-- UP\nCREATE TABLE "${base}_a" (id int);\n-- DOWN\nDROP TABLE "${base}_a";\n`,
      );
      writeFileSync(join(dir, '20260401000002_seed.sql'), `-- UP\nINSERT INTO "${base}_a" VALUES (1);\n-- DOWN\n`);
      writeFileSync(
        join(dir, '20260401000003_third.sql'),
        `-- UP\nCREATE TABLE "${base}_c" (id int);\n-- DOWN\nDROP TABLE "${base}_c";\n`,
      );

      const up = await migrateUp(DATABASE_URL!, dir, { allowDestructive: true });
      assert.equal(up.applied.length, 3, `expected 3 applied, got ${JSON.stringify(up.errors)}`);

      const down = await migrateDown(DATABASE_URL!, dir, { step: 3, allowDestructive: true });

      assert.deepEqual(
        down.rolledBack.map((f) => f.filename),
        ['20260401000003_third.sql'],
      );
      assert.equal(down.errors.length, 1);
      assert.match(down.errors[0]!.file.filename, /_seed\.sql$/);
      assert.match(down.errors[0]!.error, /No DOWN section/);

      // The oldest migration's table, and its seeded row, survive.
      const rows = await withClient((c) => c.query(`SELECT id FROM "${base}_a"`));
      assert.equal(rows.rowCount, 1);
    } finally {
      await withClient(async (c) => {
        await c.query(`DROP TABLE IF EXISTS "${base}_a"`);
        await c.query(`DROP TABLE IF EXISTS "${base}_c"`);
      });
      await resetTracking();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Same rule on the way up: a file with an empty UP section stops the batch. */
  dbIt('migrate up stops at a migration with an empty UP section', async () => {
    await resetTracking();
    const dir = freshDir('up-gap');
    const base = `sf_upgap_${Date.now()}`;
    try {
      writeFileSync(join(dir, '20260402000001_first.sql'), `-- UP\nCREATE TABLE "${base}_a" (id int);\n-- DOWN\n`);
      writeFileSync(join(dir, '20260402000002_empty.sql'), '-- UP\n-- DOWN\n');
      writeFileSync(join(dir, '20260402000003_third.sql'), `-- UP\nCREATE TABLE "${base}_c" (id int);\n-- DOWN\n`);

      const res = await migrateUp(DATABASE_URL!, dir, { allowDestructive: true });

      assert.deepEqual(
        res.applied.map((f) => f.filename),
        ['20260402000001_first.sql'],
      );
      assert.equal(res.errors.length, 1);
      assert.match(res.errors[0]!.file.filename, /_empty\.sql$/);

      // The third migration must NOT have been applied over the gap.
      const exists = await withClient((c) =>
        c.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [`${base}_c`]),
      );
      assert.equal(exists.rowCount, 0);
    } finally {
      await withClient(async (c) => {
        await c.query(`DROP TABLE IF EXISTS "${base}_a"`);
        await c.query(`DROP TABLE IF EXISTS "${base}_c"`);
      });
      await resetTracking();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * `migrate deploy` passes allowDestructive unconditionally, so the loose
   * `--DOWN` spelling folded a rollback section into the UP body and applied a
   * create-then-drop pair as one "successful" migration.
   */
  dbIt('migrate deploy does not run a --DOWN section as part of UP', async () => {
    await resetTracking();
    const dir = freshDir('marker');
    const table = `sf_marker_${Date.now()}`;
    try {
      writeFileSync(
        join(dir, '20260403000001_loose.sql'),
        `-- UP\nCREATE TABLE "${table}" (id int);\n--DOWN\nDROP TABLE "${table}";\n`,
      );

      const res = await migrateDeploy(DATABASE_URL!, dir);
      assert.equal(res.applied.length, 1);

      const exists = await withClient((c) =>
        c.query(`SELECT 1 FROM information_schema.tables WHERE table_name = $1`, [table]),
      );
      assert.equal(exists.rowCount, 1, 'the DOWN section must not have run as part of UP');
    } finally {
      await withClient((c) => c.query(`DROP TABLE IF EXISTS "${table}"`));
      await resetTracking();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Concurrent status calls on a fresh database must not race on the create. */
  dbIt('concurrent migrateStatus calls survive the tracking-table create race', async () => {
    await resetTracking();
    const dir = freshDir('race');
    try {
      const results = await Promise.allSettled(Array.from({ length: 12 }, () => migrateStatus(DATABASE_URL!, dir)));
      const rejected = results.filter((r) => r.status === 'rejected');
      // `String(result)` is "[object Object]" for a settled-result WRAPPER, so
      // the reason has to be reached explicitly. This test failed a release
      // with a message that named nothing.
      const why = rejected.map((r) => {
        const e = r.reason as { code?: string; message?: string } | undefined;
        return `${e?.code ?? 'no-code'}: ${e?.message ?? String(r.reason)}`;
      });
      assert.equal(rejected.length, 0, `all 12 should succeed, got: ${JSON.stringify(why)}`);
    } finally {
      await resetTracking();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  dbIt('fix #8: migrate up flags an out-of-order apply', async () => {
    await resetTracking();
    const dir = freshDir('ooo');
    try {
      // Apply a NEWER-timestamped migration first.
      const dropDir = freshDir('ooo-newer');
      const newer = createMigration(dropDir, 'newer', { up: 'SELECT 1;', down: 'SELECT 1;' });
      // Move it into the real dir under a high timestamp name.
      const newerName = '20990101000000_newer.sql';
      writeFileSync(join(dir, newerName), '-- UP\nSELECT 1;\n-- DOWN\nSELECT 1;\n');
      rmSync(dropDir, { recursive: true, force: true });
      void newer;
      await migrateUp(DATABASE_URL!, dir);

      // Now introduce an OLDER-timestamped migration and apply it.
      writeFileSync(join(dir, '20200101000000_older.sql'), '-- UP\nSELECT 1;\n-- DOWN\nSELECT 1;\n');
      const res = await migrateUp(DATABASE_URL!, dir);
      assert.equal(res.applied.length, 1);
      assert.equal(res.outOfOrder.length, 1);
      assert.equal(res.outOfOrder[0]!.applied, '20200101000000_older.sql');
      assert.equal(res.outOfOrder[0]!.newestPrior, newerName);
    } finally {
      await resetTracking();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

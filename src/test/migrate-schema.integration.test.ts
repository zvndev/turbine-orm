/**
 * `migrate up/down/status/deploy` honour the configured Postgres schema.
 *
 * The runner used to connect with the bare connection string, so a project on
 * `schema: 'app'` pushed its tables into `app`, diffed against `app`, and then
 * applied the migration that diff produced into `public`, tracking table
 * included, and reported success. The fix is the `options=-c search_path`
 * CONNECTION PARAMETER (never a session `SET`), applied by
 * `connectionStringForSchema` for every schema other than the default.
 *
 * Requires DATABASE_URL (a direct endpoint, never a pooler). Creates and drops
 * schema `qa78_ns`; every table it touches carries the `qa78_` prefix.
 *
 * Run: DATABASE_URL=... npx tsx --test src/test/migrate-schema.integration.test.ts
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import pg from 'pg';
import {
  connectionStringForSchema,
  inspectMigrationDeploy,
  migrateDown,
  migrateStatus,
  migrateUp,
} from '../cli/migrate.js';
import { skipGate } from './helpers.js';

const url = process.env.DATABASE_URL;
const gate = skipGate(!url, 'DATABASE_URL not set');

const SCHEMA = 'qa78_ns';
const PINNED_NAME = '20260906000001_qa78_create_t1';
const DEFAULT_NAME = '20260906000002_qa78_create_t1_default';

function writeMigration(dir: string, name: string, table: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${name}.sql`),
    `-- UP\nCREATE TABLE ${table} (id INTEGER PRIMARY KEY);\n\n-- DOWN\nDROP TABLE ${table};\n`,
  );
}

describe('migrate honours the configured schema (integration)', () => {
  let admin: pg.Client;
  let pinnedDir: string;
  let defaultDir: string;
  /** Whether `public._turbine_migrations` existed before this suite, so cleanup restores that state. */
  let publicTrackingExisted = false;
  /** Where an UNPINNED connection creates tables, read rather than assumed to be `public`. */
  let roleDefaultSchema = 'public';

  const tableSchemas = async (table: string): Promise<string[]> => {
    const r = await admin.query<{ table_schema: string }>(
      `SELECT table_schema FROM information_schema.tables WHERE table_name = $1 ORDER BY table_schema`,
      [table],
    );
    return r.rows.map((row) => row.table_schema);
  };

  const trackedNamesIn = async (schema: string): Promise<string[]> => {
    const exists = await admin.query<{ oid: string | null }>(`SELECT to_regclass($1)::text AS oid`, [
      `"${schema}"._turbine_migrations`,
    ]);
    if (exists.rows[0]?.oid == null) return [];
    const r = await admin.query<{ name: string }>(`SELECT name FROM "${schema}"._turbine_migrations ORDER BY name`);
    return r.rows.map((row) => row.name);
  };

  gate.before(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    roleDefaultSchema = (await admin.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
    publicTrackingExisted =
      (await admin.query<{ oid: string | null }>(`SELECT to_regclass('public._turbine_migrations')::text AS oid`))
        .rows[0]?.oid != null;
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pinnedDir = mkdtempSync(join(tmpdir(), 'turbine-qa78-pinned-'));
    defaultDir = mkdtempSync(join(tmpdir(), 'turbine-qa78-default-'));
    writeMigration(pinnedDir, PINNED_NAME, 'qa78_t1');
    writeMigration(defaultDir, DEFAULT_NAME, 'qa78_t1_default');
  });

  gate.after(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`DROP TABLE IF EXISTS "${roleDefaultSchema}".qa78_t1 CASCADE`);
    await admin.query(`DROP TABLE IF EXISTS "${roleDefaultSchema}".qa78_t1_default CASCADE`);
    for (const schema of new Set(['public', roleDefaultSchema])) {
      if ((await trackedNamesIn(schema)).length > 0 || schema !== 'public') {
        await admin.query(`DELETE FROM "${schema}"._turbine_migrations WHERE name = ANY($1)`, [
          [PINNED_NAME, DEFAULT_NAME],
        ]);
      }
    }
    // The unpinned status call below creates the public tracking table when it
    // is absent; leave the shared database as this suite found it.
    if (!publicTrackingExisted) await admin.query('DROP TABLE IF EXISTS public._turbine_migrations');
    await admin.end();
    rmSync(pinnedDir, { recursive: true, force: true });
    rmSync(defaultDir, { recursive: true, force: true });
  });

  gate.it(
    'migrateUp with `schema` creates the table AND the tracking table in that schema, nothing in public',
    async () => {
      const result = await migrateUp(url!, pinnedDir, { schema: SCHEMA });
      assert.deepEqual(result.errors, []);
      assert.equal(result.applied.length, 1, 'exactly one migration applied');

      assert.deepEqual(await tableSchemas('qa78_t1'), [SCHEMA], 'the migration DDL must land in the configured schema');
      assert.deepEqual(await trackedNamesIn(SCHEMA), [PINNED_NAME], 'the tracking table must live in the schema too');
      assert.ok(
        !(await trackedNamesIn('public')).includes(PINNED_NAME),
        'public must not record a migration that was applied to another schema',
      );
    },
  );

  gate.it('migrateStatus and inspectMigrationDeploy with the same option see it applied', async () => {
    const status = await migrateStatus(url!, pinnedDir, { schema: SCHEMA });
    assert.equal(status.length, 1);
    assert.equal(status[0]!.applied, true);
    assert.equal(status[0]!.checksumValid, true);

    const plan = await inspectMigrationDeploy(url!, pinnedDir, { schema: SCHEMA });
    assert.deepEqual(plan.pending, []);
    assert.deepEqual(plan.mismatches, []);
  });

  gate.it('without the option the same directory reads as PENDING: the two schemas do not share history', async () => {
    const status = await migrateStatus(url!, pinnedDir);
    assert.equal(status.length, 1);
    assert.equal(status[0]!.applied, false);
  });

  gate.it('migrateDown with `schema` rolls back in that schema', async () => {
    const result = await migrateDown(url!, pinnedDir, { schema: SCHEMA, allowDestructive: true });
    assert.deepEqual(result.errors, []);
    assert.equal(result.rolledBack.length, 1);
    assert.deepEqual(await tableSchemas('qa78_t1'), []);
    assert.deepEqual(await trackedNamesIn(SCHEMA), []);
  });

  gate.it('the default path is unchanged: no option means the role default schema, as before', async () => {
    const result = await migrateUp(url!, defaultDir);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(await tableSchemas('qa78_t1_default'), [roleDefaultSchema]);
    assert.ok((await trackedNamesIn(roleDefaultSchema)).includes(DEFAULT_NAME));
    assert.deepEqual(await trackedNamesIn(SCHEMA), [], 'the pinned schema must not see the default run');

    const down = await migrateDown(url!, defaultDir, { allowDestructive: true });
    assert.deepEqual(down.errors, []);
    assert.deepEqual(await tableSchemas('qa78_t1_default'), []);
  });

  gate.it('`public` emits no connection parameter at all (byte-identical to the unconfigured default)', () => {
    assert.equal(connectionStringForSchema(url!, 'public'), url);
    assert.equal(connectionStringForSchema(url!, undefined), url);
  });

  gate.it('a schema that does not exist is refused up front, naming the schema and the fix', async () => {
    await assert.rejects(migrateUp(url!, pinnedDir, { schema: 'qa78_missing_ns' }), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /TURBINE_E006/);
      assert.match(err.message, /"qa78_missing_ns" does not exist/);
      assert.match(err.message, /CREATE SCHEMA "qa78_missing_ns"/);
      return true;
    });
    // Nothing leaked into the role's default schema on the way to the refusal.
    assert.deepEqual(await tableSchemas('qa78_t1'), []);
  });

  gate.it('a schema name that cannot be a safe connection parameter is E003, before any connection', async () => {
    await assert.rejects(migrateStatus(url!, pinnedDir, { schema: 'qa78 ns; -c is_superuser=on' }), /TURBINE_E003/);
  });
});

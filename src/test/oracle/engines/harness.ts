/**
 * Engine harnesses for the cross-engine battery: Postgres (the oracle), SQLite,
 * MySQL, SQL Server and embedded PowDB.
 *
 * Each harness builds the battery's tables from `DEF` through Turbine's own DDL
 * generator, opens clients through the engine's public factory (the path a user
 * takes), and seeds through Turbine itself, so the seed is the first thing the
 * battery compares.
 *
 * Isolation. Every harness creates its own namespace in setup and removes it
 * in teardown, so nothing it writes outlives the run or is visible to another
 * suite sharing the server (src/test/mysql.test.ts, for one, asserts its
 * database's exact table list):
 *   - Postgres: one schema per engine file (`oe_<engine>`), selected with the
 *     `search_path` CONNECTION PARAMETER. No session-level SET is ever issued.
 *   - MySQL / SQL Server: a dedicated database, `<url database>_oracle_engines`,
 *     created in setup and dropped in teardown. The URL's own database is only
 *     used to connect.
 *   - SQLite / PowDB: a private temporary directory, deleted in teardown.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import pg from 'pg';
import { TurbineClient } from '../../../client.js';
import { UNSAFE } from '../../../query/index.js';
import { schemaToSQL } from '../../../schema-sql.js';
import {
  CAPABILITY_TABLES,
  type Capability,
  DEF,
  fixtureWithout,
  SCHEMA,
  SEED,
  TABLES_CHILD_FIRST,
} from './fixture.js';

// biome-ignore lint/suspicious/noExplicitAny: the battery drives tables by name, with no generated types
export type Db = any;

export type EngineName = 'postgres' | 'sqlite' | 'mysql' | 'mssql' | 'powdb';

/** Client config a scenario may ask for (global filters, strategies). */
export type ClientConfig = Record<string, unknown>;

export interface EngineHarness {
  readonly name: EngineName;
  /**
   * The capabilities this engine lacks, each with a probe. A gap's tables are
   * not created, and each scenario that needs them is checked as not
   * applicable instead: the probe must still describe the gap (return text),
   * so the day the engine closes it the battery asks for the scenarios to be
   * turned on (the probe returns undefined).
   */
  readonly gaps?: Partial<Record<Capability, () => Promise<string | undefined>>>;
  /** Create the tables and open the main client. */
  setup(): Promise<void>;
  /** Delete every row and write the seed through Turbine. */
  reset(): Promise<void>;
  /** Run `fn` with the main client, or with a dedicated client built from `config`. */
  withClient<T>(config: ClientConfig | undefined, fn: (db: Db) => Promise<T>): Promise<T>;
  teardown(): Promise<void>;
}

const BASE_CONFIG = { warnOnUnlimited: false } as const;

/**
 * Delete children first, then write parents first, all through the given client.
 *
 * `rowByRow` seeds with one `create` per row instead of `createMany`. SQL
 * Server needs it: a multi-row `createMany` whose bigint column mixes a value
 * past 2^53 (bound as text) with a small one (bound as int) fails with
 * "conversion ... overflowed an int column", which the scenario
 * `write/create-many-bigint-mixed` reports on its own.
 *
 * An empty table is not deleted from: on embedded PowDB (addon 0.20.0) a
 * `delete` against a table that was never written, followed by an insert,
 * leaves a data directory that fails to reopen ("bad heap superblock magic"),
 * and the PowDB harness reopens its directory between scenarios.
 */
async function reseed(db: Db, rowByRow = false, gaps: readonly Capability[] = []): Promise<void> {
  const tables = TABLES_CHILD_FIRST.filter((t) => !gaps.some((gap) => CAPABILITY_TABLES[gap].has(t)));
  for (const table of tables) {
    if ((await db.table(table).count()) === 0) continue;
    await db.table(table).deleteMany({ where: {}, allowFullTableScan: UNSAFE });
  }
  for (const table of [...tables].reverse()) {
    if (!rowByRow) {
      await db.table(table).createMany({ data: SEED[table] });
      continue;
    }
    for (const row of SEED[table]) await db.table(table).create({ data: row });
  }
}

// --- availability probes ------------------------------------------------------

/**
 * `node:sqlite` is a builtin only on Node >= 22.5, so it is probed at runtime
 * rather than imported: a static import would crash the file on Node 20.
 */
export const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

/** Whether the embedded PowDB addon loads on this platform. */
export async function powdbEmbeddedAvailable(): Promise<boolean> {
  try {
    const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
    return typeof mod?.Database?.open === 'function';
  } catch {
    return false;
  }
}

// --- postgres -----------------------------------------------------------------

/** `url` with `-c search_path=<schema>` appended to its `options` connection parameter. */
export function withSearchPath(url: string, schema: string): string {
  const u = new URL(url);
  const existing = u.searchParams.get('options');
  const option = `-c search_path=${schema}`;
  u.searchParams.set('options', existing ? `${existing} ${option}` : option);
  return u.toString();
}

export function postgresHarness(url: string, schema: string): EngineHarness {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`unsafe schema name ${schema}`);
  const scoped = withSearchPath(url, schema);
  let main: Db;
  const open = (config: ClientConfig = {}) =>
    new TurbineClient({ connectionString: scoped, poolSize: 2, ...BASE_CONFIG, ...config }, SCHEMA);
  const admin = async (statements: string[], connectionString: string) => {
    const client = new pg.Client({ connectionString });
    await client.connect();
    try {
      for (const sql of statements) await client.query(sql);
    } finally {
      await client.end();
    }
  };
  return {
    name: 'postgres',
    async setup() {
      await admin([`DROP SCHEMA IF EXISTS "${schema}" CASCADE`, `CREATE SCHEMA "${schema}"`], url);
      await admin(schemaToSQL(DEF), scoped);
      main = open();
    },
    reset: () => reseed(main),
    async withClient(config, fn) {
      if (!config) return fn(main);
      const db = open(config);
      try {
        return await fn(db);
      } finally {
        await db.disconnect();
      }
    },
    async teardown() {
      await main?.disconnect();
      await admin([`DROP SCHEMA IF EXISTS "${schema}" CASCADE`], url);
    },
  };
}

// --- sqlite -------------------------------------------------------------------

export function sqliteHarness(): EngineHarness {
  let dir = '';
  let file = '';
  let main: Db;
  const open = async (config: ClientConfig = {}) => {
    const { turbineSqlite } = await import('../../../sqlite.js');
    return turbineSqlite(file, SCHEMA, { ...BASE_CONFIG, ...config });
  };
  return {
    name: 'sqlite',
    async setup() {
      if (!DatabaseSync) throw new Error('node:sqlite is not available');
      const { sqliteDialect } = await import('../../../sqlite.js');
      dir = mkdtempSync(join(tmpdir(), 'turbine-oracle-engines-'));
      file = join(dir, 'battery.db');
      const raw = new DatabaseSync(file);
      try {
        for (const sql of schemaToSQL(DEF, { dialect: sqliteDialect })) raw.exec(sql);
      } finally {
        raw.close();
      }
      main = await open();
    },
    reset: () => reseed(main),
    async withClient(config, fn) {
      if (!config) return fn(main);
      const db = await open(config);
      try {
        return await fn(db);
      } finally {
        await db.disconnect();
      }
    },
    async teardown() {
      await main?.disconnect();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

// --- dedicated database (mysql, mssql) ----------------------------------------

/** The battery's own database name and a URL that selects it. */
function dedicatedDatabase(url: string): { name: string; url: string; base: URL } {
  const base = new URL(url);
  const name = `${decodeURIComponent(base.pathname.slice(1)) || 'turbine'}_oracle_engines`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe database name ${name}`);
  const scoped = new URL(url);
  scoped.pathname = `/${name}`;
  return { name, url: scoped.toString(), base };
}

// --- mysql --------------------------------------------------------------------

export function mysqlHarness(url: string): EngineHarness {
  const target = dedicatedDatabase(url);
  let main: Db;
  const open = async (config: ClientConfig = {}) => {
    const { turbineMysql } = await import('../../../mysql.js');
    return turbineMysql(target.url, SCHEMA, { ...BASE_CONFIG, connectionLimit: 2, ...config });
  };
  /** Run statements on one connection, to `database` (default: the URL's own). */
  const admin = async (statements: string[], database = decodeURIComponent(target.base.pathname.slice(1))) => {
    const { createConnection } = await import('mysql2/promise');
    const u = target.base;
    const conn = await createConnection({
      host: u.hostname,
      port: u.port ? Number(u.port) : 3306,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: database || undefined,
    });
    try {
      for (const sql of statements) await conn.query(sql);
    } finally {
      await conn.end();
    }
  };
  return {
    name: 'mysql',
    async setup() {
      const { mysqlDialect } = await import('../../../mysql.js');
      const db = `\`${target.name}\``;
      await admin([`DROP DATABASE IF EXISTS ${db}`, `CREATE DATABASE ${db}`]);
      await admin(schemaToSQL(DEF, { dialect: mysqlDialect }), target.name);
      main = await open();
    },
    reset: () => reseed(main),
    async withClient(config, fn) {
      if (!config) return fn(main);
      const db = await open(config);
      try {
        return await fn(db);
      } finally {
        await db.disconnect();
      }
    },
    async teardown() {
      await main?.disconnect();
      await admin([`DROP DATABASE IF EXISTS \`${target.name}\``]);
    },
  };
}

// --- mssql --------------------------------------------------------------------

export function mssqlHarness(url: string): EngineHarness {
  const target = dedicatedDatabase(url);
  let main: Db;
  const open = async (config: ClientConfig = {}) => {
    const { turbineMssql } = await import('../../../mssql.js');
    return turbineMssql(target.url, SCHEMA, { ...BASE_CONFIG, ...config });
  };
  /** Run batches on one pool, to `database` (default: the URL's own). */
  const admin = async (batches: string[], database = decodeURIComponent(target.base.pathname.slice(1))) => {
    // `mssql` ships no bundled types; a widened specifier keeps tsc from
    // requiring them. Only reached when MSSQL_URL is set.
    const specifier: string = 'mssql';
    // biome-ignore lint/suspicious/noExplicitAny: dynamic mssql import
    const mod: any = await import(specifier);
    const mssql = mod.default ?? mod;
    const u = target.base;
    const pool = await new mssql.ConnectionPool({
      server: u.hostname,
      port: u.port ? Number(u.port) : 1433,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: database || 'master',
      options: { encrypt: false, trustServerCertificate: true },
    }).connect();
    try {
      for (const sql of batches) await pool.request().batch(sql);
    } finally {
      await pool.close();
    }
  };
  // SINGLE_USER WITH ROLLBACK IMMEDIATE ends any connection a pool left open,
  // which would otherwise make the DROP fail.
  const drop = `IF DB_ID('${target.name}') IS NOT NULL BEGIN ALTER DATABASE [${target.name}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${target.name}]; END`;
  return {
    name: 'mssql',
    async setup() {
      const { mssqlDialect } = await import('../../../mssql.js');
      await admin([drop, `CREATE DATABASE [${target.name}]`], 'master');
      await admin(schemaToSQL(DEF, { dialect: mssqlDialect }), target.name);
      main = await open();
    },
    reset: () => reseed(main, true),
    async withClient(config, fn) {
      if (!config) return fn(main);
      const db = await open(config);
      try {
        return await fn(db);
      } finally {
        await db.disconnect();
      }
    },
    async teardown() {
      await main?.disconnect();
      await admin([drop], 'master');
    },
  };
}

// --- powdb (embedded) ---------------------------------------------------------

export function powdbHarness(): EngineHarness {
  let dir = '';
  let main: Db;
  // PowDB gets the fixture without the tables of its gaps (see `gaps` below).
  const GAPS: Capability[] = ['binary'];
  const { schema: fixture } = fixtureWithout(GAPS);
  const open = async (config: ClientConfig = {}) => {
    const { turbinePowDB } = await import('../../../powdb.js');
    return turbinePowDB({ embedded: dir }, fixture, { ...BASE_CONFIG, ...config });
  };
  /** The PowQL DDL for the full fixture's table `table`, or the error that refused it. */
  const fullDdl = async (table: string): Promise<string | Error> => {
    const { powqlSchemaDDL } = await import('../../../powdb.js');
    try {
      return powqlSchemaDDL(SCHEMA).find((stmt) => stmt.startsWith(`type ${table} `)) ?? '';
    } catch (err) {
      return err as Error;
    }
  };
  return {
    name: 'powdb',
    gaps: {
      // No binary column type: declaring one is refused.
      async binary() {
        const ddl = await fullDdl('oe_bin_parents');
        return ddl instanceof Error ? ddl.message : undefined;
      },
    },
    async setup() {
      const { powqlSchemaDDL } = await import('../../../powdb.js');
      dir = mkdtempSync(join(tmpdir(), 'turbine-oracle-engines-powdb-'));
      main = await open();
      for (const stmt of powqlSchemaDDL(fixture)) await main.rawUnsafe(stmt);
    },
    reset: () => reseed(main, false, GAPS),
    async withClient(config, fn) {
      if (!config) return fn(main);
      // The embedded engine holds one handle per directory, so the main client
      // closes while a dedicated one is open, and reopens afterwards.
      await main.disconnect();
      try {
        const db = await open(config);
        try {
          return await fn(db);
        } finally {
          await db.disconnect();
        }
      } finally {
        main = await open();
      }
    },
    async teardown() {
      await main?.disconnect();
      if (dir) rmSync(dir, { recursive: true, force: true });
    },
  };
}

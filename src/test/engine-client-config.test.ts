/**
 * Engine factories forward client-level config.
 *
 * `turbineSqlite` / `turbineMysql` / `turbineMssql` each build their own driver
 * pool and then construct a `TurbineClient`. They used to hand it a hand-listed
 * set of config keys, which made every option added to `TurbineConfig`
 * afterwards unreachable on three engines (that is how `errorMessages`, and then
 * `logQueryParams`, ended up Postgres-only in practice). The factories now
 * forward their whole options object minus the driver keys they own, so these
 * tests pin the OBSERVABLE end of that: an option set on the factory reaches the
 * client, the default is unchanged, and the engine still emits its own SQL.
 *
 * SQLite runs in-process (`node:sqlite`). MySQL is gated on `MYSQL_URL`. SQL
 * Server is driven through a fake `mssql` pool, so its forwarding is covered on
 * every machine, and the `MSSQL_URL` lane keeps the real driver honest
 * elsewhere.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { describe, it, it as nodeIt } from 'node:test';
import type { TurbineClient } from '../client.js';
import { MssqlPool, turbineMssql } from '../mssql.js';
import { turbineMysql } from '../mysql.js';
import type { QueryEvent } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { turbineSqlite } from '../sqlite.js';
import { mockTable, skipGate } from './helpers.js';

// `node:sqlite` is a builtin only on Node >= 22.5; probe without a static import
// so this file loads (and skips cleanly) on Node 20.
const DatabaseSync: (new (path: string) => DatabaseSyncType) | undefined = (() => {
  try {
    return createRequire(process.cwd())('node:sqlite').DatabaseSync;
  } catch {
    return undefined;
  }
})();

const sqliteIt: typeof nodeIt = DatabaseSync
  ? nodeIt
  : (((name: string) =>
      nodeIt(name, { skip: 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)' }, () => {})) as typeof nodeIt);

/** One table, enough for a `findUnique` that binds a real param. */
function probeSchema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      cfg_probe: mockTable('cfg_probe', [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'name', field: 'name', pgType: 'text' },
      ]),
    },
  };
}

/** Run one param-bearing query and return the emitted query event. */
async function captureQueryEvent(db: TurbineClient): Promise<QueryEvent> {
  const events: QueryEvent[] = [];
  db.$on('query', (e) => events.push(e));
  await db.table('cfg_probe').findUnique({ where: { id: 1 } });
  assert.equal(events.length, 1, 'exactly one query event');
  return events[0]!;
}

// ---------------------------------------------------------------------------
// SQLite (in-process, no container)
// ---------------------------------------------------------------------------

function openSqliteProbe(options?: Parameters<typeof turbineSqlite>[2]): TurbineClient {
  // biome-ignore lint/style/noNonNullAssertion: guarded by sqliteIt's skip.
  const handle = new DatabaseSync!(':memory:');
  handle.exec('CREATE TABLE cfg_probe (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  handle.exec("INSERT INTO cfg_probe (id, name) VALUES (1, 'probe')");
  return turbineSqlite(handle, probeSchema(), options);
}

describe('turbineSqlite forwards client config', () => {
  sqliteIt('logQueryParams: true puts real values on the query event', async () => {
    const db = openSqliteProbe({ logQueryParams: true });
    const event = await captureQueryEvent(db);
    assert.deepEqual(event.params, [1], 'the bound id, not a redaction');
    await db.disconnect();
  });

  sqliteIt('params are still redacted by default', async () => {
    const db = openSqliteProbe();
    const event = await captureQueryEvent(db);
    assert.deepEqual(event.params, ['[REDACTED]']);
    await db.disconnect();
  });

  sqliteIt('the engine still owns its dialect when config rides through', async () => {
    // The spread order is the guarantee: engine-owned keys are written after
    // the caller's config, so forwarding can never unbind the engine's SQL.
    const db = openSqliteProbe({ logQueryParams: true, errorMessages: 'safe' });
    const event = await captureQueryEvent(db);
    assert.ok(event.sql.includes(':p1'), 'still SQLite placeholders');
    assert.deepEqual(event.params, [1], 'logQueryParams wins over errorMessages: safe');
    await db.disconnect();
  });
});

// ---------------------------------------------------------------------------
// MySQL (gated on a live server)
// ---------------------------------------------------------------------------

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const mysqlGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

async function openMysqlProbe(options?: Parameters<typeof turbineMysql>[2]): Promise<TurbineClient> {
  const db = await turbineMysql(MYSQL_URL, probeSchema(), options);
  await db.raw(['DROP TABLE IF EXISTS cfg_probe'] as unknown as TemplateStringsArray);
  await db.raw([
    'CREATE TABLE cfg_probe (id INT NOT NULL PRIMARY KEY, name VARCHAR(50) NOT NULL)',
  ] as unknown as TemplateStringsArray);
  await db.raw(["INSERT INTO cfg_probe (id, name) VALUES (1, 'probe')"] as unknown as TemplateStringsArray);
  return db;
}

async function closeMysqlProbe(db: TurbineClient): Promise<void> {
  await db.raw(['DROP TABLE IF EXISTS cfg_probe'] as unknown as TemplateStringsArray);
  await db.disconnect();
}

describe('turbineMysql forwards client config', () => {
  mysqlGate.it('logQueryParams: true puts real values on the query event', async () => {
    const db = await openMysqlProbe({ logQueryParams: true });
    const event = await captureQueryEvent(db);
    assert.deepEqual(event.params, [1], 'the bound id, not a redaction');
    await closeMysqlProbe(db);
  });

  mysqlGate.it('params are still redacted by default', async () => {
    const db = await openMysqlProbe();
    const event = await captureQueryEvent(db);
    assert.deepEqual(event.params, ['[REDACTED]']);
    await closeMysqlProbe(db);
  });
});

// ---------------------------------------------------------------------------
// SQL Server (fake `mssql` pool, so the forwarding is covered without a server)
// ---------------------------------------------------------------------------

/**
 * The slice of an `mssql` ConnectionPool the factory and `MssqlPool.query`
 * touch: `request()` (positional `@pN` inputs, then `query`) and `close()`. The
 * version probe reads `recordset[0].v`, so report SQL Server 2022.
 */
function fakeMssqlPool(): MssqlPool {
  const raw = {
    request: () => ({
      input: () => {},
      query: async (text: string) => ({
        recordset: /ProductMajorVersion/.test(text) ? [{ v: 16 }] : [{ id: 1, name: 'probe' }],
        rowsAffected: [1],
      }),
    }),
    close: async () => {},
  };
  return new MssqlPool(raw as unknown as ConstructorParameters<typeof MssqlPool>[0], {} as never);
}

describe('turbineMssql forwards client config', () => {
  it('logQueryParams: true puts real values on the query event', async () => {
    const db = await turbineMssql(fakeMssqlPool(), probeSchema(), { logQueryParams: true });
    const event = await captureQueryEvent(db);
    assert.deepEqual(event.params, [1], 'the bound id, not a redaction');
  });

  it('params are still redacted by default', async () => {
    const db = await turbineMssql(fakeMssqlPool(), probeSchema());
    const event = await captureQueryEvent(db);
    assert.deepEqual(event.params, ['[REDACTED]']);
  });

  it('the engine-owned `schema` option is not mistaken for client config', async () => {
    const db = await turbineMssql(fakeMssqlPool(), probeSchema(), { schema: 'sales', logQueryParams: true });
    const event = await captureQueryEvent(db);
    assert.ok(event.sql.includes('@p1'), 'still SQL Server placeholders');
    assert.deepEqual(event.params, [1]);
  });
});

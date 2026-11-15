/** Required-service cases. Offline native API fault models are separate evidence. */
import assert from 'node:assert/strict';
import { mssqlMigrationConfig } from '../cli/mssql-migrate-connection.js';
import { MssqlPool } from '../mssql.js';
import { type MssqlSeedTable, runMssqlSeed } from '../mssql-seed.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import type { SchemaMetadata } from '../schema.js';
import { mockColumn, mockTable, skipGate } from './helpers.js';

const url = process.env.MSSQL_TEST_URL ?? process.env.MSSQL_URL;
const gate = skipGate(!url, 'requires MSSQL_URL pointing at a disposable SQL Server 2016+ database');

gate.it(
  'native seed commits/readbacks, rolls back failures, refuses wrong resolution and preserves borrowed pool',
  async (t) => {
    type Driver = ConstructorParameters<typeof MssqlPool>[1];
    const mod = (await importOptionalPeer('mssql')) as Driver & { default?: Driver };
    const driver = mod.default ?? mod;
    // The native driver takes a config object; MSSQL_URL is an mssql:// URL.
    const pool = await new driver.ConnectionPool(mssqlMigrationConfig(url!)).connect();
    const name = `seed_${process.pid}_${Math.random().toString(36).slice(2)}`;
    const ident = `[dbo].[${name}]`;
    t.after(async () => {
      try {
        await pool.request().query(`DROP TABLE IF EXISTS ${ident}`);
      } finally {
        await pool.close();
      }
    });
    await pool.request().query(`CREATE TABLE ${ident} ([id] int PRIMARY KEY, [email] nvarchar(100) NOT NULL)`);
    const schema: SchemaMetadata = {
      tables: { [name]: mockTable(name, [mockColumn('id', 'id', 'int4'), mockColumn('email', 'email', 'text')]) },
      enums: {},
    };
    const borrowed = new MssqlPool(pool, driver);
    let escaped!: MssqlSeedTable<{ id: number; email: string }>;
    await runMssqlSeed(
      borrowed,
      schema,
      async (tx) => {
        escaped = tx.table(name);
        const row = await escaped.create({ data: { id: 1, email: 'kept' } });
        assert.equal(row.email, 'kept');
        assert.equal((await escaped.findMany())[0]?.email, 'kept');
        await assert.rejects(
          tx.$transaction(async (inner) => {
            await inner.table(name).create({ data: { id: 2, email: 'savepoint rollback' } });
            throw new Error('undo inner');
          }),
          /undo inner/,
        );
      },
      { logger: {} },
    );
    await assert.rejects(escaped.findMany(), /ended/);
    await assert.rejects(
      runMssqlSeed(
        borrowed,
        schema,
        async (tx) => {
          await tx.table(name).create({ data: { id: 3, email: 'outer rollback' } });
          throw new Error('undo outer');
        },
        { logger: {} },
      ),
      /undo outer/,
    );
    let invoked = false;
    await assert.rejects(
      runMssqlSeed(
        borrowed,
        schema,
        () => {
          invoked = true;
        },
        { schema: 'other', logger: {} },
      ),
      /resolution/,
    );
    assert.equal(invoked, false);
    assert.equal(pool.connected, true);
    assert.deepEqual((await pool.request().query(`SELECT [id], [email] FROM ${ident}`)).recordset, [
      { id: 1, email: 'kept' },
    ]);
    // An owned factory target also closes after callback failure, rather than
    // leaving its native connection alive. The process-level packed cases observe
    // close explicitly; this service case observes the persisted rollback.
    await assert.rejects(
      runMssqlSeed(
        url!,
        schema,
        async (tx) => {
          await tx.table(name).create({ data: { id: 4, email: 'owned rollback' } });
          throw new Error('undo owned');
        },
        { logger: {} },
      ),
      /undo owned/,
    );
    assert.equal((await pool.request().query(`SELECT COUNT(*) AS n FROM ${ident}`)).recordset?.[0]?.n, 1);
  },
);

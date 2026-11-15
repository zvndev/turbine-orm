import { TurbineClient, type PgCompatPool, type SchemaMetadata } from 'turbine-orm';
import { turbineCore } from 'turbine-orm/core';
import { turbineD1, type D1DatabaseBinding } from 'turbine-orm/d1';
import { turbineSqlite } from 'turbine-orm/sqlite';
import { turbineMysql } from 'turbine-orm/mysql';
import { turbineMssql } from 'turbine-orm/mssql';
import { turbineLibsql } from 'turbine-orm/libsql';
import { turbineNeonHttp } from 'turbine-orm/neon-http';
import { turbineNeonWs } from 'turbine-orm/neon-ws';
import { DatabaseSync } from 'node:sqlite';
declare const schema: SchemaMetadata;
declare const pool: PgCompatPool;
declare const binding: D1DatabaseBinding;
const pg = new TurbineClient({ pool }, schema);
pg.$transaction(async (tx) => { await tx.raw`SELECT ${1}`; });
pg.pool.query<{ id: number }>('SELECT 1 AS id').then((r) => { const n: number = r.rows[0]!.id; return n; });
turbineCore(pool, schema).table<{ id: number }>('items').findMany({ where: { id: 1 } });
turbineD1(binding, schema).$batchRaw([{ sql: 'SELECT ?1', params: [1] }]);
turbineSqlite(new DatabaseSync(':memory:'), schema);
turbineMysql('mysql://localhost/test', schema);
turbineMssql('mssql://localhost/test', schema);
turbineLibsql('file:test.db', schema);
void turbineNeonHttp; void turbineNeonWs;
// @ts-expect-error Public pool results retain their row type.
pg.pool.query<{ id: number }>('SELECT 1').then((r) => { const bad: string = r.rows[0]!.id; return bad; });
// @ts-expect-error Prepared statement configuration remains boolean.
new TurbineClient({ preparedStatements: 'yes' }, schema);

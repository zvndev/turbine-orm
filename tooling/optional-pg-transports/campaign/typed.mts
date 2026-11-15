import { turbineCore, type SchemaMetadata, type PgCompatPool } from 'turbine-orm/core';
import { turbineNeonHttp, type NeonHttpSql } from 'turbine-orm/neon-http';
import { turbineNeonWs, type NeonWsSource } from 'turbine-orm/neon-ws';
import { createApplication } from './application.mjs';

export interface Row { id: number; tenantId: number; title: string; secret: string }

// Actual public typed query composition. A negative projection check must compile.
export async function typedComposition(pool: PgCompatPool, schema: SchemaMetadata) {
  const db = turbineCore(pool, schema, { warnOnUnlimited: false });
  const app = createApplication({ pool, endpoint: 'direct', channel: 'transport_events', onDiagnostic() {} });
  const live = app.watch(async () => {
    const rows = await db.table<Row>('transport_rows').findMany({ where: { tenantId: 1 },
      select: { id: true, title: true }, orderBy: { id: 'asc' }, limit: 64 });
    const id: number = rows[0]!.id;
    const title: string = rows[0]!.title;
    // @ts-expect-error projected secret is unavailable
    rows[0]!.secret;
    void [id, title];
    return rows;
  });
  return { db, app, live };
}

export async function typedTransports(config: NeonWsSource, sql: NeonHttpSql, schema: SchemaMetadata) {
  const ws = await turbineNeonWs(config, schema, { sessionMode: 'persistent', lifetime: 'persistent' });
  const http = turbineNeonHttp(sql, schema);
  const wsRows = await ws.table<Row>('transport_rows').findMany({ select: { id: true, title: true }, limit: 64 });
  const httpRows = await http.table<Row>('transport_rows').findMany({ select: { id: true, title: true }, limit: 64 });
  const titles: string[] = [wsRows[0]!.title, httpRows[0]!.title];
  // @ts-expect-error projected secret is unavailable
  wsRows[0]!.secret;
  // @ts-expect-error projected secret is unavailable
  httpRows[0]!.secret;
  void titles;
  await ws.disconnect(); await http.disconnect();
}

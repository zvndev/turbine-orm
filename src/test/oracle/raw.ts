/**
 * Raw-SQL access for oracles.
 *
 * Nothing here goes through Turbine. The reader returns EVERY value as the text
 * Postgres sent, so Turbine's process-global pg type parsers cannot leak into an
 * expectation, and the session time zone is set as a connection PARAMETER, never
 * a session `SET` (a SET on a pooled connection leaks to the next borrower).
 */

import pg from 'pg';

/** Merge `-c` options into a connection URL without losing ones already there. */
export function withServerOptions(url: string, options: string): string {
  const u = new URL(url);
  const existing = u.searchParams.get('options');
  u.searchParams.set('options', existing ? `${existing} ${options}` : options);
  return u.toString();
}

export function withTimeZone(url: string, timeZone: string): string {
  return withServerOptions(url, `-c TimeZone=${timeZone}`);
}

const TEXT_ONLY = { getTypeParser: () => (v: string) => v } as unknown as pg.ClientConfig['types'];

/** A connected pg client that returns every value as text. */
export async function rawReader(url: string, timeZone = 'UTC'): Promise<pg.Client> {
  const client = new pg.Client({
    connectionString: withTimeZone(url, timeZone),
    types: TEXT_ONLY,
  });
  await client.connect();
  return client;
}

/** A connected pg client with the driver's default parsers (for DDL and writes). */
export async function rawWriter(url: string): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
}

/** Run one script (DDL, seed data) on a throwaway connection. */
export async function runScript(url: string, sql: string): Promise<void> {
  const client = await rawWriter(url);
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** `SELECT` rows as plain objects of text. */
export async function rows(
  reader: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, string | null>[]> {
  return (await reader.query(sql, params)).rows as Record<string, string | null>[];
}

/** First column of every row, as numbers. For `SELECT id ...` oracles. */
export async function ids(reader: pg.Client, sql: string, params: unknown[] = []): Promise<number[]> {
  const result = await reader.query({ text: sql, values: params, rowMode: 'array' });
  return (result.rows as (string | null)[][]).map((r) => Number(r[0]));
}

/** Every row of a table as JSON, keyed by column name (snake_case). */
export async function dumpJson(reader: pg.Client, table: string, orderBy = 'id'): Promise<Record<string, unknown>[]> {
  const result = await reader.query({
    text: `SELECT to_json(t)::text AS j FROM ${table} t ORDER BY ${orderBy}`,
    rowMode: 'array',
  });
  return (result.rows as string[][]).map((r) => JSON.parse(r[0] as string) as Record<string, unknown>);
}

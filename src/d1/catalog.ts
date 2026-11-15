/** Native D1 catalog collection. No connection/session emulation or writes. */
import { InvariantError, ValidationError } from '../errors.js';
import type { D1DatabaseBinding, D1Result } from './types.js';

const MANIFEST = 'SELECT type, name, tbl_name, rootpage, sql FROM main.sqlite_master ORDER BY type, name';
export const CATALOG_TABLES = 'd1:main-tables';
export const CATALOG_VIEWS = 'd1:main-views';
export const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;
export const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

interface CatalogObject extends Record<string, unknown> {
  type: string;
  name: string;
  tbl_name: string;
  rootpage: number;
  sql: string | null;
}

export interface D1CatalogSnapshot {
  read<T>(query: string): T[];
}

function resultRows<T>(result: D1Result<T> | undefined): T[] {
  if (result?.success !== true || !Array.isArray(result.results))
    throw new InvariantError(
      'd1-catalog-result',
      `Unsuccessful or malformed D1 catalog result: ${result?.error ?? 'no error detail'}.`,
    );
  return result.results;
}

function manifestRows(result: D1Result<CatalogObject> | undefined): CatalogObject[] {
  const rows = resultRows(result);
  if (
    rows.some(
      (row) =>
        typeof row.type !== 'string' ||
        typeof row.name !== 'string' ||
        typeof row.tbl_name !== 'string' ||
        typeof row.rootpage !== 'number' ||
        !(row.sql === null || typeof row.sql === 'string'),
    )
  )
    throw new InvariantError('d1-catalog-manifest', 'Malformed D1 schema manifest.');
  return rows;
}

const userObject = (name: string): boolean => !/^(sqlite_|_cf_)/i.test(name);

/**
 * Discovery plans identifiers only. All metadata facts come from ONE native
 * sequential atomic batch. Its manifest must equal discovery and its final
 * manifest, otherwise refuse. No schema_version (D1 forbids it), BEGIN, session,
 * transaction pinning, retries, or caller-owned binding lifecycle operations.
 */
export async function collectD1Catalog(binding: D1DatabaseBinding): Promise<D1CatalogSnapshot> {
  const discovered = manifestRows(await binding.prepare(MANIFEST).all<CatalogObject>());
  const tables = discovered.filter((row) => row.type === 'table' && userObject(row.name));
  // WITHOUT ROWID primary-key indexes have index_list entries without a
  // sqlite_master row. Discover names; never synthesize auto-index names.
  const plannedIndexes = tables.length
    ? await binding.batch<{ name: string }>(
        tables.map((table) => binding.prepare(`PRAGMA main.index_list(${q(table.name)})`)),
      )
    : [];
  if (!Array.isArray(plannedIndexes) || plannedIndexes.length !== tables.length)
    throw new InvariantError('d1-catalog-plan', 'D1 index discovery count differs from its statement count.');
  const indexNames = plannedIndexes.flatMap((result) => resultRows(result).map((row) => row.name));
  const queries = [MANIFEST, 'PRAGMA main.table_list'];
  for (const table of tables) {
    for (const pragma of ['table_xinfo', 'foreign_key_list', 'index_list'])
      queries.push(`PRAGMA main.${pragma}(${q(table.name)})`);
  }
  for (const name of indexNames) queries.push(`PRAGMA main.index_info(${q(name)})`);
  queries.push('PRAGMA main.table_list', MANIFEST);
  const results = await binding.batch<Record<string, unknown>>(queries.map((sql) => binding.prepare(sql)));
  if (!Array.isArray(results) || results.length !== queries.length)
    throw new InvariantError('d1-catalog-batch', 'D1 catalog batch result count differs from its statement count.');
  const rows = results.map((result) => resultRows(result));
  const fingerprint = (value: unknown): string => JSON.stringify(value);
  if (
    fingerprint(discovered) !== fingerprint(manifestRows(results[0] as D1Result<CatalogObject>)) ||
    fingerprint(discovered) !== fingerprint(manifestRows(results.at(-1) as D1Result<CatalogObject>)) ||
    fingerprint(rows[1]) !== fingerprint(rows.at(-2))
  )
    throw new ValidationError('The D1 catalog changed during introspection. Retry after schema changes finish.');

  const data = new Map<string, unknown[]>();
  queries.forEach((sql, index) => {
    data.set(sql, rows[index]!);
  });
  // These projections are derived from the validated native batch manifest.
  data.set(
    CATALOG_TABLES,
    tables.map(({ name, sql }) => ({ name, sql })),
  );
  data.set(
    CATALOG_VIEWS,
    discovered.filter((row) => row.type === 'view' && userObject(row.name)),
  );
  tables.forEach((table, index) => {
    if (
      fingerprint(data.get(`PRAGMA main.index_list(${q(table.name)})`)) !==
      fingerprint(resultRows(plannedIndexes[index]))
    )
      throw new ValidationError('The D1 catalog changed during introspection. Retry after schema changes finish.');
  });
  for (const name of indexNames)
    data.set(`SELECT sql FROM main.sqlite_master WHERE type = 'index' AND name = ${literal(name)}`, [
      { sql: discovered.find((row) => row.type === 'index' && row.name === name)?.sql ?? null },
    ]);
  return {
    read<T>(sql: string): T[] {
      const value = data.get(sql);
      if (!value) throw new InvariantError('d1-catalog-plan', 'Catalog metadata requested an uncollected fact.');
      return value as T[];
    },
  };
}

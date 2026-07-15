/**
 * turbine-orm/powdb — `describe`-based introspection.
 *
 * PowDB exposes its catalog through two ordinary rows-returning statements
 * (keywords since engine 0.10):
 *   - `schema` → one row per type: `{ name, columns }` (columns = a count).
 *   - `describe <T>` / `schema <T>` → one row per column:
 *     `{ column, type, nullable, index }` where `type` is a PowQL type name
 *     (`str`/`int`/`float`/`bool`/`json`/`datetime`/`uuid`/`bytes`), `nullable`
 *     is `"true"`/`"false"`, and `index` is `"unique"` / `"index"` / `""`.
 *
 * {@link introspectPowdbDatabase} turns those into the same {@link SchemaMetadata}
 * shape the SQL introspectors produce, so a code-first PowDB database can be
 * introspected for bootstrap/verification. It is transport-agnostic: the caller
 * supplies an `exec(powql)` that returns row objects keyed by column name.
 *   - Embedded / owned pool: `exec = async (q) => ({ rows: await db.raw([q]) })`
 *     using a live `turbinePowDB` client's `raw` tagged template.
 *   - Networked: `exec = async (q) => ({ rows: (await client.query(q)).rows })`
 *     over `@zvndev/powdb-client`.
 *
 * IMPORTANT LIMITATIONS (all documented, none silent):
 *   - Relations are ALWAYS `{}`: PowDB has no declared foreign keys, so
 *     `describe` cannot report them. The recommended flow for relation-aware
 *     metadata is code-first `defineSchema` + `schemaDefToMetadata`; use
 *     introspection to bootstrap or verify column shape.
 *   - Primary key is a HEURISTIC (`describe` has no PK concept): PowDB marks a
 *     PK column as `required unique`, so the first non-nullable `unique` column
 *     is chosen (a column named `id` wins ties). A table with no such column
 *     yields `primaryKey: []` and a warning; single-row ops on it fail loudly.
 *   - `isGenerated` is always `false`: `describe` does not expose PowDB's `auto`
 *     modifier, so an introspected int PK is treated as client-supplied unless
 *     the caller hand-edits the metadata.
 *   - Doc-field expression indexes are INVISIBLE to `describe`, so they never
 *     round-trip; only plain `unique`/`index` columns appear in `indexes`.
 *   - `datetime` / `uuid` / `bytes` columns map to read-oriented TS types
 *     (`Date` / `string` / `Uint8Array`). Turbine never emits those PowQL types
 *     on write, so writing to such a column may not round-trip.
 *
 * v1 is a PROGRAMMATIC API (exported from `turbine-orm/powdb`); the CLI's
 * `turbine generate` still defaults to Postgres. Routing a `powdb://` URL
 * through the CLI would additionally need: a `powdbDialect.introspector`
 * wired to a networked `exec`, and `cli/config.ts` teaching the generate
 * funnel to construct a PowDB client instead of a `pg` client for `powdb://`.
 */

import { quotePowqlIdent } from './powdb.js';
import type { ColumnMetadata, IndexMetadata, SchemaMetadata, TableMetadata } from './schema.js';
import { snakeToCamel } from './schema.js';

/** A minimal rows-returning executor over a PowDB connection (embedded or networked). */
export type PowdbExec = (powql: string) => Promise<{ rows: Record<string, unknown>[] }>;

/** Options controlling which tables {@link introspectPowdbDatabase} reads. */
export interface PowdbIntrospectOptions {
  /** Only introspect these table names (snake_case, as PowDB reports them). */
  include?: string[];
  /** Skip these table names. */
  exclude?: string[];
}

/** One row of a `describe <T>` result, after string-coercing each cell. */
interface DescribeRow {
  column: string;
  type: string;
  nullable: boolean;
  index: string;
}

/** Coerce a wire cell to string (legacy wire cells are strings; native cells may be typed). */
function asString(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

/** Coerce a `describe` `nullable` cell (`"true"`/`"false"` or a native boolean) to a JS boolean. */
function asBool(v: unknown): boolean {
  return v === true || asString(v).toLowerCase() === 'true';
}

/**
 * Map a PowQL type name to the {@link ColumnMetadata} TS/dialect types. The
 * `tsType` drives read coercion (`coerceValue`) and write typing
 * (`powqlColumnType`); `dialectType`/`pgType` carry the PowQL type name so
 * `isFloatColumn` / `isJsonColumn` classify correctly.
 */
function mapPowqlType(powqlType: string): { tsType: string; dialectType: string } {
  switch (powqlType) {
    case 'int':
      return { tsType: 'number', dialectType: 'int' };
    case 'float':
      return { tsType: 'number', dialectType: 'float' };
    case 'bool':
      return { tsType: 'boolean', dialectType: 'bool' };
    case 'json':
      return { tsType: 'unknown', dialectType: 'json' };
    case 'datetime':
      return { tsType: 'Date', dialectType: 'datetime' };
    case 'uuid':
      return { tsType: 'string', dialectType: 'uuid' };
    case 'bytes':
      return { tsType: 'Uint8Array', dialectType: 'bytes' };
    default:
      // `str` and any unknown future scalar fall back to string.
      return { tsType: 'string', dialectType: 'str' };
  }
}

/**
 * Read a live PowDB database into {@link SchemaMetadata} via `schema` +
 * `describe <T>` statements run through the supplied {@link PowdbExec}.
 *
 * @param exec Rows-returning executor (embedded `db.raw` or networked `client.query`).
 * @param options `include`/`exclude` table filters.
 */
export async function introspectPowdbDatabase(
  exec: PowdbExec,
  options: PowdbIntrospectOptions = {},
): Promise<SchemaMetadata> {
  // ----- Types (one row per table, columns `name`, `columns`) -----
  const schemaRows = (await exec('schema')).rows;
  let tableNames = schemaRows.map((r) => asString(r.name)).filter((n) => n.length > 0);

  if (options.include?.length) {
    const inc = new Set(options.include);
    tableNames = tableNames.filter((t) => inc.has(t));
  }
  if (options.exclude?.length) {
    const exc = new Set(options.exclude);
    tableNames = tableNames.filter((t) => !exc.has(t));
  }

  const tables: Record<string, TableMetadata> = {};

  for (const tableName of tableNames) {
    // `describe` needs the table name in bare-identifier position → quote it so
    // a reserved-word / non-bare table name (`order`) does not become a parse
    // error.
    const describeRows = (await exec(`describe ${quotePowqlIdent(tableName)}`)).rows.map<DescribeRow>((r) => ({
      column: asString(r.column),
      type: asString(r.type),
      nullable: asBool(r.nullable),
      index: asString(r.index),
    }));

    const columns: ColumnMetadata[] = [];
    const columnMap: Record<string, string> = {};
    const reverseColumnMap: Record<string, string> = {};
    const dateColumns = new Set<string>();
    const dialectTypes: Record<string, string> = {};
    const pgTypes: Record<string, string> = {};
    const allColumns: string[] = [];
    const uniqueColumns: string[][] = [];
    const indexes: IndexMetadata[] = [];
    // PK heuristic candidates: non-nullable `unique` columns.
    const pkCandidates: string[] = [];

    for (const row of describeRows) {
      const name = row.column;
      const field = snakeToCamel(name);
      const { tsType, dialectType } = mapPowqlType(row.type);
      const nullable = row.nullable;
      const finalTs = nullable ? `${tsType} | null` : tsType;

      const col: ColumnMetadata = {
        name,
        field,
        dialectType,
        pgType: dialectType,
        tsType: finalTs,
        nullable,
        // `describe` reports neither defaults nor the `auto` modifier.
        hasDefault: false,
        isGenerated: false,
        isArray: false,
        arrayType: undefined,
        pgArrayType: 'text[]',
      };
      columns.push(col);
      columnMap[field] = name;
      reverseColumnMap[name] = field;
      allColumns.push(name);
      dialectTypes[name] = dialectType;
      pgTypes[name] = dialectType;
      if (dialectType === 'datetime') dateColumns.add(name);

      if (row.index === 'unique') {
        uniqueColumns.push([name]);
        if (!nullable) pkCandidates.push(name);
      }
      if (row.index === 'unique' || row.index === 'index') {
        indexes.push({
          name: `${tableName}_${name}_idx`,
          columns: [name],
          unique: row.index === 'unique',
          definition: `${row.index === 'unique' ? 'unique ' : ''}index on ${tableName}(${name})`,
        });
      }
    }

    // Primary key: first non-nullable unique column, preferring one named `id`.
    let primaryKey: string[] = [];
    if (pkCandidates.length > 0) {
      primaryKey = [pkCandidates.includes('id') ? 'id' : pkCandidates[0]!];
    } else {
      console.warn(
        `[turbine] PowDB introspection: table "${tableName}" has no non-nullable unique column; ` +
          'primaryKey is [] (single-row operations will fail). Supply a primary key via code-first ' +
          '`defineSchema` metadata if this table needs findUnique/update/delete by id.',
      );
    }

    tables[tableName] = {
      name: tableName,
      columns,
      columnMap,
      reverseColumnMap,
      dateColumns,
      dialectTypes,
      pgTypes,
      allColumns,
      primaryKey,
      uniqueColumns,
      // PowDB has no declared foreign keys → no relations from introspection.
      relations: {},
      indexes,
    };
  }

  return { tables, enums: {} };
}

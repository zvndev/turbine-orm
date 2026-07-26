/**
 * turbine-orm/powdb, `describe`-based introspection.
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
 * supplies an `exec(powql)` that returns row objects **keyed by column name**.
 *   - Embedded / owned pool: `exec = async (q) => ({ rows: await db.raw([q]) })`
 *     using a live `turbinePowDB` client's `raw` tagged template.
 *   - Networked: the raw `@zvndev/powdb-client` returns POSITIONAL rows
 *     (`{ columns: string[], rows: string[][] }`), so zip them into records.
 *     A bare `(await client.query(q)).rows` would hand this function `string[][]`
 *     whose `.name` cell is `undefined` and every table would silently drop out:
 *     ```ts
 *     const exec = async (q) => {
 *       const r = await client.query(q);
 *       return { rows: r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]]))) };
 *     };
 *     ```
 *     (A mis-shaped exec is now caught: if `schema` returns rows but none carry
 *     a `name`, {@link introspectPowdbDatabase} throws instead of returning an
 *     empty schema.)
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
 *     on write, so writing to such a column may not round-trip. This introspector
 *     is the ONLY producer of `dialectType: 'datetime'` metadata, and a predicate
 *     on such a column is version-gated: comparing it against the integer
 *     microseconds Turbine binds was silently wrong below engine 0.20, so those
 *     predicates raise a typed E017 there rather than being answered wrongly (see
 *     `PowdbCapabilities.datetimeCompare`). The `in` / `not in` list forms are
 *     still wrong upstream at 0.20, so Turbine never emits one for such a column:
 *     it compiles to the equality chain the engine answers correctly, bounded by
 *     `MAX_POWQL_DATETIME_TERMS`. Reads, ordering, grouping and null checks on
 *     the column are unaffected.
 *
 * v1 is a PROGRAMMATIC API (exported from `turbine-orm/powdb`); the CLI's
 * `turbine generate` still defaults to Postgres. Routing a `powdb://` URL
 * through the CLI would additionally need: a `powdbDialect.introspector`
 * wired to a networked `exec`, and `cli/config.ts` teaching the generate
 * funnel to construct a PowDB client instead of a `pg` client for `powdb://`.
 */

import { ValidationError } from './errors.js';
import { applyTableFilters } from './introspect.js';
import { type PowdbCapabilities, quotePowqlIdent, requireCapability } from './powdb.js';
import type { ColumnMetadata, IndexMetadata, RelationDef, SchemaMetadata, TableMetadata } from './schema.js';
import { singularize, snakeToCamel } from './schema.js';

/** A minimal rows-returning executor over a PowDB connection (embedded or networked). */
export type PowdbExec = (powql: string) => Promise<{ rows: Record<string, unknown>[] }>;

/** Options controlling which tables {@link introspectPowdbDatabase} reads. */
export interface PowdbIntrospectOptions {
  /** Only introspect these table names (snake_case, as PowDB reports them). */
  include?: string[];
  /** Skip these table names. */
  exclude?: string[];
  /**
   * Bound connection capabilities. When supplied AND `introspection` (engine
   * >= 0.10) is false, this throws a version-hinting {@link UnsupportedFeatureError}
   * (E017) up front instead of letting a pre-0.10 engine reject the `schema` /
   * `describe` keywords with an opaque parse error. Omit it (the bare-exec path)
   * to run ungated; the pool paths that know the version pass it through.
   */
  capabilities?: PowdbCapabilities;
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
  // Gate on the engine's introspection capability (>= 0.10) when the caller
  // knows the version, so a pre-0.10 engine gets a typed E017 hint instead of
  // an opaque `unexpected token schema` parse error.
  if (options.capabilities) {
    requireCapability(options.capabilities, 'introspection', 'PowDB `describe` introspection');
  }

  // ----- Types (one row per table, columns `name`, `columns`) -----
  const schemaRows = (await exec('schema')).rows;
  const candidateTables = schemaRows.map((r) => asString(r.name)).filter((n) => n.length > 0);

  // A mis-shaped `exec` (e.g. the raw client's positional `string[][]` rows
  // passed straight through) yields rows whose `name` cell is `undefined`, so
  // every table filters out and the schema comes back silently empty. Refuse
  // that instead of losing data: real rows must carry a `name`.
  if (schemaRows.length > 0 && candidateTables.length === 0) {
    throw new ValidationError(
      `[turbine] PowDB introspection: the \`schema\` statement returned ${schemaRows.length} row(s) but none carried a ` +
        '`name` cell. The `exec` you supplied likely returns POSITIONAL rows (string[][]) rather than records keyed by ' +
        'column name; zip `columns` with each row (see introspectPowdbDatabase docs).',
    );
  }

  // include / exclude + default bookkeeping-table exclusions (F12).
  const tableNames = applyTableFilters(candidateTables, options);

  const tables: Record<string, TableMetadata> = {};

  for (const tableName of tableNames) {
    // `describe` needs the table name in bare-identifier position → quote it so
    // a reserved-word / non-bare table name (`order`) does not become a parse
    // error.
    const describeRows = (await exec(`describe ${quotePowqlIdent(tableName)}`)).rows
      // PowDB >= 0.19.1 appends entity-LINK rows after the 4 column rows in
      // `describe <T>` (a `type` cell of literally `"link"`, an Empty nullable
      // slot, and an arrow description in the index slot). They are NOT columns,
      // so drop them before column parsing, unconditionally (no capability check):
      // the rows simply never appear on a pre-0.19.1 engine, and a linked database
      // introspected without this filter would produce garbage `link`-typed
      // columns. Declared links are read separately via `schema links` below.
      .filter((r) => asString(r.type) !== 'link')
      .map<DescribeRow>((r) => ({
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
      // Populated below from `schema links` when the engine supports link
      // introspection (>= 0.19.1); stays `{}` otherwise (PowDB has no declared
      // foreign keys, so pre-link introspection reports no relations).
      relations: {},
      indexes,
    };
  }

  // Link introspection (>= 0.19.1): populate relations from declared entity links.
  // Behaves exactly as before (relations stay `{}`) when the capability is absent
  // or not supplied.
  if (options.capabilities?.linkIntrospection) {
    await introspectPowdbLinks(exec, tables);
  }

  return { tables, enums: {} };
}

/** One row of the `schema links` listing, after string-coercing each cell. */
interface LinkRow {
  owner: string;
  name: string;
  target: string;
  localKey: string;
  targetKey: string;
  cardinality: string;
}

/**
 * Read `schema links` and populate {@link TableMetadata.relations}: the first
 * time PowDB introspection can report relations. Each declared link becomes a
 * relation on its OWNER, and its natural REVERSE is synthesized on the target
 * (mirroring the SQL introspector, which always emits both sides of a FK):
 *
 *   - `"to-one"`  link `Order.user -> User`: owner gets a `belongsTo` (localKey =
 *     the FK on the owner, targetKey = the referenced key on target); the target
 *     gets a reverse `hasMany` named for the pluralized owner table.
 *   - `"to-many"` link `User.orders -> Order`: owner gets a `hasMany` (localKey =
 *     the referenced key on the owner, targetKey = the FK on the child); the
 *     target gets a reverse `belongsTo` named for the singularized owner table.
 *
 * Reverse synthesis is best-effort and collision-guarded: a synthesized name that
 * would shadow a column field or an already-present relation on the target is
 * skipped (never a hard error), so introspection can only ADD relations, never
 * clobber. m2m junctions cannot be inferred from links and stay undetected;
 * `defineSchema` remains the relation-complete path. Column names arrive as
 * PowDB's emitted (snake) names and stay snake in `foreignKey`/`referenceKey`
 * (the SQL introspector's convention); the relation NAME is camelCased to match
 * the query field surface. Naming edge: `schema links` is the contextual listing
 * keyword: a table literally named `links` is still read via `describe links`.
 */
async function introspectPowdbLinks(exec: PowdbExec, tables: Record<string, TableMetadata>): Promise<void> {
  const linkRows: LinkRow[] = (await exec('schema links')).rows.map((r) => ({
    owner: asString(r.owner),
    name: asString(r.name),
    target: asString(r.target),
    localKey: asString(r.local_key),
    targetKey: asString(r.target_key),
    cardinality: asString(r.cardinality),
  }));

  for (const link of linkRows) {
    const owner = tables[link.owner];
    const target = tables[link.target];
    // A link referencing a filtered-out (include/exclude) table is skipped: we
    // cannot describe the target, so the relation would be unusable.
    if (!owner || !target) continue;
    const toOne = link.cardinality === 'to-one';
    const relName = snakeToCamel(link.name);

    // Forward relation on the owner (the declared direction).
    if (toOne) {
      addRelation(owner, {
        type: 'belongsTo',
        name: relName,
        from: link.owner,
        to: link.target,
        foreignKey: link.localKey,
        referenceKey: link.targetKey,
      });
    } else {
      addRelation(owner, {
        type: 'hasMany',
        name: relName,
        from: link.owner,
        to: link.target,
        foreignKey: link.targetKey, // FK on the child (target) side
        referenceKey: link.localKey, // referenced key on the owner (parent) side
      });
    }

    // Reverse relation on the target (synthesized, collision-guarded).
    const reverseName = toOne ? pluralize(snakeToCamel(link.owner)) : singularize(snakeToCamel(link.owner));
    if (!relationNameTaken(target, reverseName)) {
      addRelation(target, {
        type: toOne ? 'hasMany' : 'belongsTo',
        name: reverseName,
        from: link.target,
        to: link.owner,
        // Same two columns, roles swapped for the opposite direction.
        foreignKey: toOne ? link.localKey : link.targetKey,
        referenceKey: toOne ? link.targetKey : link.localKey,
      });
    }
  }
}

/** True when `name` already names a relation OR a column field/name on `meta`. */
function relationNameTaken(meta: TableMetadata, name: string): boolean {
  if (meta.relations[name]) return true;
  return meta.columns.some((c) => c.field === name || c.name === name);
}

/** Add a relation to a table's relations map (keyed by its camelCase name). */
function addRelation(meta: TableMetadata, rel: RelationDef): void {
  if (meta.relations[rel.name]) return; // never clobber an existing relation
  meta.relations[rel.name] = rel;
}

/**
 * Minimal English pluralizer for reverse-relation names (`user` → `users`,
 * `company` → `companies`, `box` → `boxes`). Only ever produces a candidate name
 * that {@link relationNameTaken} then vets, so an imperfect plural can at worst be
 * skipped, never break a query.
 */
function pluralize(word: string): string {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

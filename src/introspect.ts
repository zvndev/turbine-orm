/**
 * turbine-orm — Schema introspection
 *
 * Connects to a live Postgres database, reads information_schema + pg_catalog,
 * and produces a SchemaMetadata object describing every table, column, relation,
 * and index in the target schema.
 *
 * This is the foundation of `npx turbine generate`.
 */

import pg from 'pg';
import { type Dialect, postgresDialect } from './dialect.js';
import {
  type CheckMetadata,
  type ColumnMetadata,
  type IndexMetadata,
  isDateType,
  pgTypeToTs,
  type ReferentialAction,
  type RelationDef,
  type SchemaMetadata,
  singularize,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';

/**
 * Map a `pg_constraint.confdeltype` / `confupdtype` character to a
 * {@link ReferentialAction}. Postgres encodes: `a` = NO ACTION, `r` = RESTRICT,
 * `c` = CASCADE, `n` = SET NULL, `d` = SET DEFAULT.
 */
export function pgConfActionToReferential(ch: string): ReferentialAction {
  switch (ch) {
    case 'c':
      return 'cascade';
    case 'r':
      return 'restrict';
    case 'n':
      return 'set null';
    case 'd':
      return 'set default';
    default:
      return 'no action';
  }
}

// ---------------------------------------------------------------------------
// SQL queries (all parameterized, no interpolation)
// ---------------------------------------------------------------------------

const SQL_TABLES = `
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = $1
    AND table_type = 'BASE TABLE'
  ORDER BY table_name
`;

const SQL_COLUMNS = `
  SELECT
    table_name,
    column_name,
    udt_name,
    udt_schema,
    data_type,
    is_nullable,
    column_default,
    is_identity,
    is_generated,
    generation_expression,
    ordinal_position,
    character_maximum_length
  FROM information_schema.columns
  WHERE table_schema = $1
  ORDER BY table_name, ordinal_position
`;

const SQL_PRIMARY_KEYS = `
  SELECT
    tc.table_name,
    kcu.column_name,
    kcu.ordinal_position
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = $1
  ORDER BY tc.table_name, kcu.ordinal_position
`;

const SQL_FOREIGN_KEYS = `
  SELECT
    tc.table_name AS source_table,
    kcu.column_name AS source_column,
    ccu.table_name AS target_table,
    ccu.column_name AS target_column,
    tc.constraint_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu
    ON tc.constraint_name = ccu.constraint_name
    AND tc.table_schema = ccu.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY'
    AND tc.table_schema = $1
`;

const SQL_UNIQUE_CONSTRAINTS = `
  SELECT
    tc.table_name,
    tc.constraint_name,
    kcu.column_name,
    kcu.ordinal_position
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON tc.constraint_name = kcu.constraint_name
    AND tc.table_schema = kcu.table_schema
  WHERE tc.constraint_type = 'UNIQUE'
    AND tc.table_schema = $1
  ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
`;

const SQL_INDEXES = `
  SELECT tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = $1
`;

// Foreign-key referential actions (ON DELETE / ON UPDATE) live in pg_catalog,
// not information_schema. Keyed by constraint name for join with SQL_FOREIGN_KEYS.
const SQL_FK_ACTIONS = `
  SELECT con.conname, con.confdeltype, con.confupdtype
  FROM pg_constraint con
  JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
  WHERE con.contype = 'f'
    AND n.nspname = $1
`;

// CHECK constraints (contype = 'c'). NOT NULL is stored as attnotnull, not a
// check constraint, so it never appears here.
const SQL_CHECKS = `
  SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_catalog.pg_class rel ON rel.oid = con.conrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = con.connamespace
  WHERE con.contype = 'c'
    AND n.nspname = $1
`;

// Views (relkind 'v') — column metadata comes free from information_schema.columns.
const SQL_VIEWS = `
  SELECT table_name
  FROM information_schema.views
  WHERE table_schema = $1
  ORDER BY table_name
`;

// Materialized views (relkind 'm') — NOT in information_schema; read from pg_catalog.
const SQL_MATVIEWS = `
  SELECT matviewname AS table_name
  FROM pg_matviews
  WHERE schemaname = $1
  ORDER BY matviewname
`;

// Materialized-view columns — information_schema.columns omits matviews, so pull
// them from pg_attribute. Aliased to mirror SQL_COLUMNS so the same row-mapping
// applies (array types surface as data_type 'ARRAY' + a '_'-prefixed udt_name).
const SQL_MATVIEW_COLUMNS = `
  SELECT
    c.relname AS table_name,
    a.attname AS column_name,
    t.typname AS udt_name,
    tn.nspname AS udt_schema,
    CASE WHEN t.typcategory = 'A' THEN 'ARRAY' ELSE 'base' END AS data_type,
    CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS is_nullable,
    NULL AS column_default,
    'NO' AS is_identity,
    'NEVER' AS is_generated,
    NULL AS generation_expression,
    a.attnum AS ordinal_position,
    NULL::int AS character_maximum_length
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_type t ON t.oid = a.atttypid
  JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
  WHERE n.nspname = $1
    AND c.relkind = 'm'
    AND a.attnum > 0
    AND NOT a.attisdropped
  ORDER BY c.relname, a.attnum
`;

const SQL_ENUMS = `
  SELECT t.typname, e.enumlabel
  FROM pg_type t
  JOIN pg_enum e ON t.oid = e.enumtypid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = $1
  ORDER BY t.typname, e.enumsortorder
`;

// ---------------------------------------------------------------------------
// Default table exclusions (F12)
// ---------------------------------------------------------------------------

/**
 * Migration-bookkeeping tables that introspection drops by default: Turbine's
 * own `_turbine_migrations` / `_turbine_metrics` and Prisma's
 * `_prisma_migrations`. These are almost never meant to be surfaced as typed
 * accessors, and a fresh migrate-from-Prisma introspection would otherwise emit
 * a `PrismaMigrations` entity plus stray FK-derived relations on neighbours.
 *
 * A table named here is dropped UNLESS it is explicitly listed in
 * `options.include` (`include` is the escape hatch, no separate flag), and
 * naming a default-excluded table restores its old generated output byte for
 * byte. The list is deliberately tight (exactly these three); leading-
 * underscore tables are legitimate user tables and are never blanket-excluded.
 */
export const DEFAULT_EXCLUDED_TABLES = ['_turbine_migrations', '_prisma_migrations', '_turbine_metrics'] as const;

/** The include / exclude filters shared by every introspector's table selection. */
export interface TableFilterOptions {
  /** Tables to include (empty/undefined = all). Applied first. */
  include?: string[];
  /** Tables the user asked to exclude. Applied after include. */
  exclude?: string[];
}

/**
 * The single authority for turning a raw list of candidate table names into the
 * introspected set, shared by the Postgres catalog reader and every engine
 * introspector (SQLite / MySQL / MSSQL / PowDB) so all surfaces agree.
 *
 * Order of operations:
 *   1. `include` filter: when non-empty, keep only the named tables.
 *   2. user `exclude`: drop anything the caller listed.
 *   3. {@link DEFAULT_EXCLUDED_TABLES}: drop migration bookkeeping tables,
 *      EXCEPT any that the caller explicitly named in `include` (the escape
 *      hatch that restores the pre-0.41 output for those tables).
 */
export function applyTableFilters(names: string[], options: TableFilterOptions = {}): string[] {
  let result = names;
  const includeSet = options.include?.length ? new Set(options.include) : null;
  if (includeSet) {
    result = result.filter((t) => includeSet.has(t));
  }
  if (options.exclude?.length) {
    const excludeSet = new Set(options.exclude);
    result = result.filter((t) => !excludeSet.has(t));
  }
  // Default exclusions never override an explicit include.
  const defaults = new Set<string>(DEFAULT_EXCLUDED_TABLES);
  result = result.filter((t) => !defaults.has(t) || (includeSet?.has(t) ?? false));
  return result;
}

/**
 * The subset of {@link DEFAULT_EXCLUDED_TABLES} that were present in `names` but
 * dropped by {@link applyTableFilters} (i.e. not re-added via `include`). Pure
 * helper so the CLI can report "skipped internal table X" without re-deriving
 * the filtering rule.
 */
export function defaultExcludedTablesPresent(names: string[], options: TableFilterOptions = {}): string[] {
  const includeSet = options.include?.length ? new Set(options.include) : null;
  const present = new Set(names);
  return DEFAULT_EXCLUDED_TABLES.filter((t) => present.has(t) && !(includeSet?.has(t) ?? false));
}

// ---------------------------------------------------------------------------
// Introspection options
// ---------------------------------------------------------------------------

export interface IntrospectOptions {
  /** Postgres connection string */
  connectionString: string;
  /** Schema to introspect (default: 'public') */
  schema?: string;
  /** Tables to include (default: all). Glob-like patterns not supported yet. */
  include?: string[];
  /** Tables to exclude (default: none). Applied after include. */
  exclude?: string[];
  /**
   * Also introspect **views** and **materialized views** as read-only
   * {@link TableMetadata} entries (`isView: true`). Off by default. Write
   * builders reject views (E003); a view without a primary key is excluded from
   * the generated `findUnique`-family accessor types.
   */
  includeViews?: boolean;
  /**
   * Opt OUT of the unique-FK → `hasOne` flip (F2). By default (`false`)
   * introspection emits a to-one (`hasOne`) relation on the parent side when a
   * child's foreign-key column set is EXACTLY covered by a UNIQUE constraint or
   * a non-partial, non-expression UNIQUE index, matching Prisma one-to-one
   * introspection. Set to `true` to keep the pre-0.41 behavior where every such
   * relation was emitted as `hasMany` (a to-many array). See
   * {@link detectUniqueForeignKeySets}.
   */
  legacyToManyUniques?: boolean;
  /**
   * Called with any {@link DEFAULT_EXCLUDED_TABLES} that were present in the
   * database but dropped from this run (F12), so the CLI can print a
   * "skipped internal table X (add it to include to keep it)" note. Not invoked
   * when the set is empty. Postgres path only for now.
   */
  onDefaultTableExclusion?: (tables: string[]) => void;
  /**
   * Dialect whose {@link Dialect.introspector} drives the catalog reads.
   * Defaults to {@link postgresDialect}. Engines plug their own introspector
   * here so `introspect()` works across databases.
   */
  dialect?: Dialect;
}

// ---------------------------------------------------------------------------
// Main introspection function
// ---------------------------------------------------------------------------

/**
 * Introspect a database into {@link SchemaMetadata}, routing through the active
 * dialect's {@link Dialect.introspector} so each engine can override the catalog
 * SQL. PostgreSQL is driven by {@link introspectPostgresCatalog}.
 */
export async function introspect(options: IntrospectOptions): Promise<SchemaMetadata> {
  const dialect = options.dialect ?? postgresDialect;
  const introspector = dialect.introspector;
  if (introspector) {
    return introspector.introspect(options);
  }
  // Dialects without an introspector fall back to the Postgres catalog reader.
  return introspectPostgresCatalog(options);
}

/**
 * PostgreSQL catalog introspector: reads information_schema + pg_catalog and
 * produces {@link SchemaMetadata}. This is the implementation wrapped by
 * `postgresDialect.introspector`; call {@link introspect} for dialect routing.
 */
export async function introspectPostgresCatalog(options: IntrospectOptions): Promise<SchemaMetadata> {
  const schema = options.schema ?? 'public';
  const dialect = postgresDialect;
  const pool = new pg.Pool({
    connectionString: options.connectionString,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  try {
    // Run all information_schema queries in parallel
    const [
      tablesResult,
      columnsResult,
      pkResult,
      fkResult,
      fkActionsResult,
      uniqueResult,
      indexResult,
      checkResult,
      enumResult,
    ] = await Promise.all([
      pool.query(SQL_TABLES, [schema]),
      pool.query(SQL_COLUMNS, [schema]),
      pool.query(SQL_PRIMARY_KEYS, [schema]),
      pool.query(SQL_FOREIGN_KEYS, [schema]),
      pool.query(SQL_FK_ACTIONS, [schema]),
      pool.query(SQL_UNIQUE_CONSTRAINTS, [schema]),
      pool.query(SQL_INDEXES, [schema]),
      pool.query(SQL_CHECKS, [schema]),
      pool.query(SQL_ENUMS, [schema]),
    ]);

    // Views + materialized views (opt-in). Regular-view columns are already in
    // columnsResult (information_schema.columns); matview columns need a separate
    // pg_catalog read, which we splice into the column rows below.
    const viewNameSet = new Set<string>();
    const matviewColumnRows: Array<Record<string, unknown>> = [];
    if (options.includeViews) {
      const [viewsResult, matviewsResult, matviewColsResult] = await Promise.all([
        pool.query(SQL_VIEWS, [schema]),
        pool.query(SQL_MATVIEWS, [schema]),
        pool.query(SQL_MATVIEW_COLUMNS, [schema]),
      ]);
      for (const r of viewsResult.rows) viewNameSet.add(r.table_name);
      for (const r of matviewsResult.rows) viewNameSet.add(r.table_name);
      matviewColumnRows.push(...matviewColsResult.rows);
    }

    // constraint_name → { onDelete, onUpdate } referential actions.
    const fkActions = new Map<string, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>();
    for (const row of fkActionsResult.rows) {
      fkActions.set(row.conname, {
        onDelete: pgConfActionToReferential(row.confdeltype),
        onUpdate: pgConfActionToReferential(row.confupdtype),
      });
    }

    // Filter tables by include/exclude + default bookkeeping-table exclusions
    // (F12). Views/matviews join the base tables as candidates so the filters
    // apply uniformly.
    const candidateTables: string[] = [
      ...tablesResult.rows.map((r: { table_name: string }) => r.table_name),
      ...viewNameSet,
    ];
    const tableNames = applyTableFilters(candidateTables, options);
    if (options.onDefaultTableExclusion) {
      const skipped = defaultExcludedTablesPresent(candidateTables, options);
      if (skipped.length > 0) options.onDefaultTableExclusion(skipped);
    }

    const tableSet = new Set(tableNames);

    // ----- Group columns by table -----
    // Base-table + regular-view columns come from information_schema.columns;
    // materialized-view columns are appended from the pg_catalog read.
    const columnsByTable = new Map<string, ColumnMetadata[]>();
    for (const row of [...columnsResult.rows, ...matviewColumnRows]) {
      const tableName: string = row.table_name;
      if (!tableSet.has(tableName)) continue;

      const isNullable = row.is_nullable === 'YES';
      const isArray = row.data_type === 'ARRAY';
      const baseType: string = isArray ? row.udt_name.slice(1) : row.udt_name;

      const dialectType = row.udt_name;
      const arrayType = dialect.arrayType?.(baseType) ?? 'text[]';
      const col: ColumnMetadata = {
        name: row.column_name,
        field: snakeToCamel(row.column_name),
        dialectType,
        pgType: dialectType,
        tsType:
          dialect.typeToTypeScript?.(isArray ? dialectType : baseType, isNullable) ??
          pgTypeToTs(isArray ? dialectType : baseType, isNullable),
        nullable: isNullable,
        hasDefault: row.column_default !== null,
        // Server-generated = a sequence default (serial/BIGSERIAL → nextval(…))
        // or an IDENTITY column. Distinct from a client-side default expression
        // (gen_random_uuid(), now()), which Turbine must still synthesize.
        isGenerated:
          (typeof row.column_default === 'string' && row.column_default.includes('nextval(')) ||
          row.is_identity === 'YES',
        // GENERATED ALWAYS AS (expr) STORED — computed by the database, never
        // writable. Distinct from isGenerated (serial/identity, which a client
        // MAY override). is_generated is 'ALWAYS' for STORED columns, else 'NEVER'.
        isGeneratedStored: row.is_generated === 'ALWAYS',
        generationExpression:
          row.is_generated === 'ALWAYS' && row.generation_expression ? row.generation_expression : undefined,
        isArray,
        arrayType,
        pgArrayType: arrayType,
        maxLength: row.character_maximum_length ?? undefined,
        // Record the type's schema ONLY when it lives outside the introspected
        // schema (and isn't a pg_catalog builtin). A same-named enum in another
        // schema must NOT get this schema's `::"enum"` cast — search_path would
        // resolve the cast to the wrong type (see enumTypeForColumn). Omitting
        // it for the common case keeps generated metadata byte-identical.
        ...(typeof row.udt_schema === 'string' && row.udt_schema !== schema && row.udt_schema !== 'pg_catalog'
          ? { pgTypeSchema: row.udt_schema }
          : {}),
      };

      if (!columnsByTable.has(tableName)) columnsByTable.set(tableName, []);
      columnsByTable.get(tableName)!.push(col);
    }

    // ----- Group primary keys by table -----
    const pkByTable = new Map<string, string[]>();
    for (const row of pkResult.rows) {
      if (!tableSet.has(row.table_name)) continue;
      if (!pkByTable.has(row.table_name)) pkByTable.set(row.table_name, []);
      pkByTable.get(row.table_name)!.push(row.column_name);
    }

    // ----- Group unique constraints by table -----
    // Group rows by (table_name, constraint_name) to correctly handle multi-column unique constraints
    const uniqueByTable = new Map<string, string[][]>();
    const uniqueConstraintGroups = new Map<string, { table: string; columns: string[] }>();
    for (const row of uniqueResult.rows) {
      if (!tableSet.has(row.table_name)) continue;
      const key = `${row.table_name}::${row.constraint_name}`;
      if (!uniqueConstraintGroups.has(key)) {
        uniqueConstraintGroups.set(key, { table: row.table_name, columns: [] });
      }
      uniqueConstraintGroups.get(key)!.columns.push(row.column_name);
    }
    for (const { table, columns } of uniqueConstraintGroups.values()) {
      if (!uniqueByTable.has(table)) uniqueByTable.set(table, []);
      uniqueByTable.get(table)!.push(columns);
    }

    // ----- Group indexes by table -----
    const indexesByTable = new Map<string, IndexMetadata[]>();
    for (const row of indexResult.rows) {
      if (!tableSet.has(row.tablename)) continue;
      if (!indexesByTable.has(row.tablename)) indexesByTable.set(row.tablename, []);

      const indexdef = row.indexdef as string;
      const isUnique = indexdef.includes('UNIQUE');
      const isPartial = indexHasWhere(indexdef);

      indexesByTable.get(row.tablename)!.push({
        name: row.indexname,
        columns: parseIndexColumns(indexdef),
        unique: isUnique,
        definition: indexdef,
        ...(isPartial ? { partial: true } : {}),
      });
    }

    // ----- Group check constraints by table -----
    // pg_get_constraintdef yields e.g. `CHECK ((price >= 0))`; strip the leading
    // `CHECK ` and the outermost paren pair to recover the raw expression.
    const checksByTable = new Map<string, CheckMetadata[]>();
    for (const row of checkResult.rows) {
      if (!tableSet.has(row.table_name)) continue;
      if (!checksByTable.has(row.table_name)) checksByTable.set(row.table_name, []);
      checksByTable.get(row.table_name)!.push({
        name: row.conname,
        expression: stripCheckWrapper(row.definition),
      });
    }

    // ----- Collect enums -----
    const enums: Record<string, string[]> = {};
    for (const row of enumResult.rows) {
      if (!enums[row.typname]) enums[row.typname] = [];
      enums[row.typname]!.push(row.enumlabel);
    }

    // ----- Build foreign key map -----
    // Group FK rows by constraint_name to correctly handle multi-column composite FKs.
    // Each constraint becomes one FKEntry with arrays of columns.
    const fkGroups = new Map<string, ForeignKeyEntry>();
    for (const row of fkResult.rows) {
      if (!tableSet.has(row.source_table) || !tableSet.has(row.target_table)) continue;
      const key = row.constraint_name as string;
      if (!fkGroups.has(key)) {
        fkGroups.set(key, {
          sourceTable: row.source_table,
          sourceColumns: [],
          targetTable: row.target_table,
          targetColumns: [],
          constraintName: key,
        });
      }
      const entry = fkGroups.get(key)!;
      entry.sourceColumns.push(row.source_column);
      entry.targetColumns.push(row.target_column);
    }
    const foreignKeys = Array.from(fkGroups.values());

    // ----- Build relations from foreign keys -----
    // Delegated to the pure, unit-testable builder. Relation names are derived
    // per-FK-column when several FKs point at the same target, and every name
    // is collision-checked against the table's scalar column fields so a
    // relation can never shadow a column (which generated unsound types and
    // made both surfaces unusable — dogfood T-4).
    const columnFieldsByTable = new Map<string, Set<string>>();
    const unknownTypedFieldsByTable = new Map<string, Set<string>>();
    for (const [tbl, cols] of columnsByTable) {
      columnFieldsByTable.set(tbl, new Set(cols.map((c) => c.field)));
      // Enum-typed columns also report tsType 'unknown' here, but generate.ts
      // gives them a concrete union type — a shadow of one was type-broken on
      // main, so only genuine json/jsonb columns qualify as historical shadows.
      unknownTypedFieldsByTable.set(
        tbl,
        new Set(cols.filter((c) => isUnknownTsType(c.tsType) && !Object.hasOwn(enums, c.pgType)).map((c) => c.field)),
      );
    }
    // F2: unless the caller opts out, detect child FK column sets that a unique
    // constraint / plain unique index exactly covers, so the reverse relation is
    // emitted as a one-to-one (`hasOne`) instead of `hasMany`.
    const uniqueSetsByTable = options.legacyToManyUniques
      ? undefined
      : detectUniqueForeignKeySets(pkByTable, uniqueByTable, indexesByTable);
    const relationsByTable = buildRelationsFromForeignKeys(
      foreignKeys,
      columnFieldsByTable,
      fkActions,
      unknownTypedFieldsByTable,
      uniqueSetsByTable,
    );

    // ----- Conservative many-to-many auto-detection (PURELY ADDITIVE) -----
    //
    // Auto-detecting m2m is a footgun: any table with two FKs *looks* like a
    // junction, but a `enrollments(student_id, course_id, grade, enrolled_at)`
    // table is a first-class entity, not a join table. Prisma and Drizzle both
    // require explicit m2m declaration for exactly this reason.
    //
    // We only treat a table J as a PURE junction when ALL of these hold:
    //   1. J's primary key is exactly two columns.
    //   2. J has exactly two FKs, each single-column.
    //   3. Each FK's source column is one of J's two PK columns (the PK *is* the
    //      two FK columns — no surrogate PK, no extra identity).
    //   4. The two FKs target two DISTINCT tables (A and B).
    //   5. J has no columns beyond those two FK/PK columns (no payload columns
    //      like `grade` or `created_at`).
    //
    // For such a J linking A and B we ADD a `manyToMany` relation on A → B and
    // symmetrically on B → A, both routed `through` J. The existing belongsTo /
    // hasMany relations derived from J's FKs are left untouched — this block
    // never removes or renames anything. Naming/collision handling lives in the
    // shared addAutoManyToManyRelations helper.
    //
    // Prisma's implicit m2m junctions have no primary key (just a two-column
    // UNIQUE index over the FK columns), so pass the introspected two-column
    // unique indexes as the fallback junction-key source.
    const uniqueIndexColsByTable = new Map<string, string[][]>();
    for (const [tbl, idxs] of indexesByTable) {
      const twoColUniques = idxs.filter((idx) => idx.unique && idx.columns.length === 2).map((idx) => idx.columns);
      if (twoColUniques.length > 0) uniqueIndexColsByTable.set(tbl, twoColUniques);
    }
    addAutoManyToManyRelations(
      tableNames,
      foreignKeys,
      pkByTable,
      new Map(Array.from(columnsByTable, ([tbl, cols]) => [tbl, cols.map((c) => c.name)])),
      relationsByTable,
      columnFieldsByTable,
      unknownTypedFieldsByTable,
      uniqueIndexColsByTable,
    );

    // ----- Assemble TableMetadata for each table -----
    const tables: Record<string, TableMetadata> = {};

    for (const tableName of tableNames) {
      const columns = columnsByTable.get(tableName) ?? [];
      const columnMap: Record<string, string> = {};
      const reverseColumnMap: Record<string, string> = {};
      const dateColumns = new Set<string>();
      const dialectTypes: Record<string, string> = {};
      const pgTypes: Record<string, string> = {};
      const allColumns: string[] = [];

      for (const col of columns) {
        columnMap[col.field] = col.name;
        reverseColumnMap[col.name] = col.field;
        allColumns.push(col.name);
        dialectTypes[col.name] = col.dialectType ?? col.pgType;
        pgTypes[col.name] = col.pgType;

        const baseType = col.isArray ? (col.dialectType ?? col.pgType).slice(1) : (col.dialectType ?? col.pgType);
        if (isDateType(baseType)) {
          dateColumns.add(col.name);
        }
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
        primaryKey: pkByTable.get(tableName) ?? [],
        uniqueColumns: uniqueByTable.get(tableName) ?? [],
        relations: relationsByTable.get(tableName) ?? {},
        indexes: indexesByTable.get(tableName) ?? [],
        checks: checksByTable.get(tableName) ?? [],
        ...(viewNameSet.has(tableName) ? { isView: true } : {}),
      };
    }

    return { tables, enums };
  } finally {
    await pool.end();
  }
}

/**
 * Parse the indexed column names out of a `pg_indexes.indexdef` string.
 *
 * `indexdef` always reads `CREATE [UNIQUE] INDEX name ON tbl USING method
 * (col, ...) [WHERE predicate]`. We anchor on the `USING` clause's parenthesised
 * column list (the same precedent as `describeIndexDefMismatch` in
 * schema-sql.ts) so a PARTIAL index's trailing `WHERE (...)` parentheses are
 * never mistaken for the column list. The older greedy `/\((.+)\)/` swallowed
 * `) WHERE (` and spliced a raw predicate fragment into the column names, which
 * then leaked into generated compound-unique selector names.
 *
 * Each column is de-quoted (Postgres quotes non-lowercase identifiers such as a
 * Prisma implicit m2m junction's `"A"` / `"B"`), so the names match the
 * unquoted column names carried elsewhere in the metadata. Expression columns
 * (anything containing a parenthesis) are dropped conservatively: a functional
 * index does not name a plain column.
 */
export function parseIndexColumns(indexdef: string): string[] {
  const m = indexdef.match(/USING\s+\w+\s*\(([^)]*)\)/i) ?? indexdef.match(/\(([^)]*)\)/);
  if (!m) return [];
  return m[1]!
    .split(',')
    .map((c) =>
      unquoteIndexIdent(
        c
          .trim()
          .replace(/\s+(ASC|DESC)$/i, '')
          .trim(),
      ),
    )
    .filter((c) => c.length > 0 && !c.includes('(') && !c.includes(')'));
}

/** Strip one pair of surrounding double quotes and unescape doubled `""`. */
function unquoteIndexIdent(col: string): string {
  if (col.length >= 2 && col.startsWith('"') && col.endsWith('"')) {
    return col.slice(1, -1).replace(/""/g, '"');
  }
  return col;
}

/**
 * Whether an `indexdef` carries a top-level `WHERE` predicate (a PARTIAL index).
 * pg_indexes only ever emits `WHERE` as the partial predicate, so a keyword
 * match is sufficient (matches the `describeIndexDefMismatch` precedent).
 */
export function indexHasWhere(indexdef: string): boolean {
  return /\bWHERE\b/i.test(indexdef);
}

/**
 * Recover the raw check expression from `pg_get_constraintdef` output, which
 * wraps it as `CHECK ((expr))`. Strips the leading `CHECK ` keyword and one
 * balanced outer paren pair; leaves anything unexpected untouched.
 */
export function stripCheckWrapper(def: string): string {
  let s = def.trim();
  const m = /^CHECK\s*\((.*)\)$/is.exec(s);
  if (m) s = m[1]!.trim();
  // pg double-wraps single expressions: `(price >= 0)` → unwrap one more pair
  // only when the parens are balanced across the whole string.
  if (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0;
    let balanced = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') {
        depth--;
        if (depth === 0 && i < s.length - 1) {
          balanced = false;
          break;
        }
      }
    }
    if (balanced) s = s.slice(1, -1).trim();
  }
  return s;
}

// ---------------------------------------------------------------------------
// Relation derivation from foreign keys (pure — unit-testable without a DB)
// ---------------------------------------------------------------------------

/** A foreign-key constraint grouped by constraint name (composite FKs carry column arrays). */
export interface ForeignKeyEntry {
  sourceTable: string;
  sourceColumns: string[];
  targetTable: string;
  targetColumns: string[];
  constraintName: string;
}

/**
 * Derive a belongsTo relation name from its FK column. Strips a trailing
 * `_id` (snake_case) or `Id` (camelCase column names — common in Prisma-ported
 * schemas where columns are quoted camelCase identifiers), then camelCases:
 * `current_version_id` and `currentVersionId` both yield `currentVersion`.
 * Stripping is what keeps the scalar FK field (`currentVersionId`) targetable
 * alongside the relation. A column literally named `id` (nothing left after
 * stripping) keeps its own name.
 */
export function relationNameFromColumn(column: string): string {
  let base = column;
  if (/_id$/i.test(base)) base = base.slice(0, -3);
  else if (/[a-z0-9]Id$/.test(base)) base = base.slice(0, -2);
  if (base.length === 0) base = column;
  return snakeToCamel(base);
}

/** Uppercase the first character (camelCase → PascalCase join helper). */
function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * True for the tsType forms a json/jsonb column maps to (`unknown`, nullable
 * `unknown | null`). A relation shadowing such a column is a HISTORICAL shadow
 * that worked at runtime and compiled (`unknown` absorbs the relation
 * payload), so the legacy-first naming keeps it instead of renaming.
 */
export function isUnknownTsType(tsType: string): boolean {
  return tsType === 'unknown' || tsType === 'unknown | null';
}

// ---------------------------------------------------------------------------
// Unique-foreign-key detection for one-to-one relations (F2)
// ---------------------------------------------------------------------------

/** True when two column lists cover the same set (order-insensitive, no dupes). */
function columnSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((c) => bs.has(c));
}

/**
 * Parse the column list of a PLAIN unique index from its `pg_indexes.indexdef`,
 * returning `null` for anything that does NOT guarantee at-most-one child row:
 *
 *   - a PARTIAL index (has a `WHERE` clause): only unique within the predicate;
 *   - an EXPRESSION index (`lower(email)`, `(a || b)`): the uniqueness is on the
 *     expression, not the raw FK column set.
 *
 * Anchors on the `USING <method> (` clause the same way
 * {@link describeIndexDefMismatch} does, so a partial index's `WHERE (...)`
 * parentheses are never mistaken for the column list. Every column token must be
 * a bare or double-quoted identifier; anything else (a function call, an
 * operator expression) fails the check and yields `null`.
 */
export function parsePlainUniqueIndexColumns(indexdef: string): string[] | null {
  // Partial index: uniqueness is scoped to the WHERE predicate.
  if (/\bWHERE\b/i.test(indexdef)) return null;
  const paren = indexdef.match(/USING\s+\w+\s*\(([^)]*)\)/i);
  if (!paren) return null;
  const tokens = paren[1]!.split(',').map((c) =>
    c
      .trim()
      .replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST))\b/gi, '')
      .trim(),
  );
  const columns: string[] = [];
  for (const token of tokens) {
    if (token.length === 0) return null;
    if (/^"(?:[^"]|"")*"$/.test(token)) {
      // Quoted identifier: unquote and unescape doubled quotes.
      columns.push(token.slice(1, -1).replace(/""/g, '"'));
    } else if (/^[A-Za-z_][A-Za-z0-9_$]*$/.test(token)) {
      columns.push(token);
    } else {
      // Expression column (function call, operator, cast, and the like): never a plain FK.
      return null;
    }
  }
  return columns.length > 0 ? columns : null;
}

/**
 * Assemble, per table, every column set that EXACTLY guarantees at-most-one row:
 * the primary key, every UNIQUE constraint, and every PLAIN (non-partial,
 * non-expression) UNIQUE index. Consumed by
 * {@link buildRelationsFromForeignKeys} to flip a child relation whose FK column
 * set matches one of these sets from `hasMany` to `hasOne` (F2, Prisma
 * one-to-one parity).
 */
export function detectUniqueForeignKeySets(
  pkByTable: Map<string, string[]>,
  uniqueByTable: Map<string, string[][]>,
  indexesByTable: Map<string, IndexMetadata[]>,
): Map<string, string[][]> {
  const result = new Map<string, string[][]>();
  const add = (table: string, cols: string[]) => {
    if (cols.length === 0) return;
    if (!result.has(table)) result.set(table, []);
    result.get(table)!.push(cols);
  };
  for (const [table, pk] of pkByTable) add(table, pk);
  for (const [table, sets] of uniqueByTable) for (const cols of sets) add(table, cols);
  for (const [table, indexes] of indexesByTable) {
    for (const idx of indexes) {
      if (!idx.unique) continue;
      const cols = parsePlainUniqueIndexColumns(idx.definition);
      if (cols) add(table, cols);
    }
  }
  return result;
}

/**
 * Resolve a derived relation name against the names already taken on the
 * table (scalar column fields + previously assigned relations). On collision,
 * applies a deterministic `Rel` / `Rel2` / `Rel3`… suffix and warns — a
 * colliding name would otherwise shadow a column field and generate types
 * that fail `tsc --strict` (TS2430/TS2322).
 */
function resolveRelationNameCollision(candidate: string, taken: Set<string>, table: string, source: string): string {
  if (!taken.has(candidate)) return candidate;
  let name = `${candidate}Rel`;
  for (let i = 2; taken.has(name); i++) name = `${candidate}Rel${i}`;
  console.warn(
    `[turbine] Relation name "${candidate}" on table "${table}" (from ${source}) collides with an existing column or relation — using "${name}" instead.`,
  );
  return name;
}

/**
 * Build the belongsTo/hasMany relation maps for every table from its foreign
 * keys. Naming rules (LEGACY-FIRST — a relation name that previously worked at
 * runtime must never change out from under a regenerating app):
 *
 *   1. First compute the historical derivation exactly as it shipped before
 *      the collision guard existed: belongsTo strips a case-SENSITIVE `_id`
 *      suffix (`snakeToCamel(col.replace(/_id$/, ''))` when several FKs point
 *      at the same target, else the singularized target table), and hasMany is
 *      `snakeToCamel(`${source}_by_${strippedColumn}`)` (else the source
 *      table). If that legacy name is free, KEEP IT — even when it looks odd
 *      (`blogPostsByAuthorId`, `postsBy_Author`): those names were collision-
 *      free and worked, so regenerating must not rename them.
 *   2. If the legacy name collides ONLY with a scalar column whose tsType is
 *      `unknown` (json/jsonb), keep it anyway with a warning: the shadow is
 *      historical, ran fine at runtime, and compiled (`unknown` absorbs the
 *      relation payload; generate.ts's typeSafeRelations omits the relation
 *      from the type layer).
 *   3. On a genuine collision (concrete-typed column shadow, or a previously
 *      assigned relation), fall back to the modern derivation — the `_id`/`Id`
 *      case-insensitive strip of {@link relationNameFromColumn} plus the
 *      `By`-composed reverse name — which fixes the camelCase-FK shadowing
 *      shapes that were actually BROKEN before (relation name === scalar FK
 *      field → unusable types).
 *   4. Last resort: deterministic `Rel`/`Rel2` suffix + warning.
 *
 * @param columnFieldsByTable camelCase column *fields* per table — used to
 *   guarantee relations never shadow concrete-typed scalar columns.
 * @param unknownTypedFieldsByTable subset of the column fields whose tsType is
 *   `unknown` (json/jsonb) — legacy shadows of these are preserved (rule 2).
 * @param uniqueSetsByTable when provided (F2), the child-table column sets that
 *   guarantee at-most-one row (PK + unique constraints + plain unique indexes,
 *   from {@link detectUniqueForeignKeySets}). A reverse relation whose FK column
 *   set EXACTLY matches one of the child's unique sets is emitted as `hasOne`
 *   (to-one) instead of `hasMany`, and named with the SINGULAR of the child
 *   table (falling back to the legacy plural name on collision). Omit it (the
 *   engine introspectors and `defineSchema` path do) to keep every reverse
 *   relation `hasMany`.
 */
export function buildRelationsFromForeignKeys(
  foreignKeys: ForeignKeyEntry[],
  columnFieldsByTable: Map<string, Set<string>>,
  fkActions?: Map<string, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>,
  unknownTypedFieldsByTable?: Map<string, Set<string>>,
  uniqueSetsByTable?: Map<string, string[][]>,
): Map<string, Record<string, RelationDef>> {
  // Count FKs per (source, target) pair for disambiguation.
  const fkCounts = new Map<string, number>();
  for (const fk of foreignKeys) {
    const key = `${fk.sourceTable}→${fk.targetTable}`;
    fkCounts.set(key, (fkCounts.get(key) ?? 0) + 1);
  }

  const relationsByTable = new Map<string, Record<string, RelationDef>>();

  // Names already taken per table: seeded with the scalar column fields so a
  // relation can never shadow a column; relation names are added as assigned.
  const takenByTable = new Map<string, Set<string>>();
  const takenFor = (table: string): Set<string> => {
    let taken = takenByTable.get(table);
    if (!taken) {
      taken = new Set(columnFieldsByTable.get(table) ?? []);
      takenByTable.set(table, taken);
    }
    return taken;
  };
  // Relation names actually assigned so far (as opposed to column fields) —
  // needed to tell "collides only with a column" apart from "collides with an
  // already-assigned relation" for the legacy-shadow-preserving rule.
  const assignedByTable = new Map<string, Set<string>>();
  const assignedFor = (table: string): Set<string> => {
    let assigned = assignedByTable.get(table);
    if (!assigned) {
      assigned = new Set();
      assignedByTable.set(table, assigned);
    }
    return assigned;
  };

  /** Legacy-first name resolution — see the naming rules in the JSDoc above. */
  const resolveName = (legacy: string, modern: string | null, table: string, source: string): string => {
    const taken = takenFor(table);
    if (!taken.has(legacy)) return legacy;
    // Historical json/jsonb shadow: previously worked at runtime AND compiled
    // (tsType `unknown` absorbs the relation payload). Keep the name, warn —
    // typeSafeRelations() keeps the generated type layer sound.
    if (!assignedFor(table).has(legacy) && unknownTypedFieldsByTable?.get(table)?.has(legacy)) {
      console.warn(
        `[turbine] Relation "${legacy}" on table "${table}" (from ${source}) shadows the json/jsonb column ` +
          `"${legacy}" — keeping the historical name for runtime compatibility; the relation is omitted from ` +
          `the generated types. Rename the column to expose it.`,
      );
      return legacy;
    }
    if (modern !== null && modern !== legacy && !taken.has(modern)) return modern;
    return resolveRelationNameCollision(modern ?? legacy, taken, table, source);
  };

  for (const fk of foreignKeys) {
    const pairKey = `${fk.sourceTable}→${fk.targetTable}`;
    const needsDisambiguation = (fkCounts.get(pairKey) ?? 0) > 1;
    const singleColumn = fk.sourceColumns.length === 1;

    // For single-column FKs, keep string form for backwards compatibility.
    // For multi-column (composite) FKs, use array form.
    const foreignKey = singleColumn ? fk.sourceColumns[0]! : fk.sourceColumns;
    const referenceKey = fk.targetColumns.length === 1 ? fk.targetColumns[0]! : fk.targetColumns;

    // Composite FKs have no single column to derive from — fall back to the
    // constraint name (with the usual fk_/-_fkey affixes stripped).
    const constraintBase = fk.constraintName.replace(/^fk_/, '').replace(/_fkey$/, '');

    // --- belongsTo on the source (child) table ---
    // e.g. posts.user_id → users.id creates posts.user (belongsTo)
    const legacyBelongsTo = needsDisambiguation
      ? singleColumn
        ? snakeToCamel(fk.sourceColumns[0]!.replace(/_id$/, ''))
        : snakeToCamel(constraintBase)
      : singularize(snakeToCamel(fk.targetTable));
    const modernBelongsTo = needsDisambiguation && singleColumn ? relationNameFromColumn(fk.sourceColumns[0]!) : null;
    const belongsToName = resolveName(legacyBelongsTo, modernBelongsTo, fk.sourceTable, `FK ${fk.constraintName}`);
    takenFor(fk.sourceTable).add(belongsToName);
    assignedFor(fk.sourceTable).add(belongsToName);

    // Referential actions (omit the 'no action' default to keep metadata lean).
    const actions = fkActions?.get(fk.constraintName);
    const actionFields: { onDelete?: ReferentialAction; onUpdate?: ReferentialAction } = {};
    if (actions?.onDelete && actions.onDelete !== 'no action') actionFields.onDelete = actions.onDelete;
    if (actions?.onUpdate && actions.onUpdate !== 'no action') actionFields.onUpdate = actions.onUpdate;

    if (!relationsByTable.has(fk.sourceTable)) relationsByTable.set(fk.sourceTable, {});
    relationsByTable.get(fk.sourceTable)![belongsToName] = {
      type: 'belongsTo',
      name: belongsToName,
      from: fk.sourceTable,
      to: fk.targetTable,
      foreignKey,
      referenceKey,
      ...actionFields,
    };

    // --- reverse relation on the target (parent) table ---
    // e.g. posts.user_id → users.id creates users.posts (hasMany), UNLESS the
    // child's FK column set is exactly covered by a unique constraint / plain
    // unique index (F2), then it is a one-to-one, emitted as `hasOne` and
    // named with the SINGULAR of the child table.
    const isUniqueFk = (uniqueSetsByTable?.get(fk.sourceTable) ?? []).some((set) =>
      columnSetsEqual(set, fk.sourceColumns),
    );

    const disambSuffix = needsDisambiguation
      ? singleColumn
        ? `By${upperFirst(relationNameFromColumn(fk.sourceColumns[0]!))}`
        : `By${upperFirst(snakeToCamel(constraintBase))}`
      : '';
    const legacyReverse = needsDisambiguation
      ? singleColumn
        ? snakeToCamel(`${fk.sourceTable}_by_${fk.sourceColumns[0]!.replace(/_id$/, '')}`)
        : snakeToCamel(`${fk.sourceTable}_by_${constraintBase}`)
      : snakeToCamel(fk.sourceTable);
    const modernReverse = needsDisambiguation ? `${snakeToCamel(fk.sourceTable)}${disambSuffix}` : null;

    let reverseName: string;
    const reverseType: 'hasMany' | 'hasOne' = isUniqueFk ? 'hasOne' : 'hasMany';
    if (isUniqueFk) {
      // Prefer the singular child-table name; fall back to the legacy plural
      // (which stays byte-stable for any app that was on the pre-flip shape).
      const singularReverse = `${singularize(snakeToCamel(fk.sourceTable))}${disambSuffix}`;
      reverseName = resolveName(singularReverse, legacyReverse, fk.targetTable, `FK ${fk.constraintName}`);
    } else {
      reverseName = resolveName(legacyReverse, modernReverse, fk.targetTable, `FK ${fk.constraintName}`);
    }
    takenFor(fk.targetTable).add(reverseName);
    assignedFor(fk.targetTable).add(reverseName);

    if (!relationsByTable.has(fk.targetTable)) relationsByTable.set(fk.targetTable, {});
    relationsByTable.get(fk.targetTable)![reverseName] = {
      type: reverseType,
      name: reverseName,
      from: fk.targetTable,
      to: fk.sourceTable,
      foreignKey,
      referenceKey,
      ...actionFields,
    };
  }

  return relationsByTable;
}

/**
 * Conservative auto-`manyToMany` detection over pure junction tables, shared
 * by the Postgres introspector, the engine introspectors (SQLite / MySQL /
 * MSSQL), the MCP server, and `schemaDefToMetadata()` so all surfaces derive
 * IDENTICAL relation names for the same logical schema.
 *
 * A table J is a PURE junction only when ALL of these hold:
 *   1. J's junction KEY is exactly two columns: either a two-column primary
 *      key, OR (Prisma implicit m2m junctions have NO primary key) a two-column
 *      UNIQUE index over exactly the two FK columns, supplied via the optional
 *      `uniqueIndexColsByTable`. When that map is absent the behavior is
 *      unchanged: only a two-column PK qualifies.
 *   2. J has exactly two FKs, each single-column.
 *   3. Each FK's source column is one of J's two key columns.
 *   4. The two FKs target two DISTINCT tables (A and B).
 *   5. J has no payload columns beyond the two FK/key columns.
 *
 * For such a J linking A and B this ADDS a `manyToMany` on A → B and B → A
 * routed `through` J. It never removes or renames an existing relation:
 *   - an already-assigned relation with the same name → SKIP (additive-only,
 *     unchanged historical behavior);
 *   - a shadowed json/jsonb (`unknown`-typed) column → keep the historical
 *     name + warn (it worked at runtime and compiled);
 *   - a shadowed concrete-typed column → deterministic `Rel` suffix + warn
 *     instead of silently dropping the relation.
 */
export function addAutoManyToManyRelations(
  tableNames: Iterable<string>,
  foreignKeys: ForeignKeyEntry[],
  pkByTable: Map<string, string[]>,
  columnNamesByTable: Map<string, string[]>,
  relationsByTable: Map<string, Record<string, RelationDef>>,
  columnFieldsByTable?: Map<string, Set<string>>,
  unknownTypedFieldsByTable?: Map<string, Set<string>>,
  uniqueIndexColsByTable?: Map<string, string[][]>,
): void {
  for (const tableName of tableNames) {
    // FKs whose source is this table — both must be single-column.
    const tableFks = foreignKeys.filter((fk) => fk.sourceTable === tableName);
    if (tableFks.length !== 2) continue;
    if (tableFks.some((fk) => fk.sourceColumns.length !== 1)) continue;

    const fkCols = tableFks.map((fk) => fk.sourceColumns[0]!);
    if (new Set(fkCols).size !== 2) continue;
    const fkSet = new Set(fkCols);

    // The junction KEY is normally the two-column PK. Prisma's implicit m2m
    // junctions have NO primary key, so accept instead a two-column UNIQUE
    // index that covers exactly the two FK columns. Only a PK-less table is
    // eligible for the unique-index fallback, so a real entity that happens to
    // carry a two-column unique index is never mistaken for a junction.
    const pk = pkByTable.get(tableName) ?? [];
    let keyCols: string[] | undefined;
    if (pk.length === 2 && pk.every((c) => fkSet.has(c))) {
      keyCols = pk;
    } else if (pk.length === 0) {
      const uniques = uniqueIndexColsByTable?.get(tableName) ?? [];
      keyCols = uniques.find((u) => u.length === 2 && u.every((c) => fkSet.has(c)));
    }
    if (!keyCols) continue;

    // Two DISTINCT target tables.
    const [fkA, fkB] = tableFks as [ForeignKeyEntry, ForeignKeyEntry];
    if (fkA.targetTable === fkB.targetTable) continue;

    // No payload columns: J's columns are exactly the two FK/key columns.
    const jCols = columnNamesByTable.get(tableName) ?? [];
    if (jCols.length !== 2) continue;
    if (!jCols.every((c) => fkSet.has(c))) continue;

    // For each direction, the m2m `referenceKey` is the *targeted* table's
    // referenced column(s); the junction's sourceKey is the FK column pointing
    // to that table; the targetKey is the FK column pointing to the OTHER table.
    const addM2M = (self: ForeignKeyEntry, other: ForeignKeyEntry) => {
      const sourceTbl = self.targetTable; // A
      const targetTbl = other.targetTable; // B
      let relName = snakeToCamel(targetTbl); // plural table name → e.g. "tags"
      if (!relationsByTable.has(sourceTbl)) relationsByTable.set(sourceTbl, {});
      const existing = relationsByTable.get(sourceTbl)!;
      // Additive-only: never clobber an existing relation name.
      if (existing[relName]) return;
      const columnFields = columnFieldsByTable?.get(sourceTbl);
      if (columnFields?.has(relName)) {
        if (unknownTypedFieldsByTable?.get(sourceTbl)?.has(relName)) {
          // Historical json/jsonb shadow — worked at runtime, compiled fine.
          console.warn(
            `[turbine] Relation "${relName}" on table "${sourceTbl}" (junction ${tableName}) shadows the ` +
              `json/jsonb column "${relName}" — keeping the historical name for runtime compatibility; ` +
              `the relation is omitted from the generated types.`,
          );
        } else {
          const taken = new Set([...columnFields, ...Object.keys(existing)]);
          relName = resolveRelationNameCollision(relName, taken, sourceTbl, `junction ${tableName}`);
        }
      }
      existing[relName] = {
        type: 'manyToMany',
        name: relName,
        from: sourceTbl,
        to: targetTbl,
        // referenceKey = A's referenced column(s) that J's sourceKey points at.
        referenceKey: self.targetColumns.length === 1 ? self.targetColumns[0]! : self.targetColumns,
        // foreignKey is unused for m2m correlation but kept for shape parity
        // (mirrors the source-side reference for back-compat consumers).
        foreignKey: self.targetColumns.length === 1 ? self.targetColumns[0]! : self.targetColumns,
        through: {
          table: tableName,
          sourceKey: self.sourceColumns[0]!, // J col → A
          targetKey: other.sourceColumns[0]!, // J col → B
        },
      };
    };

    addM2M(fkA, fkB); // A → B
    addM2M(fkB, fkA); // B → A
  }
}

/**
 * One-stop relation derivation for the engine introspectors (SQLite / MySQL /
 * MSSQL): filters the FK list to the introspected table set, seeds the
 * taken-name / json-shadow maps from the engine's column metadata, and runs
 * the SAME `buildRelationsFromForeignKeys` + `addAutoManyToManyRelations`
 * pipeline as the Postgres introspector — so every engine derives identical
 * relation names for the same logical schema (the engines previously carried
 * stale copies of a retired naming scheme).
 */
export function deriveEngineRelations(
  tableNames: string[],
  foreignKeys: ForeignKeyEntry[],
  pkByTable: Map<string, string[]>,
  columnsByTable: Map<string, Pick<ColumnMetadata, 'name' | 'field' | 'tsType'>[]>,
): Map<string, Record<string, RelationDef>> {
  const tableSet = new Set(tableNames);
  const fks = foreignKeys.filter((fk) => tableSet.has(fk.sourceTable) && tableSet.has(fk.targetTable));

  const columnFieldsByTable = new Map<string, Set<string>>();
  const unknownTypedFieldsByTable = new Map<string, Set<string>>();
  for (const [tbl, cols] of columnsByTable) {
    columnFieldsByTable.set(tbl, new Set(cols.map((c) => c.field)));
    unknownTypedFieldsByTable.set(tbl, new Set(cols.filter((c) => isUnknownTsType(c.tsType)).map((c) => c.field)));
  }

  const relationsByTable = buildRelationsFromForeignKeys(
    fks,
    columnFieldsByTable,
    undefined,
    unknownTypedFieldsByTable,
  );
  addAutoManyToManyRelations(
    tableNames,
    fks,
    pkByTable,
    new Map(Array.from(columnsByTable, ([tbl, cols]) => [tbl, cols.map((c) => c.name)])),
    relationsByTable,
    columnFieldsByTable,
    unknownTypedFieldsByTable,
  );
  return relationsByTable;
}

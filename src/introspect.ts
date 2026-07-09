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
    data_type,
    is_nullable,
    column_default,
    is_identity,
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

const SQL_ENUMS = `
  SELECT t.typname, e.enumlabel
  FROM pg_type t
  JOIN pg_enum e ON t.oid = e.enumtypid
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = $1
  ORDER BY t.typname, e.enumsortorder
`;

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

    // constraint_name → { onDelete, onUpdate } referential actions.
    const fkActions = new Map<string, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>();
    for (const row of fkActionsResult.rows) {
      fkActions.set(row.conname, {
        onDelete: pgConfActionToReferential(row.confdeltype),
        onUpdate: pgConfActionToReferential(row.confupdtype),
      });
    }

    // Filter tables by include/exclude
    let tableNames: string[] = tablesResult.rows.map((r: { table_name: string }) => r.table_name);
    if (options.include?.length) {
      const includeSet = new Set(options.include);
      tableNames = tableNames.filter((t) => includeSet.has(t));
    }
    if (options.exclude?.length) {
      const excludeSet = new Set(options.exclude);
      tableNames = tableNames.filter((t) => !excludeSet.has(t));
    }

    const tableSet = new Set(tableNames);

    // ----- Group columns by table -----
    const columnsByTable = new Map<string, ColumnMetadata[]>();
    for (const row of columnsResult.rows) {
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
        isArray,
        arrayType,
        pgArrayType: arrayType,
        maxLength: row.character_maximum_length ?? undefined,
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

      const isUnique = (row.indexdef as string).includes('UNIQUE');
      // Extract column names from indexdef (e.g. "CREATE INDEX idx ON tbl USING btree (col1, col2)")
      const colMatch = (row.indexdef as string).match(/\((.+)\)/);
      const columns = colMatch ? colMatch[1]!.split(',').map((c) => c.trim().replace(/ (ASC|DESC)/i, '')) : [];

      indexesByTable.get(row.tablename)!.push({
        name: row.indexname,
        columns,
        unique: isUnique,
        definition: row.indexdef,
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
    interface FKEntry {
      sourceTable: string;
      sourceColumns: string[];
      targetTable: string;
      targetColumns: string[];
      constraintName: string;
    }
    const fkGroups = new Map<string, FKEntry>();
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
    // Count FKs per (source, target) pair for disambiguation
    const fkCounts = new Map<string, number>();
    for (const fk of foreignKeys) {
      const key = `${fk.sourceTable}→${fk.targetTable}`;
      fkCounts.set(key, (fkCounts.get(key) ?? 0) + 1);
    }

    const relationsByTable = new Map<string, Record<string, RelationDef>>();

    for (const fk of foreignKeys) {
      const pairKey = `${fk.sourceTable}→${fk.targetTable}`;
      const needsDisambiguation = (fkCounts.get(pairKey) ?? 0) > 1;

      // For single-column FKs, keep string form for backwards compatibility.
      // For multi-column (composite) FKs, use array form.
      const foreignKey = fk.sourceColumns.length === 1 ? fk.sourceColumns[0]! : fk.sourceColumns;
      const referenceKey = fk.targetColumns.length === 1 ? fk.targetColumns[0]! : fk.targetColumns;

      // --- belongsTo on the source (child) table ---
      // e.g. posts.user_id → users.id creates posts.user (belongsTo)
      // For composite FKs with disambiguation, use the constraint name
      const belongsToName = needsDisambiguation
        ? fk.sourceColumns.length === 1
          ? snakeToCamel(fk.sourceColumns[0]!.replace(/_id$/, ''))
          : snakeToCamel(fk.constraintName.replace(/^fk_/, '').replace(/_fkey$/, ''))
        : singularize(snakeToCamel(fk.targetTable));

      // Referential actions (omit the 'no action' default to keep metadata lean).
      const actions = fkActions.get(fk.constraintName);
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

      // --- hasMany on the target (parent) table ---
      // e.g. posts.user_id → users.id creates users.posts (hasMany)
      const hasManyName = needsDisambiguation
        ? fk.sourceColumns.length === 1
          ? snakeToCamel(`${fk.sourceTable}_by_${fk.sourceColumns[0]!.replace(/_id$/, '')}`)
          : snakeToCamel(`${fk.sourceTable}_by_${fk.constraintName.replace(/^fk_/, '').replace(/_fkey$/, '')}`)
        : snakeToCamel(fk.sourceTable);

      if (!relationsByTable.has(fk.targetTable)) relationsByTable.set(fk.targetTable, {});
      relationsByTable.get(fk.targetTable)![hasManyName] = {
        type: 'hasMany',
        name: hasManyName,
        from: fk.targetTable,
        to: fk.sourceTable,
        foreignKey,
        referenceKey,
        ...actionFields,
      };
    }

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
    // never removes or renames anything. If the chosen relation name already
    // exists on the source table (e.g. another relation grabbed it), we SKIP to
    // stay additive.
    for (const tableName of tableNames) {
      const pk = pkByTable.get(tableName) ?? [];
      if (pk.length !== 2) continue;

      // FKs whose source is this table.
      const tableFks = foreignKeys.filter((fk) => fk.sourceTable === tableName);
      if (tableFks.length !== 2) continue;
      // Both FKs must be single-column.
      if (tableFks.some((fk) => fk.sourceColumns.length !== 1)) continue;

      const fkCols = tableFks.map((fk) => fk.sourceColumns[0]!);
      const pkSet = new Set(pk);
      // Both FK columns must be the PK columns (and vice-versa).
      if (!fkCols.every((c) => pkSet.has(c))) continue;
      if (new Set(fkCols).size !== 2) continue;

      // Two DISTINCT target tables.
      const [fkA, fkB] = tableFks as [FKEntry, FKEntry];
      if (fkA.targetTable === fkB.targetTable) continue;

      // No payload columns: J's columns are exactly the two FK/PK columns.
      const jCols = (columnsByTable.get(tableName) ?? []).map((c) => c.name);
      if (jCols.length !== 2) continue;

      // For each direction, the m2m `referenceKey` is the *targeted* table's
      // referenced column(s); the junction's sourceKey is the FK column pointing
      // to that table; the targetKey is the FK column pointing to the OTHER table.
      const addM2M = (self: FKEntry, other: FKEntry) => {
        const sourceTbl = self.targetTable; // A
        const targetTbl = other.targetTable; // B
        const relName = snakeToCamel(targetTbl); // plural table name → e.g. "tags"
        if (!relationsByTable.has(sourceTbl)) relationsByTable.set(sourceTbl, {});
        const existing = relationsByTable.get(sourceTbl)!;
        // Additive-only: never clobber an existing relation name.
        if (existing[relName]) return;
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
      };
    }

    return { tables, enums };
  } finally {
    await pool.end();
  }
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

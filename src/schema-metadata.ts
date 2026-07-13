/**
 * turbine-orm — defineSchema() → SchemaMetadata bridge
 *
 * Converts a code-first {@link SchemaDef} (the output of `defineSchema()`)
 * into the runtime {@link SchemaMetadata} shape that the query builder,
 * `TurbineClient`, and the non-SQL engines consume — without touching a
 * live database.
 *
 * Why this exists: the historical converter path (`introspect()` +
 * `generate()`) requires a running SQL database, but code-first engines
 * (PowDB, in-memory SQLite bootstraps, tests) only have the `SchemaDef`.
 * `schemaDefToMetadata()` is the pure-function equivalent: its output
 * matches what `turbine generate` would emit into `metadata.ts` for the
 * same schema, minus the pieces only a live catalog can know (real index
 * names, constraint names, view flags).
 *
 * Parity notes (ground truth = introspect.ts + generate.ts):
 *   - Relations are derived from `references:` exactly like introspection
 *     derives them from foreign keys: a `belongsTo` on the child table and
 *     a `hasMany` on the parent, with the same disambiguation rules when
 *     multiple FKs point at the same target.
 *   - Pure junction tables (2-column composite PK that IS the two
 *     single-column FKs to two distinct tables, no payload columns) get
 *     the same conservative auto-`manyToMany` treatment as introspection.
 *   - Explicit `manyToMany` declarations on the SchemaDef are merged via
 *     {@link applyManyToManyRelations} (additive, never clobbering).
 *   - `indexes` is always `[]` — SchemaDef cannot express indexes, and an
 *     empty list keeps `schemaHasIndexInfo()` false so the index advisor
 *     and the dev-mode missing-index warning stay silent instead of
 *     producing blanket false positives.
 *
 * @example
 * ```ts
 * import { defineSchema, schemaDefToMetadata } from 'turbine-orm';
 *
 * const def = defineSchema({
 *   users: { id: { type: 'serial', primaryKey: true }, name: { type: 'text', notNull: true } },
 *   posts: { id: { type: 'serial', primaryKey: true },
 *            userId: { type: 'integer', notNull: true, references: 'users.id' } },
 * });
 * const metadata = schemaDefToMetadata(def);
 * // → usable anywhere SchemaMetadata is expected (e.g. turbinePowDB, TurbineClient)
 * ```
 */

import {
  type ColumnMetadata,
  camelToSnake,
  isDateType,
  pgArrayType,
  pgTypeToTs,
  type RelationDef,
  type SchemaMetadata,
  singularize,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';
import { applyManyToManyRelations, type ColumnConfig, type ColumnType, type SchemaDef } from './schema-builder.js';

// ---------------------------------------------------------------------------
// DDL type → Postgres udt_name (what introspection reads from the catalog)
// ---------------------------------------------------------------------------

const DDL_TO_UDT: Record<Exclude<ColumnType, 'ENUM' | 'VECTOR'>, string> = {
  SERIAL: 'int4',
  BIGSERIAL: 'int8',
  BIGINT: 'int8',
  INTEGER: 'int4',
  SMALLINT: 'int2',
  TEXT: 'text',
  VARCHAR: 'varchar',
  BOOLEAN: 'bool',
  TIMESTAMPTZ: 'timestamptz',
  DATE: 'date',
  JSONB: 'jsonb',
  UUID: 'uuid',
  REAL: 'float4',
  'DOUBLE PRECISION': 'float8',
  NUMERIC: 'numeric',
  BYTEA: 'bytea',
};

/** Resolve a ColumnConfig's Postgres base type name (udt_name form). */
function udtName(config: ColumnConfig): string {
  if (config.type === 'ENUM') return config.enumName ?? 'text';
  if (config.type === 'VECTOR') return 'vector';
  return DDL_TO_UDT[config.type];
}

/** Server-generated (sequence-backed) types — pg's `nextval(...)` default. */
function isSerialType(type: ColumnType): boolean {
  return type === 'SERIAL' || type === 'BIGSERIAL';
}

// ---------------------------------------------------------------------------
// Reference-target resolution ("table.column" → snake_case names)
// ---------------------------------------------------------------------------

interface ResolvedTable {
  /** DDL (snake_case) table name */
  name: string;
  /** camelCase field name → snake_case column name */
  fieldToColumn: Map<string, string>;
  /** All snake_case column names */
  columnNames: Set<string>;
}

interface ResolvedFk {
  sourceTable: string;
  sourceColumn: string;
  targetTable: string;
  targetColumn: string;
  onDelete: RelationDef['onDelete'];
  onUpdate: RelationDef['onUpdate'];
}

/**
 * Resolve the raw column part of a `references: 'table.column'` target to a
 * snake_case column name — accepting either the camelCase field name or the
 * snake_case DDL name, mirroring how schema-sql.ts accepts both table forms.
 */
function resolveColumnName(raw: string, target: ResolvedTable | undefined): string {
  if (target) {
    const viaField = target.fieldToColumn.get(raw);
    if (viaField !== undefined) return viaField;
    if (target.columnNames.has(raw)) return raw;
  }
  return camelToSnake(raw);
}

// ---------------------------------------------------------------------------
// The converter
// ---------------------------------------------------------------------------

/**
 * Convert a code-first {@link SchemaDef} into runtime {@link SchemaMetadata}.
 *
 * Pure function — no database connection, no side effects, input untouched.
 * The output is shaped identically to the `SCHEMA` constant `turbine generate`
 * emits from introspection, so it can be handed to any consumer that expects
 * introspected metadata: `new TurbineClient(config, metadata)`,
 * `turbinePowDB(..., metadata)`, `QueryInterface`, the index advisor, etc.
 *
 * What maps:
 *   - Columns → full {@link ColumnMetadata} (snake_case name, camelCase field,
 *     pg type names, TS types, nullability, defaults, `isGenerated` for
 *     serial/bigserial, array + varchar length info, date-column tracking).
 *   - Column-level `primaryKey` and table-level composite `primaryKey`.
 *   - `unique: true` columns → single-column `uniqueColumns` entries.
 *   - `references:` FKs → `belongsTo` (child) + `hasMany` (parent) relations,
 *     including `onDelete`/`onUpdate` actions (the `'no action'` default is
 *     omitted, matching introspection).
 *   - Pure junction tables → auto-detected `manyToMany` relations (same
 *     conservative rules as introspection).
 *   - Explicit `manyToMany` declarations → merged additively.
 *   - Schema-level `enums`.
 *
 * What SchemaDef cannot express (and how it degrades):
 *   - Indexes → every table gets `indexes: []`, which keeps
 *     `schemaHasIndexInfo()` false so index-advisor consumers produce no
 *     false positives on code-first metadata.
 *   - Views → never marked (`isView` is introspection-only).
 *   - Composite foreign keys → `references:` is single-column by design.
 */
export function schemaDefToMetadata(def: SchemaDef): SchemaMetadata {
  // ----- Pass 1: resolve every table's snake_case names for FK lookups -----
  // Lookup accepts the accessor key (camelCase), the DDL name (snake_case),
  // and the explicit `accessor` field — same tolerance as schema-sql.ts.
  const lookup = new Map<string, ResolvedTable>();
  for (const [key, tableDef] of Object.entries(def.tables)) {
    const fieldToColumn = new Map<string, string>();
    const columnNames = new Set<string>();
    for (const field of Object.keys(tableDef.columns)) {
      const snake = camelToSnake(field);
      fieldToColumn.set(field, snake);
      columnNames.add(snake);
    }
    const resolved: ResolvedTable = { name: tableDef.name, fieldToColumn, columnNames };
    lookup.set(key, resolved);
    if (tableDef.name) lookup.set(tableDef.name, resolved);
    if (tableDef.accessor) lookup.set(tableDef.accessor, resolved);
  }

  // ----- Pass 2: collect resolved single-column FKs -----
  const foreignKeys: ResolvedFk[] = [];
  for (const tableDef of Object.values(def.tables)) {
    for (const [field, config] of Object.entries(tableDef.columns)) {
      if (!config.referencesTarget) continue;
      const parts = config.referencesTarget.split('.');
      if (parts.length !== 2) continue;
      const target = lookup.get(parts[0]!);
      // Reference to a table outside this SchemaDef — skip, exactly like
      // introspection skips FKs whose target is excluded from the table set.
      if (!target) continue;
      foreignKeys.push({
        sourceTable: tableDef.name,
        sourceColumn: camelToSnake(field),
        targetTable: target.name,
        targetColumn: resolveColumnName(parts[1]!, target),
        onDelete: config.onDelete ?? undefined,
        onUpdate: config.onUpdate ?? undefined,
      });
    }
  }

  // ----- Pass 3: derive belongsTo / hasMany relations (mirrors introspect) --
  const fkCounts = new Map<string, number>();
  for (const fk of foreignKeys) {
    const key = `${fk.sourceTable}→${fk.targetTable}`;
    fkCounts.set(key, (fkCounts.get(key) ?? 0) + 1);
  }

  const relationsByTable = new Map<string, Record<string, RelationDef>>();
  const relationsFor = (table: string): Record<string, RelationDef> => {
    let rels = relationsByTable.get(table);
    if (!rels) {
      rels = {};
      relationsByTable.set(table, rels);
    }
    return rels;
  };

  for (const fk of foreignKeys) {
    const needsDisambiguation = (fkCounts.get(`${fk.sourceTable}→${fk.targetTable}`) ?? 0) > 1;

    // Referential actions — omit the 'no action' default to keep metadata lean.
    const actionFields: { onDelete?: RelationDef['onDelete']; onUpdate?: RelationDef['onUpdate'] } = {};
    if (fk.onDelete && fk.onDelete !== 'no action') actionFields.onDelete = fk.onDelete;
    if (fk.onUpdate && fk.onUpdate !== 'no action') actionFields.onUpdate = fk.onUpdate;

    // belongsTo on the child: posts.user_id → users.id gives posts.user
    const belongsToName = needsDisambiguation
      ? snakeToCamel(fk.sourceColumn.replace(/_id$/, ''))
      : singularize(snakeToCamel(fk.targetTable));
    relationsFor(fk.sourceTable)[belongsToName] = {
      type: 'belongsTo',
      name: belongsToName,
      from: fk.sourceTable,
      to: fk.targetTable,
      foreignKey: fk.sourceColumn,
      referenceKey: fk.targetColumn,
      ...actionFields,
    };

    // hasMany on the parent: posts.user_id → users.id gives users.posts
    const hasManyName = needsDisambiguation
      ? snakeToCamel(`${fk.sourceTable}_by_${fk.sourceColumn.replace(/_id$/, '')}`)
      : snakeToCamel(fk.sourceTable);
    relationsFor(fk.targetTable)[hasManyName] = {
      type: 'hasMany',
      name: hasManyName,
      from: fk.targetTable,
      to: fk.sourceTable,
      foreignKey: fk.sourceColumn,
      referenceKey: fk.targetColumn,
      ...actionFields,
    };
  }

  // ----- Pass 4: conservative junction auto-m2m (mirrors introspect) -------
  // A table J is a PURE junction only when its PK is exactly the two
  // single-column FKs to two DISTINCT tables and it has no payload columns.
  for (const tableDef of Object.values(def.tables)) {
    const pkFields =
      tableDef.primaryKey && tableDef.primaryKey.length > 0
        ? [...tableDef.primaryKey]
        : Object.entries(tableDef.columns)
            .filter(([, c]) => c.isPrimaryKey)
            .map(([f]) => f);
    if (pkFields.length !== 2) continue;

    const tableFks = foreignKeys.filter((fk) => fk.sourceTable === tableDef.name);
    if (tableFks.length !== 2) continue;

    const pkSet = new Set(pkFields.map(camelToSnake));
    const fkCols = tableFks.map((fk) => fk.sourceColumn);
    if (!fkCols.every((c) => pkSet.has(c))) continue;
    if (new Set(fkCols).size !== 2) continue;

    const [fkA, fkB] = tableFks as [ResolvedFk, ResolvedFk];
    if (fkA.targetTable === fkB.targetTable) continue;

    // No payload columns: J's columns are exactly the two FK/PK columns.
    if (Object.keys(tableDef.columns).length !== 2) continue;

    const addM2M = (self: ResolvedFk, other: ResolvedFk) => {
      const relName = snakeToCamel(other.targetTable);
      const existing = relationsFor(self.targetTable);
      // Additive-only: never clobber an existing relation name.
      if (existing[relName]) return;
      existing[relName] = {
        type: 'manyToMany',
        name: relName,
        from: self.targetTable,
        to: other.targetTable,
        referenceKey: self.targetColumn,
        // foreignKey is unused for m2m correlation but kept for shape parity.
        foreignKey: self.targetColumn,
        through: {
          table: tableDef.name,
          sourceKey: self.sourceColumn,
          targetKey: other.sourceColumn,
        },
      };
    };
    addM2M(fkA, fkB);
    addM2M(fkB, fkA);
  }

  // ----- Pass 5: assemble TableMetadata -----
  const tables: Record<string, TableMetadata> = {};

  for (const tableDef of Object.values(def.tables)) {
    const columns: ColumnMetadata[] = [];
    const columnMap: Record<string, string> = {};
    const reverseColumnMap: Record<string, string> = {};
    const dateColumns = new Set<string>();
    const dialectTypes: Record<string, string> = {};
    const pgTypes: Record<string, string> = {};
    const allColumns: string[] = [];
    const primaryKey: string[] = [];
    const uniqueColumns: string[][] = [];

    for (const [field, config] of Object.entries(tableDef.columns)) {
      const name = camelToSnake(field);
      const base = udtName(config);
      // Introspection reports array columns with pg's leading-underscore
      // udt_name (`_text`), which pgTypeToTs also understands.
      const wireType = config.isArray ? `_${base}` : base;
      const serial = isSerialType(config.type);
      // PK members and serials are NOT NULL in Postgres regardless of flags.
      const nullable = !(config.isPrimaryKey || config.isNotNull || serial);

      const col: ColumnMetadata = {
        name,
        field,
        dialectType: wireType,
        pgType: wireType,
        tsType: pgTypeToTs(wireType, nullable),
        nullable,
        hasDefault: config.defaultValue != null || serial,
        isArray: config.isArray,
        arrayType: pgArrayType(base),
        pgArrayType: pgArrayType(base),
        ...(serial ? { isGenerated: true } : {}),
        ...(config.maxLength != null ? { maxLength: config.maxLength } : {}),
      };
      columns.push(col);

      columnMap[field] = name;
      reverseColumnMap[name] = field;
      allColumns.push(name);
      dialectTypes[name] = wireType;
      pgTypes[name] = wireType;
      if (isDateType(base)) dateColumns.add(name);
      if (config.isPrimaryKey) primaryKey.push(name);
      if (config.isUnique) uniqueColumns.push([name]);
    }

    // Table-level composite PK takes precedence (defineSchema already cleared
    // the column-level flags for its members).
    const pk =
      tableDef.primaryKey && tableDef.primaryKey.length > 0 ? tableDef.primaryKey.map(camelToSnake) : primaryKey;

    tables[tableDef.name] = {
      name: tableDef.name,
      columns,
      columnMap,
      reverseColumnMap,
      dateColumns,
      dialectTypes,
      pgTypes,
      allColumns,
      primaryKey: pk,
      uniqueColumns,
      relations: relationsByTable.get(tableDef.name) ?? {},
      // SchemaDef cannot express indexes. An empty list keeps
      // schemaHasIndexInfo() false → no index-advisor false positives.
      indexes: [],
    };
  }

  const enums: Record<string, string[]> = {};
  for (const [name, labels] of Object.entries(def.enums ?? {})) {
    enums[name] = [...labels];
  }

  // ----- Pass 6: merge explicit manyToMany declarations (additive) ---------
  return applyManyToManyRelations({ tables, enums }, def);
}

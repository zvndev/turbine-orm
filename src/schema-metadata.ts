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
 *   - `indexes` carries any declared `TableDef.indexes` (plain column and/or
 *     PowDB doc-field expression indexes); a table with none declared gets
 *     `[]`, which keeps `schemaHasIndexInfo()` false so the index advisor and
 *     the dev-mode missing-index warning stay silent instead of producing
 *     blanket false positives. Doc-field (docPath) indexes are ignored by the
 *     advisor, so a doc-only index set never flips `schemaHasIndexInfo()`.
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

import { ValidationError } from './errors.js';
import {
  addAutoManyToManyRelations,
  buildRelationsFromForeignKeys,
  type ForeignKeyEntry,
  isUnknownTsType,
} from './introspect.js';
import {
  type ColumnMetadata,
  camelToSnake,
  type IndexMetadata,
  isDateType,
  pgArrayType,
  pgTypeToTs,
  type ReferentialAction,
  type RelationDef,
  type SchemaMetadata,
  type TableMetadata,
} from './schema.js';
import {
  applyManyToManyRelations,
  type ColumnConfig,
  type ColumnType,
  isDocFieldIndexDef,
  type SchemaDef,
  type SchemaIndexDef,
  type TableDef,
} from './schema-builder.js';

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
// Index declarations → IndexMetadata
// ---------------------------------------------------------------------------

/**
 * Render a doc-field JSON path into an illustrative PowQL fragment for the
 * `IndexMetadata.definition` field (debuggability only; the authoritative,
 * lexer-exact emission lives in `powqlSchemaDDL`). String segments are shown
 * double-quoted, integer array indexes bare.
 */
function docPathFragment(column: string, path: (string | number)[]): string {
  const segs = path.map((s) => (typeof s === 'number' ? `->${s}` : `->"${s}"`)).join('');
  return `(.${column}${segs})`;
}

/**
 * Convert a table's {@link SchemaIndexDef} list into {@link IndexMetadata}.
 * A doc-field index carries `docPath` and `columns: [<json column>]`; a plain
 * column index carries its snake_case column list and no `docPath`. Names are
 * auto-derived (`<table>_<cols>_idx`) when not supplied.
 */
function mapIndexes(tableDef: TableDef, declared: readonly SchemaIndexDef[] | undefined): IndexMetadata[] {
  if (!declared || declared.length === 0) return [];
  const out: IndexMetadata[] = [];
  for (const idx of declared) {
    if (isDocFieldIndexDef(idx)) {
      const column = camelToSnake(idx.docField);
      const segPart = idx.path.map((s) => (typeof s === 'number' ? String(s) : s)).join('_');
      const name = idx.name ?? `${tableDef.name}_${column}_${segPart}_idx`;
      // Validate numeric (array-index) segments up front: PowDB rejects a
      // negative / fractional / NaN JSON-path index at migration time with an
      // opaque parse error, so fail here with a typed ValidationError naming the
      // index instead of emitting malformed PowQL later.
      for (const seg of idx.path) {
        if (typeof seg === 'number' && (!Number.isInteger(seg) || seg < 0)) {
          throw new ValidationError(
            `[turbine] Doc-field index "${name}" on "${tableDef.name}": array-index path segment ${seg} must be a ` +
              'non-negative integer (a JSON array index). Use a string for an object key.',
          );
        }
      }
      out.push({
        name,
        columns: [column],
        unique: idx.unique ?? false,
        definition: `${idx.unique ? 'unique ' : 'index '}${docPathFragment(column, idx.path)}`,
        docPath: [...idx.path],
        declared: true,
      });
    } else {
      const columns = idx.columns.map(camelToSnake);
      const name = idx.name ?? `${tableDef.name}_${columns.join('_')}_idx`;
      out.push({
        name,
        columns,
        unique: idx.unique ?? false,
        definition: `${idx.unique ? 'unique ' : 'index '}(${columns.join(', ')})`,
        declared: true,
      });
    }
  }
  return out;
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
 * What maps (continued):
 *   - `indexes` → declared `TableDef.indexes` become `IndexMetadata` (plain
 *     column indexes and PowDB doc-field expression indexes, the latter
 *     carrying `docPath`). A table with no declared indexes gets `[]`, keeping
 *     `schemaHasIndexInfo()` false so index-advisor consumers produce no false
 *     positives on index-less code-first metadata.
 *
 * What SchemaDef cannot express (and how it degrades):
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

  // ----- Pass 3: derive belongsTo / hasMany relations (SHARED with introspect)
  //
  // Delegates to the exact same builder introspection uses
  // (`buildRelationsFromForeignKeys`), so the same logical schema yields
  // IDENTICAL relation names whether it arrives via `defineSchema()` or a live
  // catalog: legacy-first naming, per-column disambiguation for several FKs to
  // the same target, and collision resolution against scalar column fields
  // (json/jsonb `unknown`-typed shadows keep the historical name). The old
  // local reimplementation had NO collision guard — `posts.user` (text) +
  // `userId references users.id` produced a relation `user` that shadowed the
  // scalar, and two FKs deriving the same name silently clobbered each other
  // (N-4).
  //
  // Constraint names are synthesized in pg's default `<table>_<column>_fkey`
  // form; they only feed the referential-action lookup and composite-FK
  // naming (never hit here — `references:` is single-column by design).
  const fkEntries: ForeignKeyEntry[] = [];
  const fkActions = new Map<string, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>();
  for (const fk of foreignKeys) {
    const constraintName = `${fk.sourceTable}_${fk.sourceColumn}_fkey`;
    fkEntries.push({
      sourceTable: fk.sourceTable,
      sourceColumns: [fk.sourceColumn],
      targetTable: fk.targetTable,
      targetColumns: [fk.targetColumn],
      constraintName,
    });
    fkActions.set(constraintName, {
      onDelete: fk.onDelete ?? 'no action',
      onUpdate: fk.onUpdate ?? 'no action',
    });
  }

  // Taken-name seeds: every table's camelCase column fields (the SchemaDef
  // keys ARE the fields) + which of them are json/jsonb (`unknown`-typed).
  const columnFieldsByTable = new Map<string, Set<string>>();
  const unknownTypedFieldsByTable = new Map<string, Set<string>>();
  for (const tableDef of Object.values(def.tables)) {
    const fields = Object.keys(tableDef.columns);
    columnFieldsByTable.set(tableDef.name, new Set(fields));
    // ENUM columns map to concrete union types in the generated layer, so
    // only genuine json/jsonb (`unknown`-typed) columns qualify as shadows.
    unknownTypedFieldsByTable.set(
      tableDef.name,
      new Set(
        fields.filter((f) => {
          const config = tableDef.columns[f]!;
          if (config.type === 'ENUM') return false;
          const wire = config.isArray ? `_${udtName(config)}` : udtName(config);
          return isUnknownTsType(pgTypeToTs(wire, false));
        }),
      ),
    );
  }

  const relationsByTable = buildRelationsFromForeignKeys(
    fkEntries,
    columnFieldsByTable,
    fkActions,
    unknownTypedFieldsByTable,
  );

  // ----- Pass 4: conservative junction auto-m2m (SHARED with introspect) ---
  // Same shared detector + naming/collision rules as introspection: a table J
  // is a PURE junction only when its PK is exactly the two single-column FKs
  // to two DISTINCT tables and it has no payload columns.
  const pkByTable = new Map<string, string[]>();
  const columnNamesByTable = new Map<string, string[]>();
  for (const tableDef of Object.values(def.tables)) {
    const pkFields =
      tableDef.primaryKey && tableDef.primaryKey.length > 0
        ? [...tableDef.primaryKey]
        : Object.entries(tableDef.columns)
            .filter(([, c]) => c.isPrimaryKey)
            .map(([f]) => f);
    pkByTable.set(tableDef.name, pkFields.map(camelToSnake));
    columnNamesByTable.set(tableDef.name, Object.keys(tableDef.columns).map(camelToSnake));
  }
  addAutoManyToManyRelations(
    Object.values(def.tables).map((t) => t.name),
    fkEntries,
    pkByTable,
    columnNamesByTable,
    relationsByTable,
    columnFieldsByTable,
    unknownTypedFieldsByTable,
  );

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
      // Declared `indexes` (plain column + doc-field expression) carry through;
      // an undeclared table gets `[]`, which keeps schemaHasIndexInfo() false so
      // the index advisor stays silent. Doc-field (docPath) indexes are ignored
      // by the advisor entirely (see index-advisor.ts), so a doc-only index set
      // never flips schemaHasIndexInfo() and never produces FK false positives.
      indexes: mapIndexes(tableDef, tableDef.indexes),
    };
  }

  const enums: Record<string, string[]> = {};
  for (const [name, labels] of Object.entries(def.enums ?? {})) {
    enums[name] = [...labels];
  }

  // ----- Pass 6: merge explicit manyToMany declarations (additive) ---------
  return applyManyToManyRelations({ tables, enums }, def);
}

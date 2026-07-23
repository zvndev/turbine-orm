/**
 * turbine-orm — Schema metadata types
 *
 * These types represent the introspected database schema at runtime.
 * They're used by the query builder, code generator, and CLI.
 */

// ---------------------------------------------------------------------------
// Core schema types
// ---------------------------------------------------------------------------

export interface SchemaMetadata {
  /** All discovered tables, keyed by table name */
  tables: Record<string, TableMetadata>;
  /** Database-level enums (typname → labels) */
  enums: Record<string, string[]>;
}

export interface TableMetadata {
  /** Table name in the database (snake_case) */
  name: string;
  /** All columns in ordinal order */
  columns: ColumnMetadata[];
  /** camelCase field name → snake_case column name */
  columnMap: Record<string, string>;
  /** snake_case column name → camelCase field name */
  reverseColumnMap: Record<string, string>;
  /** snake_case columns that are timestamp/date types (need Date parsing) */
  dateColumns: Set<string>;
  /** snake_case column → dialect-native database type. */
  dialectTypes?: Record<string, string>;
  /** snake_case column → Postgres type for UNNEST casts. Back-compat alias for dialectTypes. */
  pgTypes: Record<string, string>;
  /** All snake_case column names in ordinal order */
  allColumns: string[];
  /** Primary key column(s) in snake_case */
  primaryKey: string[];
  /** Unique constraint columns */
  uniqueColumns: string[][];
  /** Relations defined on this table */
  relations: Record<string, RelationDef>;
  /** Indexes on this table */
  indexes: IndexMetadata[];
  /**
   * Named `CHECK` constraints on this table (introspected from
   * `pg_constraint` where `contype = 'c'`, excluding NOT NULL artifacts).
   * Optional / defaults to `[]` for back-compat.
   */
  checks?: readonly CheckMetadata[];
  /**
   * True when this metadata entry describes a database **view** or
   * **materialized view** rather than a base table (introspected with the
   * `includeViews` option). Views are read-only: every write builder
   * (`create`/`update`/`upsert`/`delete` + their `*Many` forms) throws a
   * `ValidationError` (E003). A view without a primary key is additionally
   * excluded from the `findUnique`-family generated accessor types.
   * Optional / defaults to `false` for back-compat.
   */
  isView?: boolean;
}

export interface CheckMetadata {
  /** Constraint name (system-generated or user-supplied). */
  name: string;
  /** The check expression source (`pg_get_constraintdef` inner text). */
  expression: string;
}

export interface ColumnMetadata {
  /** snake_case column name */
  name: string;
  /** camelCase field name for TypeScript */
  field: string;
  /** Dialect-native database type (e.g. PostgreSQL 'int8', MySQL 'bigint', SQLite 'INTEGER'). */
  dialectType?: string;
  /** Postgres base type (e.g. 'int8', 'text', 'timestamptz'). Back-compat alias for dialectType. */
  pgType: string;
  /**
   * Schema the column's Postgres type lives in, recorded by introspection
   * ONLY when it differs from the introspected schema (and isn't a
   * `pg_catalog` builtin) — e.g. an enum or domain owned by another schema.
   * Consumers use it as a cross-schema guard: a same-named enum in another
   * schema must not receive this schema's `::"enum"` cast (search_path would
   * resolve it to the wrong type). Absent for same-schema types, builtins,
   * `defineSchema()` output, and legacy generated metadata.
   */
  pgTypeSchema?: string;
  /** TypeScript type string (e.g. 'number', 'string', 'Date') */
  tsType: string;
  /** Whether the column allows NULL */
  nullable: boolean;
  /** Whether the column has a DEFAULT, is serial, or is generated */
  hasDefault: boolean;
  /**
   * Whether the **database server** generates this column's value on insert —
   * a `serial`/`BIGSERIAL` sequence, an `IDENTITY` column, or PowDB's `auto`
   * modifier. This is a strict subset of {@link hasDefault} (a server-generated
   * column always reports `hasDefault: true`), but unlike a client-side default
   * expression (`gen_random_uuid()`, `now()`) the value is assigned by the
   * engine, so Turbine must NOT synthesize one client-side and the PowDB DDL
   * emits the `auto` modifier. Optional / defaults to `false` for back-compat.
   */
  isGenerated?: boolean;
  /**
   * True when this is a Postgres **`GENERATED ALWAYS AS (expr) STORED`** column
   * (`information_schema.columns.is_generated = 'ALWAYS'`). Distinct from
   * {@link isGenerated} — which flags a server-*assigned* identity/serial value
   * that a client MAY still override — a STORED generated column's value is
   * *computed from other columns* and can NEVER be supplied on insert/update
   * (Postgres rejects it). Codegen therefore omits it from `*Create`/`*Update`
   * input types, and the write builders reject any `data` containing it with a
   * {@link ValidationError} (E003). Optional / defaults to `false`.
   */
  isGeneratedStored?: boolean;
  /**
   * The generation expression for a {@link isGeneratedStored} column
   * (`information_schema.columns.generation_expression`), e.g. `price * qty`.
   * Present only when `isGeneratedStored` is true and the catalog exposed it.
   */
  generationExpression?: string;
  /**
   * True when this column holds personally identifiable information (PII).
   * Tagged in `defineSchema` (`pii: true`) and carried through generated
   * metadata. A PII column is EXCLUDED from default projections: it comes back
   * only when explicitly named in `select` or when the query passes
   * `includePii: true` (full opt-in). Studio redacts PII cells by default.
   * Optional / defaults to `false`; untagged schemas behave exactly as before.
   * Introspection never auto-tags PII (it is a code-first declaration).
   */
  pii?: boolean;
  /** Whether this is an array column */
  isArray: boolean;
  /** Dialect-specific array/bulk-insert type token when needed. */
  arrayType?: string;
  /** Postgres array type for UNNEST (e.g. 'bigint[]'). Back-compat alias for arrayType. */
  pgArrayType: string;
  /** Max character length (for varchar) */
  maxLength?: number;
}

/**
 * PostgreSQL referential action for a foreign key's `ON DELETE` / `ON UPDATE`
 * clause. `'no action'` is the implicit default (matches Postgres) and is
 * omitted from emitted DDL.
 */
export type ReferentialAction = 'cascade' | 'restrict' | 'set null' | 'set default' | 'no action';

export interface RelationDef {
  type: 'hasMany' | 'hasOne' | 'belongsTo' | 'manyToMany';
  /**
   * FK `ON DELETE` action (introspected from `pg_constraint.confdeltype`).
   * Present on `belongsTo`/`hasMany` relations derived from a real FK; omitted
   * when unknown (e.g. `defineSchema`-only metadata) or `'no action'`.
   */
  onDelete?: ReferentialAction;
  /** FK `ON UPDATE` action (introspected from `pg_constraint.confupdtype`). */
  onUpdate?: ReferentialAction;
  /** Relation name (camelCase, used as the field name) */
  name: string;
  /** Source table */
  from: string;
  /** Target table */
  to: string;
  /** FK column(s) on the "many" / "child" side (snake_case). Array for composite FKs. */
  foreignKey: string | string[];
  /** Referenced column(s) on the "one" / "parent" side (snake_case). Array for composite FKs. */
  referenceKey: string | string[];
  /**
   * For `manyToMany` relations only: the junction (join) table that links the
   * source and target tables. The subquery JOINs the target through this table.
   *
   *   - `table`     — junction table name (snake_case).
   *   - `sourceKey` — junction column(s) referencing the SOURCE table's
   *                   {@link referenceKey} (typically the source PK).
   *   - `targetKey` — junction column(s) referencing the TARGET table's PK.
   *
   * Array forms support composite keys (paired positionally with the
   * referenced columns). Omitted for non-m2m relations.
   */
  through?: {
    table: string;
    sourceKey: string | string[];
    targetKey: string | string[];
  };
}

// ---------------------------------------------------------------------------
// Helpers for composite key handling
// ---------------------------------------------------------------------------

/** Normalize foreignKey/referenceKey to always be an array for uniform processing */
export function normalizeKeyColumns(key: string | string[]): string[] {
  return Array.isArray(key) ? key : [key];
}

export interface IndexMetadata {
  name: string;
  columns: string[];
  unique: boolean;
  definition: string;
  /**
   * Set only for a PowDB doc-field expression index: the JSON path (string keys
   * and integer array indexes) into the single json document column named by
   * `columns[0]`. When present, `columns` is `[<json column>]` and the index
   * targets `columns[0]-><segments>` rather than the raw column.
   *
   * Consumed by the PowDB DDL generator (`powqlSchemaDDL` emits
   * `alter T add index (.col->"seg")`). The missing-FK index advisor ignores
   * doc-field indexes entirely (a JSON expression index never covers an
   * equality probe on the raw column). Doc-field indexes are invisible to
   * `describe`-based introspection, so they do NOT round-trip through
   * introspection.
   */
  docPath?: (string | number)[];
  /**
   * Set for indexes DECLARED in a code-first `defineSchema` (`TableDef.indexes`)
   * rather than read from a live database by introspection. The SQL DDL
   * generators (`schema-sql.ts` / `schemaDiff`) do NOT emit these yet, so a
   * declared index does not reflect a real database index on the SQL engines.
   * The missing-FK index advisor therefore treats declared indexes as
   * "index-info unknown" (same as an index-less schema): counting them would
   * both arm blanket FK false positives and suppress warnings for indexes that
   * were never created. Introspected metadata never sets this.
   */
  declared?: boolean;
}

// ---------------------------------------------------------------------------
// Type mapping: Postgres → TypeScript
// ---------------------------------------------------------------------------

const PG_TO_TS: Record<string, string> = {
  // Integers
  int2: 'number',
  int4: 'number',
  // int8 maps to `number` for DX (auto-increment IDs, counts, etc.).
  // Values exceeding Number.MAX_SAFE_INTEGER (2^53 - 1) are returned as
  // `string` at runtime to avoid precision loss. See client.ts int8 parser.
  int8: 'number',
  float4: 'number',
  float8: 'number',
  oid: 'number',
  // Precision-sensitive — keep as string to avoid JS float issues
  numeric: 'string',
  money: 'string',
  // Boolean
  bool: 'boolean',
  // Strings
  text: 'string',
  varchar: 'string',
  char: 'string',
  bpchar: 'string',
  name: 'string',
  uuid: 'string',
  citext: 'string',
  xml: 'string',
  // Dates & times
  timestamptz: 'Date',
  timestamp: 'Date',
  date: 'Date',
  time: 'string',
  timetz: 'string',
  interval: 'string',
  // JSON
  json: 'unknown',
  jsonb: 'unknown',
  // Binary
  bytea: 'Buffer',
  // Network
  inet: 'string',
  cidr: 'string',
  macaddr: 'string',
  // Geometric
  point: 'string',
  line: 'string',
  lseg: 'string',
  box: 'string',
  path: 'string',
  polygon: 'string',
  circle: 'string',
  // TSVector
  tsvector: 'string',
  tsquery: 'string',
  // pgvector — embeddings. Mapped to `number[]` for DX (the natural shape an app
  // passes when inserting / comparing embeddings). NOTE: like `numeric` above,
  // there is a runtime caveat — pg has no built-in parser for the `vector` type,
  // so over the wire a fetched vector arrives as a string literal like
  // '[1,2,3]' unless the app registers its own parser (e.g. via pgvector's
  // `registerType`). Turbine never auto-registers one (no side-effecting type
  // parsers outside the client constructor). The query-side helpers (KNN
  // orderBy, distance WHERE) always bind the query vector as a `$n::vector`
  // param, so writing/comparing is unaffected by the read-side caveat.
  vector: 'number[]',
};

const DATE_TYPES = new Set(['timestamptz', 'timestamp', 'date']);

const PG_TO_ARRAY: Record<string, string> = {
  int2: 'smallint[]',
  int4: 'integer[]',
  int8: 'bigint[]',
  float4: 'real[]',
  float8: 'double precision[]',
  numeric: 'numeric[]',
  bool: 'boolean[]',
  text: 'text[]',
  varchar: 'text[]',
  char: 'text[]',
  bpchar: 'text[]',
  uuid: 'uuid[]',
  timestamptz: 'timestamptz[]',
  timestamp: 'timestamp[]',
  date: 'date[]',
  json: 'json[]',
  jsonb: 'jsonb[]',
  bytea: 'bytea[]',
  inet: 'inet[]',
};

/** Map a Postgres type to its TypeScript equivalent */
export function pgTypeToTs(pgType: string, nullable: boolean): string {
  // Array types: udt_name starts with '_'
  if (pgType.startsWith('_')) {
    const elementType = pgTypeToTs(pgType.slice(1), false);
    const tsType = `${elementType}[]`;
    return nullable ? `${tsType} | null` : tsType;
  }

  const tsType = PG_TO_TS[pgType] ?? 'unknown';
  return nullable ? `${tsType} | null` : tsType;
}

/** Check if a Postgres type is a date/timestamp that needs Date parsing */
export function isDateType(pgType: string): boolean {
  return DATE_TYPES.has(pgType);
}

/** Get the Postgres array cast type for UNNEST batch inserts */
export function pgArrayType(pgType: string): string {
  return PG_TO_ARRAY[pgType] ?? 'text[]';
}

// ---------------------------------------------------------------------------
// Name conversion utilities
// ---------------------------------------------------------------------------

/** snake_case → camelCase */
export function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** camelCase → snake_case */
export function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

/** snake_case → PascalCase (for type names) */
export function snakeToPascal(s: string): string {
  return s
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

/** Naive singularize: "posts" → "post", "categories" → "category" */
export function singularize(s: string): string {
  if (s.endsWith('ies')) return `${s.slice(0, -3)}y`;
  if (s.endsWith('ses') || s.endsWith('xes') || s.endsWith('zes')) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

// ---------------------------------------------------------------------------
// keepColumnNames transform (F4)
// ---------------------------------------------------------------------------

/**
 * Return a copy of `schema` in which every column's TypeScript **field** name is
 * the raw database column name (snake_case) instead of the camelCased default,
 * i.e. `user_id` stays `user_id` rather than becoming `userId`.
 *
 * This is a PURE, generate-time transform with ZERO runtime changes: it only
 * rewrites `column.field` and rebuilds each table's `columnMap` /
 * `reverseColumnMap` as IDENTITY maps (`user_id → user_id`). Because every
 * runtime surface resolves column names through those maps (`toColumn`,
 * `parseRow`, relation `json_build_object` keys, batched-loader stitching,
 * positional decoding, aggregate/groupBy naming), the generated client returns
 * rows keyed by DB column names and accepts DB column names in
 * `where`/`orderBy`/`select` with no code path aware of the difference.
 *
 * Deliberately left untouched (the flag is literally about column names):
 *   - `name`, `allColumns`, `dateColumns`, `dialectTypes`, `pgTypes`,
 *     `primaryKey`, `uniqueColumns`, `indexes`, `checks`, `isView` (all already
 *     keyed by snake_case column names);
 *   - `relations` (relation PROPERTY names are synthetic introspection names
 *     with no DB column equivalent, and `foreignKey`/`referenceKey`/`through`
 *     already hold DB column names);
 *   - entity type names, table accessors, and `enums`.
 *
 * Every non-PII field of each {@link ColumnMetadata} (`pii`, `pgType`,
 * `dialectType`, `nullable`, …) is preserved. Exported from the package root so
 * runtime-introspection and serverless users can apply the same identity mapping
 * to a schema they build at runtime, e.g. `turbineHttp(pool,
 * withDbFieldNames(schema))`.
 */
export function withDbFieldNames(schema: SchemaMetadata): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  for (const [tableKey, table] of Object.entries(schema.tables)) {
    const columns = table.columns.map((col) => ({ ...col, field: col.name }));
    const columnMap: Record<string, string> = {};
    const reverseColumnMap: Record<string, string> = {};
    for (const col of columns) {
      columnMap[col.name] = col.name;
      reverseColumnMap[col.name] = col.name;
    }
    tables[tableKey] = { ...table, columns, columnMap, reverseColumnMap };
  }
  return { ...schema, tables };
}

// ---------------------------------------------------------------------------
// Prisma-compat name map
// ---------------------------------------------------------------------------

/**
 * A typed name map from a Prisma schema onto a Turbine client, produced by
 * `turbine migrate-from-prisma` (`generatePrismaMap` writes it as a
 * `prisma-map.ts` module next to the generated client). It is library-side so
 * the phase-2 `turbine-orm/prisma-compat` runtime adapter can consume the same
 * shape to translate Prisma model/field/relation/compound-unique names onto the
 * Turbine surface without re-parsing anything.
 *
 * Every name it carries was RESOLVED against live introspected metadata: a model
 * or field that could not be matched is omitted from the map and listed in the
 * migration report instead, so the map only ever contains verified mappings.
 */
export interface PrismaCompatMap {
  /** Prisma model name → its resolved mapping. */
  models: Record<string, PrismaModelMap>;
  /** Prisma enum name → resolved database enum-type name. */
  enums: Record<string, string>;
}

/** One Prisma model's resolved mapping onto a Turbine table + client accessor. */
export interface PrismaModelMap {
  /** Resolved snake_case database table name. */
  table: string;
  /** camelCase `TurbineClient` accessor (`db.<accessor>`). */
  accessor: string;
  /** Prisma field name → Turbine field name (camelCase). Relation fields excluded. */
  fields: Record<string, string>;
  /** Prisma relation-field name → resolved Turbine relation + cardinality. */
  relations: Record<string, PrismaRelationMap>;
  /**
   * Prisma compound-unique/compound-id selector name → the Turbine field names
   * (in declared order). The selector name is Prisma's: the explicit
   * `@@unique(name:)` / `@@id(name:)` argument, else the field names joined with
   * `_`. Consumed by the phase-2 client to translate
   * `where: { <selector>: { ... } }`, including custom `@@unique(name:)` names
   * the core `findUnique`-family derivation cannot know.
   */
  compoundUniques: Record<string, string[]>;
}

/** A resolved Prisma relation field → Turbine relation. */
export interface PrismaRelationMap {
  /** Turbine relation name (the `with` clause key). */
  name: string;
  /** `'one'` (to-one) or `'many'` (to-many, including m2m). */
  cardinality: 'one' | 'many';
}

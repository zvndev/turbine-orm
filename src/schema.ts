/**
 * @batadata/turbine — Schema metadata types
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
  /** snake_case column → Postgres type for UNNEST casts */
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
}

export interface ColumnMetadata {
  /** snake_case column name */
  name: string;
  /** camelCase field name for TypeScript */
  field: string;
  /** Postgres base type (e.g. 'int8', 'text', 'timestamptz') */
  pgType: string;
  /** TypeScript type string (e.g. 'number', 'string', 'Date') */
  tsType: string;
  /** Whether the column allows NULL */
  nullable: boolean;
  /** Whether the column has a DEFAULT, is serial, or is generated */
  hasDefault: boolean;
  /** Whether this is an array column */
  isArray: boolean;
  /** Postgres array type for UNNEST (e.g. 'bigint[]') */
  pgArrayType: string;
  /** Max character length (for varchar) */
  maxLength?: number;
}

export interface RelationDef {
  type: 'hasMany' | 'hasOne' | 'belongsTo';
  /** Relation name (camelCase, used as the field name) */
  name: string;
  /** Source table */
  from: string;
  /** Target table */
  to: string;
  /** FK column on the "many" / "child" side (snake_case) */
  foreignKey: string;
  /** Referenced column on the "one" / "parent" side (snake_case) */
  referenceKey: string;
}

export interface IndexMetadata {
  name: string;
  columns: string[];
  unique: boolean;
  definition: string;
}

// ---------------------------------------------------------------------------
// Type mapping: Postgres → TypeScript
// ---------------------------------------------------------------------------

const PG_TO_TS: Record<string, string> = {
  // Integers
  int2: 'number',
  int4: 'number',
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
  if (s.endsWith('ies')) return s.slice(0, -3) + 'y';
  if (s.endsWith('ses') || s.endsWith('xes') || s.endsWith('zes')) return s.slice(0, -2);
  if (s.endsWith('s') && !s.endsWith('ss')) return s.slice(0, -1);
  return s;
}

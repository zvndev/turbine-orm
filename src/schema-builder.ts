/**
 * @batadata/turbine — Schema Builder
 *
 * TypeScript-first schema definition API. Define your database schema
 * as plain objects — no method chaining, no DSL. Fully type-checked,
 * JSON-serializable, and easy to read.
 *
 * @example
 * ```ts
 * import { defineSchema } from '@batadata/turbine';
 *
 * export default defineSchema({
 *   users: {
 *     id:        { type: 'serial', primaryKey: true },
 *     email:     { type: 'text', unique: true, notNull: true },
 *     name:      { type: 'text', notNull: true },
 *     bio:       { type: 'text' },
 *     role:      { type: 'varchar', maxLength: 50, default: "'user'" },
 *     orgId:     { type: 'bigint', notNull: true, references: 'organizations.id' },
 *     createdAt: { type: 'timestamp', default: 'now()' },
 *   },
 * });
 * ```
 */

import { camelToSnake } from './schema.js';

// ---------------------------------------------------------------------------
// Column types — lowercase shorthand mapped to Postgres types
// ---------------------------------------------------------------------------

/** Shorthand type names that map to Postgres column types */
export type ColumnTypeName =
  | 'serial'     // BIGSERIAL
  | 'bigint'     // BIGINT
  | 'integer'    // INTEGER
  | 'smallint'   // SMALLINT
  | 'text'       // TEXT
  | 'varchar'    // VARCHAR(n)
  | 'boolean'    // BOOLEAN
  | 'timestamp'  // TIMESTAMPTZ
  | 'date'       // DATE
  | 'json'       // JSONB
  | 'uuid'       // UUID
  | 'real'       // REAL
  | 'double'     // DOUBLE PRECISION
  | 'numeric'    // NUMERIC
  | 'bytea';     // BYTEA

/** Maps shorthand names to actual Postgres type strings */
const TYPE_MAP: Record<ColumnTypeName, string> = {
  serial: 'BIGSERIAL',
  bigint: 'BIGINT',
  integer: 'INTEGER',
  smallint: 'SMALLINT',
  text: 'TEXT',
  varchar: 'VARCHAR',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMPTZ',
  date: 'DATE',
  json: 'JSONB',
  uuid: 'UUID',
  real: 'REAL',
  double: 'DOUBLE PRECISION',
  numeric: 'NUMERIC',
  bytea: 'BYTEA',
};

// ---------------------------------------------------------------------------
// Column definition — the user-facing type
// ---------------------------------------------------------------------------

/** Column definition as a plain object. This is what users write. */
export interface ColumnDef {
  /** Column type (required) */
  type: ColumnTypeName;
  /** PRIMARY KEY constraint */
  primaryKey?: boolean;
  /** NOT NULL constraint */
  notNull?: boolean;
  /** Explicitly nullable */
  nullable?: boolean;
  /** UNIQUE constraint */
  unique?: boolean;
  /** DEFAULT expression (raw SQL, e.g. 'now()' or "'active'") */
  default?: string;
  /** REFERENCES target in "table.column" form */
  references?: string;
  /** Max length for varchar columns */
  maxLength?: number;
}

// ---------------------------------------------------------------------------
// Internal ColumnConfig — used by schema-sql.ts
// ---------------------------------------------------------------------------

/** Postgres-level column type (uppercase, as used in DDL) */
export type ColumnType =
  | 'BIGSERIAL'
  | 'BIGINT'
  | 'INTEGER'
  | 'SMALLINT'
  | 'TEXT'
  | 'BOOLEAN'
  | 'TIMESTAMPTZ'
  | 'JSONB'
  | 'UUID'
  | 'REAL'
  | 'DOUBLE PRECISION'
  | 'NUMERIC'
  | 'BYTEA'
  | 'DATE'
  | 'VARCHAR';

export interface ColumnConfig {
  type: ColumnType;
  isPrimaryKey: boolean;
  isNotNull: boolean;
  isNullable: boolean;
  isUnique: boolean;
  defaultValue: string | null;
  referencesTarget: string | null;
  maxLength: number | null;
}

/** Convert a user-facing ColumnDef to the internal ColumnConfig */
function resolveColumn(def: ColumnDef): ColumnConfig {
  return {
    type: TYPE_MAP[def.type] as ColumnType,
    isPrimaryKey: def.primaryKey ?? false,
    isNotNull: def.notNull ?? false,
    isNullable: def.nullable ?? false,
    isUnique: def.unique ?? false,
    defaultValue: def.default ?? null,
    referencesTarget: def.references ?? null,
    maxLength: def.maxLength ?? null,
  };
}

// ---------------------------------------------------------------------------
// Table & Schema definitions
// ---------------------------------------------------------------------------

export interface TableDef {
  /** Table name (set during defineSchema) */
  name: string;
  /** Column definitions keyed by camelCase field name */
  columns: Record<string, ColumnConfig>;
}

export interface SchemaDef {
  /** All tables keyed by table name */
  tables: Record<string, TableDef>;
}

/** Input format: table name -> column defs (object format) or TableDef (legacy builder) */
type SchemaInput = Record<string, Record<string, ColumnDef> | TableDef>;

/** Check if a value is a TableDef (from legacy table() builder) */
function isTableDef(v: unknown): v is TableDef {
  return typeof v === 'object' && v !== null && 'columns' in v && 'name' in v;
}

/**
 * Define the full database schema using plain objects.
 *
 * @example
 * ```ts
 * export default defineSchema({
 *   users: {
 *     id:    { type: 'serial', primaryKey: true },
 *     email: { type: 'text', unique: true, notNull: true },
 *     name:  { type: 'text', notNull: true },
 *   },
 *   posts: {
 *     id:     { type: 'serial', primaryKey: true },
 *     userId: { type: 'bigint', notNull: true, references: 'users.id' },
 *     title:  { type: 'text', notNull: true },
 *   },
 * });
 * ```
 */
export function defineSchema(input: SchemaInput): SchemaDef {
  const tables: Record<string, TableDef> = {};

  for (const [tableName, value] of Object.entries(input)) {
    if (isTableDef(value)) {
      // Legacy format: defineSchema({ users: table({ ... }) })
      value.name = tableName;
      tables[tableName] = value;
    } else {
      // Object format: defineSchema({ users: { id: { type: 'serial' }, ... } })
      const columns: Record<string, ColumnConfig> = {};
      for (const [fieldName, def] of Object.entries(value as Record<string, ColumnDef>)) {
        columns[fieldName] = resolveColumn(def);
      }
      tables[tableName] = { name: tableName, columns };
    }
  }

  return { tables };
}

// ---------------------------------------------------------------------------
// Legacy compat — ColumnBuilder still works for existing code
// ---------------------------------------------------------------------------

export class ColumnBuilder {
  private _config: ColumnConfig;

  constructor() {
    this._config = {
      type: 'TEXT',
      isPrimaryKey: false,
      isNotNull: false,
      isNullable: false,
      isUnique: false,
      defaultValue: null,
      referencesTarget: null,
      maxLength: null,
    };
  }

  serial(): this { this._config.type = 'BIGSERIAL'; return this; }
  bigint(): this { this._config.type = 'BIGINT'; return this; }
  integer(): this { this._config.type = 'INTEGER'; return this; }
  smallint(): this { this._config.type = 'SMALLINT'; return this; }
  text(): this { this._config.type = 'TEXT'; return this; }
  varchar(length: number): this { this._config.type = 'VARCHAR'; this._config.maxLength = length; return this; }
  boolean(): this { this._config.type = 'BOOLEAN'; return this; }
  timestamp(): this { this._config.type = 'TIMESTAMPTZ'; return this; }
  date(): this { this._config.type = 'DATE'; return this; }
  json(): this { this._config.type = 'JSONB'; return this; }
  uuid(): this { this._config.type = 'UUID'; return this; }
  real(): this { this._config.type = 'REAL'; return this; }
  doublePrecision(): this { this._config.type = 'DOUBLE PRECISION'; return this; }
  numeric(): this { this._config.type = 'NUMERIC'; return this; }
  bytea(): this { this._config.type = 'BYTEA'; return this; }

  primaryKey(): this { this._config.isPrimaryKey = true; return this; }
  notNull(): this { this._config.isNotNull = true; return this; }
  nullable(): this { this._config.isNullable = true; return this; }
  unique(): this { this._config.isUnique = true; return this; }
  default(val: string): this { this._config.defaultValue = val; return this; }
  references(target: string): this { this._config.referencesTarget = target; return this; }

  build(): ColumnConfig { return { ...this._config }; }
}

/** @deprecated Use defineSchema() with plain objects instead */
type ColumnProxy = {
  [K in 'serial' | 'bigint' | 'integer' | 'smallint' | 'text' | 'boolean' | 'timestamp' | 'date' | 'json' | 'uuid' | 'real' | 'doublePrecision' | 'numeric' | 'bytea']: () => ColumnBuilder;
} & { varchar: (length: number) => ColumnBuilder; };

/** @deprecated Use defineSchema() with plain objects instead */
export const column: ColumnProxy = new Proxy({} as ColumnProxy, {
  get(_target, prop: string) {
    if (prop === 'varchar') return (length: number) => new ColumnBuilder().varchar(length);
    return () => {
      const builder = new ColumnBuilder();
      if (typeof (builder as any)[prop] === 'function') return (builder as any)[prop].call(builder);
      throw new Error(`Unknown column type: ${prop}`);
    };
  },
});

/** @deprecated Use defineSchema() with plain objects instead */
export function table(columns: Record<string, ColumnBuilder>): TableDef {
  const built: Record<string, ColumnConfig> = {};
  for (const [fieldName, builder] of Object.entries(columns)) {
    built[fieldName] = builder.build();
  }
  return { name: '', columns: built };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { camelToSnake } from './schema.js';

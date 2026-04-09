/**
 * turbine-orm — Schema Builder
 *
 * TypeScript-first schema definition API. Define your database schema
 * as plain objects — no method chaining, no DSL. Fully type-checked,
 * JSON-serializable, and easy to read.
 *
 * @example
 * ```ts
 * import { defineSchema } from 'turbine-orm';
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

// ---------------------------------------------------------------------------
// Column types — lowercase shorthand mapped to Postgres types
// ---------------------------------------------------------------------------

/** Shorthand type names that map to Postgres column types */
export type ColumnTypeName =
  | 'serial' // BIGSERIAL
  | 'bigint' // BIGINT
  | 'integer' // INTEGER
  | 'smallint' // SMALLINT
  | 'text' // TEXT
  | 'varchar' // VARCHAR(n)
  | 'boolean' // BOOLEAN
  | 'timestamp' // TIMESTAMPTZ
  | 'date' // DATE
  | 'json' // JSONB
  | 'uuid' // UUID
  | 'real' // REAL
  | 'double' // DOUBLE PRECISION
  | 'numeric' // NUMERIC
  | 'bytea'; // BYTEA

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
  if (!(def.type in TYPE_MAP)) {
    throw new Error(`Invalid column type "${def.type}". Valid types: ${Object.keys(TYPE_MAP).join(', ')}`);
  }
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
  /**
   * DDL-facing table name (snake_case). This is the name used when generating
   * `CREATE TABLE` and other DDL statements. Set automatically during
   * `defineSchema()` by converting the JS-facing accessor key from camelCase
   * to snake_case (e.g. `postTags` → `post_tags`).
   */
  name: string;
  /**
   * JS-facing accessor name (camelCase). This is the original key the user
   * supplied to `defineSchema({ ... })` and is used as the property name on
   * the generated `TurbineClient` (e.g. `db.postTags`). For schemas that
   * already use snake_case keys, this matches `name`.
   */
  accessor: string;
  /** Column definitions keyed by camelCase field name */
  columns: Record<string, ColumnConfig>;
  /**
   * Optional composite primary key. When present, takes precedence over any
   * column-level `primaryKey: true` flags. Column names listed here are the
   * camelCase JS-facing field names — they will be converted to snake_case
   * when emitted as a `PRIMARY KEY (...)` table constraint.
   */
  primaryKey?: readonly string[];
}

/**
 * User-facing input shape for a single table when using the object format.
 * The optional `primaryKey` field declares a composite primary key.
 */
export interface TableInput {
  /** Optional composite primary key (camelCase field names) */
  primaryKey?: readonly string[];
  /** Column definitions keyed by camelCase field name */
  [columnName: string]: ColumnDef | readonly string[] | undefined;
}

export interface SchemaDef {
  /**
   * All tables keyed by their JS-facing accessor name (camelCase, exactly as
   * the user wrote them in `defineSchema({ ... })`). The DDL-facing snake_case
   * name is available as `tables[key].name`.
   */
  tables: Record<string, TableDef>;
}

/** Input format: table name -> column defs (object format) or TableDef (legacy builder) */
type SchemaInput = Record<string, Record<string, ColumnDef> | TableDef | TableInput>;

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

  for (const [accessor, value] of Object.entries(input)) {
    // The user-facing key is the camelCase JS accessor; the DDL-facing
    // table name is its snake_case form (e.g. `postTags` → `post_tags`).
    const dbName = camelToSnakeLocal(accessor);

    if (isTableDef(value)) {
      // Legacy format: defineSchema({ users: table({ ... }) })
      // Stamp both the DDL name and the JS accessor.
      value.name = dbName;
      value.accessor = accessor;
      tables[accessor] = value;
    } else {
      // Object format: defineSchema({ users: { id: { type: 'serial' }, ... } })
      const raw = value as TableInput;
      const columns: Record<string, ColumnConfig> = {};
      let pk: readonly string[] | undefined;

      for (const [fieldName, def] of Object.entries(raw)) {
        if (fieldName === 'primaryKey') {
          // Top-level composite primary key declaration
          if (def !== undefined) {
            if (!Array.isArray(def)) {
              throw new Error(
                `Table "${accessor}": top-level "primaryKey" must be an array of column names (string[])`,
              );
            }
            pk = def as readonly string[];
          }
          continue;
        }
        // Anything else is a ColumnDef
        columns[fieldName] = resolveColumn(def as ColumnDef);
      }

      // Validate composite PK references real columns and clear column-level PKs
      // for those columns so we don't double-emit `PRIMARY KEY` clauses.
      // Composite PK members are implicitly NOT NULL — preserve that even
      // when the user clears the column-level `primaryKey: true` flag.
      if (pk && pk.length > 0) {
        for (const colName of pk) {
          if (!(colName in columns)) {
            throw new Error(
              `Table "${accessor}": composite primaryKey references unknown column "${colName}". ` +
                `Known columns: ${Object.keys(columns).join(', ') || '(none)'}`,
            );
          }
          // A composite PK at the table level supersedes any column-level
          // `primaryKey: true` flag — silently clear it so DDL emission
          // produces a single, valid table-level PRIMARY KEY constraint.
          // Force NOT NULL since PK columns can never be nullable.
          const c = columns[colName];
          if (c) {
            c.isPrimaryKey = false;
            c.isNotNull = true;
          }
        }
      }

      tables[accessor] = {
        name: dbName,
        accessor,
        columns,
        ...(pk && pk.length > 0 ? { primaryKey: pk } : {}),
      };
    }
  }

  return { tables };
}

/**
 * Local copy of camelToSnake to avoid a circular import dependency at the
 * top of the file. Mirrors the implementation in `./schema.ts`.
 */
function camelToSnakeLocal(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
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

  serial(): this {
    this._config.type = 'BIGSERIAL';
    return this;
  }
  bigint(): this {
    this._config.type = 'BIGINT';
    return this;
  }
  integer(): this {
    this._config.type = 'INTEGER';
    return this;
  }
  smallint(): this {
    this._config.type = 'SMALLINT';
    return this;
  }
  text(): this {
    this._config.type = 'TEXT';
    return this;
  }
  varchar(length: number): this {
    this._config.type = 'VARCHAR';
    this._config.maxLength = length;
    return this;
  }
  boolean(): this {
    this._config.type = 'BOOLEAN';
    return this;
  }
  timestamp(): this {
    this._config.type = 'TIMESTAMPTZ';
    return this;
  }
  date(): this {
    this._config.type = 'DATE';
    return this;
  }
  json(): this {
    this._config.type = 'JSONB';
    return this;
  }
  uuid(): this {
    this._config.type = 'UUID';
    return this;
  }
  real(): this {
    this._config.type = 'REAL';
    return this;
  }
  doublePrecision(): this {
    this._config.type = 'DOUBLE PRECISION';
    return this;
  }
  numeric(): this {
    this._config.type = 'NUMERIC';
    return this;
  }
  bytea(): this {
    this._config.type = 'BYTEA';
    return this;
  }

  primaryKey(): this {
    this._config.isPrimaryKey = true;
    return this;
  }
  notNull(): this {
    this._config.isNotNull = true;
    return this;
  }
  nullable(): this {
    this._config.isNullable = true;
    return this;
  }
  unique(): this {
    this._config.isUnique = true;
    return this;
  }
  default(val: string): this {
    this._config.defaultValue = val;
    return this;
  }
  references(target: string): this {
    this._config.referencesTarget = target;
    return this;
  }

  build(): ColumnConfig {
    return { ...this._config };
  }
}

/** @deprecated Use defineSchema() with plain objects instead */
type ColumnProxy = {
  [K in
    | 'serial'
    | 'bigint'
    | 'integer'
    | 'smallint'
    | 'text'
    | 'boolean'
    | 'timestamp'
    | 'date'
    | 'json'
    | 'uuid'
    | 'real'
    | 'doublePrecision'
    | 'numeric'
    | 'bytea']: () => ColumnBuilder;
} & { varchar: (length: number) => ColumnBuilder };

/** Nullary (no-arg) type methods on ColumnBuilder — everything except varchar */
type NullaryColumnType = Exclude<keyof ColumnProxy, 'varchar'>;

/** Type guard: is `prop` a known nullary ColumnBuilder type method? */
function isNullaryColumnType(prop: string): prop is NullaryColumnType {
  return (
    prop === 'serial' ||
    prop === 'bigint' ||
    prop === 'integer' ||
    prop === 'smallint' ||
    prop === 'text' ||
    prop === 'boolean' ||
    prop === 'timestamp' ||
    prop === 'date' ||
    prop === 'json' ||
    prop === 'uuid' ||
    prop === 'real' ||
    prop === 'doublePrecision' ||
    prop === 'numeric' ||
    prop === 'bytea'
  );
}

/** @deprecated Use defineSchema() with plain objects instead */
export const column: ColumnProxy = new Proxy({} as ColumnProxy, {
  get(_target, prop: string) {
    if (prop === 'varchar') return (length: number) => new ColumnBuilder().varchar(length);
    if (isNullaryColumnType(prop)) {
      return () => {
        const builder = new ColumnBuilder();
        return builder[prop]();
      };
    }
    return () => {
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
  return { name: '', accessor: '', columns: built };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { camelToSnake } from './schema.js';

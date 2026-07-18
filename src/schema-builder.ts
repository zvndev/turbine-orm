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

// Type-only import — erased at runtime, so it cannot introduce a circular
// runtime dependency (the local `camelToSnakeLocal` copy avoids that for the
// value-level helper).
import type { ReferentialAction, RelationDef, SchemaMetadata, TableMetadata } from './schema.js';

export type { ReferentialAction } from './schema.js';

// ---------------------------------------------------------------------------
// Column types — lowercase shorthand mapped to Postgres types
// ---------------------------------------------------------------------------

/** Shorthand type names that map to Postgres column types */
export type ColumnTypeName =
  | 'serial' // SERIAL (int4) — auto-increment PK that stays a JS `number`
  | 'bigserial' // BIGSERIAL (int8) — 64-bit auto-increment; large values read back as string
  | 'bigint' // BIGINT
  | 'integer' // INTEGER
  | 'smallint' // SMALLINT
  | 'text' // TEXT
  | 'varchar' // VARCHAR(n)
  | 'boolean' // BOOLEAN
  | 'timestamp' // TIMESTAMPTZ (timezone-aware; alias kept for back-compat)
  | 'timestamptz' // TIMESTAMPTZ
  | 'date' // DATE
  | 'json' // JSONB (alias kept for back-compat)
  | 'jsonb' // JSONB
  | 'uuid' // UUID
  | 'real' // REAL
  | 'double' // DOUBLE PRECISION
  | 'numeric' // NUMERIC
  | 'bytea' // BYTEA
  | 'enum' // user-defined enum type (requires `enumName`)
  | 'vector'; // pgvector vector(n) (requires `dimensions`)

/** Maps shorthand names to actual Postgres type strings */
const TYPE_MAP: Record<ColumnTypeName, string> = {
  // `serial` maps to SERIAL (int4). Its values fit in a JS `number` and pg
  // returns them as numbers — so the generated `number` type is accurate.
  // For 64-bit auto-increment keys use `bigserial` (int8), noting that values
  // above Number.MAX_SAFE_INTEGER read back as string. (Changed in 0.24.0;
  // `serial` previously emitted BIGSERIAL.)
  serial: 'SERIAL',
  bigserial: 'BIGSERIAL',
  bigint: 'BIGINT',
  integer: 'INTEGER',
  smallint: 'SMALLINT',
  text: 'TEXT',
  varchar: 'VARCHAR',
  boolean: 'BOOLEAN',
  // `timestamp` is an honest alias for TIMESTAMPTZ (timezone-aware) — Turbine
  // has always emitted TIMESTAMPTZ for it. `timestamptz` is the explicit spelling.
  timestamp: 'TIMESTAMPTZ',
  timestamptz: 'TIMESTAMPTZ',
  date: 'DATE',
  // `json` is an alias for JSONB (Turbine has always emitted JSONB). `jsonb`
  // is the explicit spelling.
  json: 'JSONB',
  jsonb: 'JSONB',
  uuid: 'UUID',
  real: 'REAL',
  double: 'DOUBLE PRECISION',
  numeric: 'NUMERIC',
  bytea: 'BYTEA',
  // Sentinels — the real DDL type is derived from `enumName` / `dimensions`
  // in schema-sql.ts, never from these placeholders.
  enum: 'ENUM',
  vector: 'VECTOR',
};

// ---------------------------------------------------------------------------
// Column definition — the user-facing type
// ---------------------------------------------------------------------------

/** Foreign key reference with optional referential actions. */
export interface ReferenceDef {
  /** REFERENCES target in "table.column" form. */
  target: string;
  /** `ON DELETE` action. Omit for the Postgres default (`NO ACTION`). */
  onDelete?: ReferentialAction;
  /** `ON UPDATE` action. Omit for the Postgres default (`NO ACTION`). */
  onUpdate?: ReferentialAction;
}

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
  /**
   * REFERENCES target. Either the "table.column" string form or an object with
   * referential actions ({@link ReferenceDef}).
   */
  references?: string | ReferenceDef;
  /** Max length for varchar columns */
  maxLength?: number;
  /** Enum type name — required when `type: 'enum'`. */
  enumName?: string;
  /** pgvector dimension count — required when `type: 'vector'`. */
  dimensions?: number;
  /** When true, the column is an array of `type` (e.g. `text[]`). */
  array?: boolean;
  /** Column-level `CHECK` expression (raw SQL, e.g. `price >= 0`). */
  check?: string;
  /**
   * Marks this column as personally identifiable information (PII). Purely a
   * code-first declaration: it carries onto {@link ColumnConfig.pii} and, via
   * `schemaDefToMetadata` / codegen, onto
   * {@link import('./schema.js').ColumnMetadata.pii}. A PII column is excluded
   * from default projections (read back only via an explicit `select` or
   * `includePii: true`) and redacted by Studio. Introspection never auto-tags PII.
   */
  pii?: boolean;
}

// ---------------------------------------------------------------------------
// Internal ColumnConfig — used by schema-sql.ts
// ---------------------------------------------------------------------------

/** Postgres-level column type (uppercase, as used in DDL) */
export type ColumnType =
  | 'SERIAL'
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
  | 'VARCHAR'
  | 'ENUM'
  | 'VECTOR';

export interface ColumnConfig {
  type: ColumnType;
  isPrimaryKey: boolean;
  isNotNull: boolean;
  isNullable: boolean;
  isUnique: boolean;
  defaultValue: string | null;
  referencesTarget: string | null;
  maxLength: number | null;
  /** FK `ON DELETE` action, or null for the Postgres default. */
  onDelete: ReferentialAction | null;
  /** FK `ON UPDATE` action, or null for the Postgres default. */
  onUpdate: ReferentialAction | null;
  /** Enum type name when `type === 'ENUM'`, else null. */
  enumName: string | null;
  /** pgvector dimensions when `type === 'VECTOR'`, else null. */
  vectorDimensions: number | null;
  /** Whether the column is an array of its base type. */
  isArray: boolean;
  /** Column-level `CHECK` expression, or null. */
  check: string | null;
  /** Whether this column is tagged as PII (personally identifiable information). */
  pii: boolean;
}

/** Convert a user-facing ColumnDef to the internal ColumnConfig */
function resolveColumn(def: ColumnDef): ColumnConfig {
  if (!(def.type in TYPE_MAP)) {
    throw new Error(`Invalid column type "${def.type}". Valid types: ${Object.keys(TYPE_MAP).join(', ')}`);
  }
  if (def.type === 'enum' && !def.enumName) {
    throw new Error(`Column of type "enum" requires an "enumName" (the CREATE TYPE name).`);
  }
  if (def.type === 'vector' && (def.dimensions == null || def.dimensions <= 0)) {
    throw new Error(`Column of type "vector" requires a positive "dimensions" count.`);
  }

  // `references` is either the "table.column" string or a { target, onDelete, onUpdate } object.
  let referencesTarget: string | null = null;
  let onDelete: ReferentialAction | null = null;
  let onUpdate: ReferentialAction | null = null;
  if (typeof def.references === 'string') {
    referencesTarget = def.references;
  } else if (def.references) {
    referencesTarget = def.references.target;
    onDelete = def.references.onDelete ?? null;
    onUpdate = def.references.onUpdate ?? null;
  }

  return {
    type: TYPE_MAP[def.type] as ColumnType,
    isPrimaryKey: def.primaryKey ?? false,
    isNotNull: def.notNull ?? false,
    isNullable: def.nullable ?? false,
    isUnique: def.unique ?? false,
    defaultValue: def.default ?? null,
    referencesTarget,
    maxLength: def.maxLength ?? null,
    onDelete,
    onUpdate,
    enumName: def.enumName ?? null,
    vectorDimensions: def.dimensions ?? null,
    isArray: def.array ?? false,
    check: def.check ?? null,
    pii: def.pii ?? false,
  };
}

// ---------------------------------------------------------------------------
// Table & Schema definitions
// ---------------------------------------------------------------------------

/**
 * Explicit many-to-many relation declaration for the code-first schema.
 *
 * Auto-detecting m2m from a junction table is intentionally conservative (a
 * junction with payload columns is treated as a first-class entity, not a join
 * table — see `introspect.ts`). This declaration lets users opt in to an m2m
 * relation explicitly, mirroring how Prisma/Drizzle require an explicit
 * `@relation` / `relation()` for join tables.
 *
 * All names are the JS-facing accessor / camelCase field names you wrote in
 * `defineSchema({ ... })`; they are normalized to snake_case when merged into
 * the introspected {@link SchemaMetadata} via {@link applyManyToManyRelations}.
 */
export interface ManyToManyDef {
  /** Relation field name on the source table (e.g. `tags`). */
  name: string;
  /** Target table accessor (e.g. `tags`). */
  target: string;
  /** Junction (join) table accessor (e.g. `postsTags`). */
  through: string;
  /** Junction column(s) referencing the SOURCE table's PK. */
  sourceKey: string | readonly string[];
  /** Junction column(s) referencing the TARGET table's PK. */
  targetKey: string | readonly string[];
  /**
   * Optional: the SOURCE table's referenced column(s) that `sourceKey` points
   * at. Defaults to `id`. Use for sources keyed on a non-`id` / composite PK.
   */
  references?: string | readonly string[];
}

/** A table-level named (or unnamed) `CHECK` constraint. */
export interface CheckDef {
  /** Optional constraint name → `CONSTRAINT "name" CHECK (...)`. */
  name?: string;
  /** Raw SQL boolean expression, e.g. `price > cost`. */
  expression: string;
}

/** A plain (column-list) index declaration. */
export interface ColumnIndexDef {
  /** camelCase field name(s) the index covers. */
  columns: string[];
  /** Whether the index enforces uniqueness. */
  unique?: boolean;
  /** Optional explicit index name (auto-derived when omitted). */
  name?: string;
}

/**
 * A doc-field expression index on a JSON document column (PowDB ≥ 0.13).
 * Indexes the value at `docField-><path>` inside the json document, so a
 * `JsonFilter`/`orderBy` on that path can use an index instead of a scan.
 */
export interface DocFieldIndexDef {
  /** camelCase field name of the json document column. */
  docField: string;
  /** JSON path into the document: string keys and integer array indexes. */
  path: (string | number)[];
  /** Whether the expression index enforces uniqueness. */
  unique?: boolean;
  /** Optional explicit index name (auto-derived when omitted). */
  name?: string;
}

/**
 * A single index declaration on a table: either a plain column-list index
 * ({@link ColumnIndexDef}) or a doc-field expression index into a json column
 * ({@link DocFieldIndexDef}).
 *
 * Consumed today by the PowDB DDL generator (`powqlSchemaDDL`) and carried onto
 * {@link import('./schema.js').IndexMetadata} by `schemaDefToMetadata`. The SQL
 * DDL generators (`schema-sql.ts` / `schemaDiff`) do NOT consume these yet.
 */
export type SchemaIndexDef = ColumnIndexDef | DocFieldIndexDef;

/** Type guard: is this index declaration a doc-field expression index? */
export function isDocFieldIndexDef(idx: SchemaIndexDef): idx is DocFieldIndexDef {
  return 'docField' in idx && typeof (idx as DocFieldIndexDef).docField === 'string';
}

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
  /**
   * Explicit many-to-many relations declared on this table. These never affect
   * DDL emission (junction tables are still ordinary `CREATE TABLE`s); they are
   * consumed by {@link applyManyToManyRelations} to enrich an introspected
   * {@link SchemaMetadata} with `manyToMany` {@link RelationDef}s.
   */
  manyToMany?: readonly ManyToManyDef[];
  /** Table-level `CHECK` constraints. */
  checks?: readonly CheckDef[];
  /**
   * Index declarations for this table (plain column indexes and/or PowDB
   * doc-field expression indexes). Consumed by the PowDB DDL generator
   * (`powqlSchemaDDL`) and carried onto `IndexMetadata` by
   * `schemaDefToMetadata`; the SQL DDL generators do not consume them yet.
   */
  indexes?: readonly SchemaIndexDef[];
}

/**
 * User-facing input shape for a single table when using the object format.
 * The optional `primaryKey` field declares a composite primary key.
 */
export interface TableInput {
  /** Optional composite primary key (camelCase field names) */
  primaryKey?: readonly string[];
  /** Optional explicit many-to-many relations on this table */
  manyToMany?: readonly ManyToManyDef[];
  /** Optional table-level CHECK constraints */
  checks?: readonly CheckDef[];
  /** Optional index declarations (plain column and/or doc-field expression) */
  indexes?: readonly SchemaIndexDef[];
  /** Column definitions keyed by camelCase field name */
  [columnName: string]:
    | ColumnDef
    | readonly string[]
    | readonly ManyToManyDef[]
    | readonly CheckDef[]
    | readonly SchemaIndexDef[]
    | undefined;
}

export interface SchemaDef {
  /**
   * All tables keyed by their JS-facing accessor name (camelCase, exactly as
   * the user wrote them in `defineSchema({ ... })`). The DDL-facing snake_case
   * name is available as `tables[key].name`.
   */
  tables: Record<string, TableDef>;
  /**
   * Schema-level enum declarations (`CREATE TYPE "<name>" AS ENUM (...)`),
   * keyed by DDL enum type name → ordered labels. Consumed by `schema-sql.ts`
   * to emit `CREATE TYPE` before the tables that reference them and by
   * `generate.ts` for string-literal union codegen. Omitted when no enums are
   * declared (back-compat with `{ tables }`-only consumers).
   */
  enums?: Record<string, readonly string[]>;
}

/** Options accepted by {@link defineSchema}. */
export interface DefineSchemaOptions {
  /**
   * Schema-level enum declarations, keyed by DDL enum type name → ordered
   * labels. Columns opt in via `{ type: 'enum', enumName: '<name>' }`.
   */
  enums?: Record<string, readonly string[]>;
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
export function defineSchema(input: SchemaInput, options?: DefineSchemaOptions): SchemaDef {
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
      let m2m: readonly ManyToManyDef[] | undefined;
      let checks: readonly CheckDef[] | undefined;
      let indexes: readonly SchemaIndexDef[] | undefined;

      for (const [fieldName, def] of Object.entries(raw)) {
        if (fieldName === 'indexes') {
          if (def !== undefined) {
            if (!Array.isArray(def)) {
              throw new Error(`Table "${accessor}": "indexes" must be an array of index declarations`);
            }
            indexes = def as readonly SchemaIndexDef[];
          }
          continue;
        }
        if (fieldName === 'manyToMany') {
          if (def !== undefined) {
            if (!Array.isArray(def)) {
              throw new Error(`Table "${accessor}": "manyToMany" must be an array of relation declarations`);
            }
            m2m = def as readonly ManyToManyDef[];
          }
          continue;
        }
        if (fieldName === 'checks') {
          if (def !== undefined) {
            if (!Array.isArray(def)) {
              throw new Error(`Table "${accessor}": "checks" must be an array of { name?, expression } objects`);
            }
            checks = def as readonly CheckDef[];
          }
          continue;
        }
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
        ...(m2m && m2m.length > 0 ? { manyToMany: m2m } : {}),
        ...(checks && checks.length > 0 ? { checks } : {}),
        ...(indexes && indexes.length > 0 ? { indexes } : {}),
      };
    }
  }

  return { tables, ...(options?.enums ? { enums: options.enums } : {}) };
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
      onDelete: null,
      onUpdate: null,
      enumName: null,
      vectorDimensions: null,
      isArray: false,
      check: null,
      pii: false,
    };
  }

  serial(): this {
    // See TYPE_MAP: `serial` is SERIAL (int4) as of 0.24.0. Use bigserial() for 64-bit.
    this._config.type = 'SERIAL';
    return this;
  }
  bigserial(): this {
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
  timestamptz(): this {
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
  jsonb(): this {
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
  references(target: string, opts?: { onDelete?: ReferentialAction; onUpdate?: ReferentialAction }): this {
    this._config.referencesTarget = target;
    this._config.onDelete = opts?.onDelete ?? null;
    this._config.onUpdate = opts?.onUpdate ?? null;
    return this;
  }
  check(expression: string): this {
    this._config.check = expression;
    return this;
  }
  pii(): this {
    this._config.pii = true;
    return this;
  }
  array(): this {
    this._config.isArray = true;
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
    | 'bigserial'
    | 'bigint'
    | 'integer'
    | 'smallint'
    | 'text'
    | 'boolean'
    | 'timestamp'
    | 'timestamptz'
    | 'date'
    | 'json'
    | 'jsonb'
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
    prop === 'bigserial' ||
    prop === 'bigint' ||
    prop === 'integer' ||
    prop === 'smallint' ||
    prop === 'text' ||
    prop === 'boolean' ||
    prop === 'timestamp' ||
    prop === 'timestamptz' ||
    prop === 'date' ||
    prop === 'json' ||
    prop === 'jsonb' ||
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
// Explicit many-to-many: merge declared relations into introspected metadata
// ---------------------------------------------------------------------------

/**
 * Merge the explicit `manyToMany` declarations from a code-first {@link SchemaDef}
 * into an introspected {@link SchemaMetadata}, returning a new metadata object
 * with the `manyToMany` {@link RelationDef}s added.
 *
 * This is the runtime bridge for the code-first m2m API: `defineSchema` only
 * produces DDL, so after `introspect()`ing the live database you call this to
 * attach the m2m relations you declared. It is PURELY ADDITIVE — existing
 * belongsTo/hasMany/hasOne relations are preserved, and a declared relation is
 * skipped (not overwritten) if its name already exists on the source table.
 *
 * @example
 * ```ts
 * const def = defineSchema({
 *   posts: { id: { type: 'serial', primaryKey: true },
 *            manyToMany: [{ name: 'tags', target: 'tags', through: 'postsTags',
 *                           sourceKey: 'postId', targetKey: 'tagId' }] },
 *   tags:  { id: { type: 'serial', primaryKey: true } },
 *   postsTags: { postId: { type: 'integer', references: 'posts.id' },
 *                tagId:  { type: 'integer', references: 'tags.id' },
 *                primaryKey: ['postId', 'tagId'] },
 * });
 * let meta = await introspect({ connectionString });
 * meta = applyManyToManyRelations(meta, def);
 * ```
 */
export function applyManyToManyRelations(meta: SchemaMetadata, def: SchemaDef): SchemaMetadata {
  // Map accessor (camelCase key) → DDL snake_case table name.
  const accessorToTable = new Map<string, string>();
  for (const [accessor, t] of Object.entries(def.tables)) {
    accessorToTable.set(accessor, t.name);
  }
  const resolveTable = (accessor: string): string => accessorToTable.get(accessor) ?? camelToSnakeLocal(accessor);
  const resolveCols = (k: string | readonly string[]): string | string[] => {
    if (Array.isArray(k)) return (k as readonly string[]).map(camelToSnakeLocal);
    return camelToSnakeLocal(k as string);
  };

  // Deep-ish clone of the tables we touch so the input metadata is not mutated.
  const tables: Record<string, TableMetadata> = { ...meta.tables };

  for (const tableDef of Object.values(def.tables)) {
    if (!tableDef.manyToMany || tableDef.manyToMany.length === 0) continue;
    const sourceTable = tableDef.name;
    const sourceMeta = tables[sourceTable];
    if (!sourceMeta) continue; // table not present in introspected metadata — skip

    const relations: Record<string, RelationDef> = { ...sourceMeta.relations };
    for (const m of tableDef.manyToMany) {
      // Additive-only: never clobber an existing relation name.
      if (relations[m.name]) continue;
      const ref = m.references ?? 'id';
      relations[m.name] = {
        type: 'manyToMany',
        name: m.name,
        from: sourceTable,
        to: resolveTable(m.target),
        referenceKey: resolveCols(ref),
        foreignKey: resolveCols(ref),
        through: {
          table: resolveTable(m.through),
          sourceKey: resolveCols(m.sourceKey),
          targetKey: resolveCols(m.targetKey),
        },
      };
    }
    tables[sourceTable] = { ...sourceMeta, relations };
  }

  return { ...meta, tables };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export { camelToSnake } from './schema.js';

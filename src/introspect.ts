/**
 * turbine-orm, Schema introspection
 *
 * Connects to a live Postgres database, reads information_schema + pg_catalog,
 * and produces a SchemaMetadata object describing every table, column, relation,
 * and index in the target schema.
 *
 * This is the foundation of `npx turbine generate`.
 */

import pg from 'pg';
import { type Dialect, postgresDialect } from './dialect.js';
import { ValidationError } from './errors.js';
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

// Foreign keys, read from pg_catalog rather than information_schema.
//
// This CANNOT be expressed against information_schema. The obvious formulation
// joins key_column_usage (the constrained columns) to constraint_column_usage
// (the referenced columns) on the constraint NAME, and that is wrong twice:
//
//   1. The two column lists have no positional link there, so the join is an
//      N-by-N cross product. A composite FK cities(country, region_code) ->
//      regions(country, code) came back as four rows, and grouping them gave
//      foreignKey ['country','country','region_code','region_code'] against
//      referenceKey ['country','code','country','code'] - four AND-ed
//      correlations, two of them pairing the wrong columns. Every read through
//      the relation silently returned nothing, with no error.
//   2. Postgres only requires a constraint name to be unique per TABLE
//      (conrelid, conname), so two tables in one schema may both have a
//      `shared_fk`. Joining on the name alone crosses them: each table's FK
//      picks up the other's referenced column, so one relation is lost and the
//      other points at a column that does not exist on its target (42703 at
//      query time). Which one won depended on catalog row order.
//
// conkey and confkey are parallel arrays, so unnesting BOTH `WITH ORDINALITY`
// and joining on the ordinal is the pairing, exactly. The constraint OID is the
// grouping key: it is unique catalog-wide, unlike the name.
//
// `target_schema` is selected so a cross-schema reference can be recognized
// rather than mistaken for a same-named local table (see the FK grouping loop).
// Referential actions come from the same row, which also removes the separate
// name-keyed actions query that shared bug 2.
//
// `conparentid = 0` keeps only DECLARED constraints. Declaring one foreign key
// against a PARTITIONED table makes Postgres materialize an extra constraint per
// partition, each pointing at that partition rather than at the parent, and each
// with `conparentid` set to the declared constraint's OID. Without this filter a
// single `items(bucket_id) REFERENCES buckets(id)` against a two-partition
// `buckets` introspected as THREE belongsTo relations (`bucket`, `bucketsLo`,
// `bucketsHi`), measured on PG 16. The two extras are fully generated, typed and
// autocompleting, and resolve to `null` for every row whose parent lives in the
// other partition, so they read as an intermittently-empty relation rather than
// as an error. The same clone exists when the REFERENCING side is partitioned
// (verified: `conparentid` is set there too), where the partition inherits the
// parent table's declared FK and needs no relation of its own.
//
// ORDER BY is (source table, constraint name), NOT `con.oid`. The OID is
// ALLOCATION order, so it encodes the order the DDL happened to run in, and the
// FK walk order decides which relation wins a contested NAME: relation naming in
// buildRelationsFromForeignKeys accumulates `taken` names as it walks, and the
// loser gets a `Rel` suffix. On a `users` table with both a `profiles` child
// (UNIQUE FK, so hasOne) and a `profile` child (plain FK, so hasMany), both
// derive the name `profile`, and the two creation orders produced
// `users.profile = hasOne -> profiles` versus `users.profile = hasMany ->
// profile`. Same logical schema, different cardinality and a different TABLE
// behind the same relation name, so a database restored from a dump disagreed
// with one built by running the migrations. Sorting by name makes the walk a
// function of the schema instead of its history. (conrelid, conname) is unique
// in Postgres and relname is unique per namespace, so the pair is a total order
// here, and sk.ord still pairs conkey to confkey within a constraint.
const SQL_FOREIGN_KEYS = `
  SELECT
    con.oid::text AS constraint_oid,
    con.conname AS constraint_name,
    src.relname AS source_table,
    src_att.attname AS source_column,
    tgt_ns.nspname AS target_schema,
    tgt.relname AS target_table,
    tgt_att.attname AS target_column,
    con.confdeltype,
    con.confupdtype
  FROM pg_catalog.pg_constraint con
  JOIN pg_catalog.pg_class src ON src.oid = con.conrelid
  JOIN pg_catalog.pg_namespace src_ns ON src_ns.oid = src.relnamespace
  JOIN pg_catalog.pg_class tgt ON tgt.oid = con.confrelid
  JOIN pg_catalog.pg_namespace tgt_ns ON tgt_ns.oid = tgt.relnamespace
  JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS sk(attnum, ord) ON TRUE
  JOIN LATERAL unnest(con.confkey) WITH ORDINALITY AS tk(attnum, ord) ON tk.ord = sk.ord
  JOIN pg_catalog.pg_attribute src_att
    ON src_att.attrelid = con.conrelid AND src_att.attnum = sk.attnum
  JOIN pg_catalog.pg_attribute tgt_att
    ON tgt_att.attrelid = con.confrelid AND tgt_att.attnum = tk.attnum
  WHERE con.contype = 'f'
    AND con.conparentid = 0
    AND src_ns.nspname = $1
  ORDER BY src.relname, con.conname, sk.ord
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

// Both of the next two queries are ordered for the same reason the FK query is:
// their rows land in metadata.ts as ARRAYS (`indexes`, `checks`), so an unordered
// read makes the generated file a function of physical catalog order rather than
// of the schema. A `DROP INDEX` + `CREATE INDEX` of an unchanged index, or a
// VACUUM FULL, is enough to permute them, which shows up as generated-file diff
// noise between one developer's machine and CI and defeats the byte-identical
// claim that makes a regenerate safe to commit. Index and check constraint names
// are both unique per schema, so each sort is total.
const SQL_INDEXES = `
  SELECT tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = $1
  ORDER BY tablename, indexname
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
  ORDER BY rel.relname, con.conname
`;

// Views (relkind 'v'), column metadata comes free from information_schema.columns.
const SQL_VIEWS = `
  SELECT table_name
  FROM information_schema.views
  WHERE table_schema = $1
  ORDER BY table_name
`;

// Materialized views (relkind 'm'), NOT in information_schema; read from pg_catalog.
const SQL_MATVIEWS = `
  SELECT matviewname AS table_name
  FROM pg_matviews
  WHERE schemaname = $1
  ORDER BY matviewname
`;

// Materialized-view columns, information_schema.columns omits matviews, so pull
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
   * Rename derived relations, as `{ table: { derivedName: desiredName } }`.
   *
   * Relation names are composed by introspection (the database does not name
   * relationships), so a port from another ORM that named them differently has
   * to touch every call site. Declaring the mapping here makes it mechanical.
   * A typo is an error, not a silent no-op: see {@link applyRelationRenames}.
   */
  relationNames?: Record<string, Record<string, string>>;
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
   * Use the raw database column name as each column's TypeScript field
   * (`user_id` stays `user_id`) instead of the camelCase default (`userId`).
   * The same identity mapping `withDbFieldNames` applies at generate time, so
   * a schema introspected with this flag is byte-identical after that
   * transform; declaring it here as well is what makes it the escape from the
   * field-collision refusal (see {@link assertDistinctColumnFields}): a table
   * carrying both `"createdAt"` and `created_at` has two distinct raw names and
   * one shared camelCase name, and only the flag can tell introspection which
   * of those two facts to build the field from.
   */
  keepColumnNames?: boolean;
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

// ---------------------------------------------------------------------------
// Catalog identifier boundary
// ---------------------------------------------------------------------------

/**
 * Characters that no legitimate SQL object name carries and that are exactly
 * the primitives for breaking OUT of a generated string literal or comment: the
 * C0 control range (NUL, newline, carriage return, tab), the C1 range, and the
 * two Unicode line terminators.
 *
 * Postgres permits ANY character in a double-quoted identifier up to 63 bytes,
 * so a catalog name is attacker-controlled text as soon as anyone but the DBA
 * can create an object. `turbine generate` turns those names into TypeScript
 * that is then `import`ed, i.e. EXECUTED, and `turbine studio` / the MCP server
 * render them into HTML and JSON. Escaping at each of those sinks is the actual
 * fix (see `escSQ` / `quoteIfNeeded` / `docSafe` in generate.ts); this boundary
 * is the belt-and-braces refusal one layer earlier, and it names the object so
 * the operator can see WHICH one is malformed instead of debugging generated
 * output.
 *
 * Deliberately narrow. It does NOT refuse a name that merely cannot become a
 * TypeScript identifier (`2fa_codes`), because `introspect()` also feeds
 * Studio, the MCP server, and `doctor`, none of which emit identifiers, and
 * refusing there would break tools that work today. That question belongs to
 * the code generator and is answered by `assertEmittableSchema` in generate.ts.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control characters is this pattern's purpose
const UNSAFE_CATALOG_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Refuse one catalog identifier carrying a character from
 * {@link UNSAFE_CATALOG_CHARS}. `subject` names the object in the error.
 */
export function assertSafeCatalogIdentifier(name: string, subject: string): void {
  const match = UNSAFE_CATALOG_CHARS.exec(name);
  if (match === null) return;
  const code = match[0].charCodeAt(0).toString(16).padStart(4, '0');
  throw new ValidationError(
    `Refusing to introspect ${subject}: its name contains the control character U+${code.toUpperCase()} ` +
      `at position ${match.index}. Such a name cannot be safely emitted into generated code, SQL comments, or ` +
      `tooling output. Rename the database object, or exclude it from introspection.`,
  );
}

/**
 * Walk a freshly introspected {@link SchemaMetadata} and refuse any catalog
 * identifier that carries a control character (see
 * {@link assertSafeCatalogIdentifier}).
 *
 * Covers every string that is a NAME: tables, columns (catalog name and derived
 * field), relations (key, name, endpoints, keys, junction), enum types and their
 * labels, index names and their columns, and check-constraint names. It does
 * NOT cover free-text SQL, index definitions, check expressions, and column
 * defaults are emitted with `JSON.stringify` and are not identifiers.
 */
export function assertSafeCatalogSchema(schema: SchemaMetadata): void {
  for (const [enumName, labels] of Object.entries(schema.enums)) {
    assertSafeCatalogIdentifier(enumName, `enum type "${enumName}"`);
    for (const label of labels) {
      assertSafeCatalogIdentifier(label, `a label of enum type "${enumName}"`);
    }
  }
  for (const [tableKey, table] of Object.entries(schema.tables)) {
    assertSafeCatalogIdentifier(tableKey, `table "${tableKey}"`);
    assertSafeCatalogIdentifier(table.name, `table "${tableKey}"`);
    const where = `table "${table.name}"`;
    for (const col of table.columns) {
      assertSafeCatalogIdentifier(col.name, `column "${col.name}" on ${where}`);
      assertSafeCatalogIdentifier(col.field, `the field name derived for a column on ${where}`);
    }
    for (const [relKey, rel] of Object.entries(table.relations)) {
      const relWhere = `relation "${relKey}" on ${where}`;
      assertSafeCatalogIdentifier(relKey, relWhere);
      assertSafeCatalogIdentifier(rel.name, relWhere);
      assertSafeCatalogIdentifier(rel.from, `the source table of ${relWhere}`);
      assertSafeCatalogIdentifier(rel.to, `the target table of ${relWhere}`);
      for (const k of [rel.foreignKey, rel.referenceKey].flat()) {
        assertSafeCatalogIdentifier(k, `a key column of ${relWhere}`);
      }
      if (rel.through) {
        assertSafeCatalogIdentifier(rel.through.table, `the junction table of ${relWhere}`);
        for (const k of [rel.through.sourceKey, rel.through.targetKey].flat()) {
          assertSafeCatalogIdentifier(k, `a junction key column of ${relWhere}`);
        }
      }
    }
    for (const idx of table.indexes) {
      assertSafeCatalogIdentifier(idx.name, `index "${idx.name}" on ${where}`);
      for (const c of idx.columns) {
        assertSafeCatalogIdentifier(c, `a column of index "${idx.name}" on ${where}`);
      }
    }
    for (const chk of table.checks ?? []) {
      assertSafeCatalogIdentifier(chk.name, `check constraint "${chk.name}" on ${where}`);
    }
  }
}

/**
 * Introspect a database into {@link SchemaMetadata}, routing through the active
 * dialect's {@link Dialect.introspector} so each engine can override the catalog
 * SQL. PostgreSQL is driven by {@link introspectPostgresCatalog}.
 */
export async function introspect(options: IntrospectOptions): Promise<SchemaMetadata> {
  const dialect = options.dialect ?? postgresDialect;
  const introspector = dialect.introspector;
  const schema = introspector
    ? await introspector.introspect(options)
    : // Dialects without an introspector fall back to the Postgres catalog reader.
      await introspectPostgresCatalog(options);
  // Applied here rather than inside each introspector so every engine gets it.
  const renamed = options.relationNames ? applyRelationRenames(schema, options.relationNames) : schema;
  // Same reason: one boundary for every engine, and AFTER the renames so a
  // caller-supplied relation name is checked too.
  assertSafeCatalogSchema(renamed);
  return renamed;
}

/**
 * Rename introspected relations, per table, from the name turbine derived to
 * the name the caller wants.
 *
 * Relation names are DERIVED, not declared: the database has no name for a
 * foreign key's relationship, so introspection composes one, and two foreign
 * keys pointing at the same table produce composed names (`msgsBySender`,
 * `msgsByRecipient`) that nobody would predict. A codebase migrating from
 * another ORM already has names for these, chosen by different rules, so every
 * call site has to be hand-edited. This map turns that into a mechanical
 * mapping done once in the config.
 *
 * Renames are validated rather than best-effort: an unknown table or an
 * unknown source relation is an ERROR, because silently ignoring a typo here
 * means the call sites it was supposed to fix break at runtime instead.
 */
export function applyRelationRenames(
  schema: SchemaMetadata,
  renames: Record<string, Record<string, string>>,
): SchemaMetadata {
  const tables: Record<string, TableMetadata> = { ...schema.tables };

  for (const [table, mapping] of Object.entries(renames)) {
    const meta = tables[table];
    if (!meta) {
      throw new ValidationError(
        `relationNames: unknown table "${table}". Known tables: ${Object.keys(tables).join(', ')}.`,
      );
    }
    const relations: Record<string, RelationDef> = { ...meta.relations };
    const columnFields = new Set(Object.values(meta.columnMap));

    for (const [from, to] of Object.entries(mapping)) {
      if (!Object.hasOwn(relations, from)) {
        throw new ValidationError(
          `relationNames: table "${table}" has no relation "${from}". ` +
            `Derived relations: ${Object.keys(relations).join(', ') || '(none)'}.`,
        );
      }
      if (from === to) continue;
      if (Object.hasOwn(relations, to)) {
        throw new ValidationError(
          `relationNames: cannot rename "${table}.${from}" to "${to}", that relation already exists.`,
        );
      }
      if (columnFields.has(to)) {
        throw new ValidationError(
          `relationNames: cannot rename "${table}.${from}" to "${to}", a column on "${table}" ` +
            `already uses that field name, and a relation must never shadow a column.`,
        );
      }
      const def = relations[from]!;
      delete relations[from];
      // `RelationDef.name` is the relation's own identity, so it moves with it.
      relations[to] = { ...def, name: to };
    }

    tables[table] = { ...meta, relations };
  }

  return { ...schema, tables };
}

/**
 * THE field-collision rule: two columns of one table may never resolve to the
 * same TypeScript field.
 *
 * Fields are derived with `snakeToCamel`, so a table carrying both a quoted
 * `"createdAt"` and a `created_at` column (a Prisma-era column beside a
 * hand-written one is the common way to get there) yields two `createdAt`
 * fields. Nothing used to refuse that, and every consumer keyed by field then
 * lost a column silently: `columnMap` kept whichever column was written last,
 * reads folded both columns into one property, a write to the field reached
 * only one of them, and `types.ts` carried a duplicate member that failed the
 * consumer's `tsc` (TS2300) while `turbine generate` exited 0.
 *
 * A thrown error names the table, every colliding column and the fix. There is
 * no per-column rename option, so the fix is `keepColumnNames` (the field is
 * then the raw column name, and two distinct columns cannot collide) or a
 * rename in the database. Applied once per table right after the catalog's
 * columns are grouped, and again by the generate.ts emitters so a schema that
 * never went through introspection is refused at the same boundary.
 */
export function assertDistinctColumnFields(tableName: string, columns: readonly ColumnMetadata[]): void {
  const columnsByField = new Map<string, string[]>();
  for (const col of columns) {
    const names = columnsByField.get(col.field);
    if (names) names.push(col.name);
    else columnsByField.set(col.field, [col.name]);
  }
  const collisions: string[] = [];
  for (const [field, names] of columnsByField) {
    if (names.length < 2) continue;
    const quoted = names.map((n) => `"${n}"`);
    const list = `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
    collisions.push(`columns ${list} ${names.length === 2 ? 'both' : 'all'} resolve to the field "${field}"`);
  }
  if (collisions.length === 0) return;
  throw new ValidationError(
    `Field collision on table "${tableName}": ${collisions.join('; ')}. A client addresses one column per field, ` +
      'so reads would fold the colliding columns into one property and a write to that field would reach only ' +
      'one of them. Rename one of the columns, or set `keepColumnNames: true` in turbine.config.ts ' +
      '(`turbine generate --keep-column-names`) so every field is its raw column name.',
  );
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
    const [tablesResult, columnsResult, pkResult, fkResult, uniqueResult, indexResult, checkResult, enumResult] =
      await Promise.all([
        pool.query(SQL_TABLES, [schema]),
        pool.query(SQL_COLUMNS, [schema]),
        pool.query(SQL_PRIMARY_KEYS, [schema]),
        pool.query(SQL_FOREIGN_KEYS, [schema]),
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
        // Under keepColumnNames the field IS the column name, which is why two
        // distinct columns can never collide there (see assertDistinctColumnFields).
        field: options.keepColumnNames ? row.column_name : snakeToCamel(row.column_name),
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
        // GENERATED ALWAYS AS (expr) STORED, computed by the database, never
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
        // schema must NOT get this schema's `::"enum"` cast, search_path would
        // resolve the cast to the wrong type (see enumTypeForColumn). Omitting
        // it for the common case keeps generated metadata byte-identical.
        ...(typeof row.udt_schema === 'string' && row.udt_schema !== schema && row.udt_schema !== 'pg_catalog'
          ? { pgTypeSchema: row.udt_schema }
          : {}),
      };

      if (!columnsByTable.has(tableName)) columnsByTable.set(tableName, []);
      columnsByTable.get(tableName)!.push(col);
    }

    // Every consumer below keys the table by FIELD (columnMap, the relation
    // derivation's shadow check, the generated interface), so the field set
    // must be sound before any of them runs. THE one place the rule is applied
    // to a live catalog; generate.ts re-asserts it for schemas built elsewhere.
    for (const [tableName, cols] of columnsByTable) assertDistinctColumnFields(tableName, cols);

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
    // Group FK rows by constraint OID, NOT by constraint name: Postgres only
    // requires a name to be unique per table, so two tables in one schema may
    // both own a `shared_fk` and grouping by name merges them into one entry
    // (see SQL_FOREIGN_KEYS). Rows arrive ordered by (oid, ordinal), so pushing
    // in arrival order preserves the column pairing the query established.
    //
    // A reference to a table in ANOTHER schema is skipped DELIBERATELY, and by
    // its schema rather than by tableSet membership. Generated metadata keys
    // tables by bare name and emits unqualified SQL, so a relation to
    // `other.things` has no table to point at; worse, checking only
    // `tableSet.has(target_table)` would bind it to a same-named table in THIS
    // schema and generate a relation that reads the wrong table entirely.
    // Skipped references are reported once, so they are visible rather than
    // silently absent.
    const fkGroups = new Map<string, ForeignKeyEntry>();
    const crossSchemaRefs: string[] = [];
    for (const row of fkResult.rows) {
      if (!tableSet.has(row.source_table)) continue;
      if (row.target_schema !== schema) {
        crossSchemaRefs.push(
          `${row.source_table}.${row.source_column} -> ${row.target_schema}.${row.target_table}.${row.target_column}`,
        );
        continue;
      }
      if (!tableSet.has(row.target_table)) continue;
      const key = row.constraint_oid as string;
      if (!fkGroups.has(key)) {
        fkGroups.set(key, {
          sourceTable: row.source_table,
          sourceColumns: [],
          targetTable: row.target_table,
          targetColumns: [],
          constraintName: row.constraint_name,
        });
      }
      const entry = fkGroups.get(key)!;
      entry.sourceColumns.push(row.source_column);
      entry.targetColumns.push(row.target_column);
    }
    const foreignKeys = Array.from(fkGroups.values());

    if (crossSchemaRefs.length > 0) {
      console.warn(
        `[turbine] Skipped ${crossSchemaRefs.length} foreign key(s) referencing a table outside schema "${schema}": ` +
          `${crossSchemaRefs.join(', ')}. Generated clients address tables by bare name within one schema, so no ` +
          `relation is emitted for these. Introspect the other schema separately, or add the target table to this one.`,
      );
    }

    // Referential actions (ON DELETE / ON UPDATE) per constraint. Keyed
    // "<table>::<constraint>" because the NAME alone is not unique (the same
    // collision SQL_FOREIGN_KEYS documents); buildRelationsFromForeignKeys
    // prefers that key and falls back to the bare name for callers that build
    // the map from a code-first schema, where names are synthesized per table.
    const fkActions = new Map<string, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>();
    for (const row of fkResult.rows) {
      fkActions.set(`${row.source_table}::${row.constraint_name}`, {
        onDelete: pgConfActionToReferential(row.confdeltype),
        onUpdate: pgConfActionToReferential(row.confupdtype),
      });
    }

    // ----- Build relations from foreign keys -----
    // Delegated to the shared catalog derivation, which `turbine mcp` also
    // calls. Relation names are derived per-FK-column when several FKs point at
    // the same target, every name is collision-checked against the table's
    // scalar column fields so a relation can never shadow a column (which
    // generated unsound types and made both surfaces unusable), a UNIQUE FK
    // flips the reverse side to `hasOne`, and pure junction tables additionally
    // get a `manyToMany` on each side. See deriveCatalogRelations for why the
    // whole pipeline is one function rather than a call site per surface.
    const relationsByTable = deriveCatalogRelations({
      tableNames,
      foreignKeys,
      pkByTable,
      columnsByTable,
      uniqueByTable,
      indexesByTable,
      enums,
      fkActions,
      legacyToManyUniques: options.legacyToManyUniques,
    });

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
 * The index-definition key-list SCANNER, and the only one that reads an
 * `indexdef` character by character.
 *
 * `pg_indexes.indexdef` always reads `CREATE [UNIQUE] INDEX name ON tbl USING
 * method (key, ...) [INCLUDE (col, ...)] [WITH (...)] [TABLESPACE ts]
 * [WHERE predicate]`. This returns the raw entries of the KEY LIST only, one per
 * top-level comma, expression entries included and verbatim.
 *
 * ## THREE indexdef parsers coexist in this repo. This is one of them.
 *
 * An earlier version of this comment said there was exactly one. There is not,
 * and pretending otherwise is how hand-synced parsers drift here, so each of the
 * three names the other two:
 *
 *   1. THIS scanner (with {@link indexKeyColumn} / {@link parseIndexColumns}).
 *      Safe for any `indexdef` pg emits, including expression keys, quoted
 *      identifiers holding commas or parens, string literals, INCLUDE lists and
 *      partial predicates. Feeds generated metadata, compound-unique selectors,
 *      the FK-index advisor and m2m detection, plus `cli/mcp.ts`.
 *   2. {@link parsePlainUniqueIndexColumns}, below. Still the old
 *      `USING \w+ \(([^)]*)\)` regex. It answers a NARROWER question ("is this a
 *      plain, whole-table unique index over these exact columns") and returns
 *      `null` on everything it cannot read, so its regex's known weaknesses cost
 *      a missed hasOne flip rather than a wrong answer.
 *   3. `describeIndexDefMismatch` in `schema-sql.ts`. Same old regex, same
 *      fail-toward-a-warning posture.
 *
 * Unifying them is a separate change with its own risk: (2) and (3) both treat
 * "cannot read this" as a safe refusal, and swapping in a parser that reads MORE
 * turns some of those refusals into answers. Until then, prefer this scanner for
 * any new caller, and do not assume a fix here reaches the other two.
 *
 * ## Why the mcp.ts copy is gone
 *
 * `cli/mcp.ts` kept its own weaker copy of this, and the two drifted: on
 * `USING btree (id) INCLUDE (email)` the copy answered `['id) INCLUDE (email']`
 * while this one answered `['id']`. Those columns feed `deriveCatalogRelations`,
 * which decides hasOne-vs-hasMany and auto-m2m, so a UNIQUE index with INCLUDE
 * columns was visible to `turbine generate` and invisible to the MCP server, and
 * the two surfaces disagreed about which relations the schema has. The
 * duplication is also what produced the predicate leak that
 * {@link parseIndexColumns}'s own history records. So mcp.ts consumes this
 * function now, and the split between the two callers is expressed as the two
 * exports below rather than as two implementations.
 *
 * ## Why a scanner rather than a regex
 *
 * The regex this replaces (`/USING\s+\w+\s*\(([^)]*)\)/`) stops at the FIRST
 * `)`, which is the wrong paren for any expression key (`lower(email)`), and a
 * plain `.split(',')` cuts `coalesce(a, b)` in half. The scan tracks paren depth
 * and single-quoted literals, so a comma or a paren inside an expression or a
 * literal is not a boundary.
 *
 * The anchor requires `USING <method> (`, which no predicate, INCLUDE list, WITH
 * list or literal can spell, so the key list is found positionally rather than
 * by hoping the first paren is the right one. When the anchor is absent (not a
 * shape pg emits) it falls back to the first parenthesised group, matching the
 * previous behaviour.
 */
export function parseIndexKeyEntries(indexdef: string): string[] {
  const anchor = /USING\s+\w+\s*\(/i.exec(indexdef);
  const open = anchor ? anchor.index + anchor[0].length : indexdef.indexOf('(') + 1;
  if (open === 0) return [];

  const entries: string[] = [];
  let depth = 0;
  let inLiteral = false;
  let inQuotedIdent = false;
  let start = open;
  for (let i = open; i < indexdef.length; i++) {
    const char = indexdef[i];
    // A doubled quote inside a literal (or a quoted identifier) toggles twice,
    // which is the same as not toggling, so pg's `''` / `""` escapes need no
    // special case. Identifier quoting is tracked as well as literal quoting: a
    // column named `it's` renders as `"it's"`, and reading its apostrophe as the
    // start of a literal swallows the rest of the definition.
    if (char === "'" && !inQuotedIdent) {
      inLiteral = !inLiteral;
      continue;
    }
    if (char === '"' && !inLiteral) {
      inQuotedIdent = !inQuotedIdent;
      continue;
    }
    if (inLiteral || inQuotedIdent) continue;
    if (char === '(') depth++;
    else if (char === ')') {
      if (depth === 0) {
        entries.push(indexdef.slice(start, i));
        return entries.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      }
      depth--;
    } else if (char === ',' && depth === 0) {
      entries.push(indexdef.slice(start, i));
      start = i + 1;
    }
  }
  // Unterminated key list: the definition does not parse, so it names no
  // columns. Never "all of it" - the one input this cannot read must not be the
  // one it forwards.
  return [];
}

/**
 * The plain COLUMN NAME an index key entry indexes, or `null` when the entry is
 * an expression rather than a column.
 *
 * A key entry is `{ column | (expression) } [COLLATE c] [opclass [(params)]]
 * [ASC|DESC] [NULLS FIRST|LAST]`, so the column is the LEADING token and
 * everything after it is a modifier. Reading it that way is what makes
 * `email COLLATE "C" text_pattern_ops` resolve to `email`; the previous
 * suffix-stripping (`ASC`/`DESC` only) returned the whole entry verbatim as a
 * "column name", which matches no real column.
 *
 * SCOPE OF THAT FIX, stated exactly because an earlier version of this comment
 * overstated it: what changes is what {@link parseIndexColumns} reports, and so
 * what its consumers see. Those are the generated `metadata.ts` index lists,
 * the compound-unique selector derivation, the FK-index advisor's leading-column
 * check, and m2m junction detection. Relation CARDINALITY is NOT among them: the
 * `hasMany`/`hasOne` flip reads {@link parsePlainUniqueIndexColumns}, a separate
 * parser this does not feed, and that one still answers `null` for an opclass'd
 * UNIQUE index exactly as it did before.
 *
 * The name is de-quoted (Postgres quotes non-lowercase identifiers such as a
 * Prisma implicit m2m junction's `"A"` / `"B"`) so it matches the unquoted names
 * carried elsewhere in the metadata.
 */
export function indexKeyColumn(entry: string): string | null {
  const trimmed = entry.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('"')) {
    // A quoted identifier ends at the first unpaired `"`; anything after it is a
    // modifier. `""` inside is one escaped quote and does not end it.
    let i = 1;
    let name = '';
    while (i < trimmed.length) {
      if (trimmed[i] === '"') {
        if (trimmed[i + 1] === '"') {
          name += '"';
          i += 2;
          continue;
        }
        // The SAME trailing-modifier rule the unquoted branch applies below,
        // and for the same reason: what follows the name must be whitespace
        // (a COLLATE clause, an opclass, ASC/DESC/NULLS) or nothing. Returning
        // at the closing quote without asking read `"MyFunc"(email)` as a
        // column named `MyFunc`, synthesizing a column that does not exist and
        // handing it to generated metadata, the FK-advisor lead-column check,
        // compound-unique selectors and m2m junction detection alike.
        const rest = trimmed.slice(i + 1);
        if (rest.length > 0 && !/^\s/.test(rest)) return null;
        return name;
      }
      name += trimmed[i];
      i++;
    }
    return null; // unterminated quote: not a name this can vouch for
  }
  // An expression key is anything that is not a bare leading identifier, which
  // includes every parenthesised or operator-bearing form pg renders.
  // Non-ASCII letters are identifier characters to Postgres and are left
  // unquoted in `indexdef`, so the class has to admit them or a `café` column
  // reads as an expression and disappears.
  const leading = /^[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_$\u0080-\uFFFF]*/.exec(trimmed);
  if (!leading) return null;
  const rest = trimmed.slice(leading[0].length);
  // The rest must be modifiers (whitespace-separated words / quoted collation /
  // opclass parameters), never a continuation of an expression: `lower(email)`
  // has a leading identifier too, and it is not a column.
  if (rest.length > 0 && !/^\s/.test(rest)) return null;
  return leading[0];
}

/**
 * Parse the indexed COLUMN names out of a `pg_indexes.indexdef` string.
 *
 * Expression keys are dropped, conservatively: a functional index does not name
 * a plain column, and generated metadata has nowhere to say "there was a key
 * here that is not a column". {@link parseIndexKeyEntries} is the variant that
 * keeps them, for the one caller (`cli/mcp.ts`) that reports their presence.
 */
export function parseIndexColumns(indexdef: string): string[] {
  return parseIndexKeyEntries(indexdef)
    .map(indexKeyColumn)
    .filter((column): column is string => column !== null);
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
// Relation derivation from foreign keys (pure, unit-testable without a DB)
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
 * `_id` (snake_case) or `Id` (camelCase column names, common in Prisma-ported
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
 * `describeIndexDefMismatch` (schema-sql.ts) does, so a partial index's
 * `WHERE (...)` parentheses are never mistaken for the column list. Every column
 * token must be a bare or double-quoted identifier; anything else (a function
 * call, an operator expression) fails the check and yields `null`.
 *
 * ## Parser 2 of 3, and what it is safe for
 *
 * This is the second of the three indexdef parsers catalogued on
 * {@link parseIndexKeyEntries}; the third is `describeIndexDefMismatch` in
 * schema-sql.ts. It is still the `USING \w+ \(([^)]*)\)` regex that the scanner
 * up there was written to replace, so it inherits that regex's weaknesses: it
 * stops at the FIRST `)`, and it splits on every comma. On an expression key
 * (`lower(email)`), on a quoted identifier containing a comma or a paren, and on
 * an opclass'd key (`email text_pattern_ops`) it therefore reads a token that is
 * not a bare identifier and returns `null`.
 *
 * That is SAFE HERE and only here, because `null` is this function's "I cannot
 * vouch for this index" answer and its single consumer
 * ({@link detectUniqueForeignKeySets}) treats it as "this index does not prove
 * uniqueness". The cost of every misread is a relation left as `hasMany` that
 * could have been `hasOne`, never a uniqueness claim the database does not back.
 * Do NOT reuse it anywhere a wrong-but-plausible column list would be acted on;
 * use the scanner for that.
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
 * applies a deterministic `Rel` / `Rel2` / `Rel3`… suffix and warns, a
 * colliding name would otherwise shadow a column field and generate types
 * that fail `tsc --strict` (TS2430/TS2322).
 */
function resolveRelationNameCollision(candidate: string, taken: Set<string>, table: string, source: string): string {
  if (!taken.has(candidate)) return candidate;
  let name = `${candidate}Rel`;
  for (let i = 2; taken.has(name); i++) name = `${candidate}Rel${i}`;
  console.warn(
    `[turbine] Relation name "${candidate}" on table "${table}" (from ${source}) collides with an existing column or relation, using "${name}" instead.`,
  );
  return name;
}

/**
 * Build the belongsTo/hasMany relation maps for every table from its foreign
 * keys. Naming rules (LEGACY-FIRST, a relation name that previously worked at
 * runtime must never change out from under a regenerating app):
 *
 *   1. First compute the historical derivation exactly as it shipped before
 *      the collision guard existed: belongsTo strips a case-SENSITIVE `_id`
 *      suffix (`snakeToCamel(col.replace(/_id$/, ''))` when several FKs point
 *      at the same target, else the singularized target table), and hasMany is
 *      `snakeToCamel(`${source}_by_${strippedColumn}`)` (else the source
 *      table). If that legacy name is free, KEEP IT, even when it looks odd
 *      (`blogPostsByAuthorId`, `postsBy_Author`): those names were collision-
 *      free and worked, so regenerating must not rename them.
 *   2. If the legacy name collides ONLY with a scalar column whose tsType is
 *      `unknown` (json/jsonb), keep it anyway with a warning: the shadow is
 *      historical, ran fine at runtime, and compiled (`unknown` absorbs the
 *      relation payload; generate.ts's typeSafeRelations omits the relation
 *      from the type layer).
 *   3. On a genuine collision (concrete-typed column shadow, or a previously
 *      assigned relation), fall back to the modern derivation, the `_id`/`Id`
 *      case-insensitive strip of {@link relationNameFromColumn} plus the
 *      `By`-composed reverse name, which fixes the camelCase-FK shadowing
 *      shapes that were actually BROKEN before (relation name === scalar FK
 *      field → unusable types).
 *   4. Last resort: deterministic `Rel`/`Rel2` suffix + warning.
 *
 * @param columnFieldsByTable camelCase column *fields* per table, used to
 *   guarantee relations never shadow concrete-typed scalar columns.
 * @param unknownTypedFieldsByTable subset of the column fields whose tsType is
 *   `unknown` (json/jsonb), legacy shadows of these are preserved (rule 2).
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
  // Relation names actually assigned so far (as opposed to column fields) -
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

  /** Legacy-first name resolution, see the naming rules in the JSDoc above. */
  const resolveName = (legacy: string, modern: string | null, table: string, source: string): string => {
    const taken = takenFor(table);
    if (!taken.has(legacy)) return legacy;
    // Historical json/jsonb shadow: previously worked at runtime AND compiled
    // (tsType `unknown` absorbs the relation payload). Keep the name, warn -
    // typeSafeRelations() keeps the generated type layer sound.
    if (!assignedFor(table).has(legacy) && unknownTypedFieldsByTable?.get(table)?.has(legacy)) {
      console.warn(
        `[turbine] Relation "${legacy}" on table "${table}" (from ${source}) shadows the json/jsonb column ` +
          `"${legacy}", keeping the historical name for runtime compatibility; the relation is omitted from ` +
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

    // Composite FKs have no single column to derive from, fall back to the
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
    // A constraint NAME is only unique per table in Postgres, so the catalog
    // introspector keys this map "<table>::<constraint>". Callers that
    // synthesize names from a code-first schema key it by bare name, so both
    // spellings resolve.
    //
    // The bare-name fallback is LIVE, not defensive: `schemaDefToMetadata` keys
    // its map by the synthesized `<table>_<column>_fkey` alone, so the qualified
    // lookup always misses there and this second lookup is the ONLY thing that
    // carries a `defineSchema` relation's onDelete/onUpdate into the metadata.
    // Deleting it would silently drop referential actions from every code-first
    // schema (verified: a `references: { onDelete: 'cascade' }` resolves through
    // this branch and through no other). It is safe for that producer precisely
    // because the name it synthesizes already embeds the source table, so a bare
    // hit cannot belong to a different table's constraint. A future producer
    // emitting TABLE-AGNOSTIC constraint names would break that property and
    // could mis-attribute one table's ON DELETE to another's relation; such a
    // producer must key the map "<table>::<constraint>" like the catalog reader.
    const actions =
      fkActions?.get(`${fk.sourceTable}::${fk.constraintName}`) ?? fkActions?.get(fk.constraintName) ?? undefined;
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
    // FKs whose source is this table, both must be single-column.
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
          // Historical json/jsonb shadow, worked at runtime, compiled fine.
          console.warn(
            `[turbine] Relation "${relName}" on table "${sourceTbl}" (junction ${tableName}) shadows the ` +
              `json/jsonb column "${relName}", keeping the historical name for runtime compatibility; ` +
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

/** Everything the catalog relation derivation reads. See {@link deriveCatalogRelations}. */
export interface CatalogRelationInputs {
  /** The introspected table set, post include/exclude filtering. */
  tableNames: string[];
  /** FK rows already grouped per constraint (one entry per declared constraint). */
  foreignKeys: ForeignKeyEntry[];
  /** Primary-key columns per table. */
  pkByTable: Map<string, string[]>;
  /** Column metadata per table (only name/field/tsType/pgType are read). */
  columnsByTable: Map<string, Pick<ColumnMetadata, 'name' | 'field' | 'tsType' | 'pgType'>[]>;
  /** UNIQUE-constraint column sets per table. */
  uniqueByTable: Map<string, string[][]>;
  /** Indexes per table, `definition` must be the raw `pg_indexes.indexdef`. */
  indexesByTable: Map<string, IndexMetadata[]>;
  /** Enum types in the schema, so an enum column is not mistaken for a json shadow. */
  enums: Record<string, string[]>;
  /** Referential actions keyed "<table>::<constraint>". Optional. */
  fkActions?: Map<string, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>;
  /** Opt out of the unique-FK → `hasOne` flip (F2), see {@link IntrospectOptions.legacyToManyUniques}. */
  legacyToManyUniques?: boolean;
}

/**
 * One-stop relation derivation for every surface that reads a live PostgreSQL
 * CATALOG: `turbine generate` (via {@link introspectPostgresCatalog}) and the
 * MCP server, which introspects for itself because it cannot assume generated
 * metadata exists.
 *
 * THE REASON THIS IS ONE FUNCTION and not two call sites: the pipeline it drives
 * is `buildRelationsFromForeignKeys` (five parameters, two optional) plus
 * `addAutoManyToManyRelations` (eight parameters, three optional), and every
 * optional one CHANGES THE ANSWER while omitting it stays silently type-correct.
 * Hand-mirroring them drifted exactly that way: MCP passed four arguments and so
 * never received `uniqueSetsByTable`, which meant a UNIQUE foreign key produced
 * `users.profile` (hasOne) under `turbine generate` and `users.profiles`
 * (hasMany) under `turbine mcp`, against the same database. An MCP client
 * following its own schema tool then queried `with: { profiles: true }` and got
 * `TURBINE_E005 Unknown relation`. MCP also omitted `uniqueIndexColsByTable`,
 * losing every auto-m2m relation through a Prisma-style PK-less junction. Adding
 * an argument here now reaches both surfaces or neither.
 *
 * The engine introspectors (SQLite / MySQL / MSSQL) keep their own
 * {@link deriveEngineRelations} because they deliberately do NOT do the
 * unique-FK → `hasOne` flip.
 */
export function deriveCatalogRelations(inputs: CatalogRelationInputs): Map<string, Record<string, RelationDef>> {
  const { tableNames, foreignKeys, pkByTable, columnsByTable, uniqueByTable, indexesByTable, enums } = inputs;

  const columnFieldsByTable = new Map<string, Set<string>>();
  const unknownTypedFieldsByTable = new Map<string, Set<string>>();
  for (const [tbl, cols] of columnsByTable) {
    columnFieldsByTable.set(tbl, new Set(cols.map((c) => c.field)));
    // Enum-typed columns also report tsType 'unknown' here, but generate.ts
    // gives them a concrete union type, so a shadow of one is type-broken and
    // must NOT be preserved as a historical json/jsonb shadow.
    unknownTypedFieldsByTable.set(
      tbl,
      new Set(cols.filter((c) => isUnknownTsType(c.tsType) && !Object.hasOwn(enums, c.pgType)).map((c) => c.field)),
    );
  }

  // F2: unless the caller opts out, detect child FK column sets that a unique
  // constraint / plain unique index exactly covers, so the reverse relation is
  // emitted as a one-to-one (`hasOne`) instead of `hasMany`.
  const uniqueSetsByTable = inputs.legacyToManyUniques
    ? undefined
    : detectUniqueForeignKeySets(pkByTable, uniqueByTable, indexesByTable);

  const relationsByTable = buildRelationsFromForeignKeys(
    foreignKeys,
    columnFieldsByTable,
    inputs.fkActions,
    unknownTypedFieldsByTable,
    uniqueSetsByTable,
  );

  // Prisma's implicit m2m junctions have no primary key (just a two-column
  // UNIQUE index over the FK columns), so pass the introspected two-column
  // unique indexes as the fallback junction-key source.
  //
  // `idx.columns` is the key list with EXPRESSION keys already dropped, so its
  // length is not the index's arity and cannot stand in for it. On
  // `UNIQUE (a, lower(b), c)` it reads `['a', 'c']`, which looks exactly like a
  // two-column junction key while the pair `(a, c)` is not unique at all, only
  // `(a, lower(b), c)` is. A manyToMany derived from it returns DUPLICATE ROWS.
  // So the arity is re-read from the raw definition and the two must agree:
  // an index with any expression key is not a junction key this can vouch for.
  // A PARTIAL unique index is refused for the same reason and is the MAINSTREAM
  // shape of it: `UNIQUE (post_id, tag_id) WHERE deleted_at IS NULL` on a
  // soft-deleted junction guarantees uniqueness only over the rows matching the
  // predicate, so the pair can repeat across the whole table and the derived
  // manyToMany returns duplicate rows. `IndexMetadata.partial` already exists and
  // already documents this, and the hasOne path already honours it (see
  // parsePlainUniqueIndexColumns, which refuses a definition carrying a WHERE).
  // This filter was simply the one place that did not read it, so the two
  // cardinality paths disagreed about whether the same index proved uniqueness.
  const uniqueIndexColsByTable = new Map<string, string[][]>();
  for (const [tbl, idxs] of indexesByTable) {
    const twoColUniques = idxs
      .filter(
        (idx) =>
          idx.unique && !idx.partial && idx.columns.length === 2 && parseIndexKeyEntries(idx.definition).length === 2,
      )
      .map((idx) => idx.columns);
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
  return relationsByTable;
}

/**
 * One-stop relation derivation for the engine introspectors (SQLite / MySQL /
 * MSSQL): filters the FK list to the introspected table set, seeds the
 * taken-name / json-shadow maps from the engine's column metadata, and runs
 * the SAME `buildRelationsFromForeignKeys` + `addAutoManyToManyRelations`
 * pipeline as the Postgres introspector, so every engine derives identical
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

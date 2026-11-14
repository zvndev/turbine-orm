/** Portable catalog policy extracted verbatim from introspect.ts. No driver imports. */
import { ValidationError } from './errors.js';
import { consoleLogger, logTo, type TurbineLogger } from './logger.js';
import {
  type ColumnMetadata,
  type ReferentialAction,
  type RelationDef,
  type SchemaMetadata,
  singularize,
  snakeToCamel,
  type TableMetadata,
} from './schema.js';

// ---------------------------------------------------------------------------
// Default table exclusions
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
export function applyTableFilters(
  names: string[],
  options: TableFilterOptions = {},
  configureDefaults?: (defaults: Set<string>) => void,
): string[] {
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
  configureDefaults?.(defaults);
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
 * Characters that must not reach a terminal or a log verbatim: everything in
 * {@link UNSAFE_CATALOG_CHARS} (an ESC starts an ANSI sequence, a carriage
 * return overwrites the line), plus the bidirectional controls that reorder how
 * a name is displayed without changing what it is.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing control characters is this pattern's purpose
const TERMINAL_UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A catalog name made safe to PRINT. Every diagnostic that quotes a table,
 * column, enum, relation or constraint name goes through this, because Postgres
 * lets anyone with CREATE privilege pick any characters for those, and an
 * unescaped name in an error message is a way to write escape sequences to the
 * developer's terminal. Control and bidi characters become visible escapes
 * (`\n`, `\u001b`); everything else, including non-ASCII letters, is untouched.
 */
export function printableCatalogName(name: string): string {
  return name.replace(TERMINAL_UNSAFE_CHARS, (ch) => {
    if (ch === '\n') return '\\n';
    if (ch === '\r') return '\\r';
    if (ch === '\t') return '\\t';
    return `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/**
 * An empty record for something keyed by catalog names. Prototype-less on
 * purpose: a plain `{}` turns a table named `__proto__` into a prototype
 * assignment (the table silently disappears), and makes `enums['constructor']`
 * truthy before any enum was ever added.
 */
export function nullRecord<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/**
 * Refuse one catalog identifier carrying a character from
 * {@link UNSAFE_CATALOG_CHARS}. `subject` names the object in the error.
 */
export function assertSafeCatalogIdentifier(name: string, subject: string): void {
  const match = UNSAFE_CATALOG_CHARS.exec(name);
  if (match === null) return;
  const code = match[0].charCodeAt(0).toString(16).padStart(4, '0');
  throw new ValidationError(
    `Refusing to introspect ${printableCatalogName(subject)}: its name contains the control character U+${code.toUpperCase()} ` +
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
  const tables: Record<string, TableMetadata> = Object.assign(nullRecord<TableMetadata>(), schema.tables);

  for (const [table, mapping] of Object.entries(renames)) {
    const meta = Object.hasOwn(tables, table) ? tables[table] : undefined;
    if (!meta) {
      throw new ValidationError(
        `relationNames: unknown table "${printableCatalogName(table)}". Known tables: ${Object.keys(tables).map(printableCatalogName).join(', ')}.`,
      );
    }
    const relations: Record<string, RelationDef> = Object.assign(nullRecord<RelationDef>(), meta.relations);
    const columnFields = new Set(Object.values(meta.columnMap));

    for (const [from, to] of Object.entries(mapping)) {
      if (!Object.hasOwn(relations, from)) {
        throw new ValidationError(
          `relationNames: table "${printableCatalogName(table)}" has no relation "${printableCatalogName(from)}". ` +
            `Derived relations: ${Object.keys(relations).map(printableCatalogName).join(', ') || '(none)'}.`,
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
    const quoted = names.map((n) => `"${printableCatalogName(n)}"`);
    const list = `${quoted.slice(0, -1).join(', ')} and ${quoted[quoted.length - 1]}`;
    collisions.push(
      `columns ${list} ${names.length === 2 ? 'both' : 'all'} resolve to the field "${printableCatalogName(field)}"`,
    );
  }
  if (collisions.length === 0) return;
  throw new ValidationError(
    `Field collision on table "${printableCatalogName(tableName)}": ${collisions.join('; ')}. A client addresses one column per field, ` +
      'so reads would fold the colliding columns into one property and a write to that field would reach only ' +
      'one of them. Rename one of the columns, or set `keepColumnNames: true` in turbine.config.ts ' +
      '(`turbine generate --keep-column-names`) so every field is its raw column name.',
  );
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
// Unique-foreign-key detection for one-to-one relations
// ---------------------------------------------------------------------------

/** True when two column lists cover the same set (order-insensitive, no dupes). */
function columnSetsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const bs = new Set(b);
  return a.every((c) => bs.has(c));
}

/**
 * Resolve a derived relation name against the names already taken on the
 * table (scalar column fields + previously assigned relations). On collision,
 * applies a deterministic `Rel` / `Rel2` / `Rel3`… suffix and warns, a
 * colliding name would otherwise shadow a column field and generate types
 * that fail `tsc --strict` (TS2430/TS2322).
 */
function resolveRelationNameCollision(
  candidate: string,
  taken: Set<string>,
  table: string,
  source: string,
  logger: TurbineLogger,
): string {
  if (!taken.has(candidate)) return candidate;
  let name = `${candidate}Rel`;
  for (let i = 2; taken.has(name); i++) name = `${candidate}Rel${i}`;
  logTo(
    logger,
    'warn',
    printableCatalogName(
      `Relation name "${candidate}" on table "${table}" (from ${source}) collides with an existing column or relation, using "${name}" instead.`,
    ),
    { code: 'introspect-relation-renamed', table, relation: name, wanted: candidate },
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
 * @param uniqueSetsByTable when provided, the child-table column sets that
 *   guarantee at-most-one row (PK + unique constraints + plain unique indexes,
 *   from {@link detectUniqueForeignKeySets}). A reverse relation whose FK column
 *   set EXACTLY matches one of the child's unique sets is emitted as `hasOne`
 *   (to-one) instead of `hasMany`, and named with the SINGULAR of the child
 *   table (falling back to the legacy plural name on collision).
 *   {@link deriveRelations} passes a function instead, deciding each foreign
 *   key on its own (on most engines a unique key alone is not enough: the key
 *   must also compare the way the join does, which depends on the parent column
 *   too). Omit it to keep every reverse relation `hasMany`.
 */
export function buildRelationsFromForeignKeys(
  foreignKeys: ForeignKeyEntry[],
  columnFieldsByTable: Map<string, Set<string>>,
  fkActions?: Map<string, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>,
  unknownTypedFieldsByTable?: Map<string, Set<string>>,
  uniqueSetsByTable?: Map<string, string[][]> | ((fk: ForeignKeyEntry) => boolean),
  logger: TurbineLogger = consoleLogger,
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
    // A relation named like a json/jsonb column keeps that name: it works at
    // runtime and compiles (the column's `unknown` type absorbs the relation
    // payload). Keep it and warn; typeSafeRelations() keeps the generated types
    // sound.
    if (!assignedFor(table).has(legacy) && unknownTypedFieldsByTable?.get(table)?.has(legacy)) {
      logTo(
        logger,
        'warn',
        printableCatalogName(
          `Relation "${legacy}" on table "${table}" (from ${source}) shadows the json/jsonb column ` +
            `"${legacy}", keeping the historical name for runtime compatibility; the relation is omitted from ` +
            `the generated types. Rename the column to expose it.`,
        ),
        { code: 'introspect-relation-shadows-json', table, relation: legacy },
      );
      return legacy;
    }
    if (modern !== null && modern !== legacy && !taken.has(modern)) return modern;
    return resolveRelationNameCollision(modern ?? legacy, taken, table, source, logger);
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

    if (!relationsByTable.has(fk.sourceTable)) relationsByTable.set(fk.sourceTable, nullRecord<RelationDef>());
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
    // unique index, then it is a one-to-one, emitted as `hasOne` and
    // named with the SINGULAR of the child table.
    const isUniqueFk =
      typeof uniqueSetsByTable === 'function'
        ? uniqueSetsByTable(fk)
        : (uniqueSetsByTable?.get(fk.sourceTable) ?? []).some((set) => columnSetsEqual(set, fk.sourceColumns));

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

    if (!relationsByTable.has(fk.targetTable)) relationsByTable.set(fk.targetTable, nullRecord<RelationDef>());
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
  logger: TurbineLogger = consoleLogger,
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
      if (!relationsByTable.has(sourceTbl)) relationsByTable.set(sourceTbl, nullRecord<RelationDef>());
      const existing = relationsByTable.get(sourceTbl)!;
      // Additive-only: never clobber an existing relation name.
      if (Object.hasOwn(existing, relName)) return;
      const columnFields = columnFieldsByTable?.get(sourceTbl);
      if (columnFields?.has(relName)) {
        if (unknownTypedFieldsByTable?.get(sourceTbl)?.has(relName)) {
          // Same json/jsonb shadow as above: keep the name and warn.
          logTo(
            logger,
            'warn',
            printableCatalogName(
              `Relation "${relName}" on table "${sourceTbl}" (junction ${tableName}) shadows the ` +
                `json/jsonb column "${relName}", keeping the historical name for runtime compatibility; ` +
                `the relation is omitted from the generated types.`,
            ),
            { code: 'introspect-relation-shadows-json', table: sourceTbl, relation: relName },
          );
        } else {
          const taken = new Set([...columnFields, ...Object.keys(existing)]);
          relName = resolveRelationNameCollision(relName, taken, sourceTbl, `junction ${tableName}`, logger);
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
 * The constraint name PostgreSQL gives a foreign key nobody named:
 * `<table>_<column>[_<column>...]_fkey`, truncated the way PostgreSQL truncates
 * an identifier to 63 bytes (the longer of the two parts first), with a counter
 * after `fkey` while the name is in `taken`.
 *
 * A relation name reads the constraint name in exactly one shape, a COMPOSITE
 * foreign key that shares its target with another foreign key from the same
 * table. Engines disagree about what an unnamed constraint is called (MySQL
 * `orders_ibfk_1`, SQL Server `FK__orders__tenan__1A2B3C4D` with a random
 * suffix, SQLite nothing at all), so an engine introspector passes this name for
 * a constraint the user did not name, and that shape derives the same relation
 * names as on PostgreSQL (and, on SQL Server, the same names on every database).
 * Pass one `taken` set per introspection so two synthesized names cannot collide.
 */
export function defaultForeignKeyConstraintName(table: string, columns: string[], taken?: Set<string>): string {
  const PG_NAME_BYTES = 63;
  const bytesOf = (s: string): number => {
    let n = 0;
    for (const ch of s) {
      const code = ch.codePointAt(0)!;
      n += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    }
    return n;
  };
  const clip = (s: string, bytes: number): string => {
    let out = '';
    for (const ch of s) {
      if (bytesOf(out + ch) > bytes) break;
      out += ch;
    }
    return out;
  };
  // ChooseForeignKeyConstraintNameAddition: columns joined by `_`, stopping
  // once the addition reaches NAMEDATALEN.
  let addition = '';
  for (const column of columns) {
    if (addition.length > 0) addition += '_';
    addition += column;
    if (bytesOf(addition) >= PG_NAME_BYTES + 1) break;
  }
  // makeObjectName + ChooseConstraintName.
  for (let pass = 0; ; pass++) {
    const label = pass === 0 ? 'fkey' : `fkey${pass}`;
    let tableBytes = bytesOf(table);
    let additionBytes = bytesOf(addition);
    const available = PG_NAME_BYTES - (label.length + 2);
    while (tableBytes + additionBytes > available) {
      if (tableBytes > additionBytes) tableBytes--;
      else additionBytes--;
    }
    const name = `${clip(table, tableBytes)}_${clip(addition, additionBytes)}_${label}`;
    if (!taken?.has(name)) {
      taken?.add(name);
      return name;
    }
  }
}

/**
 * A catalog's ON DELETE / ON UPDATE rule (`CASCADE`, `SET NULL`, SQL Server's
 * `NO_ACTION`, ...) as a {@link ReferentialAction}. Anything else is
 * `no action`, the SQL default.
 */
export function referentialActionFromCatalog(rule: unknown): ReferentialAction {
  const action = typeof rule === 'string' ? rule.trim().toLowerCase().replace(/_/g, ' ') : '';
  return action === 'cascade' || action === 'restrict' || action === 'set null' || action === 'set default'
    ? action
    : 'no action';
}

/** Everything {@link deriveRelations} reads: one engine's catalog facts. */
export interface RelationCatalogFacts {
  /** The introspected table set, after include / exclude filtering. */
  tableNames: string[];
  /** One entry per foreign-key constraint. One whose source or target is not in `tableNames` is ignored. */
  foreignKeys: ForeignKeyEntry[];
  /** Primary-key columns per table. */
  pkByTable: Map<string, string[]>;
  /** Column metadata per table (only name / field / tsType / pgType are read). */
  columnsByTable: Map<string, Pick<ColumnMetadata, 'name' | 'field' | 'tsType' | 'pgType'>[]>;
  /** Enum types, so an enum column (tsType `unknown` here) is not mistaken for a json/jsonb shadow. */
  enums?: Record<string, readonly string[]>;
  /**
   * Per table, every column set that holds at most one row under the engine's
   * own rules: the primary key, UNIQUE constraints and plain, non-partial
   * UNIQUE indexes. A foreign key whose columns are exactly one of its child
   * table's sets makes the reverse relation to-one.
   */
  uniqueKeysByTable?: Map<string, string[][]>;
  /**
   * Whether the engine compares a foreign key's child and parent columns the
   * way the child's unique key compares them (same type, affinity, collation).
   * When it does not, two children the key keeps apart can match one parent,
   * so the key proves nothing for THAT foreign key. Decided per foreign key: a
   * second foreign key over the same columns that fails it does not change the
   * first one's answer. Absent: always.
   */
  sameKeyComparison?: (fk: ForeignKeyEntry) => boolean;
  /** Two-column UNIQUE keys that stand in for a missing primary key on a junction table. */
  junctionKeysByTable?: Map<string, string[][]>;
  /** Referential actions keyed `<table>::<constraint>` (or the bare constraint name). */
  fkActions?: Map<string, { onDelete: ReferentialAction; onUpdate: ReferentialAction }>;
  /**
   * `tableNames` and `foreignKeys` are already in PostgreSQL's catalog order
   * (source table, then constraint name, as the server orders `name`), so they
   * are taken as given and not sorted again. The PostgreSQL catalog reader sets
   * it, which keeps its output exactly what its own catalog order gives.
   */
  inCatalogOrder?: boolean;
  /** Keep every reverse relation `hasMany` under its plural name, the output before the to-one rule. */
  legacyToManyUniques?: boolean;
  /** Where relation-naming notes go. Defaults to the console logger. */
  logger?: TurbineLogger;
}

/**
 * PostgreSQL's order for `name`, which compares bytes: for UTF-8 that is code
 * point order. JavaScript's `<` compares UTF-16 code units instead, which puts a
 * character above U+FFFF (a surrogate pair) BEFORE one in U+E000..U+FFFF, so two
 * differing units at or above U+D800 are compared as the code points they
 * encode.
 */
function compareCatalogNames(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      // Surrogates (U+D800..U+DFFF) move above U+E000..U+FFFF.
      x += x >= 0xe000 ? -0x800 : 0x2000;
      y += y >= 0xe000 ? -0x800 : 0x2000;
    }
    return x - y;
  }
  return a.length - b.length;
}

/**
 * THE relation derivation. Every surface that turns a schema into relations
 * calls it with its own catalog facts: the PostgreSQL introspector and the MCP
 * server (via `deriveCatalogRelations`), the SQLite, MySQL, SQL Server, libSQL
 * and D1 introspectors, and `schemaDefToMetadata` for a `defineSchema` schema.
 * The same schema therefore derives the same relations on every engine:
 * `src/test/relation-derivation-parity.test.ts` creates one schema natively on
 * each and holds them all to PostgreSQL's answer.
 *
 * Two things live here rather than in each caller, because each is where the
 * engines used to drift:
 *
 *   - CARDINALITY IS DECIDED BEFORE NAMING, one foreign key at a time. A to-one
 *     reverse relation is named with the singular of its table
 *     (`users.profile`), so the engines that flipped `hasMany` to `hasOne` after
 *     naming kept the plural (`profiles`) and accepted a different `with` key
 *     than PostgreSQL for the same schema. Each engine states what a unique key
 *     is and how its columns compare
 *     ({@link RelationCatalogFacts.uniqueKeysByTable},
 *     {@link RelationCatalogFacts.sameKeyComparison}) and the decision is made
 *     once, here.
 *   - FOREIGN KEYS ARE TAKEN IN ONE ORDER, source table then constraint name.
 *     The first foreign key to claim a contested name keeps it, and the
 *     catalogs return them in different orders (PostgreSQL by table and
 *     constraint, MySQL by constraint name, SQLite by PRAGMA id).
 */
export function deriveRelations(facts: RelationCatalogFacts): Map<string, Record<string, RelationDef>> {
  const tableSet = new Set(facts.tableNames);
  const foreignKeys = facts.foreignKeys.filter((fk) => tableSet.has(fk.sourceTable) && tableSet.has(fk.targetTable));
  if (!facts.inCatalogOrder) {
    foreignKeys.sort(
      (a, b) =>
        compareCatalogNames(a.sourceTable, b.sourceTable) || compareCatalogNames(a.constraintName, b.constraintName),
    );
  }
  const enums = facts.enums ?? {};

  const columnFieldsByTable = new Map<string, Set<string>>();
  const unknownTypedFieldsByTable = new Map<string, Set<string>>();
  for (const [tbl, cols] of facts.columnsByTable) {
    columnFieldsByTable.set(tbl, new Set(cols.map((c) => c.field)));
    // Enum-typed columns also report tsType 'unknown' here, but generate.ts
    // gives them a concrete union type, so a shadow of one is type-broken and
    // must NOT be preserved as a historical json/jsonb shadow.
    unknownTypedFieldsByTable.set(
      tbl,
      new Set(cols.filter((c) => isUnknownTsType(c.tsType) && !Object.hasOwn(enums, c.pgType)).map((c) => c.field)),
    );
  }

  const { uniqueKeysByTable, sameKeyComparison } = facts;
  const isToOne = facts.legacyToManyUniques
    ? undefined
    : (fk: ForeignKeyEntry) =>
        (uniqueKeysByTable?.get(fk.sourceTable) ?? []).some((key) => columnSetsEqual(key, fk.sourceColumns)) &&
        (sameKeyComparison === undefined || sameKeyComparison(fk));

  const logger = facts.logger ?? consoleLogger;
  const relationsByTable = buildRelationsFromForeignKeys(
    foreignKeys,
    columnFieldsByTable,
    facts.fkActions,
    unknownTypedFieldsByTable,
    isToOne,
    logger,
  );
  addAutoManyToManyRelations(
    facts.inCatalogOrder ? facts.tableNames : [...facts.tableNames].sort(compareCatalogNames),
    foreignKeys,
    facts.pkByTable,
    new Map(Array.from(facts.columnsByTable, ([tbl, cols]) => [tbl, cols.map((c) => c.name)])),
    relationsByTable,
    columnFieldsByTable,
    unknownTypedFieldsByTable,
    facts.junctionKeysByTable,
    logger,
  );
  return relationsByTable;
}

/** SQLite's declared-type affinity rules, in their required precedence order. */
function sqliteComparisonAffinity(declared: string, strict: boolean): string {
  const type = declared.toUpperCase();
  // STRICT ANY preserves storage classes instead of applying NUMERIC affinity.
  if (strict && type === 'ANY') return 'blob';
  if (type.includes('INT')) return 'integer';
  if (/CHAR|CLOB|TEXT/.test(type)) return 'text';
  if (type === '' || type.includes('BLOB')) return 'blob';
  if (/REAL|FLOA|DOUB/.test(type)) return 'real';
  return 'numeric';
}

/**
 * SQLite's {@link RelationCatalogFacts.sameKeyComparison}, shared by every
 * SQLite introspector (node:sqlite, better-sqlite3, libSQL, D1) so they cannot
 * disagree. A child's unique key proves a to-one only when the foreign key
 * compares the way the join does:
 *
 * - The same comparison affinity on both sides. A TEXT unique FK can store both
 *   '1' and '01', and both match the INTEGER parent 1 after affinity is applied,
 *   so index uniqueness alone cannot justify a to-one.
 * - No collation that could make two distinct child values match one parent.
 *   Column collations are absent from the catalog, so the test reads the DDL
 *   and refuses on any `COLLATE` it finds. The child's unique keys (the
 *   introspector's `uniqueKeysByTable`) already leave out every key of a table
 *   or index that mentions one. On the parent side a key that is the rowid
 *   alias needs no such check: it holds only integers, which compare as numbers
 *   whatever the collation. Any other parent key is refused when the parent's
 *   DDL mentions `COLLATE`, because a `NOCASE` parent key lets the child values
 *   'a' and 'A' both reference the parent 'a'.
 */
export function sqliteKeyComparison(
  columnsByTable: Map<string, ColumnMetadata[]>,
  tableDefinitions: Map<string, string>,
  tableFlags: Map<string, { strict: number }>,
): (fk: ForeignKeyEntry) => boolean {
  return (fk) => {
    const child = columnsByTable.get(fk.sourceTable);
    const parent = columnsByTable.get(fk.targetTable);
    const parentColumn = (name: string | undefined) => parent?.find((c) => c.name === name);
    const rowidParent = fk.targetColumns.length === 1 && parentColumn(fk.targetColumns[0])?.isGenerated === true;
    return (
      (rowidParent || !/\bCOLLATE\b/i.test(tableDefinitions.get(fk.targetTable) ?? '')) &&
      fk.sourceColumns.length === fk.targetColumns.length &&
      fk.sourceColumns.every((name, i) => {
        const from = child?.find((c) => c.name === name);
        const to = parentColumn(fk.targetColumns[i]);
        return (
          from !== undefined &&
          to !== undefined &&
          sqliteComparisonAffinity(from.pgType, tableFlags.get(fk.sourceTable)?.strict === 1) ===
            sqliteComparisonAffinity(to.pgType, tableFlags.get(fk.targetTable)?.strict === 1)
        );
      })
    );
  };
}

/**
 * Code-first column tags for `turbine generate`.
 *
 * `pii`, `updatedAt`, `maxLength` and `tsType` exist only in the `defineSchema()`
 * file: the database has no column for them, so a client generated from
 * introspection alone returns PII by default, never stamps `updatedAt`, and
 * types a `jsonb` column as `unknown`. `generate` reads the schema file and
 * overlays its tags onto the introspected schema with the two functions here.
 *
 * Lives under `cli/` because only the CLI uses it. `schemaDefToMetadata` (the
 * library path) shares the tag list through `declaredTagsOf`.
 */

import { ValidationError } from '../errors.js';
import { printableCatalogName } from '../introspect.js';
import { closestName } from '../query/utils.js';
import { camelToSnake, type SchemaMetadata } from '../schema.js';
import type { SchemaDef } from '../schema-builder.js';
import { type CodeFirstColumnTags, declaredTagsOf } from '../schema-metadata.js';

/** Declared tags per table (database name), per column (database name). */
export type CodeFirstTagMap = Map<string, Map<string, CodeFirstColumnTags>>;
/**
 * Collect the code-first-only tags a {@link SchemaDef} declares, keyed by the
 * database table and column they land on (the same `camelToSnake(field)` rule
 * {@link schemaDefToMetadata} uses). Tables and columns that declare no tag are
 * absent from the result.
 *
 * Introspection can not see these flags, because the database has no column for
 * them. `turbine generate` overlays them onto the introspected schema with
 * {@link applyCodeFirstColumnTags}.
 */
export function extractCodeFirstColumnTags(def: SchemaDef): CodeFirstTagMap {
  const out: CodeFirstTagMap = new Map();
  for (const tableDef of Object.values(def.tables)) {
    for (const [field, config] of Object.entries(tableDef.columns)) {
      const tags = declaredTagsOf(config);
      if (Object.keys(tags).length === 0) continue;
      let columns = out.get(tableDef.name);
      if (!columns) {
        columns = new Map();
        out.set(tableDef.name, columns);
      }
      columns.set(camelToSnake(field), tags);
    }
  }
  return out;
}

/** A tag the database has no column for, so only the schema file can supply it. */
function isCodeFirstOnly(tags: CodeFirstColumnTags): boolean {
  return tags.pii === true || tags.updatedAt === true;
}

/** What {@link applyCodeFirstColumnTags} changed. */
export interface AppliedColumnTags {
  /** Tables that received at least one tag. */
  tables: number;
  pii: number;
  updatedAt: number;
  maxLength: number;
  /**
   * Declared `tsType`s, as generator `columnTypes` entries
   * (`'<table>.<column>'` by database name). Returned rather than written onto
   * the schema so they go through the generator's own key and type-text
   * validation, the same as a `columnTypes` entry in the config file.
   */
  columnTypes: Record<string, string>;
}

/**
 * Overlay declared tags onto an introspected schema, in place, matching tables
 * and columns by their database names.
 *
 * `pii` and `updatedAt` are set wherever declared. `maxLength` only fills a gap:
 * the live column's own length wins when introspection read one.
 *
 * A `pii` or `updatedAt` tag that names a table or column the database does not
 * have is an error, never a skip: a typo or an un-pushed schema would otherwise
 * generate a client that silently returns the column it was tagged to hide.
 * Every problem is reported at once. `maxLength` is also in the DDL, so a
 * missing table or column only costs that fill-in. `inScope` lets the caller say
 * that a missing table was deliberately left out of the client (an `exclude`
 * filter), which is not an error either.
 */
export function applyCodeFirstColumnTags(
  schema: SchemaMetadata,
  tags: CodeFirstTagMap,
  options: { source?: string; inScope?: (table: string) => boolean } = {},
): AppliedColumnTags {
  const applied: AppliedColumnTags = { tables: 0, pii: 0, updatedAt: 0, maxLength: 0, columnTypes: {} };
  const problems: string[] = [];

  for (const [tableName, columns] of tags) {
    const shown = printableCatalogName(tableName);
    if (!Object.hasOwn(schema.tables, tableName)) {
      if (options.inScope && !options.inScope(tableName)) continue;
      if (![...columns.values()].some(isCodeFirstOnly)) continue;
      const near = closestName(tableName, Object.keys(schema.tables));
      problems.push(
        `table "${shown}" is not in the database${near ? ` (did you mean "${printableCatalogName(near)}"?)` : ''}`,
      );
      continue;
    }
    const table = schema.tables[tableName]!;
    let touched = false;
    for (const [columnName, declared] of columns) {
      const column = table.columns.find((c) => c.name === columnName);
      if (!column) {
        if (!isCodeFirstOnly(declared)) continue;
        const near = closestName(
          columnName,
          table.columns.map((c) => c.name),
        );
        problems.push(
          `column "${printableCatalogName(columnName)}" on table "${shown}" is not in the database` +
            `${near ? ` (did you mean "${printableCatalogName(near)}"?)` : ''}`,
        );
        continue;
      }
      if (declared.pii) {
        column.pii = true;
        applied.pii++;
        touched = true;
      }
      if (declared.updatedAt) {
        column.updatedAt = true;
        applied.updatedAt++;
        touched = true;
      }
      if (declared.maxLength !== undefined && column.maxLength === undefined) {
        column.maxLength = declared.maxLength;
        applied.maxLength++;
        touched = true;
      }
      if (declared.tsType !== undefined) {
        applied.columnTypes[`${tableName}.${columnName}`] = declared.tsType;
        touched = true;
      }
    }
    if (touched) applied.tables++;
  }

  if (problems.length > 0) {
    const from = options.source ? ` in ${options.source}` : '';
    throw new ValidationError(
      `Cannot apply the column tags declared${from}: ${problems.join('; ')}. ` +
        'Run `turbine push` so the database has them, or fix the name in the schema file. ' +
        'Generating without the tags would return the columns they mark as PII.',
    );
  }
  return applied;
}

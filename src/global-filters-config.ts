/**
 * turbine-orm, `globalFilters` checked when the client is constructed
 *
 * A global filter is a tenancy or soft-delete boundary, so a filter that
 * silently applies to nothing is the worst way for it to fail: a key naming no
 * table (a typo, a renamed table), or a key the query builder does not look
 * up. The builder looks filters up by TABLE name, while the config docs key
 * them by client ACCESSOR (`blogPosts` for `blog_posts`).
 *
 * {@link normalizeGlobalFilters} maps each key to its table name, refuses a key
 * that names no table and a static filter whose keys name no column or
 * relation, and returns the map the query builder reads. Function filters are
 * kept as they are: what they return is checked per query by the resolver,
 * which also refuses a filter that resolves to `undefined`.
 */

import { ValidationError } from './errors.js';
import { isPlainRecord, setOwn } from './query/filters.js';
import type { GlobalFilters } from './query/index.js';
import { resolveColumnName, resolveRelation } from './query/utils.js';
import { type CombinatorKey, combinatorBranches, foldWhereFor } from './query/where-compile.js';
import type { SchemaMetadata, TableMetadata } from './schema.js';

/** The accessor a table gets on the client (`blog_posts` -> `blogPosts`). The one place it is derived. */
export function tableAccessorName(tableName: string): string {
  return tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Whether a `skipGlobalFilters: [UNSAFE, ...names]` list names `table`, by its
 * table name or by its client accessor, the two spellings `globalFilters` keys
 * accept. With `tables` (the schema's table map), an accessor spelling that is
 * itself another table's name refers to that other table only.
 */
export function skipListNamesTable(
  names: readonly string[],
  table: string,
  tables?: Readonly<Record<string, unknown>>,
): boolean {
  if (names.includes(table)) return true;
  const accessor = tableAccessorName(table);
  if (accessor === table || (tables !== undefined && Object.hasOwn(tables, accessor))) return false;
  return names.includes(accessor);
}

/**
 * Refuse a `skipGlobalFilters` list entry that names no table, by table name or
 * accessor: a misspelled entry skips nothing, so the filter the caller meant to
 * lift stays on and the query quietly returns fewer rows than intended.
 */
export function assertSkipListNames(names: readonly string[], tables: Readonly<Record<string, unknown>>): void {
  for (const name of names) {
    if (Object.hasOwn(tables, name)) continue;
    if (Object.keys(tables).some((table) => skipListNamesTable([name], table, tables))) continue;
    const candidates = Object.keys(tables).flatMap((table) => [table, tableAccessorName(table)]);
    const hint = nearestName(name, candidates);
    throw new ValidationError(
      `skipGlobalFilters names "${name}", which is not a table in the schema${hint ? `. Did you mean "${hint}"?` : '.'} ` +
        'An entry that names no table skips nothing. List tables by table name (`blog_posts`) or client accessor (`blogPosts`).',
    );
  }
}

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);

/** How a non-plain-object config value reads in an error message. */
function describeShape(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  const name = (Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null)?.constructor?.name;
  return `an instance of ${name || 'a class'}, not a plain object`;
}

/**
 * Validate `globalFilters` against the schema and key it by table name.
 * Throws `ValidationError` (E003) naming the bad key and the closest valid one.
 */
export function normalizeGlobalFilters(
  filters: GlobalFilters | undefined | null,
  schema: SchemaMetadata,
): GlobalFilters | undefined {
  if (filters === undefined || filters === null) return undefined;
  if (!isPlainRecord(filters)) {
    throw new ValidationError(
      `globalFilters must be an object keyed by table, for example \`{ posts: { deletedAt: null } }\`; received ${describeShape(
        filters,
      )}.`,
    );
  }
  const byAccessor = new Map<string, string>();
  for (const table of Object.keys(schema.tables)) {
    const accessor = tableAccessorName(table);
    if (accessor !== table && !Object.hasOwn(schema.tables, accessor)) byAccessor.set(accessor, table);
  }
  const normalized: GlobalFilters = {};
  const keyFor = new Map<string, string>();
  for (const key of Object.keys(filters)) {
    const table = Object.hasOwn(schema.tables, key) ? key : byAccessor.get(key);
    if (table === undefined) {
      const hint = nearestName(key, [...Object.keys(schema.tables), ...byAccessor.keys()]);
      throw new ValidationError(
        `globalFilters: "${key}" names no table in the schema${hint ? `. Did you mean "${hint}"?` : '.'} ` +
          'A filter under a name that matches no table is never applied, so the rows it was meant to hide ' +
          'would be returned. Key each filter by table name (`blog_posts`) or by its client accessor (`blogPosts`).',
      );
    }
    const earlier = keyFor.get(table);
    if (earlier !== undefined) {
      throw new ValidationError(
        `globalFilters: "${earlier}" and "${key}" both name table "${table}". Keep one filter per table, ` +
          'combining the conditions with `AND: [...]` if both are needed.',
      );
    }
    keyFor.set(table, key);
    const value = filters[key];
    if (typeof value === 'function' || value === null) {
      setOwn(normalized as Record<string, unknown>, table, value);
      continue;
    }
    if (!isPlainRecord(value)) {
      throw new ValidationError(
        `globalFilters["${key}"] must be a where object or a function returning one; received ${describeShape(
          value,
        )}. An undefined filter usually means the value it was built from was not available yet: pass a ` +
          'function, which is evaluated per query, for anything that depends on the current request.',
      );
    }
    assertFilterNamesExist(value, schema.tables[table]!, key, '');
    // The whole clause shape at every depth (relation quantifier values among
    // it), checked here rather than at the first query that reads this table.
    try {
      foldWhereFor(schema.tables, table, value);
    } catch (err) {
      if (err instanceof ValidationError) throw new ValidationError(`globalFilters["${key}"]: ${err.message}`);
      throw err;
    }
    setOwn(normalized as Record<string, unknown>, table, value);
  }
  return normalized;
}

/**
 * Every top-level key of a static filter (and of its AND/OR/NOT branches) must
 * be a column or relation, and every combinator must have a shape the query
 * compiler reads: one it cannot read would apply no condition, so a tenant
 * filter written as `OR: { ... }` would match every row.
 */
function assertFilterNamesExist(filter: Record<string, unknown>, meta: TableMetadata, key: string, path: string): void {
  for (const field of Object.keys(filter)) {
    const at = path ? `${path}.${field}` : field;
    if (COMBINATORS.has(field)) {
      const branch = filter[field];
      try {
        combinatorBranches(field as CombinatorKey, branch, meta.name);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        const reason = err.message.replace(/^\[TURBINE_E\d+\] /, '').replace(/ \(https:\/\/\S+\)$/, '');
        throw new ValidationError(`globalFilters["${key}"]: "${at}" is refused. ${reason}`);
      }
      if (Array.isArray(branch)) {
        branch.forEach((b, i) => {
          if (b !== undefined) assertFilterNamesExist(b as Record<string, unknown>, meta, key, `${at}[${i}]`);
        });
      } else if (branch !== undefined) {
        assertFilterNamesExist(branch as Record<string, unknown>, meta, key, at);
      }
      continue;
    }
    if (resolveColumnName(meta, field) !== undefined) continue;
    if (resolveRelation(meta.relations ?? {}, field) !== undefined) continue;
    const candidates = [...Object.keys(meta.columnMap), ...Object.keys(meta.relations ?? {})];
    const hint = nearestName(field, candidates);
    throw new ValidationError(
      `globalFilters["${key}"]: "${at}" is not a column or relation of "${meta.name}"` +
        `${hint ? `. Did you mean "${hint}"?` : '.'} The filter would fail on every query against this table.`,
    );
  }
}

/** Levenshtein distance between two strings. */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/**
 * The candidate a mistyped name most likely meant, by edit distance with case
 * and underscores ignored (so `tenent_id` and `tenentID` both reach
 * `tenantId`), ties broken by the raw spelling. Not substring containment: a
 * short name inside the typo (`id` in `tenentId`) is not what was meant.
 */
function nearestName(input: string, candidates: readonly string[]): string | null {
  const fold = (name: string) => name.toLowerCase().replace(/_/g, '');
  const wanted = fold(input);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const folded = fold(candidate);
    const distance = editDistance(wanted, folded);
    if (distance > Math.max(2, Math.floor(Math.max(wanted.length, folded.length) / 3))) continue;
    const score = distance * 1000 + editDistance(input, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

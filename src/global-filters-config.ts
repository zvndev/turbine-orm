/**
 * turbine-orm, `globalFilters` checked when the client is constructed
 *
 * A global filter is a tenancy or soft-delete boundary, so a filter that
 * silently applies to nothing is the worst way for it to fail. Two ways to get
 * one used to be accepted without a word:
 *
 *   - a key naming no table (a typo, or a table that was renamed);
 *   - the client ACCESSOR spelling of a multi-word table (`blogPosts` for
 *     `blog_posts`), which the config docs show, while the query builder looked
 *     filters up by table name only.
 *
 * {@link normalizeGlobalFilters} maps each key to its table name, refuses a key
 * that names no table and a static filter whose keys name no column or
 * relation, and returns the map the query builder reads. Function filters are
 * kept as they are: what they return is checked per query by the resolver,
 * which also refuses a filter that resolves to `undefined`.
 */

import { ValidationError } from './errors.js';
import type { GlobalFilters } from './query/index.js';
import { resolveColumnName, resolveRelation } from './query/utils.js';
import type { SchemaMetadata, TableMetadata } from './schema.js';

/** The accessor a table gets on the client (`blog_posts` -> `blogPosts`), as the constructors derive it. */
function accessorFor(tableName: string): string {
  return tableName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

const COMBINATORS = new Set(['AND', 'OR', 'NOT']);

/**
 * Validate `globalFilters` against the schema and key it by table name.
 * Throws `ValidationError` (E003) naming the bad key and the closest valid one.
 */
export function normalizeGlobalFilters(
  filters: GlobalFilters | undefined | null,
  schema: SchemaMetadata,
): GlobalFilters | undefined {
  if (filters === undefined || filters === null) return undefined;
  if (typeof filters !== 'object' || Array.isArray(filters)) {
    throw new ValidationError(
      `globalFilters must be an object keyed by table, for example \`{ posts: { deletedAt: null } }\`; received ${
        Array.isArray(filters) ? 'an array' : typeof filters
      }.`,
    );
  }
  const byAccessor = new Map<string, string>();
  for (const table of Object.keys(schema.tables)) {
    const accessor = accessorFor(table);
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
    const value = (filters as Record<string, unknown>)[key];
    if (typeof value === 'function' || value === null) {
      normalized[table] = value as GlobalFilters[string];
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError(
        `globalFilters["${key}"] must be a where object or a function returning one; received ${
          Array.isArray(value) ? 'an array' : value === undefined ? 'undefined' : typeof value
        }. An undefined filter usually means the value it was built from was not available yet: pass a ` +
          'function, which is evaluated per query, for anything that depends on the current request.',
      );
    }
    assertFilterNamesExist(value as Record<string, unknown>, schema.tables[table]!, key, '');
    normalized[table] = value as GlobalFilters[string];
  }
  return normalized;
}

/** Every top-level key of a static filter (and of its AND/OR/NOT branches) must be a column or relation. */
function assertFilterNamesExist(filter: Record<string, unknown>, meta: TableMetadata, key: string, path: string): void {
  for (const field of Object.keys(filter)) {
    const at = path ? `${path}.${field}` : field;
    if (COMBINATORS.has(field)) {
      const branch = filter[field];
      const branches = Array.isArray(branch) ? branch : [branch];
      branches.forEach((b, i) => {
        if (b !== null && typeof b === 'object' && !Array.isArray(b)) {
          assertFilterNamesExist(b as Record<string, unknown>, meta, key, Array.isArray(branch) ? `${at}[${i}]` : at);
        }
      });
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

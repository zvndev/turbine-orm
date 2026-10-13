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
 * relation, and returns the map the query builder reads. Given the client's
 * dialect it also compiles each static filter once, so a value the compiler
 * refuses fails when the client is built rather than on the first query.
 * Function filters are kept as they are: what they return is checked per query
 * by the resolver, which also refuses a filter that resolves to `undefined`.
 */

import type { Dialect } from './dialect.js';
import { UnsupportedFeatureError, ValidationError } from './errors.js';
import type { TurbineLogger } from './logger.js';
import type { PgCompatPool } from './pg-types.js';
import type { QueryInterface } from './query/builder.js';
import {
  findUndefinedPath,
  holdsUndefinedValue,
  isPlainRecord,
  RELATION_FILTER_WRAPPERS,
  setOwn,
} from './query/filters.js';
import type { GlobalFilters } from './query/index.js';
import { resolveColumnName, resolveRelation } from './query/utils.js';
import {
  type CombinatorKey,
  combinatorBranches,
  foldWhereFor,
  MAX_WHERE_DEPTH,
  metadataWhereHost,
  walkWhere,
} from './query/where-compile.js';
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
 * The client options a static filter is compiled with at construction: the
 * ones that decide whether a where clause compiles, and to what.
 */
export interface StaticFilterCompileOptions {
  /**
   * The SQL query builder. Passed in rather than imported: the query modules
   * import this one, so a value import back would be an import cycle.
   */
  QueryInterface: typeof QueryInterface;
  dialect?: Dialect | undefined;
  utcTimestamps?: boolean | undefined;
}

/**
 * Validate `globalFilters` against the schema and key it by table name.
 * Throws `ValidationError` (E003) naming the bad key and the closest valid one.
 *
 * With `compile` (the client passes it for every SQL engine), each static
 * filter is also compiled once with that dialect, so an operand the compiler
 * refuses, a column misspelled inside a relation filter or a feature the
 * engine lacks (E017) fails here and not on the first query.
 */
export function normalizeGlobalFilters(
  filters: GlobalFilters | undefined | null,
  schema: SchemaMetadata,
  compile?: StaticFilterCompileOptions,
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
    assertFilterNamesExist(value, schema.tables, schema.tables[table]!, key, '', 0);
    // The query path refuses a filter holding `undefined` on every query (it
    // may be a tenant id that was not set); a static filter is read once, so
    // say so now, with the fix that applies to a static filter.
    const hole = holdsUndefinedValue(value, 0) ? findUndefinedPath(value, '', 0) : null;
    if (hole !== null) {
      throw new ValidationError(
        `globalFilters["${key}"] has an undefined value at "${hole}". A static filter is read once, when the ` +
          'client is constructed, so a value that was not available then stays undefined, and every query on ' +
          'the table would be refused. Pass a function, which is evaluated per query, for anything that depends ' +
          'on the current request.',
      );
    }
    // The whole clause shape at every depth (relation quantifier values among
    // it), checked here rather than at the first query that reads this table.
    try {
      foldWhereFor(schema.tables, table, value);
    } catch (err) {
      if (err instanceof ValidationError) throw new ValidationError(`globalFilters["${key}"]: ${reasonOf(err)}`);
      throw err;
    }
    setOwn(normalized as Record<string, unknown>, table, value);
  }
  assertNoFilterCycle(normalized, schema, keyFor);
  if (compile !== undefined) assertStaticFiltersCompile(normalized, schema, keyFor, compile);
  return normalized;
}

/** An error's own text, without the code tag and docs link a TurbineError message carries. */
function reasonOf(err: Error): string {
  return err.message.replace(/^\[TURBINE_E\d+\] /, '').replace(/ \(https:\/\/\S+\)$/, '');
}

/** Swallows every line: a construction-time compile is a check, not a query. */
const SILENT_LOGGER: TurbineLogger = Object.freeze({});

/**
 * Compile every static filter with the client's dialect, through the query
 * builder the queries use, so each value is checked by the same code that
 * will bind it. First each table with only its own filter (so an error names
 * the filter that holds it), then each table with every static filter, which
 * also compiles the filters a relation filter reaches. Function filters are
 * never called here: they may read request state that does not exist yet.
 */
function assertStaticFiltersCompile(
  filters: GlobalFilters,
  schema: SchemaMetadata,
  keyFor: Map<string, string>,
  options: StaticFilterCompileOptions,
): void {
  const staticFilters: GlobalFilters = {};
  for (const table of Object.keys(filters)) {
    const filter = filters[table];
    if (isPlainRecord(filter)) setOwn(staticFilters as Record<string, unknown>, table, filter);
  }
  const compileOn = (table: string, applied: GlobalFilters): void => {
    try {
      new options.QueryInterface<object>(null as unknown as PgCompatPool, table, schema, [], {
        dialect: options.dialect,
        utcTimestamps: options.utcTimestamps,
        globalFilters: applied,
        sqlCache: false,
        logger: SILENT_LOGGER,
        diagnostics: { mode: 'production', advice: false },
      }).buildFindMany({});
    } catch (err) {
      throw labelledFilterError(err, keyFor.get(table) ?? table);
    }
  };
  for (const table of Object.keys(staticFilters)) {
    compileOn(table, { [table]: staticFilters[table]! } as GlobalFilters);
  }
  for (const table of Object.keys(staticFilters)) compileOn(table, staticFilters);
}

/** The compiler's refusal, named after the filter it came from, in its own class. */
function labelledFilterError(err: unknown, key: string): unknown {
  if (err instanceof UnsupportedFeatureError) {
    const head = `${err.feature} is unsupported on "${err.dialect}".`;
    const reason = reasonOf(err);
    const hint = reason.startsWith(head) ? reason.slice(head.length).trim() : '';
    return new UnsupportedFeatureError(`globalFilters["${key}"]: ${err.feature}`, err.dialect, hint || undefined);
  }
  if (err instanceof ValidationError) return new ValidationError(`globalFilters["${key}"]: ${reasonOf(err)}`);
  return err;
}

/** One step of a global-filter chain: the filter for `from` reaches `to` through `relation`. */
interface FilterEdge {
  from: string;
  to: string;
  relation: string;
}

/**
 * Refuse static filters that reach their own table through relations, directly
 * (`comments: { parent: { is: {...} } }`) or through another table's filter
 * (`posts: { user: {...} }` beside `users: { posts: {...} }`). A table's
 * filter applies to every row a relation filter reaches, the rows reached from
 * inside another table's filter included, so such filters would apply each
 * other without end. Function filters are not inspected here; the query path
 * applies each table's filter once per chain for them.
 */
function assertNoFilterCycle(filters: GlobalFilters, schema: SchemaMetadata, keyFor: Map<string, string>): void {
  const edges = new Map<string, FilterEdge[]>();
  for (const table of Object.keys(filters)) {
    const filter = filters[table];
    if (!isPlainRecord(filter)) continue;
    const reached: FilterEdge[] = [];
    collectReachedTables(schema, table, table, filter, reached, 0);
    edges.set(table, reached);
  }
  // Depth-first over tables with a static filter; `path[i]` is the table
  // `chain[i]` leaves from, so a step back onto `path[k]` closes the cycle
  // `chain[k..]`.
  const done = new Set<string>();
  const visit = (table: string, chain: FilterEdge[], path: string[]): void => {
    if (done.has(table)) return;
    for (const edge of edges.get(table) ?? []) {
      const k = path.indexOf(edge.to);
      if (k !== -1) throw filterCycleError([...chain.slice(k), edge], keyFor);
      if (edges.has(edge.to)) visit(edge.to, [...chain, edge], [...path, edge.to]);
    }
    done.add(table);
  };
  for (const table of edges.keys()) visit(table, [], [table]);
}

/** Every relation a where on `table` names, at any depth, as edges from `owner`'s filter. */
function collectReachedTables(
  schema: SchemaMetadata,
  owner: string,
  table: string,
  where: Record<string, unknown>,
  out: FilterEdge[],
  depth: number,
): void {
  const meta = Object.hasOwn(schema.tables, table) ? schema.tables[table] : undefined;
  if (!meta || depth > MAX_WHERE_DEPTH) return;
  for (const event of walkWhere(metadataWhereHost(meta), where)) {
    if (event.kind === 'or' || event.kind === 'and') {
      for (const branch of event.conditions) collectReachedTables(schema, owner, table, branch, out, depth + 1);
    } else if (event.kind === 'not') {
      collectReachedTables(schema, owner, table, event.condition, out, depth + 1);
    } else if (event.kind === 'relation') {
      out.push({ from: owner, to: event.relDef.to, relation: `${table}.${event.key}` });
      for (const wrapper of RELATION_FILTER_WRAPPERS) {
        const sub = event.filterObj[wrapper];
        if (isPlainRecord(sub)) collectReachedTables(schema, owner, event.relDef.to, sub, out, depth + 1);
      }
    }
  }
}

function filterCycleError(cycle: readonly FilterEdge[], keyFor: Map<string, string>): ValidationError {
  const steps = cycle.map(
    (edge) => `the filter for "${keyFor.get(edge.from) ?? edge.from}" reaches "${edge.to}" through "${edge.relation}"`,
  );
  return new ValidationError(
    `globalFilters: ${steps.join(', and ')}. A global filter applies to every row a relation filter reaches, ` +
      "including the rows reached from inside another table's filter, so these filters would apply each other " +
      'without end. Remove the relation filter from one of them, or write that condition into the queries that ' +
      'need it.',
  );
}

/**
 * Every key of a static filter (of its AND/OR/NOT branches, and of the where
 * objects its relation filters hold, against the related table) must be a
 * column or relation, and every combinator must have a shape the query
 * compiler reads: one it cannot read would apply no condition, so a tenant
 * filter written as `OR: { ... }` would match every row.
 */
function assertFilterNamesExist(
  filter: Record<string, unknown>,
  tables: Readonly<Record<string, TableMetadata>>,
  meta: TableMetadata,
  key: string,
  path: string,
  depth: number,
): void {
  if (depth > MAX_WHERE_DEPTH) return;
  for (const field of Object.keys(filter)) {
    const at = path ? `${path}.${field}` : field;
    if (COMBINATORS.has(field)) {
      const branch = filter[field];
      try {
        combinatorBranches(field as CombinatorKey, branch, meta.name);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        throw new ValidationError(`globalFilters["${key}"]: "${at}" is refused. ${reasonOf(err)}`);
      }
      if (Array.isArray(branch)) {
        branch.forEach((b, i) => {
          if (b !== undefined) {
            assertFilterNamesExist(b as Record<string, unknown>, tables, meta, key, `${at}[${i}]`, depth + 1);
          }
        });
      } else if (branch !== undefined) {
        assertFilterNamesExist(branch as Record<string, unknown>, tables, meta, key, at, depth + 1);
      }
      continue;
    }
    if (resolveColumnName(meta, field) !== undefined) continue;
    const relation = resolveRelation(meta.relations ?? {}, field);
    if (relation !== undefined) {
      const value = filter[field];
      const target = Object.hasOwn(tables, relation.def.to) ? tables[relation.def.to] : undefined;
      if (target === undefined || !isPlainRecord(value)) continue;
      const wrapped = RELATION_FILTER_WRAPPERS.some((wrapper) => wrapper in value);
      if (!wrapped) {
        // A bare where object on a to-one relation (an implicit `is`).
        assertFilterNamesExist(value, tables, target, key, at, depth + 1);
        continue;
      }
      for (const wrapper of RELATION_FILTER_WRAPPERS) {
        const sub = value[wrapper];
        if (isPlainRecord(sub)) assertFilterNamesExist(sub, tables, target, key, `${at}.${wrapper}`, depth + 1);
      }
      continue;
    }
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

/**
 * turbine-orm CLI: compile a read query WITHOUT executing it.
 *
 * Turbine already separates BUILD from EXECUTE: every `build*()` method on
 * `QueryInterface` returns a {@link DeferredQuery} (`{ sql, params, transform,
 * tag }`) and nothing runs until something calls `execute()`. This module is
 * that seam turned into a tool: hand it schema metadata and a set of `findMany`
 * -shaped args, get back the exact statement the ORM would send, the bound
 * parameter list, and a read of whether the query is a mistake.
 *
 * ZERO DATABASE ACCESS, ENFORCED BY CONSTRUCTION RATHER THAN BY REVIEW.
 * `QueryInterface` takes a pool in its constructor and never touches it on the
 * build path, so this module hands it {@link SEALED_POOL}, whose every method
 * THROWS. That is the whole guarantee: a future build path that grew a query
 * would fail loudly here instead of quietly opening a connection, and the
 * "compiles nothing, runs nothing" claim in the tool description does not
 * depend on anyone re-reading the builder. The caller is responsible for
 * obtaining `SchemaMetadata`; this module reads no catalog of its own.
 *
 * WHAT IT REFUSES TO DO. Read operations only, and that is a property of this
 * module, not of its caller: {@link COMPILE_OPERATIONS} is the closed set, and
 * a name outside it never reaches a builder. A write's SQL text is arguably as
 * harmless to display as a read's, but the TOOL SURFACE is the security
 * boundary on an agent-facing server, and "we also compile deletes, we just
 * don't run them" is an argument, where "there is no write path" is a fact.
 *
 * A COMPILE FAILURE IS AN ANSWER, NOT AN ERROR. `where: { titel: 'x' }` throws
 * `ValidationError` (E003) and `with: { autor: true }` throws `RelationError`
 * (E005); both are exactly what the caller asked to find out, one round trip
 * before the code is written. So a `TurbineError` out of the builder comes back
 * as a successful result carrying the code, the message, the docs URL and the
 * catalog's causes/fixes. Anything that is NOT a TurbineError propagates: it is
 * a bug or a malformed request, and dressing it up as a query verdict would
 * hide it.
 */

import { TurbineError } from '../errors.js';
import { missingIndexForRelation } from '../index-advisor.js';
import type { PgCompatPool } from '../pg-types.js';
import type {
  AggregateArgs,
  CountArgs,
  FindManyArgs,
  FindUniqueArgs,
  GroupByArgs,
  RelationLoadStrategy,
} from '../query/index.js';
import { QueryInterface } from '../query/index.js';
import { ownLookup, resolveRelation } from '../query/utils.js';
import type { RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { explainErrorCode } from './error-catalog.js';
import { PII_GUARD_MAX_DEPTH } from './pii-predicate-guard.js';

/**
 * The read operations this module compiles. A CLOSED set, checked before any
 * builder is reached, which is what keeps the read-only stance a fact rather
 * than a convention: there is no branch here that reaches `buildCreate`,
 * `buildUpdate`, `buildDelete` or `buildUpsert`.
 */
export const COMPILE_OPERATIONS = ['findMany', 'findUnique', 'findFirst', 'count', 'aggregate', 'groupBy'] as const;

export type CompileOperation = (typeof COMPILE_OPERATIONS)[number];

/** True for the two operations whose args are NOT findMany-shaped. */
export function isAggregateShaped(operation: CompileOperation): boolean {
  return operation === 'aggregate' || operation === 'groupBy';
}

/**
 * A pool that refuses every call.
 *
 * `QueryInterface`'s constructor requires one, and the build path never uses
 * it. Passing a sealed object rather than the caller's real pool is what makes
 * "this compiles and does not execute" structurally true: there is no live
 * connection in scope for a statement to escape down, and a future build path
 * that tried to read something would throw a message naming this file rather
 * than silently issuing a query on an agent's behalf.
 */
export const SEALED_POOL: PgCompatPool = {
  query(): never {
    throw new Error('[turbine] compile-query: the compile path must never execute a statement (sealed pool)');
  },
  connect(): never {
    throw new Error('[turbine] compile-query: the compile path must never open a connection (sealed pool)');
  },
  end(): never {
    throw new Error('[turbine] compile-query: the compile path owns no connection to close (sealed pool)');
  },
};

/**
 * Serialized length past which a bound parameter is summarized instead of
 * echoed. A TOKEN budget, not a security boundary: see the params note in
 * {@link compileQueryPlan}.
 */
const PARAM_ECHO_MAX_CHARS = 200;

/** Depth past which the with-clause walk stops describing relations. */
const WITH_WALK_MAX_DEPTH = 12;

/**
 * Query-arg keys that name a column or an ordering over one, in any of the six
 * operations. Used only by the caller's fail-closed check for an unreadable PII
 * tag scan: with no trustworthy tag list, a compile carrying any of these
 * cannot be shown not to name a hidden column.
 *
 * `select` / `omit` / `with` are deliberately absent, matching the guard's own
 * rule: they return values, and this tool returns no values at all.
 */
export const COLUMN_NAMING_ARG_KEYS: readonly string[] = [
  'where',
  'orderBy',
  'cursor',
  'distinct',
  'by',
  'having',
  'distinctOn',
  '_count',
  '_sum',
  '_avg',
  '_min',
  '_max',
];

/**
 * Does this args object carry a key that names a column, AT ANY DEPTH?
 *
 * The depth is the whole point and it was missing until 0.76.0. This is the
 * fail-closed test for the case where the PII tag file could not be read, so
 * "no column-naming arg" is a claim that the query cannot be filtering on a
 * hidden column. A top-level-only check makes that claim falsely:
 * `{ with: { posts: { where: { secretNote: { not: null } } } } }` has no
 * column-naming key at the top level and filters on a column two levels down,
 * and the tool reported it as safe to compile.
 *
 * `with` is not itself a column-naming key (its keys are RELATION names, and
 * `select` / `omit` are excluded on the guard's own rule that they return
 * values, which this tool never does), but the OPTIONS inside a `with` entry
 * are the full findMany surface, so the walk descends through them.
 *
 * It errs toward TRUE: an unrecognized object value is descended into rather
 * than skipped, and the depth cap answers true rather than false. This function
 * only ever gates a refusal, so a false positive costs a caller one message and
 * a false negative is the disclosure it exists to prevent.
 */
export function carriesColumnNamingArg(args: Record<string, unknown>, depth = 0): boolean {
  if (depth > PII_GUARD_MAX_DEPTH) return true;
  for (const [key, value] of Object.entries(args)) {
    if (COLUMN_NAMING_ARG_KEYS.includes(key) && value !== undefined) return true;
    // `select` / `omit` name columns but return them rather than filtering on
    // them, and nothing is returned here; skipping them keeps this aligned with
    // cli/pii-predicate-guard.ts, which makes the same call for the same reason.
    if (key === 'select' || key === 'omit') continue;
    if (value && typeof value === 'object') {
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry && typeof entry === 'object' && carriesColumnNamingArg(entry as Record<string, unknown>, depth + 1)) {
          return true;
        }
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Report shapes
// ---------------------------------------------------------------------------

/** One relation reached by the query's `with` clause. */
export interface CompiledRelation {
  /** Dotted path from the queried table, e.g. `author.org`. */
  path: string;
  name: string;
  type: RelationDef['type'];
  from: string;
  to: string;
  /** 1 for a top-level `with` entry. */
  depth: number;
  /** hasMany / manyToMany return arrays; hasOne / belongsTo return one row or null. */
  returnsArray: boolean;
  /** Per-relation `limit`, when the caller set one. */
  limit: number | null;
  /**
   * The table + column(s) this relation probes per parent row, when the probe
   * has no index to serve it. `null` means indexed, or that the schema carries
   * no index information to judge against (see `schemaHasIndexInfo`).
   */
  unindexedProbe: { table: string; columns: string[]; createSql: string } | null;
}

export interface CompiledAdvice {
  code: string;
  severity: 'warn' | 'info';
  message: string;
}

export interface CompiledQueryError {
  code: string;
  message: string;
  docsUrl: string;
  className?: string;
  whenThrown?: string;
  likelyCauses?: string[];
  howToFix?: string[];
}

export interface CompileQueryInput {
  metadata: SchemaMetadata;
  table: TableMetadata;
  operation: CompileOperation;
  args: Record<string, unknown>;
  /**
   * The relation-load strategy the APPLICATION's client is configured with, so
   * the report can say which plan an unspecified query would take. Defaults to
   * `'auto'`, which is core's own default.
   */
  clientRelationLoadStrategy?: RelationLoadStrategy;
}

export type CompileQueryReport =
  | ({ ok: true } & CompiledQuerySuccess)
  | { ok: false; table: string; operation: CompileOperation; error: CompiledQueryError };

export interface CompiledQuerySuccess {
  table: string;
  operation: CompileOperation;
  sql: string;
  params: unknown[];
  paramCount: number;
  paramsTruncated: boolean;
  paramNote: string;
  preparedStatement: { named: boolean; name: string | null; note: string };
  statements: { compiled: number; atExecution: number | null; note: string };
  plan: {
    relationLoadStrategy: { requested: RelationLoadStrategy | null; effective: RelationLoadStrategy; note: string };
    relationCount: number;
    relationDepth: number;
    relations: CompiledRelation[];
    relationsTruncated: boolean;
    hasWhere: boolean;
    hasOrderBy: boolean;
    bounded: boolean;
    limit: number | null;
    boundedBy: string | null;
    readsEveryRow: boolean;
  };
  advice: CompiledAdvice[];
  note: string;
}

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A where clause that actually constrains something. `{}` compiles to no WHERE. */
function hasRealWhere(args: Record<string, unknown>): boolean {
  const where = args.where;
  if (!isPlainObject(where)) return false;
  return Object.values(where).some((value) => value !== undefined);
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * Compile one read query and describe it. Never touches a database; see the
 * module header for why that is enforced rather than promised.
 */
export function compileQueryPlan(input: CompileQueryInput): CompileQueryReport {
  const { metadata, table, operation, args } = input;
  // THIS OPTIONS LITERAL IS WHAT MAKES `paramNote` TRUE. Every element of
  // `deferred.params` traces back to a value the caller wrote in `args`, and it
  // does so because exactly two core features bind a value the caller did not
  // write: a configured `globalFilters` entry, and `defaultLimit`. Neither is
  // set here. Adding either to this literal turns the echoed parameter list into
  // a disclosure channel for the application's own configuration, so do not,
  // and if a third such feature ever lands, it belongs on this list rather than
  // in the reply.
  const qi = new QueryInterface<Record<string, unknown>>(SEALED_POOL, table.name, metadata, [], {
    // Diagnostics come from this module, not from a console warning fired into
    // the operator's stderr on someone else's behalf.
    warnOnUnlimited: false,
    // The cache is per-QueryInterface and this one is discarded with the reply,
    // so leaving it ON would only ever miss. It stays OFF for the same reason
    // `explain_query` and Studio's builder turn it off: a diagnostic compile
    // must not be able to seed or read a shared template. The prepared-statement
    // NAME is unaffected, `buildCacheEntry` computes it either way, which is
    // what lets the report tell a named shape from an unnamed one.
    sqlCache: false,
    preparedStatements: false,
  });

  let deferred: { sql: string; params: unknown[]; preparedName?: string };
  try {
    deferred = compileOne(qi, operation, args);
  } catch (err) {
    if (err instanceof TurbineError) {
      return { ok: false, table: table.name, operation, error: describeTurbineError(err) };
    }
    throw err;
  }

  const requested = (args.relationLoadStrategy as RelationLoadStrategy | undefined) ?? null;
  const effective = requested ?? input.clientRelationLoadStrategy ?? 'auto';

  const relations: CompiledRelation[] = [];
  let relationsTruncated = false;
  if (isPlainObject(args.with)) {
    relationsTruncated = walkWith(metadata, table, args.with, 1, '', relations);
  }
  const relationDepth = relations.reduce((max, relation) => Math.max(max, relation.depth), 0);

  const params = deferred.params.map(echoParam);
  const paramsTruncated = params.some((entry) => entry.truncated);

  const named = deferred.preparedName !== '' && deferred.preparedName !== undefined;
  const bound = describeBound(operation, args);
  const hasWhere = hasRealWhere(args);

  const success: CompiledQuerySuccess = {
    table: table.name,
    operation,
    sql: deferred.sql,
    params: params.map((entry) => entry.value),
    paramCount: deferred.params.length,
    paramsTruncated,
    paramNote:
      'Every bound value here came from this request. The compiler binds no value of its own on this path: ' +
      'the two core features that would (a configured global filter, and a client-level default limit) are not ' +
      'enabled on the compiling interface. A value whose serialized form exceeds ' +
      `${PARAM_ECHO_MAX_CHARS} characters is summarized rather than echoed, and paramsTruncated says so.`,
    preparedStatement: {
      named,
      name: named ? (deferred.preparedName ?? null) : null,
      note: named
        ? 'This shape executes as a NAMED prepared statement, so the server parses and plans it once per ' +
          'connection and reuses it.'
        : 'This shape executes UNNAMED. Two things give a statement up its server-side name, and this query has ' +
          'at least one: a caller-written AND / OR ARRAY in the where or having clause (whose LENGTH is written ' +
          'into the SQL text, one parenthesized branch per element), or a MULTI-column `distinct` (whose column ' +
          'list is written in one term at a time, so the reachable statement set is the ordered subsets of the ' +
          'table). Either way a list assembled from variable input would mint statements the server never ' +
          'deallocates, so unnamed is the bound. It costs one re-parse per execution and changes no SQL. Use ' +
          '`in: [...]` where you can: it binds one array parameter whatever the list length.',
    },
    statements: describeStatements(operation, effective, relations.length, args),
    plan: {
      relationLoadStrategy: { requested, effective, note: strategyNote(requested, effective, relations.length) },
      relationCount: relations.length,
      relationDepth,
      relations,
      relationsTruncated,
      hasWhere,
      hasOrderBy: args.orderBy !== undefined,
      bounded: bound.bounded,
      limit: bound.limit,
      boundedBy: bound.by,
      readsEveryRow: !hasWhere,
    },
    advice: buildAdvice(operation, relations, relationDepth, named, hasWhere, bound),
    note:
      'This is the statement the ORM would send. It was compiled and NOT executed: no connection was opened and ' +
      'no query ran, so the numbers here are properties of the query, never of your data.',
  };
  return { ok: true, ...success };
}

/** Dispatch to the one builder for this operation. The only place operations map to builders. */
function compileOne(
  qi: QueryInterface<Record<string, unknown>>,
  operation: CompileOperation,
  args: Record<string, unknown>,
): { sql: string; params: unknown[]; preparedName?: string } {
  switch (operation) {
    case 'findMany':
      return qi.buildFindMany(args as FindManyArgs<Record<string, unknown>>);
    // `as unknown as` for the two arg types with a REQUIRED member
    // (`findUnique.where`, `groupBy.by`). Omitting it is a caller error the
    // builder raises as a typed `ValidationError`, which is the answer this tool
    // exists to hand back, so the cast must not pre-empt it with a TypeScript
    // complaint about args that arrived over JSON-RPC anyway.
    case 'findUnique':
      return qi.buildFindUnique(args as unknown as FindUniqueArgs<Record<string, unknown>>);
    case 'findFirst':
      return qi.buildFindFirst(args as FindManyArgs<Record<string, unknown>>);
    case 'count':
      return qi.buildCount(args as CountArgs<Record<string, unknown>>);
    case 'aggregate':
      return qi.buildAggregate(args as AggregateArgs<Record<string, unknown>>);
    case 'groupBy':
      return qi.buildGroupBy(args as unknown as GroupByArgs<Record<string, unknown>>);
  }
}

/**
 * A thrown `TurbineError`, as the caller's answer.
 *
 * The catalog fields are folded in here rather than left to the caller because
 * this is the one place that knows a compile FAILED, and an agent holding
 * `TURBINE_E003` with no idea what E003 means is one tool call away from
 * guessing. Absent when the code is not catalogued (nothing here invents one).
 */
function describeTurbineError(err: TurbineError): CompiledQueryError {
  const explanation = explainErrorCode(err.code);
  return {
    code: err.code,
    message: err.message,
    docsUrl: err.docsUrl,
    className: explanation?.className,
    whenThrown: explanation?.whenThrown,
    likelyCauses: explanation?.likelyCauses,
    howToFix: explanation?.howToFix,
  };
}

/**
 * One bound parameter, sized for an LLM context.
 *
 * A withholding is LABELLED, never expressed by dropping the value: an absent
 * element would renumber the list and make `$3` in the SQL point at the wrong
 * entry, which is a worse answer than a marker.
 */
function echoParam(value: unknown): { value: unknown; truncated: boolean } {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return { value: '(value withheld: not JSON-serializable)', truncated: true };
  }
  if (json === undefined) return { value: null, truncated: false };
  if (json.length <= PARAM_ECHO_MAX_CHARS) return { value, truncated: false };
  if (typeof value === 'string') {
    return { value: `${value.slice(0, PARAM_ECHO_MAX_CHARS)}… (truncated, ${value.length} chars)`, truncated: true };
  }
  return { value: `(value withheld: ${json.length} serialized chars, too large to echo)`, truncated: true };
}

/**
 * Describe every relation the `with` clause reaches.
 *
 * Runs only AFTER a successful compile, so an unknown relation name cannot
 * appear here: the builder has already refused it as E005. Returns true when
 * the walk stopped at {@link WITH_WALK_MAX_DEPTH}, which is reported rather
 * than silently swallowed.
 */
function walkWith(
  metadata: SchemaMetadata,
  table: TableMetadata,
  withClause: Record<string, unknown>,
  depth: number,
  prefix: string,
  out: CompiledRelation[],
): boolean {
  if (depth > WITH_WALK_MAX_DEPTH) return true;
  let truncated = false;
  for (const [key, spec] of Object.entries(withClause)) {
    // `_count` is an inline aggregate, not a relation node: it adds no follow-up
    // statement and has no target table of its own.
    if (key === '_count') continue;
    // Resolve the caller's spelling the way the compiler does: a relation declared
    // `blogPosts` is also reachable as `blog_posts` (resolveRelation, since 0.72). An
    // exact-match lookup here did not fail loudly, it silently dropped the relation from
    // the report, so compile_query under-counted statements and skipped the correlation
    // probes for exactly the relation the caller asked about.
    const resolved = resolveRelation(table.relations, key);
    if (!resolved) continue;
    const relation = resolved.def;
    const path = prefix ? `${prefix}.${relation.name}` : relation.name;
    out.push({
      path,
      name: relation.name,
      type: relation.type,
      from: relation.from,
      to: relation.to,
      depth,
      returnsArray: relation.type === 'hasMany' || relation.type === 'manyToMany',
      limit: isPlainObject(spec) ? positiveInteger(spec.limit) : null,
      unindexedProbe: missingIndexForRelation(metadata, relation),
    });
    const target = ownLookup(metadata.tables, relation.to);
    if (target && isPlainObject(spec) && isPlainObject(spec.with)) {
      truncated = walkWith(metadata, target, spec.with, depth + 1, path, out) || truncated;
    }
  }
  return truncated;
}

/** Whether the query is bounded to a known number of rows, and by what. */
function describeBound(
  operation: CompileOperation,
  args: Record<string, unknown>,
): { bounded: boolean; limit: number | null; by: string | null } {
  if (operation === 'findUnique') return { bounded: true, limit: 1, by: 'findUnique (a unique where matches one row)' };
  if (operation === 'findFirst') return { bounded: true, limit: 1, by: 'findFirst (LIMIT 1)' };
  if (operation === 'count' || operation === 'aggregate') {
    return { bounded: true, limit: 1, by: `${operation} (one result row)` };
  }
  // `by` names the key that actually produced the number, not merely the key
  // that was present: `{ limit: 0, take: 5 }` is bounded BY TAKE.
  const fromLimit = positiveInteger(args.limit);
  if (fromLimit !== null) return { bounded: true, limit: fromLimit, by: 'limit' };
  const fromTake = positiveInteger(args.take);
  if (fromTake !== null) return { bounded: true, limit: fromTake, by: 'take' };
  return { bounded: false, limit: null, by: null };
}

/**
 * How many statements this query costs at execution.
 *
 * Only two of the four strategies have a knowable answer before the query runs,
 * and saying so is the point: `'auto'` decides its split per relation at
 * execute time from index coverage and the parent-row bound, so a number here
 * would be a guess dressed as a fact. It gets a RANGE and a reason instead.
 */
function describeStatements(
  operation: CompileOperation,
  effective: RelationLoadStrategy,
  relationCount: number,
  args: Record<string, unknown>,
): { compiled: number; atExecution: number | null; note: string } {
  if (!isPlainObject(args.with) || relationCount === 0) {
    return { compiled: 1, atExecution: 1, note: 'No relations to load, so this is a single statement.' };
  }
  if (operation === 'count' || operation === 'aggregate' || operation === 'groupBy') {
    return {
      compiled: 1,
      atExecution: 1,
      note: `A ${operation} loads no relations, so a \`with\` clause here does not add statements.`,
    };
  }
  if (effective === 'batched') {
    return {
      compiled: 1,
      atExecution: 1 + relationCount,
      note:
        `The base statement plus one flat follow-up per relation (${relationCount}), stitched client-side. A ` +
        'parent set with more than 32,000 correlation keys is chunked, which adds a statement per chunk.',
    };
  }
  if (effective === 'auto') {
    return {
      compiled: 1,
      atExecution: null,
      note:
        `Between 1 and ${1 + relationCount}. \`auto\` plans the single-statement join and falls back to a batched ` +
        'follow-up PER RELATION whose correlation column is provably unindexed, or whose parent set is unbounded; ' +
        'that decision is made at execute time, so it is not knowable here. The SQL above is the join plan. Pass ' +
        "relationLoadStrategy: 'join' or 'batched' to compile a query whose statement count is fixed.",
    };
  }
  return {
    compiled: 1,
    atExecution: 1,
    note:
      effective === 'flatten'
        ? 'One statement: eligible to-one relations compile to a LEFT JOIN, and any relation that is not eligible ' +
          'silently falls back to a correlated subquery in the same statement.'
        : 'One statement: every relation is a correlated json_agg subquery inside the SELECT above.',
  };
}

function strategyNote(
  requested: RelationLoadStrategy | null,
  effective: RelationLoadStrategy,
  relationCount: number,
): string {
  if (relationCount === 0) return 'This query loads no relations, so the relation-load strategy does not apply.';
  if (requested !== null) return `The query asked for '${requested}', so that is what it compiles to.`;
  return `The query names no strategy, so it inherits the client default ('${effective}').`;
}

/**
 * The part that answers "is this query a mistake" rather than "what SQL is it".
 *
 * Every entry is derived from the compiled query or from schema metadata, never
 * from data, so nothing here can be wrong because a table is empty today.
 */
function buildAdvice(
  operation: CompileOperation,
  relations: CompiledRelation[],
  relationDepth: number,
  named: boolean,
  hasWhere: boolean,
  bound: { bounded: boolean },
): CompiledAdvice[] {
  const advice: CompiledAdvice[] = [];

  if (operation === 'findMany' && !bound.bounded) {
    advice.push({
      code: 'unbounded-read',
      severity: 'warn',
      message: hasWhere
        ? 'This findMany has no `limit`, so it returns every row matching the filter. That set grows with the ' +
          'table; add a `limit` (and an `orderBy` so the page is deterministic).'
        : 'This findMany has neither a `where` nor a `limit`, so it reads and returns the whole table. Add a ' +
          'filter, a limit, or both.',
    });
  }

  // `findUnique` is excluded because the builder refuses one with no predicate
  // (E003), so it can never reach this point without a where.
  if (!hasWhere && operation !== 'findUnique') {
    advice.push({
      code: 'no-filter',
      severity: 'info',
      message:
        'No `where` clause, so the engine has no predicate to use an index for and must consider every row of ' +
        'the table. A LIMIT bounds the rows RETURNED, not the rows scanned.',
    });
  }

  for (const relation of relations) {
    if (!relation.unindexedProbe) continue;
    advice.push({
      code: 'unindexed-relation-probe',
      severity: 'warn',
      message:
        `Relation "${relation.path}" probes ${relation.unindexedProbe.table}(${relation.unindexedProbe.columns.join(', ')}), ` +
        'which no index serves. Under the single-statement join that probe is a full scan re-run once per parent ' +
        `row. Create the index (${relation.unindexedProbe.createSql}) or load this relation batched.`,
    });
  }

  if (relationDepth > 5) {
    advice.push({
      code: 'deep-with',
      severity: 'warn',
      message:
        `The \`with\` clause is ${relationDepth} levels deep. Under the join strategy each level is a correlated ` +
        'subquery the engine re-evaluates once per row of the level above, so the work multiplies down the tree. ' +
        'Split the query, or load it batched.',
    });
  }

  const unlimitedToMany = relations.filter((relation) => relation.returnsArray && relation.limit === null);
  if (unlimitedToMany.length > 0) {
    advice.push({
      code: 'unbounded-relation',
      severity: 'info',
      message:
        `To-many relation(s) ${unlimitedToMany.map((relation) => relation.path).join(', ')} carry no per-relation ` +
        '`limit`, so every child row of every parent is materialized into the result. Set a `limit` on the ' +
        'relation if you only need the first few.',
    });
  }

  if (!named) {
    advice.push({
      code: 'unnamed-prepared-statement',
      severity: 'info',
      message:
        'This shape executes as an UNNAMED prepared statement, because a caller-written AND / OR array or a ' +
        'multi-column `distinct` writes its own LENGTH into the SQL text. That is deliberate and bounds server ' +
        'memory; the cost is one re-parse per execution. Prefer `in: [...]` for a variable-length list.',
    });
  }

  return advice;
}

// ---------------------------------------------------------------------------
// Aggregate-shaped column names, for the caller's PII guard
// ---------------------------------------------------------------------------

/**
 * Every string that could be a column name anywhere in an `aggregate` /
 * `groupBy` args object, EXCLUDING `where` (which the shared PII predicate
 * guard walks properly).
 *
 * DELIBERATELY BLUNTER THAN THE SHARED WALKER, and blunt in the fail-closed
 * direction. The aggregate arg surface names columns in positions the where /
 * orderBy walker was never built for: `by` names them as ARRAY ELEMENTS,
 * `_min` / `_max` / `_sum` / `_avg` as KEYS one level under an aggregate block,
 * `having` as keys under both, and a JSON-path group key names one inside a
 * `{ field, path }` object. Teaching the shared walker each of those shapes
 * means a second place that has to stay in step with the aggregate compiler,
 * which is the exact failure mode `cli/pii-predicate-guard.ts` exists to end.
 *
 * So this harvests EVERY string in key or value position and hands the lot to
 * the caller's column resolver. A string that is not a column resolves to
 * nothing and is ignored; a string that IS a hidden column is refused wherever
 * it appears. The cost is a false refusal on a schema whose hidden column is
 * named `desc` or `_all`; the benefit is that a new aggregate arg shape is
 * covered the day it ships, with no edit here.
 *
 * `where` is excluded because the shared walker already covers it with the
 * relation-aware precision this cannot have.
 */
export function collectAggregateColumnNames(args: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > PII_GUARD_MAX_DEPTH) {
      throw new RangeError(
        `[turbine] compile-query: aggregate args are nested more than ${PII_GUARD_MAX_DEPTH} levels deep`,
      );
    }
    if (typeof value === 'string') {
      names.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (!isPlainObject(value)) return;
    for (const [key, member] of Object.entries(value)) {
      names.add(key);
      visit(member, depth + 1);
    }
  };
  for (const [key, value] of Object.entries(args)) {
    if (key === 'where') continue;
    visit(value, 1);
  }
  return [...names];
}

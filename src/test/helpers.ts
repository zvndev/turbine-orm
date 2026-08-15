/**
 * Shared test helpers for build-only (no DB) tests.
 *
 * Provides mock schema builders so each test file only defines
 * the table layout it cares about.
 */

import { after, before, it } from 'node:test';
import { QueryInterface, type QueryInterfaceOptions } from '../query/index.js';
import {
  type ColumnMetadata,
  pgArrayType,
  type RelationDef,
  type SchemaMetadata,
  type TableMetadata,
} from '../schema.js';

/** Test runners returned by {@link skipGate}. */
export interface GatedRunners {
  it: typeof it;
  before: typeof before;
  after: typeof after;
}

/**
 * The engine tokens `TURBINE_REQUIRE_ENGINE` accepts, each mapped to the pattern
 * that identifies THAT engine's availability gate in a `skipGate` reason string.
 *
 * Matching on the reason (rather than on an extra `skipGate` argument) is what
 * keeps this to one file: every call site already names its precondition in
 * prose, and the prose already contains the env var. Adding a parameter would
 * mean editing ~60 test files and would leave a new gate un-covered by default,
 * which is the failure mode being closed here.
 *
 * It also means a REWORDED reason silently disarms the guard, which is why
 * `scripts/check-skip-gate-reasons.ts` reads this table and fails the build on
 * any `skipGate` reason in src/test/** that neither matches a pattern here nor
 * appears on that script's explicit "not an engine gate" allowlist. Exported for
 * exactly that consumer: the check must run against the SAME patterns
 * {@link skipGate} enforces, never a transcription of them.
 *
 * The patterns are deliberately narrow, because a job requires ONE engine while
 * running the whole suite: the mysql job runs with DATABASE_URL empty, so its
 * Postgres gates must still be free to skip.
 *
 * `powdb` covers TWO shapes, because the embedded addon has no env var and its
 * gates say two different things. "no prebuilt binary" is "the addon does not
 * load here", and `@zvndev/powdb-embedded >= <version>` is "it loads but is
 * older than this feature". Both must fire in the powdb CI job: devDependencies
 * pin the addon, so on the job's Linux-glibc-x64 runner a version gate that
 * skips means the pin is wrong or the package resolved to something else, not
 * that the feature is legitimately unavailable. Matching only the first shape
 * left four real gates (nested projections, entity links, link paths, the
 * datetime fix) skipping under a green job. The networked POWDB_URL suite says
 * neither and still skips, since CI runs no PowDB server.
 */
export const ENGINE_GATE_PATTERNS: Readonly<Record<string, RegExp>> = {
  postgres: /\bDATABASE_URL\b/,
  mysql: /\bMYSQL_URL\b/,
  mssql: /\bMSSQL_URL\b/,
  powdb: /no prebuilt binary|@zvndev\/powdb-embedded >=/,
  sqlite: /\bnode:sqlite\b/,
};

/**
 * Parse `TURBINE_REQUIRE_ENGINE` into the reason patterns a skip must not match.
 *
 * An UNKNOWN token throws. A typo'd engine name that silently disabled the
 * requirement would recreate the exact bug this variable exists to catch: a CI
 * job reporting green while the suite it was built for never ran.
 */
function requiredEnginePatterns(): RegExp[] {
  const raw = process.env.TURBINE_REQUIRE_ENGINE;
  if (!raw) return [];
  const tokens = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return tokens.map((token) => {
    const pattern = ENGINE_GATE_PATTERNS[token];
    if (!pattern) {
      throw new Error(
        `TURBINE_REQUIRE_ENGINE names an unknown engine "${token}". ` +
          `Known engines: ${Object.keys(ENGINE_GATE_PATTERNS).join(', ')}.`,
      );
    }
    return pattern;
  });
}

/**
 * Gate an integration suite on an environment precondition (usually DATABASE_URL).
 *
 * When `skip` is false this returns the real node:test runners, so behavior is
 * byte-for-byte identical to importing them directly. When `skip` is true it
 * returns an `it` that registers every test with `{ skip: reason }`, the
 * reporter counts them as skipped instead of silently omitting them, and
 * no-op `before`/`after` hooks so suite setup never touches the database.
 *
 * ## TURBINE_REQUIRE_ENGINE
 *
 * Skipping is the right default locally, and it is exactly wrong in the CI job
 * that exists to run these tests. A mistyped `MYSQL_URL` in the workflow, or a
 * renamed env var, or a service container that never published its port, all
 * produce the same outcome as having no MySQL at all: every gated suite skips
 * and the job reports GREEN. Nothing downstream asserts the tests ran.
 *
 * Set `TURBINE_REQUIRE_ENGINE` to one or more comma-separated engine tokens
 * (`postgres`, `mysql`, `mssql`, `powdb`, `sqlite`) and a gate that would skip
 * for that engine THROWS instead, naming the precondition it could not meet.
 * The throw happens at module scope, where these gates are declared, so the
 * test runner fails the file rather than reporting zero tests. Gates for the
 * other engines are untouched and still skip normally, which is what lets a
 * single-engine job keep running the whole suite.
 */
export function skipGate(skip: boolean, reason: string): GatedRunners {
  if (!skip) return { it, before, after };
  for (const pattern of requiredEnginePatterns()) {
    if (!pattern.test(reason)) continue;
    throw new Error(
      `TURBINE_REQUIRE_ENGINE=${process.env.TURBINE_REQUIRE_ENGINE} is set, so this suite must run, ` +
        `but its precondition is unmet: ${reason}. ` +
        `Check that the environment variable it names is actually exported to this process ` +
        `(a typo in the variable NAME looks identical to an absent database), ` +
        `or unset TURBINE_REQUIRE_ENGINE to allow the skip.`,
    );
  }
  const noop = () => {};
  // biome-ignore lint/suspicious/noExplicitAny: forwards node:test's overloaded `it` signature
  const skippedIt = ((name: any, options?: any, fn?: any) =>
    typeof options === 'function' || options === undefined
      ? it(name, { skip: reason }, options)
      : it(name, { ...options, skip: reason }, fn)) as typeof it;
  return { it: skippedIt, before: noop as typeof before, after: noop as typeof after };
}

/**
 * Build a minimal ColumnMetadata for testing.
 *
 * `pgArrayType` is DERIVED from `pgType` via the same {@link pgArrayType} map
 * introspection uses. Hardcoding it (it used to be a flat `'bigint[]'`) made
 * every mock table claim a bigint array cast, which silently encoded whatever
 * the real UNNEST cast happened to be into `createMany` SQL assertions.
 */
export function mockColumn(name: string, field: string, pgType = 'int8'): ColumnMetadata {
  return {
    name,
    field,
    pgType,
    tsType: 'number',
    nullable: false,
    hasDefault: name === 'id',
    isArray: false,
    pgArrayType: pgArrayType(pgType),
  };
}

/** Build a minimal TableMetadata for testing */
export function mockTable(
  tableName: string,
  columns: { name: string; field: string; pgType?: string }[],
  relations: Record<string, RelationDef> = {},
): TableMetadata {
  const cols = columns.map((c) => mockColumn(c.name, c.field, c.pgType ?? 'int8'));
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const allColumns: string[] = [];

  for (const col of cols) {
    columnMap[col.field] = col.name;
    reverseColumnMap[col.name] = col.field;
    allColumns.push(col.name);
  }

  return {
    name: tableName,
    columns: cols,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    dialectTypes: Object.fromEntries(cols.map((c) => [c.name, c.dialectType ?? c.pgType])),
    pgTypes: Object.fromEntries(cols.map((c) => [c.name, c.pgType])),
    allColumns,
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  };
}

/** Create a QueryInterface without a real pool (for build-only SQL tests) */
export function makeQuery<T extends object = Record<string, unknown>>(
  tableName: string,
  schema: SchemaMetadata,
  options?: QueryInterfaceOptions,
): QueryInterface<T> {
  // biome-ignore lint/suspicious/noExplicitAny: mock pool not needed for build-only tests
  return new QueryInterface<T>(null as any, tableName, schema, undefined, options);
}

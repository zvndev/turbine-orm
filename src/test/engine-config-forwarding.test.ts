/**
 * Every engine factory forwards every client option, checked at COMPILE time
 * and at RUNTIME.
 *
 * The bug this exists for has shipped twice in two disguises, and it is
 * invisible to ordinary tests both times:
 *
 *   - `turbinePowDB` extended a four-key `Pick<TurbineConfig, ...>` AND
 *     hand-listed the same four keys into `new TurbineClient`, so a
 *     `globalFilters` passed to the public factory was dropped one level above
 *     the code that honours it. Every unit test of that code constructs the
 *     query interface directly, so all of them passed while the factory that
 *     every real caller uses discarded the option.
 *   - `turbineHttp` extended a three-key `Pick`, which made a working option an
 *     excess-property error on the serverless entry point.
 *
 * Neither is reachable from a test that builds a query interface itself: the
 * defect is in the factory's plumbing, above everything a query test touches.
 * So this file asserts the plumbing, from two directions.
 *
 * TYPE: each factory's options type must ADMIT client options that none of the
 * old allowlists named. These are `satisfies` expressions, so re-narrowing any
 * options type fails `npm run typecheck` and fails this file to load at all.
 *
 * RUNTIME: a client built BY A FACTORY, with a global filter passed through
 * that factory's options argument, must emit the filter. `turbineHttp` is the
 * one factory that needs no driver and no database, so it is the one that can
 * assert this in the unit lane. It is the same plumbing in every factory, and
 * the type assertions cover the rest.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineConfig } from '../client.js';
import type { EngineClientConfig } from '../engine-config.js';
import type { TurbineMssqlOptions } from '../mssql.js';
import type { TurbineMysqlOptions } from '../mysql.js';
import type { TurbinePowdbOptions } from '../powdb.js';
import type { TurbineHttpOptions } from '../serverless.js';
import { turbineHttp } from '../serverless.js';
import type { TurbineSqliteOptions } from '../sqlite.js';
import { mockColumn, mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// 1. Type-level: every factory admits options outside the historical allowlists
// ---------------------------------------------------------------------------

/**
 * Options that were in NO factory's `Pick`, chosen because each one's silent
 * absence is the worst kind: a tenant predicate, an error-redaction mode, and a
 * relation-ordering guarantee.
 */
const BEYOND_THE_ALLOWLIST = {
  globalFilters: {},
  errorMessages: 'safe',
  stableRelationOrder: true,
} as const;

void (BEYOND_THE_ALLOWLIST satisfies EngineClientConfig);
void (BEYOND_THE_ALLOWLIST satisfies TurbineSqliteOptions);
void (BEYOND_THE_ALLOWLIST satisfies TurbineMysqlOptions);
void (BEYOND_THE_ALLOWLIST satisfies TurbineMssqlOptions);
void (BEYOND_THE_ALLOWLIST satisfies TurbinePowdbOptions);
void (BEYOND_THE_ALLOWLIST satisfies TurbineHttpOptions);

/** ...and they are really `TurbineConfig` keys, not just keys the target admits. */
type OptionsAreConfigKeys = keyof typeof BEYOND_THE_ALLOWLIST extends keyof TurbineConfig ? true : false;
const _optionsAreConfigKeys: OptionsAreConfigKeys = true;
void _optionsAreConfigKeys;

/**
 * `turbineHttp` takes its pool as the first argument, so `pool` is the ONE key
 * its options type excludes. Asserting the exclusion as well as the inclusions
 * keeps the type honest in both directions.
 */
type HttpHasPool = 'pool' extends keyof TurbineHttpOptions ? true : false;
const _httpExcludesPool: HttpHasPool = false;
void _httpExcludesPool;

/**
 * The keys `turbinePowDB` destructures out of `options` before spreading the
 * rest into `TurbineClient`, and the invariant that matters about them: a key
 * that is BOTH a PowDB transport key and a `TurbineConfig` option would be
 * destructured away from the client, which is exactly how a real option becomes
 * unreachable. Stated as a type so it costs nothing and cannot be skipped.
 *
 * Listed here rather than imported from `powdb.ts`: a list the implementation
 * shares cannot disagree with the implementation, and disagreement is the thing
 * under test.
 */
type PowdbTransportKey =
  | 'connectionLimit'
  | 'transactionQueueTimeoutMs'
  | 'retryStaleReads'
  | 'assumeEngineVersion'
  | 'readonly'
  | 'powdbClientModule'
  | 'powdbEmbeddedModule';

type TransportShadowsAConfigKey = Extract<PowdbTransportKey, keyof TurbineConfig>;
const _noTransportShadowing: [TransportShadowsAConfigKey] extends [never] ? true : false = true;
void _noTransportShadowing;

/** Every transport key must actually be on the options type (else the list is stale). */
type TransportKeysExist = PowdbTransportKey extends keyof TurbinePowdbOptions ? true : false;
const _transportKeysExist: TransportKeysExist = true;
void _transportKeysExist;

// ---------------------------------------------------------------------------
// 2. Runtime: an option passed to a FACTORY reaches the emitted statement
// ---------------------------------------------------------------------------

const schema = {
  enums: {},
  tables: {
    widgets: mockTable('widgets', [mockColumn('id', 'id', 'int4'), mockColumn('tenant_id', 'tenantId', 'text')]),
  },
};

describe('engine factories forward the whole client config', () => {
  it('a global filter passed to turbineHttp reaches the SQL', () => {
    // The pool is never used: buildFindMany compiles without executing.
    const pool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({}), end: async () => {} };
    const db = turbineHttp(pool as never, schema as never, {
      globalFilters: { widgets: { tenantId: 't1' } } as never,
    });
    const q = db.table('widgets') as unknown as { buildFindMany: (a: unknown) => { sql: string; params: unknown[] } };

    const { sql, params } = q.buildFindMany({});
    assert.match(sql, /WHERE/, 'the factory-forwarded global filter must produce a predicate');
    assert.match(sql, /"tenant_id"/, 'and it must be on the filtered column');
    assert.deepEqual(params, ['t1'], 'bound, not interpolated');
  });

  it('an unfiltered table on the same client is untouched', () => {
    // Anti-vacuous: proves the assertion above is reading the global filter and
    // not merely observing that findMany emits a WHERE clause in general.
    const pool = { query: async () => ({ rows: [], rowCount: 0 }), connect: async () => ({}), end: async () => {} };
    const db = turbineHttp(pool as never, schema as never, {});
    const q = db.table('widgets') as unknown as { buildFindMany: (a: unknown) => { sql: string; params: unknown[] } };

    const { sql, params } = q.buildFindMany({});
    assert.doesNotMatch(sql, /WHERE/, 'no global filter configured, so no predicate');
    assert.deepEqual(params, []);
  });
});

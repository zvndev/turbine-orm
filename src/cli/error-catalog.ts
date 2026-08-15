/**
 * turbine-orm CLI: the error-code catalog behind `explain_error`.
 *
 * A pure leaf module, the same role `cli/rate-limit.ts`, `cli/destructive.ts`
 * and `cli/pii-predicate-guard.ts` play: no I/O, no state, and no import from a
 * sibling CLI module. Its ONE dependency is `../errors.js`, which is where the
 * codes and the docs URL actually live.
 *
 * WHY IT EXISTS. An agent that catches `[TURBINE_E003] Unknown column "titel"`
 * has the code and nothing else. `errors.ts` knows the class and the docs
 * anchor but carries no prose about causes or repairs, and the prose that does
 * exist lives on the docs site, which an offline agent cannot read and which a
 * `WebFetch` of a marketing page is a poor way to consult. This turns "I got
 * E015" into "this is an OptimisticLockError, here is why it fired, here is what
 * to do", with no database, no network, and no tokens spent re-deriving it.
 *
 * TWO RULES KEEP IT HONEST.
 *
 *  1. `docsUrl` is NEVER written out here. It is read off a real
 *     {@link TurbineError} instance, so the URL an agent is handed is
 *     byte-identical to the one on the error it actually caught. A second
 *     hand-maintained copy of `docsUrlForCode` is exactly the drift this repo
 *     has been bitten by before.
 *  2. The catalog is keyed by `TurbineErrorCode`, exhaustively. Adding a code to
 *     `errors.ts` without adding a row here FAILS THE BUILD (the mapped type
 *     below requires every key), and a row for a code that no longer exists
 *     fails as an excess property. Same stance as `query/option-surface.ts`:
 *     a human classifies the new thing, the compiler notices when nobody did.
 */

import { TurbineError, type TurbineErrorCode } from '../errors.js';

/** One code's explanation, as `explain_error` returns it. */
export interface ErrorExplanation {
  /** The canonical code, e.g. `TURBINE_E003`. */
  code: TurbineErrorCode;
  /** The exported class name, e.g. `ValidationError`. */
  className: string;
  /** Anchor into the published error table. Sourced from a real error instance. */
  docsUrl: string;
  /** True only for the two errors carrying `isRetryable: true as const`. */
  retryable: boolean;
  /**
   * How the error reaches you: raised by Turbine itself, or translated from a
   * PostgreSQL SQLSTATE by `wrapPgError()`. An agent chasing a `wrapped` error
   * should be reading the database's constraint, not Turbine's call site.
   */
  origin: 'turbine' | 'wrapped-pg';
  /** The SQLSTATE `wrapPgError()` maps, for `origin: 'wrapped-pg'`. */
  sqlstate?: string;
  /** One sentence: the condition that raises it. */
  whenThrown: string;
  /** The concrete situations that produce it, most common first. */
  likelyCauses: string[];
  /** What to change, in the same order. */
  howToFix: string[];
  /** Extra own properties the error carries beyond `code` / `message` / `docsUrl`. */
  properties: string[];
}

/**
 * The catalog body, minus the two fields derived from `errors.ts` itself
 * (`code` is the key, `docsUrl` comes off a live instance).
 */
type ErrorExplanationBody = Omit<ErrorExplanation, 'code' | 'docsUrl'>;

/**
 * Every code, explained. Exhaustive by construction: `Record<TurbineErrorCode,
 * …>` means a new code in `errors.ts` does not compile until it is written up
 * here, and a code removed there leaves an excess property that also does not
 * compile.
 */
const CATALOG: Record<TurbineErrorCode, ErrorExplanationBody> = {
  TURBINE_E001: {
    className: 'NotFoundError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'A query that promises a row did not find one.',
    likelyCauses: [
      '`findUniqueOrThrow` / `findFirstOrThrow` matched no row.',
      '`update` / `delete` addressed a row that does not exist, or that a global filter excludes.',
      'The where clause names the right column but the wrong value (a stale id, a string/number mismatch on the key).',
      'A tenant/global filter configured on the client narrowed the query to zero rows without the caller knowing.',
    ],
    howToFix: [
      'Use `findUnique` / `findFirst` and branch on `null` when absence is a normal outcome.',
      'Read `err.table`, `err.where` and `err.operation` to see exactly what was addressed; the message redacts the VALUES unless the client is on `errorMessages: "verbose"`.',
      'If a global filter is in play, re-run the same query with `skipGlobalFilters: UNSAFE` to confirm the row exists but is filtered.',
    ],
    properties: ['table', 'where', 'operation'],
  },
  TURBINE_E002: {
    className: 'TimeoutError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'A query or transaction ran past its configured timeout.',
    likelyCauses: [
      'A missing index turned a relation probe or a where clause into a sequential scan.',
      'A transaction held a lock another transaction was waiting on.',
      'The timeout is simply lower than the work (a large `createMany`, an unbounded `findMany`).',
    ],
    howToFix: [
      'Run `doctor_report` for missing relation indexes, and `explain_query` on the shape that timed out.',
      'Read `err.timeoutMs` for the limit that was hit; raise it per query with the `timeout` option rather than globally.',
      'Bound the read: add a `limit`, or paginate.',
    ],
    properties: ['timeoutMs'],
  },
  TURBINE_E003: {
    className: 'ValidationError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'The query args were rejected before any SQL ran.',
    likelyCauses: [
      'A name that resolves to no column: in `where`, `orderBy`, `distinct`, a `groupBy` `by` key, an aggregate target, create/update `data`, or (since 0.64) `select` / `omit` at any depth.',
      'A relation named in `select` or `omit`. Relations load through `with`, which is a SIBLING of `select`, not a member of it.',
      'A projection shape that selects nothing: an empty or all-false `select`, or `select` and `omit` on the same query.',
      'The empty-where guard: `update` / `delete` / `updateMany` / `deleteMany` with `{}` or an all-undefined where.',
      'An aggregate over a PII-tagged column (`_min` / `_max`, or a PII column as a `groupBy` key) with no `includePii`.',
      'A privilege option (`includePii`, `skipGlobalFilters`, `allowFullTableScan`) passed `true` instead of the `UNSAFE` symbol.',
      '`forceCustomPlan` against a client pinned to `planCacheMode: "force_generic_plan"`.',
    ],
    howToFix: [
      'Read the message: it names the table and, where it can, the column you probably meant.',
      'For a relation, move it out of `select` and into `with: { name: true }`.',
      'For a mass mutation you really do want, pass `allowFullTableScan: UNSAFE` explicitly.',
      'Import `UNSAFE` from the package root for any privilege option; `JSON.parse` cannot produce a symbol, which is the point.',
    ],
    properties: [],
  },
  TURBINE_E004: {
    className: 'ConnectionError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'The pool could not establish or keep a connection.',
    likelyCauses: [
      'Nothing is listening (ECONNREFUSED), DNS failed (ENOTFOUND / EAI_AGAIN), or the connect timed out (ETIMEDOUT).',
      'TLS: a self-signed or expired certificate, or a hostname the certificate does not cover.',
      'The connection string is malformed, or points at a pooler port the server is not on.',
      'The server closed an idle pooled connection (proxy idle timeout, restart, failover).',
    ],
    howToFix: [
      'Read `err.sqlstate` and the hint in the message: each driver code carries its own next step.',
      'Check the host, port and database name; for TLS, supply the CA via `ssl: { ca }` rather than disabling verification.',
      'For a serverless driver, pass the external pool on `TurbineConfig.pool` instead of a connection string.',
    ],
    properties: ['sqlstate'],
  },
  TURBINE_E005: {
    className: 'RelationError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'A `with` clause named a relation the schema does not declare.',
    likelyCauses: [
      'A typo, or a Prisma-style name that Turbine derives differently.',
      'The generated metadata is stale: the relation exists in the database but `turbine generate` has not been re-run.',
      'A UNIQUE foreign key, which Turbine derives as a singular `hasOne` (`user.profile`) rather than a plural `hasMany` (`user.profiles`).',
    ],
    howToFix: [
      'Call `relation_graph` (optionally scoped with `table`) and read the relation names Turbine actually derived, rather than guessing them.',
      'Call `find_join_path` for the `with` clause to write, instead of assembling one by hand.',
      'Re-run `turbine generate` if the database has changed.',
    ],
    properties: [],
  },
  TURBINE_E006: {
    className: 'MigrationError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'A migration could not be parsed, verified, or applied.',
    likelyCauses: [
      'A checksum mismatch: an already-applied migration file was edited after the fact.',
      'A migration file with no `-- UP` section, or an unparseable one.',
      'The advisory migration lock was already held by a concurrent runner.',
      'The SQL itself failed; the migration is rolled back, and the underlying error is the `cause`.',
    ],
    howToFix: [
      'Run `migrate_status` to see applied / pending / drifted counts and which file drifted.',
      'Never edit an applied migration. Write a new one that makes the correction.',
      'For lock contention, wait for the other runner; `migrate deploy` is the no-prompt CI form.',
    ],
    properties: [],
  },
  TURBINE_E007: {
    className: 'CircularRelationError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'A `with` clause nested more than 10 relation levels deep.',
    likelyCauses: [
      'A back-reference walked in a loop: `user -> posts -> user -> posts -> …`.',
      'A genuinely deep tree built by concatenating `with` fragments programmatically.',
    ],
    howToFix: [
      'Read `err.path` for the exact trail that hit the cap.',
      'Back-references are legal; the cap is on DEPTH, so re-root the query at the level you actually need instead of walking back up.',
      'Split one very deep read into two shallower queries.',
    ],
    properties: ['path'],
  },
  TURBINE_E008: {
    className: 'UniqueConstraintError',
    retryable: false,
    origin: 'wrapped-pg',
    sqlstate: '23505',
    whenThrown: 'A write violated a unique constraint or unique index.',
    likelyCauses: [
      'An insert of a value that already exists (the classic duplicate email).',
      'An update that moved a row onto an existing key.',
      'A race: two concurrent inserts of the same key, where a read-then-insert check passed in both.',
    ],
    howToFix: [
      'Read `err.constraint`, `err.columns` and `err.table` and map the constraint to a user-facing message (HTTP 409).',
      'Use `upsert`, or `createMany({ skipDuplicates: true })`, instead of check-then-insert.',
      'Never branch on the message text; branch on `err.code` or `instanceof UniqueConstraintError`.',
    ],
    properties: ['constraint', 'columns', 'table'],
  },
  TURBINE_E009: {
    className: 'ForeignKeyError',
    retryable: false,
    origin: 'wrapped-pg',
    sqlstate: '23503',
    whenThrown: 'A write violated a foreign key constraint.',
    likelyCauses: [
      'An insert or update pointing a foreign key at a parent row that does not exist.',
      'A delete of a parent row that still has children, where the constraint is `NO ACTION` / `RESTRICT`.',
      'Rows written in the wrong order inside a transaction.',
    ],
    howToFix: [
      'Read `err.constraint` and `err.table` to see which side failed.',
      'Use a nested write (`data: { child: { create: … } }`), which orders the inserts for you inside one transaction.',
      'To delete a parent, delete or re-point its children first, or declare `ON DELETE CASCADE`.',
    ],
    properties: ['constraint', 'table'],
  },
  TURBINE_E010: {
    className: 'NotNullViolationError',
    retryable: false,
    origin: 'wrapped-pg',
    sqlstate: '23502',
    whenThrown: 'A write left a NOT NULL column with no value.',
    likelyCauses: [
      'A required column omitted from `data`.',
      'An explicit `null` written to a NOT NULL column.',
      'A migration that added a NOT NULL column with no default while old code still inserts without it.',
    ],
    howToFix: [
      'Read `err.column` and `err.table` for the exact column.',
      'Supply the value, or give the column a database default.',
      'For an existing table, add the column nullable, backfill, then `SET NOT NULL` (`turbine migrate create <name> --recipe backfill` scaffolds this).',
    ],
    properties: ['column', 'table'],
  },
  TURBINE_E011: {
    className: 'CheckConstraintError',
    retryable: false,
    origin: 'wrapped-pg',
    sqlstate: '23514',
    whenThrown: 'A write violated a CHECK constraint.',
    likelyCauses: [
      'A value outside the range the constraint allows (a negative quantity, an out-of-set status string).',
      'An atomic update operator (`decrement`) driving a column past a bound the constraint enforces.',
    ],
    howToFix: [
      'Read `err.constraint` and `err.table`, then read the constraint body: `table_detail` reports named check constraints where the schema declares them.',
      'Validate in application code before the write, so the user gets a field-level message rather than a 500.',
    ],
    properties: ['constraint', 'table'],
  },
  TURBINE_E012: {
    className: 'DeadlockError',
    retryable: true,
    origin: 'wrapped-pg',
    sqlstate: '40P01',
    whenThrown: 'PostgreSQL detected a deadlock and cancelled this transaction.',
    likelyCauses: [
      'Two transactions locking the same rows in opposite order.',
      'A long transaction holding a lock while doing unrelated work.',
    ],
    howToFix: [
      'Retry. `err.isRetryable === true`, and `withRetry(fn)` / `db.$retry(fn)` retries exactly the errors carrying that flag.',
      'Lock rows in a consistent order across code paths (for example, always ascending by primary key).',
      'Shorten transactions: do the I/O and the computation outside, the writes inside.',
    ],
    properties: ['isRetryable', 'constraint'],
  },
  TURBINE_E013: {
    className: 'SerializationFailureError',
    retryable: true,
    origin: 'wrapped-pg',
    sqlstate: '40001',
    whenThrown: 'A SERIALIZABLE or REPEATABLE READ transaction could not be serialized.',
    likelyCauses: [
      'Concurrent transactions at `Serializable` touching an overlapping row set.',
      'A read-modify-write on a hot row under `Repeatable Read`.',
    ],
    howToFix: [
      'Retry: this is the expected, designed outcome at these isolation levels, not a bug. `withRetry(fn)` / `db.$retry(fn)` handles it.',
      'Where the operation is a pure increment, use an atomic update operator (`{ increment: 1 }`) instead of read-then-write.',
      'Consider whether the transaction genuinely needs `Serializable`.',
    ],
    properties: ['isRetryable'],
  },
  TURBINE_E014: {
    className: 'PipelineError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'A non-transactional pipeline (`{ transactional: false }`) had at least one failing query.',
    likelyCauses: ['One query in the batch failed while others succeeded, so there is no single error to throw.'],
    howToFix: [
      'Read `err.results`: one slot per query, each `{ status: "ok", value }` or `{ status: "error", error }`, with the real typed error inside.',
      '`err.failedIndex` and `err.failedTag` point at the first failure.',
      'If partial success is not acceptable, drop `transactional: false`; a transactional pipeline either fully succeeds or rolls back.',
    ],
    properties: ['results', 'failedIndex', 'failedTag'],
  },
  TURBINE_E015: {
    className: 'OptimisticLockError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'An `optimisticLock` update found no row at the expected version.',
    likelyCauses: [
      'Another transaction updated the row between your read and your write. This is the mechanism working.',
      'The version value passed was stale (held across a user interaction, or cached).',
      'The row was deleted.',
    ],
    howToFix: [
      'Re-read the row, re-apply the change to the fresh values, and write again. Do NOT blindly retry the same payload: the point of the check is that the underlying data moved.',
      'Read `err.table`, `err.versionField` and `err.expectedVersion` to report the conflict to the user.',
      'It is deliberately NOT flagged retryable: an automatic retry would defeat the guard.',
    ],
    properties: ['table', 'versionField', 'expectedVersion'],
  },
  TURBINE_E016: {
    className: 'ExclusionConstraintError',
    retryable: false,
    origin: 'wrapped-pg',
    sqlstate: '23P01',
    whenThrown: 'A write violated an EXCLUDE constraint.',
    likelyCauses: [
      'Overlapping ranges where the constraint forbids overlap (the canonical booking / reservation clash).',
    ],
    howToFix: [
      'Read `err.constraint` and `err.table`, then translate the clash into a domain message ("that slot is taken").',
      'Query for the conflicting row with a range-overlap filter so the user can be shown WHAT it clashes with.',
    ],
    properties: ['constraint', 'table'],
  },
  TURBINE_E017: {
    className: 'UnsupportedFeatureError',
    retryable: false,
    origin: 'turbine',
    whenThrown:
      'This build cannot do that: a capability flag on the active dialect reports the feature unsupported, so Turbine refuses instead of emitting broken SQL.',
    likelyCauses: [
      'A Postgres-only feature on another engine: pgvector distance operators, `$listen` / `$notify`, RLS `sessionContext` / `$withSession`, `planCacheMode`.',
      'NOT only a wrong-engine error, and reading it that way sends you looking in the wrong place. PostgreSQL raises it too: `relationLoadStrategy: "batched"` on a COMPOSITE-key relation refuses rather than loading a wrong set.',
      'On PowDB: a nested `$transaction`, a re-entrant `$transaction`, or a feature above the connected engine version (the message carries the upgrade hint).',
      '`limit` on `updateMany` / `deleteMany` through the prisma-compat adapter.',
    ],
    howToFix: [
      'Read `err.feature` and `err.dialect`: together they say exactly what was refused and by which engine.',
      'For a composite-key relation, use the default join plan rather than `batched`.',
      'For a version gate, upgrade the engine to the version named in the hint.',
    ],
    properties: ['feature', 'dialect'],
  },
  TURBINE_E018: {
    className: 'ReadOnlyError',
    retryable: false,
    origin: 'turbine',
    whenThrown: 'A write was refused because the database or the connection is read-only.',
    likelyCauses: [
      '`reason: "snapshot"`: the client was opened `readonly: true`, or PowDB is serving a read-only snapshot.',
      '`reason: "rbac"`: the connected role has no write privilege.',
    ],
    howToFix: [
      'Read `err.reason` first: the two causes have nothing in common except the refusal.',
      'For `snapshot`, open a writable client; the read-only one is doing its job.',
      'For `rbac`, grant the role the privilege, or connect as one that has it.',
    ],
    properties: ['reason'],
  },
};

/** Every code in the catalog, in code order. */
export const CATALOGUED_ERROR_CODES = Object.keys(CATALOG).sort() as TurbineErrorCode[];

/**
 * Accept the spellings a caller actually types and return the canonical code,
 * or `null`.
 *
 * A code arrives from a log line (`TURBINE_E003`), from a docs anchor (`e003`),
 * from prose ("E3"), or as a bare number. All of them mean the same code, and
 * refusing three of the four teaches an agent to give up rather than to
 * normalize. What is NOT accepted is anything that resolves to no code at all:
 * the caller gets `null` and a list, never a guess.
 */
export function normalizeErrorCode(input: string): TurbineErrorCode | null {
  const trimmed = input.trim().toUpperCase().replace(/\s+/g, '');
  // `TURBINE_E003` / `TURBINE-E003` / `TURBINEE003` / `E003` / `E3` / `003` / `3`
  const match = /^(?:TURBINE[_-]?)?E?(\d{1,4})$/.exec(trimmed);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 1) return null;
  const code = `TURBINE_E${String(n).padStart(3, '0')}` as TurbineErrorCode;
  return Object.hasOwn(CATALOG, code) ? code : null;
}

/**
 * The full explanation for a code, or `null` when the input names no code.
 *
 * `docsUrl` is read off a real {@link TurbineError} rather than formatted here,
 * so it cannot drift from the URL on the error an agent actually caught.
 */
export function explainErrorCode(input: string): ErrorExplanation | null {
  const code = normalizeErrorCode(input);
  if (!code) return null;
  return { code, docsUrl: new TurbineError(code, '').docsUrl, ...CATALOG[code] };
}

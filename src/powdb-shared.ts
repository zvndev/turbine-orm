/**
 * Shared PowDB primitives: identifier quoting, capability gating, type mapping
 * and value coercion.
 *
 * KEEP THIS FILE FREE OF IMPORTS FROM powdb.ts / powql.ts / powdb-introspect.ts.
 * That is the whole point: those three formed a runtime cycle because powdb.ts
 * re-exported from the other two while both imported values back from it. This
 * is the same shape pg-types.ts and connection-url.ts already use to keep
 * client.ts and query/ acyclic.
 *
 * A cycle is not a style complaint. `dist/powdb.js` is the largest engine
 * entry, and in a cycle one of its three modules always executes while another
 * is half-initialized: whichever module the loader reaches first decides, so
 * the same code can work under ESM and fail under CJS, or work until an import
 * is reordered. The failure surfaces far from its cause, as an undefined
 * binding at call time. `scripts/check-import-cycles.mjs` now fails the build
 * on any such cycle under `src/`, so this file is what keeps that gate green
 * for the PowDB engine.
 *
 * Everything here is re-exported by powdb.ts under its original name, so the
 * public `turbine-orm/powdb` surface is byte-identical to before the split.
 * The few helpers powdb.ts consumes but never published (`isDateColumn`) are
 * exported from this module and NOT re-exported from powdb.ts.
 *
 * @module
 */

import { ConnectionError, UnsupportedFeatureError, ValidationError } from './errors.js';
import type { ColumnMetadata, TableMetadata } from './schema.js';

// ---------------------------------------------------------------------------
// Bound-parameter markers
// ---------------------------------------------------------------------------

/**
 * Marker wrapper for a value bound to a `float` column. The networked driver
 * unwraps it to the plain number (the wire param is unchanged), but the
 * *embedded* literal encoder reads it to emit a float-form PowQL literal (`42`
 * → `42.0`) so an integer-valued float column stays unambiguously a float.
 * Constructed in {@link PowqlInterface.param}.
 */
export class PowdbFloatParam {
  constructor(readonly value: number) {}
}

/**
 * Marker wrapper for a JS object/array bound to a `json` document column. Both
 * transports serialize `value` with `JSON.stringify` and send the text as a
 * `str` param / string literal, exactly how the PowDB docs insert a json
 * document (the engine validates it as JSON text and stores the canonical
 * binary form). Constructed in {@link PowqlInterface.param} when the target
 * column is `json` and the value is a non-null object/array; a JS string
 * written to a json column passes through RAW (same contract as pg jsonb,
 * pass `'"x"'` to store the JSON string `"x"`), and `null` stays `null`.
 */
export class PowdbJsonParam {
  /** `column` is diagnostic only: it names the target column when serialization fails. */
  constructor(
    readonly value: unknown,
    readonly column?: string,
  ) {}
}

// ---------------------------------------------------------------------------
// Capability gating: per-version / per-transport feature flags
// ---------------------------------------------------------------------------

/**
 * Feature capabilities of a bound PowDB connection. Resolved once (from the
 * probed server version on the networked transport, or the addon package
 * version on embedded) and carried on the pool so {@link PowqlInterface} can
 * gate PowQL features that only exist on newer engines, an old engine gets a
 * typed {@link UnsupportedFeatureError} (E017) with a version hint instead of a
 * raw PowQL parse error.
 */
export interface PowdbCapabilities {
  /** Best-known engine version (e.g. `'0.13.0'`), or `null` when unknowable. */
  engineVersion: string | null;
  /** ≥ 0.12: `json` column type, `->` path filters / ordering / grouping. */
  jsonDocs: boolean;
  /** ≥ 0.13: `alter T add index (.col->seg)` expression indexes. */
  docFieldIndexes: boolean;
  /** ≥ 0.10: `schema` / `describe` introspection statements. */
  introspection: boolean;
  /** ≥ 0.13: server-side joins, hash-accelerated and bounded. */
  serverJoins: boolean;
  /**
   * ≥ 0.18: nested projections (shaped results), a projection field may be a
   * whole correlated child query returning a per-parent JSON array. When set,
   * eligible `with` clauses compile into the parent statement instead of the
   * batched loaders.
   */
  nestedProjections: boolean;
  /**
   * ≥ 0.19: entity links (`link` DDL, scalar/block traversal). Capability is
   * recognized (probe-only), but query generation deliberately does NOT consume
   * links yet: turbine keeps composing its own nested projections (see the
   * PowDB engine page for the rationale). Declaring a link permanently upgrades
   * the on-disk catalog to v7, so this stays FALSE in ALL_POWDB_CAPABILITIES.
   */
  entityLinks: boolean;
  /**
   * ≥ 0.19.1: link INTROSPECTION, the `schema links` listing statement and the
   * appended link rows in `describe <T>`. Only meaningful when probed (there is
   * no query-generation flip behind it), so it stays FALSE in
   * ALL_POWDB_CAPABILITIES like the other probe-only gates. Floored at the PATCH
   * 0.19.1: the listing statement shipped there, not in 0.19.0.
   */
  linkIntrospection: boolean;
  /**
   * ≥ 0.19.1: scalar to-one link PATHS in query generation. Floored at the PATCH
   * 0.19.1 (never 0.19.0) because 0.19.0 had silent-wrong-results link bugs
   * (bare-dotted-path split, wrong aggregates over links) that make traversal
   * unsafe; 0.19.1 turned those into hard errors. This flag flips real query
   * generation (a to-one `with` whose child carries bigint/bytes compiles to
   * link-path projections instead of a loader), so it stays FALSE in
   * ALL_POWDB_CAPABILITIES: it must only light up behind a real version probe.
   */
  linkPaths: boolean;
  /**
   * ≥ 0.20: a comparison between a `datetime` column and an integer timestamp
   * literal evaluates as microseconds. Below 0.20 that pairing was unhandled and
   * fell back to comparing TYPE TAGS (every DateTime sorted above every Int), so
   * `>` matched every non-null row, `=` and `<` matched none, and the answer
   * additionally depended on whether the column carried an index. Turbine binds
   * a JS `Date` as int micros, so that is exactly the shape it emits: every
   * datetime predicate was silently wrong on an older engine.
   *
   * The `in` / `not in` LIST form is a separate, still-open engine bug that 0.20
   * did NOT fix, so this flag does not unlock it: a datetime `in` list is
   * COMPILED AWAY into the equality chain the engine does answer correctly (see
   * `PowqlInterface.buildInList`). That expansion needs working binary
   * comparisons, so it too sits behind this flag.
   *
   * Predominantly a refusal gate, but the `in` rewrite makes it a (bounded)
   * generation flip as well. It stays ON in {@link ALL_POWDB_CAPABILITIES}
   * anyway: with the flag OFF the datetime paths do not fall back to some other
   * SQL, they refuse outright, so a hand-constructed pool defaulting to OFF
   * would break datetime queries that work rather than protect anything.
   */
  datetimeCompare: boolean;
  /**
   * ≥ 0.20: `count(T { .col })` counts non-null values of `.col` (SQL's
   * `COUNT(col)`), which is what Turbine's per-field `_count` means. Below 0.20
   * both frontends ignored the projection and returned the ROW count, so
   * `aggregate({ _count: { field: true } })` silently disagreed with every SQL
   * engine on a nullable column. `count(T)` / `_count: true` is unaffected on
   * every version. Refusal-only gate (the emitted PowQL does not change).
   */
  projectedCountNonNull: boolean;
  /** Networked only: server ≥ 0.13 AND the client exposes `queryNativeRaw`. */
  nativeRaw: boolean;
}

/** The feature-gate capability keys (everything except the version/nativeRaw metadata). */
type PowdbFeatureKey =
  | 'jsonDocs'
  | 'docFieldIndexes'
  | 'introspection'
  | 'serverJoins'
  | 'nestedProjections'
  | 'entityLinks'
  | 'linkIntrospection'
  | 'linkPaths'
  | 'datetimeCompare'
  | 'projectedCountNonNull';

/**
 * Minimum engine version each gated feature needs, for the E017 hint text.
 * Most gates carry a `major.minor` floor (patch-insensitive); the two link
 * lanes carry a `major.minor.patch` floor (`0.19.1`) because the listing
 * statement and the safe traversal semantics landed in the PATCH release, not
 * in 0.19.0. {@link atLeastVersion} compares all three components, so a
 * `major.minor` floor still matches every patch of that minor.
 */
const POWDB_FEATURE_MIN_VERSION: Record<PowdbFeatureKey, string> = {
  introspection: '0.10',
  jsonDocs: '0.12',
  docFieldIndexes: '0.13',
  serverJoins: '0.13',
  nestedProjections: '0.18',
  entityLinks: '0.19',
  linkIntrospection: '0.19.1',
  linkPaths: '0.19.1',
  datetimeCompare: '0.20',
  projectedCountNonNull: '0.20',
};

/**
 * Trusted-caller default: every FEATURE gate on, engine version unknown. Used
 * for a directly-constructed {@link PowdbPool} / {@link PowdbEmbeddedPool} that
 * did not go through {@link turbinePowDB}'s version probe (e.g. an injected
 * pool, or a unit-test pool). `nativeRaw` stays OFF here because it flips the
 * actual wire path and must only be enabled after a real server-version probe,
 * never inferred from a bare construction. `nestedProjections` stays OFF for
 * the same reason: it changes the generated PowQL for every `with` query, and
 * an unprobed engine below 0.18 would reject the syntax outright.
 * `entityLinks` stays OFF for a stronger reason still: declaring a link
 * one-way-upgrades the on-disk catalog to v7 and locks out pre-0.19 binaries,
 * so it must only ever light up behind a real version probe.
 * `linkIntrospection` / `linkPaths` stay OFF for the same probe-only discipline:
 * `linkPaths` flips real query generation (a to-one `with` compiling to link
 * projections), and `linkIntrospection` is only meaningful once genuinely
 * probed, so both must come from a real version resolution, never a bare
 * construction.
 * `datetimeCompare` / `projectedCountNonNull` stay ON here for the same
 * trusted-caller reason as `jsonDocs` and `serverJoins`. Neither is a fallback
 * gate: with the flag OFF the affected query is REFUSED, not served by some
 * other statement, so defaulting them off would break working queries rather
 * than protect anything. Every path that can learn the engine version
 * (`turbinePowDB`, embedded or networked) resolves them from a real probe; this
 * fallback only covers a hand-constructed or injected pool, whose owner is
 * asserting the engine is current.
 */
export const ALL_POWDB_CAPABILITIES: PowdbCapabilities = {
  engineVersion: null,
  jsonDocs: true,
  docFieldIndexes: true,
  introspection: true,
  serverJoins: true,
  nestedProjections: false,
  entityLinks: false,
  linkIntrospection: false,
  linkPaths: false,
  datetimeCompare: true,
  projectedCountNonNull: true,
  nativeRaw: false,
};

/**
 * Throw a version-hinting {@link UnsupportedFeatureError} (E017) when a gated
 * PowQL feature is used on an engine that does not support it. Keeps old engines
 * getting clean typed errors instead of raw PowQL parse failures.
 *
 * The error's first sentence already names the feature (`<feature> is
 * unsupported on "PowDB".`), so the hint says "Requires PowDB >= x" rather than
 * repeating the label: a long feature description read twice in one message
 * (`per-field \`_count\` … is unsupported … per-field \`_count\` … requires …`)
 * buries the version floor that is the actionable part.
 *
 * `extra` appends one more sentence for gates that have a workaround worth
 * naming (e.g. the read path that answers the same query without the gated
 * comparison).
 */
export function requireCapability(
  caps: PowdbCapabilities,
  key: PowdbFeatureKey,
  feature: string,
  extra?: string,
): void {
  if (caps[key]) return;
  const min = POWDB_FEATURE_MIN_VERSION[key];
  const reported = caps.engineVersion
    ? `this connection reports ${caps.engineVersion}`
    : 'this connection could not report a version';
  throw new UnsupportedFeatureError(
    feature,
    'PowDB',
    `Requires PowDB >= ${min}; ${reported}. Upgrade powdb-server / @zvndev/powdb-embedded ` +
      `(or pass \`assumeEngineVersion\` if the version cannot be detected).${extra ? ` ${extra}` : ''}`,
  );
}

// ---------------------------------------------------------------------------
// Type mapping, Turbine schema type -> PowQL DDL type
// ---------------------------------------------------------------------------

/**
 * PowQL column types Turbine emits: the four writable scalars plus PowDB's
 * native `json` document type (added to the map in the 0.12/0.13 parity round,
 * see {@link isJsonColumn}). A `json` column stores a canonical binary document
 * (sorted keys, int/float distinction preserved) that Turbine writes as a JSON
 * string literal and reads back by parsing the canonical JSON text.
 */
export type PowqlType = 'str' | 'int' | 'float' | 'bool' | 'json';

/**
 * Does this column map to PowDB's native `json` document type? A Postgres
 * `json`/`jsonb` type (via `dialectType`/`pgType`) is authoritative; otherwise
 * the tsType heuristic (`Record<…>`, `object`, `unknown`, an object/array
 * literal) that the four scalar branches do not claim. Array columns never map
 * to json, a PowDB array only exists INSIDE a json document, so a Postgres
 * array column has no PowDB shape and still throws in {@link powqlColumnType}.
 */
export function isJsonColumn(col: ColumnMetadata): boolean {
  if (col.isArray) return false;
  const dbType = (col.dialectType ?? col.pgType ?? '').toLowerCase();
  if (dbType === 'json' || dbType === 'jsonb') return true;
  const ts = col.tsType.replace(/\s*\|\s*null$/i, '').trim();
  if (ts === 'Date' || ts === 'boolean' || ts === 'number' || ts === 'bigint' || ts === 'string') return false;
  if (ts === 'Buffer' || ts === 'Uint8Array') return false;
  return /Record<|object|unknown|\[\]|\{/.test(ts);
}

/**
 * Map a Turbine column to the PowQL DDL type used in `defineSchema` →
 * `type T { … }`. Turbine never emits PowDB's `uuid`/`datetime`/`bytes` types,
 * which cannot hold client-supplied values on the wire (no literal, no cast):
 *   - `Date` → `int` (epoch micros)   - `boolean` → `bool`
 *   - integral `number`/`bigint` → `int`   - fractional `number` → `float`
 *   - JSON / object columns → `json` (native PowDB document type, ≥ 0.12)
 *   - everything else (incl. UUID/PK strings) → `str`
 * Array (non-json) and bytes columns throw, they have no PowDB equivalent.
 */
export function powqlColumnType(col: ColumnMetadata): PowqlType {
  if (col.isArray) {
    throw new ValidationError(
      `Column "${col.name}" is an array, PowDB has no array type. Arrays are unsupported on the PowDB backend.`,
    );
  }
  if (isJsonColumn(col)) return 'json';
  const ts = col.tsType.replace(/\s*\|\s*null$/i, '').trim();
  if (ts === 'Date') return 'int'; // epoch micros
  if (ts === 'boolean') return 'bool';
  if (ts === 'number') return isFloatColumn(col) ? 'float' : 'int';
  if (ts === 'bigint') return 'int';
  if (ts === 'string') return 'str';
  if (ts === 'Buffer' || ts === 'Uint8Array') {
    throw new ValidationError(
      `Column "${col.name}" is binary, PowDB cannot store client-supplied bytes on the wire. Use a string (e.g. base64) instead.`,
    );
  }
  return 'str';
}

/** Heuristic: does this numeric column hold fractional values (→ PowQL `float`)? */
function isFloatColumn(col: ColumnMetadata): boolean {
  const t = (col.dialectType ?? col.pgType ?? '').toLowerCase();
  return /float|double|real|numeric|decimal|money/.test(t);
}

/**
 * Is a column stored as `int` epoch micros but surfaced as a JS `Date`?
 *
 * Exported because powdb.ts's parameter encoder asks the same question on the
 * write side, and one definition of "this column is a Date" is the point of a
 * shared leaf. Deliberately NOT re-exported from powdb.ts: the
 * `turbine-orm/powdb` surface is unchanged by this split.
 */
export function isDateColumn(col: ColumnMetadata): boolean {
  return col.tsType.replace(/\s*\|\s*null$/i, '').trim() === 'Date';
}

/**
 * Is this column stored in PowDB's NATIVE `datetime` type (as opposed to the
 * `int` epoch micros Turbine's own DDL emits for a `Date` column)?
 *
 * Only the literal PowQL type name counts. `powqlColumnType` never returns
 * `datetime`, so a Turbine-provisioned table can never have one; the shapes that
 * do are a table created outside Turbine and read back through
 * `introspectPowdbDatabase` (which maps `datetime` → `{ tsType: 'Date',
 * dialectType: 'datetime' }`), or hand-written metadata declaring it. Deliberately
 * strict: a Postgres-sourced `timestamptz` column is DDL'd as PowQL `int`, so it
 * is NOT a PowDB datetime and must not be caught here.
 *
 * Matters because comparing a datetime column against the integer timestamp
 * literal Turbine binds was silently wrong below engine 0.20 (see
 * {@link PowdbCapabilities.datetimeCompare}).
 */
export function isPowdbDatetimeColumn(col: ColumnMetadata): boolean {
  return (col.dialectType ?? col.pgType ?? '').toLowerCase() === 'datetime';
}

// ---------------------------------------------------------------------------
// Identifier quoting
// ---------------------------------------------------------------------------

/**
 * PowQL reserved words, the v0.10 lexer keyword table from POWQL.md's
 * "Reserved Words and Quoting" section, including the v0.10 additions
 * `schema` and `describe`. Keyword matching is case-sensitive in the lexer,
 * so only the exact lowercase form collides.
 */
export const POWQL_KEYWORDS: ReadonlySet<string> = new Set([
  'abs',
  'add',
  'alter',
  'and',
  'as',
  'asc',
  'auto',
  'avg',
  'begin',
  'between',
  'case',
  'cast',
  'ceil',
  'column',
  'commit',
  'concat',
  'conflict',
  'count',
  'cross',
  'date_add',
  'date_diff',
  'default',
  'delete',
  'dense_rank',
  'desc',
  'describe',
  'distinct',
  'drop',
  'else',
  'end',
  'exists',
  'explain',
  'extract',
  'false',
  'filter',
  'floor',
  'group',
  'having',
  'in',
  'index',
  'inner',
  'insert',
  'is',
  'join',
  'left',
  'length',
  'let',
  'like',
  'limit',
  'link',
  'lower',
  'match',
  'materialize',
  'materialized',
  'max',
  'min',
  'multi',
  'not',
  'now',
  'null',
  'offset',
  'on',
  'or',
  'order',
  'outer',
  'over',
  'partition',
  'pow',
  'rank',
  'refresh',
  'required',
  'returning',
  'right',
  'rollback',
  'round',
  'row_number',
  'schema',
  'select',
  'sqrt',
  'substring',
  'sum',
  'then',
  'transaction',
  'trim',
  'true',
  'type',
  'union',
  'unique',
  'update',
  'upper',
  'upsert',
  'view',
  'when',
]);

const POWQL_BARE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Backtick-quote an identifier when PowQL would otherwise lex it as a keyword
 * (or when it contains characters outside the bare-identifier grammar).
 * Applied only in bare-identifier positions, DDL type/field names, index DDL,
 * and `insert`/`update`/`upsert` assignment targets. Dotted references
 * (`.col` in filters/projections/ordering) bypass keyword lookup on every
 * engine version and deliberately stay bare for ≤0.9 compatibility. Backticks
 * parse on PowDB ≥ 0.10; on older engines these names were already parse
 * errors when emitted bare, so quoting is strictly an improvement.
 */
export function quotePowqlIdent(name: string): string {
  if (name.includes('`')) {
    // The lexer has no backtick escape inside a quoted identifier.
    throw new ValidationError(`Identifier "${name}" contains a backtick, which PowQL cannot represent.`);
  }
  return POWQL_KEYWORDS.has(name) || !POWQL_BARE_IDENT.test(name) ? `\`${name}\`` : name;
}

/**
 * The DOTTED-position spelling of {@link quotePowqlIdent}: quote a name that
 * falls outside the bare-identifier grammar, and only that.
 *
 * A dotted reference (`.col` in a filter, projection, `order`, `group`, or an
 * `upsert on`) bypasses keyword lookup, so `.order` parses on every engine
 * version and stays bare here, which is the ≤0.9 compatibility decision
 * {@link quotePowqlIdent} documents and which this must not undo.
 *
 * What it does NOT excuse is interpolating the name RAW, which is what these
 * sites used to do. Keyword-ness is a parsing question; a name outside
 * `POWQL_BARE_IDENT` is a statement-integrity one, and that name is the only
 * thing that can carry PowQL syntax into a statement whose values are all bound
 * as `$N` params. Reaching it needs a hostile column name (an introspected
 * database, a generator, a migration authored elsewhere) since names come from
 * schema metadata, but "the names are trusted" is not the invariant the rest of
 * this engine is written to. So: bare when the grammar allows it (byte-identical
 * output for every ordinary and every keyword name), quoted when it does not,
 * where the bare form was a parse error anyway. Verified against the engine that
 * a quoted dotted reference parses everywhere the bare one does and yields the
 * same result-column name.
 */
export function quotePowqlDotted(name: string): string {
  if (POWQL_BARE_IDENT.test(name)) return name;
  if (name.includes('`')) {
    throw new ValidationError(`Identifier "${name}" contains a backtick, which PowQL cannot represent.`);
  }
  return `\`${name}\``;
}

// ---------------------------------------------------------------------------
// Value coercion, PowDB wire cell -> JS value
// ---------------------------------------------------------------------------

/**
 * Coerce a single PowDB wire string into the JS value its column type implies.
 * Every PowDB value arrives as a string; NULL arrives as the bareword `"null"`.
 * Metadata resolves the `"null"` ambiguity for nullable non-string columns.
 */
export function coerceValue(raw: string, col: ColumnMetadata): unknown {
  const ts = col.tsType.replace(/\s*\|\s*null$/i, '').trim();
  const json = isJsonColumn(col);
  // NULL bareword: unambiguous for non-string columns; for `str` we cannot tell a
  // literal "null" from SQL NULL, so a nullable str of value "null" reads as null.
  // For a `json` column the bareword `null` (a legacy-wire rendering shared by an
  // absent value AND a top-level JSON-null document, documented residual,
  // resolved on the native transport by the WireValue path) maps to null; a JSON
  // string document "null" renders WITH quotes (`"null"`) and parses distinctly.
  if (raw === 'null' && (json || ts !== 'string' || col.nullable)) return null;
  if (json) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw; // defensive: canonical JSON text always parses
    }
  }
  if (ts === 'Date') {
    const micros = Number(raw);
    return Number.isFinite(micros) ? new Date(micros / 1000) : null;
  }
  if (ts === 'boolean') return raw === 'true';
  if (ts === 'number') {
    const n = Number(raw);
    // int8 policy: keep precision-losing big integers as strings.
    return Number.isSafeInteger(n) || !Number.isInteger(n) ? n : raw;
  }
  if (ts === 'bigint') return BigInt(raw);
  return raw; // string / uuid-as-string
}

/**
 * Coerce a single cell that arrived over the NATIVE typed wire (decoded from a
 * {@link PowdbWireValue}, so already a JS `bigint`/`number`/`boolean`/`string`/
 * `NativeJson`/`Uint8Array`/`null`, never a bare `"null"` string). Unlike
 * {@link coerceValue} this NEVER collapses the string `"null"` to `null`: an
 * absent value already decoded to `null` (from the `empty` cell), so a genuine
 * str `"null"` stays the string `"null"` (fixes the legacy-wire wart on the
 * native transport). `datetime`-shaped cells (int micros) become `Date`; a
 * bigint on a `number` column follows the int8 safe-integer policy.
 *
 * A date cell can also arrive as a DIGIT STRING: a nested-projection block's
 * children ride a JSON array, and micros exceed `Number.MAX_SAFE_INTEGER`'s
 * decimal comfort, so the engine renders them as a JSON string. Before that
 * string was parsed here, a nested `with` handed back the raw micros text while
 * the batched loader and the native join both handed back a `Date` (the same
 * relation, three answers). Only an all-digit string is parsed; any other text
 * on a date column passes through untouched.
 */
export function coerceNativeValue(value: unknown, col: ColumnMetadata): unknown {
  if (value === undefined || value === null) return null;
  if (isDateColumn(col)) {
    if (typeof value === 'bigint') return new Date(Number(value) / 1000);
    if (typeof value === 'number') return new Date(value / 1000);
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return new Date(Number(value) / 1000);
    return value;
  }
  const ts = col.tsType.replace(/\s*\|\s*null$/i, '').trim();
  if (typeof value === 'bigint') {
    if (ts === 'bigint') return value;
    if (ts === 'number') {
      const n = Number(value);
      return Number.isSafeInteger(n) ? n : value.toString(); // int8 policy: keep big ints as strings
    }
    return value;
  }
  return value; // number / boolean / string / NativeJson document / Uint8Array
}

/**
 * Map one raw PowDB row into a typed entity (camelCase fields, coerced values).
 * Only the columns present in `raw` are emitted, so partial `select`
 * projections round-trip unchanged. `native` selects the coercion policy: the
 * default `false` handles the legacy string wire (every cell is a string, via
 * {@link coerceValue}); `true` handles the native typed wire, where non-string
 * cells arrive pre-typed and go through {@link coerceNativeValue} (see F3).
 * Callers on the native transport pass `this.pool.capabilities.nativeRaw`.
 */
export function rowToEntity(
  raw: Record<string, unknown>,
  meta: TableMetadata,
  native = false,
): Record<string, unknown> {
  const byName = new Map(meta.columns.map((c) => [c.name, c]));
  const out: Record<string, unknown> = {};
  for (const snake of Object.keys(raw)) {
    const col = byName.get(snake);
    const field = meta.reverseColumnMap[snake] ?? snake;
    const value = raw[snake];
    if (!col) {
      out[field] = value;
    } else if (native) {
      out[field] = coerceNativeValue(value, col);
    } else {
      out[field] = typeof value === 'string' ? coerceValue(value, col) : value;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Error classification shared with the read-retry path
// ---------------------------------------------------------------------------

/**
 * True when `err` is the stale-wire-frame {@link ConnectionError} produced by
 * {@link wrapPowdbError} (its `.cause` is a `protocol_error` PowDBError, or the
 * message carries the invalid-state signature). The opt-in read retry
 * (`retryStaleReads`, evaluated in {@link PowqlInterface}'s exec seam) uses this
 * to decide whether a first-statement READ may be replayed once on a fresh
 * connection; writes are NEVER retried (an ambiguous mutation reply is unsafe
 * to replay, matching the client's own native-path policy).
 */
export function isStaleFramePowdbError(err: unknown): boolean {
  if (!(err instanceof ConnectionError)) return false;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause && typeof cause === 'object' && cause.code === 'protocol_error') return true;
  return /PowDB connection is in an invalid state/.test(err.message);
}

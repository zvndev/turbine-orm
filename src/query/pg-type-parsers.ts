/**
 * PostgreSQL array parsing and process-global temporal parser registration.
 *
 * Importing this module does not register parsers. Owned PostgreSQL bindings
 * call registerUtcTemporalParsers synchronously at their existing setup seam.
 * Scalar parser factories live in the import-free temporal-parsers module.
 */

import pg from '#pg';
import { consoleLogger, logTo, type TurbineLogger } from '../logger.js';
import { createFastTimestamptzParser, createUtcDateParser, createUtcTimestampParser } from './temporal-parsers.js';
import { shouldWarnOnce, WARN_NS } from './warn-registry.js';

/**
 * The shape of `pg.types.arrayParser` at RUNTIME. The bundled `pg-types`
 * declaration file types it as a plain function, which it has not been for
 * years (it is the `postgres-array` module, `{ create(source, transform) }`),
 * so the cast below is a declaration fix, not a type escape.
 */
type PgArrayParserModule = {
  create(source: string, transform: (entry: string) => unknown): { parse(): unknown[] };
};

/**
 * Lift an element parser to the matching Postgres array OID.
 *
 * Array OIDs do NOT inherit their element type's parser: registering a parser
 * for `date` (1082) leaves `date[]` (1182) on the driver's default, so the same
 * value read from a scalar column and from an array column would disagree by
 * the process offset. Every scalar temporal parser Turbine registers is
 * therefore registered in its array form too.
 *
 * `pg.types.arrayParser` is a public member of the `pg` module (it is what the
 * driver's own `_text` / `_date` parsers are built from), so this adds no
 * dependency. NULL elements stay `null` and are never handed to `element`.
 *
 * The empty-string guard mirrors pg's own `parseDateArray`, which opens
 * `if (!value) return null`. Turbine's copy did not, and answered `[]` where
 * the driver answers `null` for the same input. No column produces it (a SQL
 * NULL never reaches a parser, and an empty array is `{}`), so this is parity
 * for its own sake rather than a bug report; it matters because these parsers
 * are registered process-globally over pg's, and a shape where Turbine's
 * answer differs from the driver's is a difference somebody eventually finds
 * the hard way.
 */
export function createPgArrayParser(element: (text: string) => unknown): (text: string) => unknown[] | null {
  const arrayParser = pg.types.arrayParser as unknown as PgArrayParserModule;
  return (text: string): unknown[] | null =>
    text
      ? arrayParser.create(text, (entry) => (entry === null || entry === undefined ? null : element(entry))).parse()
      : null;
}

/**
 * A canonical wire value per OID, plus the JS value pg's OWN default text
 * parser produces from it, used to tell "still on the driver default" from
 * "somebody else already customized this OID" (see
 * {@link isDefaultTextParser}).
 *
 * The expected values are computed from LOCAL date components on purpose: pg's
 * default for the zone-less temporal OIDs builds its `Date` in the process's
 * zone (that is the reading `utcTimestamps` exists to replace), so the
 * expectation has to be computed the same way in whatever zone the process runs.
 */
const DEFAULT_PARSER_PROBES: Readonly<Record<number, { text: string; expected: () => unknown }>> = {
  20: { text: '9007199254740993', expected: () => '9007199254740993' },
  1082: { text: '2020-01-02', expected: () => new Date(2020, 0, 2) },
  1114: { text: '2020-01-02 03:04:05', expected: () => new Date(2020, 0, 2, 3, 4, 5) },
  1115: { text: '{"2020-01-02 03:04:05"}', expected: () => [new Date(2020, 0, 2, 3, 4, 5)] },
  1182: { text: '{2020-01-02}', expected: () => [new Date(2020, 0, 2)] },
  // The `timestamptz` pair carries an explicit offset, so unlike the four
  // above its expectation is NOT computed from local components: pg's default
  // and Turbine's fast scan produce the same instant in every zone. These two
  // probes are consulted by {@link registerFastTemporalParserIfDefault}, which
  // DECLINES to install rather than warning-and-overwriting.
  1184: { text: '2020-01-02 03:04:05+00', expected: () => new Date(Date.UTC(2020, 0, 2, 3, 4, 5)) },
  1185: { text: '{"2020-01-02 03:04:05+00"}', expected: () => [new Date(Date.UTC(2020, 0, 2, 3, 4, 5))] },
};

/**
 * Marks a text parser as one TURBINE installed, so a later registration in the
 * same process (a client plus `turbine studio`, ESM plus CJS copies of this
 * module) does not report Turbine's own parser as "somebody else's". A
 * `Symbol.for` key, for the same cross-copy-identity reason the warn registry
 * uses one.
 */
const TURBINE_PARSER = Symbol.for('turbine.typeParser');

/**
 * The OIDs the `utcTimestamps` flag governs, and so the ones it can opt out of.
 *
 * 1184 / 1185 are in the set because the flag gates their registration too,
 * but they are there for a different reason from the other four: those four
 * change a READING (local zone to UTC), while the `timestamptz` pair changes
 * only decode SPEED. See {@link registerUtcTemporalParsers}.
 */
const TEMPORAL_PARSER_OIDS: ReadonlySet<number> = new Set([1114, 1082, 1115, 1182, 1184, 1185]);

/** Tag `parser` as Turbine's own and return it (see {@link TURBINE_PARSER}). */
export function markTurbineParser<F extends (text: string) => unknown>(parser: F): F {
  (parser as unknown as Record<symbol, unknown>)[TURBINE_PARSER] = true;
  return parser;
}

/** Comparable rendering of a parser result (Date by instant, array by element). */
function parserResultSignature(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (value instanceof Date) return `date:${value.getTime()}`;
  if (Array.isArray(value)) return `[${value.map(parserResultSignature).join(',')}]`;
  return `${typeof value}:${String(value)}`;
}

/**
 * Is the parser currently registered for `oid` still pg's own default?
 *
 * DETECTED BY BEHAVIOUR, NOT BY IDENTITY, and deliberately so. `pg-types` keeps
 * its default parser table private: `getTypeParser` hands back whatever is
 * registered NOW, and there is no exported way to ask what the default WAS, so
 * a function-identity comparison would need a deep import of a file the package
 * does not publish as an entry point. Instead this runs the registered parser
 * over a canonical wire value and compares the result with what pg's default
 * produces for it.
 *
 * What that buys and what it costs, stated honestly:
 *   - Every parser that behaves OBSERVABLY differently on the probe value is
 *     detected, which is the case worth warning about (someone else's reading
 *     is about to be replaced by Turbine's).
 *   - A replacement that is observably EQUIVALENT on the probe is reported as
 *     the default and draws no warning. That is a false negative, and an
 *     acceptable one: if it agrees with the default here it is not a reading
 *     anybody would notice Turbine overwriting.
 *   - A parser that THROWS on the probe is reported as non-default; pg's own
 *     never throws on a valid value of its type.
 *   - An OID with no probe entry is reported as default (never warn on a guess).
 *
 * The registered parser is invoked once, on a synthetic value, at client
 * construction. A decode parser with side effects would be surprising, and pg's
 * own have none.
 */
export function isDefaultTextParser(oid: number, parser: (text: string) => unknown): boolean {
  const probe = DEFAULT_PARSER_PROBES[oid];
  if (!probe) return true;
  try {
    return parserResultSignature(parser(probe.text)) === parserResultSignature(probe.expected());
  } catch {
    return false;
  }
}

/**
 * Warn ONCE per OID when Turbine is about to replace a text parser that is not
 * pg's default, i.e. when some other module in the process has already
 * customized it.
 *
 * `pg.types.setTypeParser` is process-global and retroactive: it changes how
 * every `pg.Pool` in the process decodes that OID, including pools that were
 * constructed and were already querying before the Turbine client existed. When
 * the OID was still on pg's default that is the documented, intended trade (the
 * whole point of `utcTimestamps`). When somebody else had already installed
 * their own reading, Turbine is silently rewriting an expectation it cannot see
 * the origin of, and the resulting bug is order-dependent: which reading wins
 * depends on module evaluation order, which lazy route imports make unstable
 * between requests. So say it out loud, once.
 *
 * NOT DEV-ONLY. It used to go quiet under `NODE_ENV=production`, along with
 * every other dev warning, and that was the wrong rule for THIS one, for the
 * same reason the temporal-infinity warning (builder.ts `warnTemporalInfinity`)
 * is not dev-only either. A parser overwrite is ORDER-DEPENDENT: which module
 * calls `setTypeParser` last decides the reading, and evaluation order is
 * exactly what differs between a dev process (eager imports, one route
 * exercised at a time) and a production one (bundled or lazily imported routes,
 * warmed in whatever order traffic arrives). So a process can be clean in dev
 * and wrong in production purely from import order, which makes production the
 * case that matters MOST, and it was the case that was silent. The cost is
 * bounded to the point of irrelevance: once per OID per process, at client
 * construction, and only when somebody else's non-default parser is actually
 * being replaced.
 */
export function warnParserOverwrite(oid: number, typeName: string, logger: TurbineLogger = consoleLogger): void {
  const getParser = pg.types.getTypeParser as unknown as (oid: number, format: 'text') => (value: string) => unknown;
  const current = getParser(oid, 'text');
  // Turbine's own earlier registration is not a third party's expectation.
  if ((current as unknown as Record<symbol, unknown>)[TURBINE_PARSER]) return;
  if (isDefaultTextParser(oid, current)) return;
  if (!shouldWarnOnce(WARN_NS.parserOverwrite, String(oid))) return;
  // The `utcTimestamps: false` opt-out only governs the six TEMPORAL OIDs.
  // Offering it as the remedy for int8 (20) would name a setting that does
  // nothing for the OID being warned about; that registration has no opt-out.
  // (1184 / 1185 never reach this warning at all: they DECLINE over a
  // non-default parser instead of overwriting it. They are named in the
  // sentence because it describes what the flag leaves alone.)
  const remedy = TEMPORAL_PARSER_OIDS.has(oid)
    ? ' `utcTimestamps: false` leaves the six temporal OIDs (1114, 1082, 1115, 1182, 1184, 1185) alone entirely.'
    : ' There is no opt-out for this OID: Turbine registers it so bigint values come back as numbers.';
  logTo(
    logger,
    'warn',
    `pg type parser for OID ${oid} (${typeName}) was already customized by something else in this ` +
      'process, and Turbine is replacing it. `pg.types.setTypeParser` is process-global and takes effect ' +
      'immediately for EVERY pg.Pool in the process, including pools that already exist and are already ' +
      'querying, so whatever set that parser will now read this column differently. If yours should win, ' +
      `register it AFTER constructing the client.${remedy} This warning fires under \`NODE_ENV=production\` ` +
      'too: which parser wins depends on module evaluation order, so a process can be clean in dev and wrong ' +
      'in production from import order alone.',
    { code: 'parser-overwrite', oid, type: typeName },
  );
}

/**
 * Register Turbine's temporal text parsers on the pg module. SIX OIDs, doing
 * two different jobs:
 *
 *   1114 / 1082 / 1115 / 1182   the UTC READING of the zone-less types,
 *                               `timestamp`, `date` and their array forms.
 *                               This changes what a column means and is what
 *                               `utcTimestamps` is named for.
 *   1184 / 1185                 the fast decode path for `timestamptz` and
 *                               `timestamptz[]`. This changes NOTHING about
 *                               what a column means: an offset-carrying value
 *                               has one instant and this reads the same one.
 *                               It is here for speed, `timestamptz` being ~88%
 *                               of the client-side decode cost of a wide row
 *                               drain, and it DECLINES rather than overwrites
 *                               (see the comment at the call site).
 *
 * ONE place, because `pg.types.setTypeParser` is process-global and the pairing
 * matters: registering a scalar without its array form, or a `date` without the
 * `timestamp` beside it, produces two columns of the same row disagreeing about
 * what the same wire text means. Both callers are processes Turbine owns the
 * pg module in: `TurbineClient` on a pool it created (never on an external
 * pool, whose parser configuration belongs to the caller), and `turbine studio`,
 * which builds a raw pool of its own and must render what the application sees.
 *
 * Each fallback is read BEFORE its parser is installed, so an unrecognised wire
 * value (`infinity`, and whatever a future server adds) still reaches the
 * driver's own parser.
 *
 * Registration is RETROACTIVE for the whole process, pools included that were
 * created and are already querying (there is one parser table, and it is read
 * per row at decode time, not captured per pool). If any of the four OIDs is
 * already on a NON-default parser, {@link warnParserOverwrite} says so once.
 */
export function registerUtcTemporalParsers(logger?: TurbineLogger): void {
  // pg-types declares get/setTypeParser over its own OID enum, which lists the
  // scalar types only. The array OIDs are just as real, so both calls are
  // retyped over a plain number rather than the incomplete enum.
  const getParser = pg.types.getTypeParser as unknown as (oid: number, format: 'text') => (value: string) => unknown;
  const setParser = pg.types.setTypeParser as unknown as (oid: number, parse: (value: string) => unknown) => void;
  warnParserOverwrite(1114, 'timestamp', logger);
  warnParserOverwrite(1082, 'date', logger);
  warnParserOverwrite(1115, 'timestamp[]', logger);
  warnParserOverwrite(1182, 'date[]', logger);
  const parseDate = createUtcDateParser(getParser(1082, 'text'));
  const parseTimestamp = createUtcTimestampParser(getParser(1114, 'text'));
  setParser(1114, markTurbineParser(parseTimestamp));
  setParser(1082, markTurbineParser(parseDate));
  // Array OIDs do not inherit their element parser, so `date[]` / `timestamp[]`
  // would otherwise keep returning local-zone Dates while the scalar columns
  // beside them returned UTC ones.
  setParser(1182, markTurbineParser(createPgArrayParser(parseDate)));
  setParser(1115, markTurbineParser(createPgArrayParser(parseTimestamp)));
  // `timestamptz` (1184) and `timestamptz[]` (1185). SPEED ONLY: an offset-
  // carrying value has exactly one instant, and this reads it as the same
  // instant `postgres-date` does, so nothing here changes what a column means.
  //
  // Two things about it are deliberate and neither is obvious.
  //
  // It is gated behind `utcTimestamps` along with the other four, even though
  // that flag is about a READING and this is not. The alternative was a second
  // registration site outside this function, and one process-global parser
  // table with two places that write to it is the exact shape the "ONE place"
  // rule above exists to prevent. So the flag reads as "leave pg's temporal
  // parser table alone", and `utcTimestamps: false` costs the optimisation as
  // well as the UTC reading. That is a documented cost, not an oversight.
  //
  // And it DECLINES rather than overwrites (see
  // {@link registerFastTemporalParserIfDefault}), which is the opposite of what
  // the four above do. They MUST overwrite: they exist to replace a reading,
  // and a process where half the temporal columns read local and half read UTC
  // is broken. This one exists only to be faster, so a caller who installed
  // their own `timestamptz` parser (to get strings, or Luxon objects, or a
  // Temporal instant) keeps it. Overwriting them would trade their correctness
  // for speed. Preserving that parser also preserves the behavior from before
  // Turbine registered a default parser for 1184.
  const parseTimestamptz = registerFastTemporalParserIfDefault(1184, createFastTimestamptzParser);
  if (parseTimestamptz) {
    registerFastTemporalParserIfDefault(1185, () => createPgArrayParser(parseTimestamptz));
  }
}

/**
 * Install a SPEED-ONLY parser for `oid`, but only over pg's own default (or
 * over a parser Turbine itself installed earlier in this process).
 *
 * Returns the installed parser, or `undefined` when it declined, so a caller
 * can hold a scalar and its array form to the same decision: registering the
 * array half over a caller's customized scalar half would make the two
 * disagree, which is worse than leaving both slow.
 *
 * `build` receives the parser being replaced, which becomes the fast path's
 * fallback. That is only sound because the parser being replaced is known to
 * be pg's default (or Turbine's own wrapper around it); the check below is
 * what makes it so, and is not an optimisation of it.
 */
function registerFastTemporalParserIfDefault(
  oid: number,
  build: (fallback: (text: string) => unknown) => (text: string) => unknown,
): ((text: string) => unknown) | undefined {
  const getParser = pg.types.getTypeParser as unknown as (oid: number, format: 'text') => (value: string) => unknown;
  const setParser = pg.types.setTypeParser as unknown as (oid: number, parse: (value: string) => unknown) => void;
  const current = getParser(oid, 'text');
  const isTurbines = (current as unknown as Record<symbol, unknown>)[TURBINE_PARSER] === true;
  if (!isTurbines && !isDefaultTextParser(oid, current)) return undefined;
  const parser = markTurbineParser(build(current));
  setParser(oid, parser);
  return parser;
}

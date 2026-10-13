/**
 * Every place an engine is ALLOWED to answer differently from Postgres. Nothing
 * outside this file is skipped or relaxed, and every entry is checked in both
 * directions: an entry whose difference has disappeared fails the battery and
 * asks to be deleted, so the list cannot rot.
 *
 * Two lists.
 *
 * SCENARIOS, keyed by engine and scenario id:
 *   unsupported  The engine refuses the shape with UnsupportedFeatureError
 *                (E017). The battery asserts the E017.
 *   difference   A documented, intended semantic difference. With
 *                `relax: 'unordered'` only row ORDER may differ and the rows
 *                are still compared exactly; without it, the results must
 *                still differ.
 *   bug          A divergence that is a defect waiting for its fix. The results
 *                must still differ; when the fix lands the entry fails.
 *
 * REPRESENTATIONS, keyed by engine and column field name: one value written a
 * different way, such as a boolean read back as 0/1. A representation entry
 * accepts exactly that pair of leaves, only under the named fields, and must be
 * used at least once per run. It exists so a type-level defect that touches
 * every row does not drown out the semantic differences in the same results:
 * the defect is still reported, once, by name.
 */

import { leafString, type ReprRule, type Tagged } from './compare.js';
import type { EngineName } from './harness.js';

type Engine = Exclude<EngineName, 'postgres'>;

export interface ScenarioEntry {
  engine: Engine;
  scenario: string;
  kind: 'unsupported' | 'difference' | 'bug';
  relax?: 'unordered';
  /** Why, in one or two sentences. For a bug: what is wrong. */
  note: string;
}

export interface RepresentationEntry {
  engine: Engine;
  id: string;
  kind: 'difference' | 'bug';
  /** Property names (the last path segment) the rule may apply under. */
  fields: readonly string[];
  accept: ReprRule['accept'];
  note: string;
}

// --- representation predicates ------------------------------------------------

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** `true` / `false` read back as `1` / `0`. */
const booleanAsInteger: ReprRule['accept'] = (o, e) =>
  (o === 'bool:true' && e === 'num:1') || (o === 'bool:false' && e === 'num:0');

/** A JSON object or array read back as its JSON text. The text is decoded and compared. */
const jsonAsText: ReprRule['accept'] = (o, e) => {
  if (typeof o === 'string') return false;
  const text = leafString(e);
  if (text === undefined) return false;
  try {
    return tagJson(JSON.parse(text));
  } catch {
    return false;
  }
};

/** A numeric (decimal string) read back as a JS number. Equal when the number is the decimal's nearest double. */
const numericAsNumber: ReprRule['accept'] = (o, e) => {
  const decimal = leafString(o);
  if (decimal === undefined || !DECIMAL.test(decimal) || typeof e !== 'string' || !e.startsWith('num:')) return false;
  return Number(decimal) === Number(e.slice(4));
};

/** A numeric decimal string padded with trailing fractional zeros: `12.34` read back as `12.340000`. */
const numericPaddedScale: ReprRule['accept'] = (o, e) => {
  const a = leafString(o);
  const b = leafString(e);
  if (a === undefined || b === undefined || !DECIMAL.test(a) || !DECIMAL.test(b)) return false;
  const trim = (d: string) => (d.includes('.') ? d.replace(/0+$/, '').replace(/\.$/, '') : d);
  return trim(a) === trim(b);
};

/** A bigint the oracle returns as an exact decimal string, read back as the nearest JS number. */
const bigintAsLossyNumber: ReprRule['accept'] = (o, e) => {
  const digits = leafString(o);
  if (digits === undefined || !/^-?\d+$/.test(digits) || typeof e !== 'string' || !e.startsWith('num:')) return false;
  return Number(digits) === Number(e.slice(4));
};

/** A timestamp within one SQL Server DATETIME tick (1/300 s) of the oracle's. */
const datetimeTick: ReprRule['accept'] = (o, e) => {
  if (typeof o !== 'string' || typeof e !== 'string' || !o.startsWith('date:') || !e.startsWith('date:')) return false;
  const delta = Math.abs(Date.parse(o.slice(5)) - Date.parse(e.slice(5)));
  return delta > 0 && delta <= 10 / 3;
};

/** A uuid read back in upper case. */
const uuidUpperCase: ReprRule['accept'] = (o, e) => {
  const a = leafString(o);
  const b = leafString(e);
  return a !== undefined && b !== undefined && a !== b && a.toUpperCase() === b;
};

function tagJson(value: unknown): Tagged {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map(tagJson);
  if (typeof value === 'object') {
    const out: { [key: string]: Tagged } = {};
    for (const key of Object.keys(value as object).sort()) out[key] = tagJson((value as Record<string, unknown>)[key]);
    return out;
  }
  if (typeof value === 'string') return `str:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `bool:${value}`;
  return `num:${value}`;
}

const BOOLEAN_FIELDS = ['active', 'published'] as const;
const JSON_FIELDS = ['prefs', 'meta'] as const;
const NUMERIC_FIELDS = ['balance'] as const;

export const REPRESENTATIONS: readonly RepresentationEntry[] = [
  {
    engine: 'sqlite',
    id: 'sqlite-boolean-as-integer',
    kind: 'bug',
    fields: BOOLEAN_FIELDS,
    accept: booleanAsInteger,
    note: 'boolean columns read back as 0/1 on every read path, though the generated type is boolean.',
  },
  {
    engine: 'sqlite',
    id: 'sqlite-json-as-text',
    kind: 'bug',
    fields: JSON_FIELDS,
    accept: jsonAsText,
    note: 'json/jsonb columns read back as JSON text instead of the parsed value.',
  },
  {
    engine: 'sqlite',
    id: 'sqlite-numeric-as-number',
    kind: 'bug',
    fields: NUMERIC_FIELDS,
    accept: numericAsNumber,
    note: 'numeric columns read back as a JS number, so a value past double precision is rounded (Postgres returns the exact decimal string).',
  },
  {
    engine: 'mysql',
    id: 'mysql-numeric-padded-scale',
    kind: 'bug',
    fields: NUMERIC_FIELDS,
    accept: numericPaddedScale,
    note: 'numeric columns are created as DECIMAL(65,30), so every value reads back with 30 fractional digits (12.34 becomes 12.340000000000000000000000000000).',
  },
  {
    engine: 'mysql',
    id: 'mysql-nested-bigint-as-number',
    kind: 'bug',
    fields: ['big'],
    accept: bigintAsLossyNumber,
    note: 'a bigint read through a `with` relation arrives as a JS number, so 9007199254740993 reads back as 9007199254740992; top-level reads keep the exact string.',
  },
  {
    engine: 'mssql',
    id: 'mssql-json-as-text',
    kind: 'bug',
    fields: JSON_FIELDS,
    accept: jsonAsText,
    note: 'json columns are created as NVARCHAR(MAX) and read back as JSON text instead of the parsed value.',
  },
  {
    engine: 'mssql',
    id: 'mssql-numeric-as-number',
    kind: 'bug',
    fields: NUMERIC_FIELDS,
    accept: numericAsNumber,
    note: 'numeric columns, and _sum/_min/_max over them, read back as a JS number, so a value past double precision is rounded.',
  },
  {
    engine: 'mssql',
    id: 'mssql-nested-bigint-as-number',
    kind: 'bug',
    fields: ['big'],
    accept: bigintAsLossyNumber,
    note: 'on the join strategy a bigint inside FOR JSON PATH is emitted as a JSON number, so 9007199254740993 reads back as 9007199254740992; top-level and batched reads keep the exact string.',
  },
  {
    engine: 'mssql',
    id: 'mssql-datetime-tick',
    kind: 'bug',
    fields: ['createdAt', 'publishedAt'],
    accept: datetimeTick,
    note: 'a JS Date is bound without a type, which the driver sends as DATETIME (1/300 s ticks), so milliseconds are rounded on write: 23:59:59.999 is stored as the next day 00:00:00.000.',
  },
  {
    engine: 'mssql',
    id: 'mssql-uuid-upper-case',
    kind: 'difference',
    fields: ['token'],
    accept: uuidUpperCase,
    note: 'UNIQUEIDENTIFIER reads back in upper case; comparisons are case-insensitive, so filters still match.',
  },
];

// NULL placement without an explicit `nulls`: Postgres sorts NULL last
// ascending and first descending; SQLite, MySQL and SQL Server treat NULL as the
// smallest value. Only the order of the NULL rows may differ.
const nullOrder = (engine: Engine): ScenarioEntry[] =>
  ['order/nullable-asc', 'order/nullable-desc', 'order/double-desc-nullable'].map((scenario) => ({
    engine,
    scenario,
    kind: 'difference',
    relax: 'unordered',
    note: 'default NULL placement differs from Postgres; pass `nulls` where the engine supports it.',
  }));

export const SCENARIO_ENTRIES: readonly ScenarioEntry[] = [
  // --- sqlite ---
  ...nullOrder('sqlite'),
  {
    engine: 'sqlite',
    scenario: 'where/contains-case-sensitive',
    kind: 'difference',
    note: 'SQLite LIKE is ASCII case-insensitive, so contains/startsWith/endsWith match across case without mode: insensitive.',
  },
  // --- mysql ---
  ...nullOrder('mysql'),
  ...['order/nulls-first', 'order/nulls-last-desc'].map(
    (scenario): ScenarioEntry => ({
      engine: 'mysql',
      scenario,
      kind: 'unsupported',
      note: 'MySQL has no NULLS FIRST/LAST, so an explicit `nulls` is refused.',
    }),
  ),
  ...[
    'where/equals-other-case',
    'where/equals-unaccented',
    'where/contains-case-sensitive',
    'where/not-text-nullable',
  ].map(
    (scenario): ScenarioEntry => ({
      engine: 'mysql',
      scenario,
      kind: 'difference',
      note: "MySQL's default collation (utf8mb4_0900_ai_ci) compares text case- and accent-insensitively.",
    }),
  ),
  {
    engine: 'mysql',
    scenario: 'write/update-divide-int',
    kind: 'bug',
    note: 'integer divide rounds half away from zero on an INT column (75 / 2 = 38); Postgres truncates to 37.',
  },
  // --- mssql ---
  ...nullOrder('mssql'),
  ...['order/nulls-first', 'order/nulls-last-desc'].map(
    (scenario): ScenarioEntry => ({
      engine: 'mssql',
      scenario,
      kind: 'unsupported',
      note: 'SQL Server has no NULLS FIRST/LAST, so an explicit `nulls` is refused.',
    }),
  ),
  ...['where/equals-other-case', 'where/contains-case-sensitive', 'where/not-text-nullable'].map(
    (scenario): ScenarioEntry => ({
      engine: 'mssql',
      scenario,
      kind: 'difference',
      note: "SQL Server's default collation compares text case-insensitively (accents still count).",
    }),
  ),
  {
    engine: 'mssql',
    scenario: 'where/timestamp-range',
    kind: 'bug',
    note: 'the DATETIME rounding (mssql-datetime-tick) stores 2025-12-31T23:59:59.999Z as 2026-01-01T00:00:00.000Z, which moves the row inside the range.',
  },
  {
    engine: 'mssql',
    scenario: 'with/depth-2-options-join',
    kind: 'bug',
    note: 'an array-form orderBy inside a relation is refused on the join strategy with E003 naming field "0"; the batched strategy accepts the same query.',
  },
  {
    engine: 'mssql',
    scenario: 'agg/group-by-boolean',
    kind: 'bug',
    note: '`_avg` over an integer column truncates (AVG of INT is INT on SQL Server): 56 where Postgres returns 56.4.',
  },
  {
    engine: 'mssql',
    scenario: 'write/create-many-bigint-mixed',
    kind: 'bug',
    note: 'createMany binds a bigint past 2^53 as text and a small one as int; SQL Server types the VALUES column as int and fails with an unwrapped RequestError ("overflowed an int column").',
  },
  {
    engine: 'mssql',
    scenario: 'write/upsert-existing',
    kind: 'bug',
    note: 'upsert with an atomic `increment` in `update` emits an unqualified column in the MERGE and fails with an unwrapped RequestError ("Ambiguous column name").',
  },
  // --- powdb ---
  ...[
    'where/numeric-gt',
    'where/numeric-equals-scale',
    'order/numeric',
    'agg/sum-numeric',
    'agg/min-max-numeric',
    'write/update-increment-numeric',
  ].map(
    (scenario): ScenarioEntry => ({
      engine: 'powdb',
      scenario,
      kind: 'unsupported',
      note: 'PowDB stores numeric as text, so comparisons, ordering, aggregates and arithmetic on it are refused.',
    }),
  ),
  ...['where/contains-percent', 'where/contains-underscore'].map(
    (scenario): ScenarioEntry => ({
      engine: 'powdb',
      scenario,
      kind: 'unsupported',
      note: 'PowQL `like` has no escape character, so `contains` with `%` or `_` in the value is refused.',
    }),
  ),
  { engine: 'powdb', scenario: 'order/nulls-first', kind: 'unsupported', note: 'PowDB always orders NULLs last.' },
  {
    engine: 'powdb',
    scenario: 'order/relation-count',
    kind: 'unsupported',
    note: 'relation `_count` ordering is refused.',
  },
  {
    engine: 'powdb',
    scenario: 'page/cursor',
    kind: 'unsupported',
    note: 'cursor pagination is refused; use limit/offset.',
  },
  ...['order/nullable-desc', 'order/double-desc-nullable'].map(
    (scenario): ScenarioEntry => ({
      engine: 'powdb',
      scenario,
      kind: 'difference',
      relax: 'unordered',
      note: 'PowDB orders NULLs last in both directions; Postgres puts them first when descending.',
    }),
  ),
  {
    engine: 'powdb',
    scenario: 'with/relation-count',
    kind: 'bug',
    note: '`with: { _count: {...} }` throws ValidationError E003 "Unknown relation _count"; it should run or refuse with E017.',
  },
  {
    engine: 'powdb',
    scenario: 'agg/sum-bigint',
    kind: 'bug',
    note: '`_sum` of a bigint column returns a JS number (Postgres returns the exact decimal string), so a sum past 2^53 loses precision.',
  },
  {
    engine: 'powdb',
    scenario: 'where/date-equals-iso-string',
    kind: 'bug',
    note: 'an ISO date string compared with a date column throws ValidationError E003; Postgres and the SQL engines accept it.',
  },
  {
    engine: 'powdb',
    scenario: 'write/update-set-null-and-json',
    kind: 'bug',
    note: 'an object written to a json column by `update` is read as an atomic operator and refused with E003 ("Unsupported update operator").',
  },
  {
    engine: 'sqlite',
    scenario: 'where/date-equals-iso-string',
    kind: 'bug',
    note: "a date column compared with an ISO date string ('2000-02-29') matches nothing: the column holds the bound Date's full ISO timestamp text.",
  },
  {
    engine: 'sqlite',
    scenario: 'write/update-divide-int',
    kind: 'bug',
    note: 'integer divide stores a fraction (75 / 2 = 37.5) in an INTEGER column; Postgres truncates to 37.',
  },
];

export function scenarioEntry(engine: EngineName, scenario: string): ScenarioEntry | undefined {
  return SCENARIO_ENTRIES.find((e) => e.engine === engine && e.scenario === scenario);
}

/** The representation rules for one engine, as `Comparison` rules scoped to their fields. */
export function representationRules(engine: EngineName): ReprRule[] {
  return REPRESENTATIONS.filter((r) => r.engine === engine).map((r) => ({
    id: r.id,
    fields: r.fields,
    accept: r.accept,
  }));
}

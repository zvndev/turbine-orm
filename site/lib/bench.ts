import results from './bench-results.json';

/**
 * The benchmark page reads every figure from one file, bench-results.json, a
 * copy of benchmarks/results-<version>.json written by the benchmark run. No
 * number on the page is typed by hand.
 */

export type Library = 'turbine' | 'drizzle' | 'prisma';

export interface Scenario {
  id: string;
  label: string;
  turbine: number;
  drizzle: number;
  prisma: number;
  control: number | null;
  tie: boolean;
}

export interface NetworkRow {
  scenario: string;
  fasterArm: string;
  faster: number;
  slowerArm: string;
  slower: number;
  ratio: number;
}

export interface BenchResults {
  version: string;
  date: string;
  env: {
    machine: string;
    node: string;
    postgres: string;
    pgDriver: string;
    drizzle: string;
    drizzleRc: string;
    prisma: string;
    rounds: number;
    warmup: number;
    runs: number;
  };
  core: Scenario[];
  extended: Scenario[];
  geomean: {
    overheadVsControl: Record<Library, number> & { scenarios: number };
    ratioToFastest: Record<Library, number> & { scenarios: number };
  };
  streaming: { arm: string; library: Library | 'control'; median: number }[];
  deepPagination: { turbine: number; turbineForceCustomPlan: number; drizzle: number; prisma: number; control?: number };
  latency: { rtt: number[]; turbinePipeline: number[]; drizzleTransaction: number[]; prismaTransaction: number[] };
  network: { rttMedian: number; postgres: string; rows: NetworkRow[] } | null;
}

/** Labels in the results file mark code with backticks; the charts show plain text. */
function plain(list: Scenario[]): Scenario[] {
  return list.map((s) => ({ ...s, label: s.label.replace(/`/g, '') }));
}

const raw = results as BenchResults;
export const BENCH: BenchResults = { ...raw, core: plain(raw.core), extended: plain(raw.extended) };

/** Chart colours, validated for colour-vision deficiency on the dark surface. */
export const LIBRARIES: { key: Library; name: string; color: string; shape: 'circle' | 'square' | 'diamond' }[] = [
  { key: 'turbine', name: 'Turbine', color: '#698eef', shape: 'circle' },
  { key: 'drizzle', name: 'Drizzle', color: '#7fa32a', shape: 'square' },
  { key: 'prisma', name: 'Prisma', color: '#009a9b', shape: 'diamond' },
];

export const CONTROL_NAME = 'hand-written pg';
export const CONTROL_COLOR = '#8a93a6';

/** Which part of an app a scenario stands for, in reading order. */
const GROUPS: { name: string; match: RegExp }[] = [
  { name: 'Reads', match: /^(findMany, \d|findUnique by|hot findUnique|count|list page|stream)/ },
  { name: 'Nested relations', match: /(\+|_count|relation filter|many-to-many|to-one)/ },
  { name: 'Writes', match: /(increment|createMany|update|upsert|delete)/ },
  { name: 'Batches and aggregates', match: /(pipeline|groupBy|first query)/ },
];

export function groupScenarios(list: Scenario[]): { name: string; rows: Scenario[] }[] {
  const out = GROUPS.map((g) => ({ name: g.name, rows: [] as Scenario[] }));
  const other = { name: 'Other', rows: [] as Scenario[] };
  for (const s of list) {
    // A nested read like "findMany, 50 users + posts" belongs with relations, so test that first.
    const i = /\+/.test(s.label) ? 1 : GROUPS.findIndex((g) => g.match.test(s.label));
    (i >= 0 ? out[i] : other).rows.push(s);
  }
  return [...out, other].filter((g) => g.rows.length > 0);
}

/** "+8%" from a ratio of 1.08. */
export function overheadPercent(ratio: number): string {
  return `+${Math.round((ratio - 1) * 100)}%`;
}

/** Milliseconds with enough digits to compare, never more than three decimals. */
export function ms(v: number): string {
  if (v >= 100) return v.toFixed(1);
  if (v >= 10) return v.toFixed(2);
  return v.toFixed(3);
}

export function ratio(v: number): string {
  return `${v >= 10 ? v.toFixed(1) : v.toFixed(2)}x`;
}

/** The fastest of the three libraries on a scenario. */
export function winner(s: Scenario): Library {
  return LIBRARIES.map((l) => l.key).reduce((a, b) => (s[b] < s[a] ? b : a));
}

export function measuredOn(): string {
  const d = new Date(`${BENCH.date}T00:00:00Z`);
  const month = d.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return `Turbine ${BENCH.version}, ${month} ${d.getUTCFullYear()}`;
}

/** How many times longer a library takes than Turbine, by geometric mean over the main scenarios. */
export function timesTurbine(key: 'drizzle' | 'prisma'): number {
  const g = BENCH.geomean.ratioToFastest;
  return g[key] / g.turbine;
}

/** "1.4x" or "2.1x": one decimal, the precision the run supports. */
export function shortRatio(v: number): string {
  return `${v.toFixed(1)}x`;
}

/** The one-line speed claim the site repeats: metadata, share card, landing page. */
export const SPEED_CLAIM = `${shortRatio(timesTurbine('drizzle'))} faster than Drizzle and ${shortRatio(
  timesTurbine('prisma'),
)} faster than Prisma`;

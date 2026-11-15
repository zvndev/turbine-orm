/**
 * The interleaved benchmark harness, shared by `bench-interleaved.ts` (the headline
 * scenarios) and `bench-extended.ts` (everything the headline set does
 * not reach: large result sets, list pages, to-one and many-to-many relations,
 * aggregation, relation filters, writes, wide rows, strategies, cold start).
 *
 * Why interleaved: measuring each arm in a contiguous block attributes any
 * drift over the life of the process (JIT state, page cache, autovacuum,
 * thermal) to whichever arm happened to occupy that slice of wall clock. Here
 * every arm runs ONCE PER ROUND with the arm order rotated each round, and the
 * MEDIAN across rounds is reported.
 *
 * It was extracted rather than copied. Two harnesses would drift, and a
 * benchmark whose two halves measure slightly differently is worse than one
 * that measures fewer things.
 */

export interface Arm {
  name: string;
  /** The measured call; observeRow is supplied only by the untimed stream verifier. */
  fn: (i: number, observeRow?: (row: unknown) => void) => Promise<unknown>;
  /**
   * Untimed preparation for this round, run immediately before `fn`. This is
   * what makes destructive scenarios measurable: a delete benchmark needs a row
   * to delete and a bulk-insert benchmark needs an empty table, and neither of
   * those is the thing being measured.
   */
  setup?: (i: number) => Promise<unknown>;
  /** Untimed exact-result/effect verification after every warmup and measured call. */
  verify?: (value: unknown, i: number) => Promise<void>;
}

export interface ArmStat {
  name: string;
  median: number;
  avg: number;
  p95: number;
  min: number;
  n: number;
  /** Execution-order durations; warmup/setup excluded. Present only when opted in. */
  samplesMs?: number[];
  p99?: number | null;
  p99Status?: 'unavailable-small-n' | 'unstable-tail' | 'estimated';
  sampleMethod?: {
    unit: 'ms';
    p50: 'arithmetic median';
    p95: 'nearest-rank';
    p99: 'nearest-rank';
    scope: 'individual arm calls';
  };
}

export interface ScenarioResult {
  scenario: string;
  stats: ArmStat[];
  /** Free-text caveat printed with the scenario and carried into the JSON dump. */
  note?: string;
}

export function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  return n % 2 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

export function pct(sorted: number[], p: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]!;
}

/** Summarize actual samples only; never combine per-arm medians into percentiles. */
export function summarizeSamples(name: string, samples: readonly number[], retainSamples = false): ArmStat {
  if (!samples.length || samples.some((n) => !Number.isFinite(n) || n < 0))
    throw new Error('Expected nonempty finite nonnegative duration samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    name,
    median: median(sorted),
    avg: sorted.reduce((a, b) => a + b, 0) / n,
    p95: pct(sorted, 0.95),
    min: sorted[0]!,
    n,
    p99: n >= 100 ? pct(sorted, 0.99) : null,
    p99Status: n < 100 ? 'unavailable-small-n' : n < 1000 ? 'unstable-tail' : 'estimated',
    sampleMethod: {
      unit: 'ms',
      p50: 'arithmetic median',
      p95: 'nearest-rank',
      p99: 'nearest-rank',
      scope: 'individual arm calls',
    },
    ...(retainSamples ? { samplesMs: [...samples] } : {}),
  };
}

export interface BenchOptions {
  rounds: number;
  warmup: number;
  retainSamples?: boolean;
}

export interface InterleaveOptions {
  retainSamples?: boolean;
  rounds?: number;
  warmup?: number;
  /**
   * Stated with the scenario when the arms are NOT doing identical work, so a
   * reader never has to infer it from the numbers. A scenario that needs one of
   * these is still worth measuring; silently reporting it as a like-for-like
   * comparison is not.
   */
  note?: string;
}

export class Bench {
  readonly results: ScenarioResult[] = [];
  readonly probes: { label: string; stats: ArmStat }[] = [];

  constructor(private readonly opts: BenchOptions) {}

  async interleave(scenario: string, arms: Arm[], options: InterleaveOptions = {}): Promise<ArmStat[]> {
    const rounds = options.rounds ?? this.opts.rounds;
    const warmup = options.warmup ?? this.opts.warmup;

    for (const arm of arms) {
      for (let i = 0; i < warmup; i++) {
        if (arm.setup) await arm.setup(i);
        const value = await arm.fn(i);
        if (arm.verify) await arm.verify(value, i);
      }
    }

    const samples = new Map<string, number[]>();
    for (const a of arms) samples.set(a.name, []);

    for (let r = 0; r < rounds; r++) {
      const offset = r % arms.length; // rotate arm order every round
      for (let k = 0; k < arms.length; k++) {
        const arm = arms[(k + offset) % arms.length]!;
        if (arm.setup) await arm.setup(r);
        const start = performance.now();
        const value = await arm.fn(r);
        samples.get(arm.name)!.push(performance.now() - start);
        if (arm.verify) await arm.verify(value, r);
      }
    }

    const retain = options.retainSamples ?? this.opts.retainSamples ?? process.env.BENCH_RETAIN_SAMPLES === '1';
    const stats = arms.map((a) => summarizeSamples(a.name, samples.get(a.name)!, retain));

    this.results.push({ scenario, stats, note: options.note });
    print(scenario, stats, options.note);
    return stats;
  }

  /**
   * `SELECT 1` median, run at the head and tail of a suite. The spread between
   * the probes is the residual drift floor: any difference between arms smaller
   * than it is not a result.
   */
  async driftProbe(pool: { query: (sql: string) => Promise<unknown> }, label: string): Promise<number> {
    for (let i = 0; i < 500; i++) await pool.query('SELECT 1'); // warm, never measured
    const s: number[] = [];
    for (let i = 0; i < 500; i++) {
      const t = performance.now();
      await pool.query('SELECT 1');
      s.push(performance.now() - t);
    }
    const retain = this.opts.retainSamples ?? process.env.BENCH_RETAIN_SAMPLES === '1';
    const stats = summarizeSamples('SELECT 1', s, retain);
    if (retain) this.probes.push({ label, stats });
    const m = stats.median;
    console.log(`\n[drift probe ${label}] SELECT 1 median ${m.toFixed(4)} ms (n=500)`);
    return m;
  }

  reportDrift(probes: number[]): void {
    const spread = ((Math.max(...probes) - Math.min(...probes)) / Math.min(...probes)) * 100;
    console.log(
      `\n[drift floor] SELECT 1 median ${probes.map((p) => p.toFixed(4)).join(' / ')} ms = ${spread.toFixed(1)}% spread over the suite`,
    );
  }
}

export function print(scenario: string, stats: ArmStat[], note?: string): void {
  console.log(`\n-- ${scenario} --`);
  if (note) console.log(`  note: ${note}`);
  console.log('  arm            median      avg      p95      min');
  const isRaw = (s: ArmStat) => /^(?:Raw(?:$|\s)|raw pg)/i.test(s.name);
  const ormStats = stats.filter((s) => !isRaw(s));
  const fastest = ormStats.length > 0 ? ormStats.reduce((a, b) => (a.median < b.median ? a : b)) : undefined;
  for (const s of stats) {
    const f = (n: number) => n.toFixed(3).padStart(8);
    const mark = s === fastest ? ' <= fastest ORM' : '';
    console.log(`  ${s.name.padEnd(12)} ${f(s.median)} ${f(s.avg)} ${f(s.p95)} ${f(s.min)}${mark}`);
  }
  const raw = stats.find(isRaw);
  if (raw) {
    for (const s of ormStats) {
      console.log(
        `    ${s.name} overhead above raw: +${(s.median - raw.median).toFixed(3)} ms (${(s.median / raw.median).toFixed(2)}x)`,
      );
    }
  }
}

/**
 * Turn one benchmark round's logs into the site's results file.
 *
 *   npx tsx build-results.ts env <outdir>     capture versions + machine into <outdir>/env.json
 *   npx tsx build-results.ts build <outdir>   read <outdir>/*.log + env.json, write <outdir>/results.json
 *
 * `run-round.sh` calls `env` before the first run and `build` after the last.
 * They are separate so that `build` is a pure function of the directory: the
 * same logs always produce the same results.json, byte for byte, and a round
 * can be rebuilt later (after a fix to this file) without re-measuring.
 *
 * Every published figure is the MEDIAN OF THE RUNS' MEDIANS, per arm per
 * scenario. The output shape is `BenchResults` in site/lib/bench.ts, the file
 * the benchmarks page reads every number from; `assertShape` below refuses to
 * write a file that page would misread.
 *
 * Environment is read, never typed: library versions from the installed
 * packages under node_modules, Postgres from `pg_settings` and `version()`
 * (plain reads, no session state is changed), the machine from the host
 * (/proc/cpuinfo on Linux, sysctl on macOS). BENCH_MACHINE replaces the
 * machine description outright; BENCH_MACHINE_NOTE is appended to it.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- the output shape (mirrors site/lib/bench.ts) ----------------------------

type Library = 'turbine' | 'drizzle' | 'prisma';

interface Scenario {
  id: string;
  label: string;
  turbine: number;
  drizzle: number;
  prisma: number;
  control: number | null;
  tie: boolean;
}

interface BenchResults {
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
  deepPagination: {
    turbine: number;
    turbineForceCustomPlan: number;
    drizzle: number;
    prisma: number;
    control?: number;
  };
  latency: { rtt: number[]; turbinePipeline: number[]; drizzleTransaction: number[]; prismaTransaction: number[] };
  network: null;
}

/** What `env` captures. A superset of results.env, plus provenance. */
interface RoundEnv {
  capturedAt: string;
  version: string;
  commit: string | null;
  node: string;
  postgres: string;
  postgresVersion: string;
  pgDriver: string;
  drizzle: string;
  drizzleRc: string;
  prisma: string;
  machine: string;
  host: HostInfo;
}

interface HostInfo {
  platform: string;
  cpuModel: string;
  cpus: number;
  memoryGiB: number;
  vm: boolean | null;
  hypervisor: string | null;
  os: string;
  kernel: string;
}

// --- env ---------------------------------------------------------------------

function pkgVersion(name: string): string {
  const p = join(HERE, 'node_modules', name, 'package.json');
  if (!existsSync(p)) throw new Error(`${name} is not installed under benchmarks/node_modules (run npm ci)`);
  return (JSON.parse(readFileSync(p, 'utf8')) as { version: string }).version;
}

function run(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function linuxHost(): HostInfo {
  const cpuinfo = readFileSync('/proc/cpuinfo', 'utf8');
  const model = /^model name\s*:\s*(.+)$/m.exec(cpuinfo)?.[1]?.trim() ?? os.cpus()[0]?.model ?? 'unknown CPU';
  // The `hypervisor` CPUID bit is set for every guest (KVM, Firecracker, Xen,
  // Hyper-V) and never on bare metal, so it answers "is this a VM" without
  // needing DMI tables, which a Firecracker guest does not have.
  const flags = /^flags\s*:\s*(.+)$/m.exec(cpuinfo)?.[1] ?? '';
  const vm = flags ? /\bhypervisor\b/.test(flags) : null;
  const detected = run('systemd-detect-virt', []);
  const hypervisor = vm ? (detected && detected !== 'none' ? detected : null) : null;
  const release = existsSync('/etc/os-release') ? readFileSync('/etc/os-release', 'utf8') : '';
  const pretty = /^PRETTY_NAME="?([^"\n]+)"?$/m.exec(release)?.[1] ?? 'Linux';
  return {
    platform: 'linux',
    cpuModel: model.replace(/\s+/g, ' '),
    cpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    vm,
    hypervisor,
    os: pretty,
    kernel: os.release(),
  };
}

function macHost(): HostInfo {
  const brand = run('sysctl', ['-n', 'machdep.cpu.brand_string']) ?? os.cpus()[0]?.model ?? 'unknown CPU';
  const model = run('sysctl', ['-n', 'hw.model']);
  const hv = run('sysctl', ['-n', 'kern.hv_vmm_present']);
  const product = run('sw_vers', ['-productVersion']);
  return {
    platform: 'darwin',
    cpuModel: model ? `${brand} (${model})` : brand,
    cpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    vm: hv === null ? null : hv === '1',
    hypervisor: null,
    os: product ? `macOS ${product}` : 'macOS',
    kernel: `Darwin ${os.release()}`,
  };
}

function describeMachine(h: HostInfo): string {
  const cores = h.vm ? `${h.cpus} vCPUs` : `${h.cpus} cores`;
  const kind = h.vm ? `${h.os} VM${h.hypervisor ? ` (${h.hypervisor})` : ''}` : h.os;
  const kernel = h.platform === 'linux' ? `kernel ${h.kernel}` : h.kernel;
  return `${h.cpuModel}, ${cores}, ${h.memoryGiB} GB, ${kind} (${kernel}), client and database on one host`;
}

async function captureEnv(outdir: string): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let postgres: string;
  let postgresVersion: string;
  try {
    const s = await client.query<{ setting: string }>(`SELECT setting FROM pg_settings WHERE name = 'server_version'`);
    const v = await client.query<{ version: string }>('SELECT version() AS version');
    // "17.6 (Debian 17.6-1.pgdg120+1)" -> "17.6"
    postgres = (s.rows[0]?.setting ?? '').split(' ')[0] ?? '';
    postgresVersion = v.rows[0]?.version ?? '';
  } finally {
    await client.end();
  }
  if (!postgres) throw new Error('could not read server_version from pg_settings');

  const host = process.platform === 'linux' ? linuxHost() : macHost();
  const note = process.env['BENCH_MACHINE_NOTE'];
  const machine = process.env['BENCH_MACHINE'] || `${describeMachine(host)}${note ? `, ${note}` : ''}`;

  const env: RoundEnv = {
    capturedAt: new Date().toISOString(),
    version: pkgVersion('turbine-orm'),
    commit: run('git', ['-C', join(HERE, '..'), 'rev-parse', 'HEAD']),
    node: process.version,
    postgres,
    postgresVersion,
    pgDriver: pkgVersion('pg'),
    drizzle: pkgVersion('drizzle-orm'),
    drizzleRc: pkgVersion('drizzle-rc'),
    prisma: pkgVersion('@prisma/client'),
    machine,
    host,
  };
  writeFileSync(join(outdir, 'env.json'), `${JSON.stringify(env, null, 2)}\n`);
  console.log(`[env] turbine-orm ${env.version} (${env.commit?.slice(0, 12) ?? 'no git'}), node ${env.node}`);
  console.log(
    `[env] postgres ${env.postgres}, pg ${env.pgDriver}, drizzle ${env.drizzle} / ${env.drizzleRc}, prisma ${env.prisma}`,
  );
  console.log(`[env] machine: ${env.machine}`);
}

// --- log parsing -------------------------------------------------------------

interface Stat {
  name: string;
  median: number;
}
interface ScenarioResult {
  scenario: string;
  stats: Stat[];
}
interface SuiteRun {
  driftHead?: number;
  driftMid?: number;
  driftTail?: number;
  results: ScenarioResult[];
}
interface LatencyRun {
  results: { scenario: string; arm: string; byRtt: Record<string, number> }[];
}
interface Combined {
  scenario: string;
  arms: Record<string, number>;
  perRun: Record<string, number[]>;
}

const median = (xs: number[]): number => {
  if (xs.length === 0) throw new Error('median of nothing');
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const geomean = (xs: number[]): number => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** The machine-readable block every suite prints after `=== JSON ===`. */
function jsonBlock<T>(path: string): T {
  const text = readFileSync(path, 'utf8');
  const at = text.indexOf('=== JSON ===');
  if (at < 0) throw new Error(`no "=== JSON ===" block in ${path}`);
  const rest = text.slice(at + '=== JSON ==='.length);
  return JSON.parse(rest.slice(0, rest.lastIndexOf('}') + 1)) as T;
}

/**
 * bench-stream-parity.ts prints only the text table bench-harness renders:
 * a `-- scenario --` header, then `  arm  median avg p95 min` rows.
 */
function textBlocks(path: string): ScenarioResult[] {
  const out: ScenarioResult[] = [];
  let cur: ScenarioResult | null = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const h = /^-- (.+) --$/.exec(line);
    if (h) {
      cur = { scenario: h[1]!, stats: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = /^ {2}(\S(?:.*?\S)?)\s{2,}(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)\s+(\d+\.\d+)/.exec(line);
    if (m && m[1] !== 'arm') cur.stats.push({ name: m[1]!, median: Number(m[2]) });
  }
  return out.filter((b) => b.stats.length > 0);
}

/** Median of the runs' medians, per arm per scenario, in first-seen order. */
function combine(runs: SuiteRun[]): Combined[] {
  const order: string[] = [];
  const cells = new Map<string, Map<string, number[]>>();
  for (const r of runs) {
    for (const sc of r.results) {
      if (!cells.has(sc.scenario)) {
        order.push(sc.scenario);
        cells.set(sc.scenario, new Map());
      }
      const arms = cells.get(sc.scenario)!;
      for (const s of sc.stats) {
        if (!arms.has(s.name)) arms.set(s.name, []);
        arms.get(s.name)!.push(s.median);
      }
    }
  }
  return order.map((scenario) => {
    const arms: Record<string, number> = {};
    const perRun: Record<string, number[]> = {};
    for (const [arm, values] of cells.get(scenario)!) {
      arms[arm] = median(values);
      perRun[arm] = values;
    }
    return { scenario, arms, perRun };
  });
}

/** <dir>/<prefix>-run1.log, -run2.log, ... stopping at the first gap. */
function runLogs(dir: string, prefix: string): string[] {
  const out: string[] = [];
  for (let i = 1; existsSync(join(dir, `${prefix}-run${i}.log`)); i++) out.push(join(dir, `${prefix}-run${i}.log`));
  if (out.length === 0) throw new Error(`no ${prefix}-run1.log in ${dir}`);
  return out;
}

// --- the published figures --------------------------------------------------

/** [id, scenario as the suite prints it, label as the site shows it]. */
const CORE: [string, string, string][] = [
  ['findMany-100', 'findMany, 100 users (flat)', 'findMany, 100 users'],
  ['findMany-l2', 'findMany, 50 users + posts (L2)', 'findMany, 50 users + posts'],
  ['findMany-l3', 'findMany, 10 users -> posts -> comments (L3)', 'findMany, 10 users + posts + comments'],
  ['findUnique-pk', 'findUnique, single user by PK', 'findUnique by primary key'],
  ['findUnique-l3', 'findUnique, user + posts + comments (L3)', 'findUnique, user + posts + comments'],
  ['count', 'count, all users', 'count, all users'],
  ['stream-50k', 'stream, iterate 50K comments (batch 1000)', 'stream 50,000 comments, per row'],
  ['increment', 'atomic increment, posts.view_count + 1', 'atomic increment'],
  ['pipeline', 'pipeline, 5-query dashboard batch', 'pipeline, 5-query batch'],
  ['hot-findUnique', 'hot findUnique, rotating IDs', 'hot findUnique, rotating ids'],
];
const EXTENDED: [string, string, string][] = [
  ['findMany-5k', 'findMany, 5,000 comments (flat)', 'findMany, 5,000 comments'],
  ['findMany-50k', 'findMany, 50,000 comments (flat)', 'findMany, 50,000 comments'],
  ['findMany-wide', 'findMany, 1,000 rows x 39 columns (wide)', 'findMany, 1,000 rows x 39 columns'],
  ['list-page', 'list, published posts in org 1, newest first (page 3)', 'list page, newest first'],
  ['createMany', 'createMany, 1,000 rows', 'createMany, 1,000 rows'],
  ['update', 'update by primary key', 'update by primary key'],
  ['upsert', 'upsert on a unique column (update path)', 'upsert on a unique column'],
  ['delete', 'delete by unique column', 'delete by unique column'],
  ['to-one', 'to-one, 500 posts + author', 'to-one, 500 posts + author'],
  ['m2m', 'many-to-many, 200 posts + tags through a junction', 'many-to-many, 200 posts + tags'],
  ['relation-count', 'relation _count, 100 users + their post count', 'relation `_count`, 100 users'],
  ['relation-filter', 'relation filter, 100 users having a published post', 'relation filter (`some`), 100 users'],
  ['groupBy', 'groupBy org, count + avg views, having count > 100', 'groupBy + `having`, 5 groups'],
  ['cold-start', 'cold start, first query on a fresh client', 'first query on a new client'],
];
const DEEP_OFFSET = 'list, published posts in org 1, newest first (deep offset)';
const LATENCY_SCENARIO = 'dashboard, 5 independent queries';

function arm(row: Combined, name: string, where: string): number {
  const v = row.arms[name];
  if (v === undefined) throw new Error(`${where}: no "${name}" arm (have: ${Object.keys(row.arms).join(', ')})`);
  return v;
}

/**
 * Tie rule, Turbine against the closer of Drizzle / Prisma. A tie when any of:
 *  - the faster of the two is not the same in every run,
 *  - the median gap is below the suite's drift floor,
 *  - the median gap is under 3% of the faster median.
 */
function tieInfo(row: Combined, floor: number): { rival: string; tie: boolean; reasons: string[]; wins: boolean } {
  const T = arm(row, 'Turbine', row.scenario);
  const rival = ['Drizzle', 'Prisma 7']
    .filter((k) => row.arms[k] !== undefined)
    .reduce((best, k) => (row.arms[k]! < row.arms[best]! ? k : best));
  const R = row.arms[rival]!;
  const winners = new Set<string>();
  const tRuns = row.perRun['Turbine']!;
  const rRuns = row.perRun[rival]!;
  for (let i = 0; i < Math.min(tRuns.length, rRuns.length); i++) winners.add(tRuns[i]! <= rRuns[i]! ? 'T' : 'R');
  const gap = Math.abs(T - R);
  const reasons: string[] = [];
  if (winners.size > 1) reasons.push('winner flipped between runs');
  if (gap < floor) reasons.push(`gap ${gap.toFixed(3)} ms below the ${floor.toFixed(3)} ms drift floor`);
  if (gap / Math.min(T, R) < 0.03) reasons.push(`gap ${((gap / Math.min(T, R)) * 100).toFixed(1)}% under 3%`);
  return { rival, tie: reasons.length > 0, reasons, wins: T < R };
}

/** Drift floor: median over runs of the spread of the SELECT 1 probes. */
function driftFloor(runs: SuiteRun[]): number {
  const spreads = runs.map((r) => {
    const probes = [r.driftHead, r.driftMid, r.driftTail].filter((x): x is number => typeof x === 'number');
    return probes.length ? Math.max(...probes) - Math.min(...probes) : 0;
  });
  return median(spreads);
}

/** The ROUNDS / WARMUP a suite printed in its header line. */
function header(path: string): { rounds: number; warmup: number } {
  const m = /ROUNDS=(\d+) WARMUP=(\d+)/.exec(readFileSync(path, 'utf8'));
  if (!m) throw new Error(`no "ROUNDS=n WARMUP=n" header in ${path}`);
  return { rounds: Number(m[1]), warmup: Number(m[2]) };
}

function build(dir: string): void {
  const env = JSON.parse(readFileSync(join(dir, 'env.json'), 'utf8')) as RoundEnv;
  const summary: string[] = [];
  const say = (s = '') => summary.push(s);

  const defaultLogs = runLogs(dir, 'default');
  const defaultRuns = defaultLogs.map((p) => jsonBlock<SuiteRun>(p));
  const extendedRuns = runLogs(dir, 'extended').map((p) => jsonBlock<SuiteRun>(p));
  const streamRuns: SuiteRun[] = runLogs(dir, 'stream').map((p) => ({ results: textBlocks(p) }));
  const latencyRuns = runLogs(dir, 'latency').map((p) => jsonBlock<LatencyRun>(p));
  const defaultTable = combine(defaultRuns);
  const extendedTable = combine(extendedRuns);
  const floors = { default: driftFloor(defaultRuns), extended: driftFloor(extendedRuns) };

  const rows = (table: Combined[], spec: [string, string, string][], floor: number, suite: string) =>
    spec.map(([id, scenario, label]) => {
      const row = table.find((r) => r.scenario === scenario);
      if (!row) throw new Error(`${suite} suite: no scenario "${scenario}"`);
      const control = row.arms['Raw'];
      const scn: Scenario = {
        id,
        label,
        turbine: r3(arm(row, 'Turbine', scenario)),
        drizzle: r3(arm(row, 'Drizzle', scenario)),
        prisma: r3(arm(row, 'Prisma 7', scenario)),
        control: control === undefined ? null : r3(control),
        tie: false,
      };
      const t = tieInfo(row, floor);
      scn.tie = t.tie;
      const rivalMs = t.rival === 'Drizzle' ? scn.drizzle : scn.prisma;
      const ctl = scn.control !== null ? `  T/ctl ${(scn.turbine / scn.control).toFixed(2)}x` : '';
      say(
        `  ${label.padEnd(40)} T ${scn.turbine.toFixed(3)} D ${scn.drizzle.toFixed(3)} P ${scn.prisma.toFixed(3)}${ctl}` +
          ` | vs ${t.rival}: ${t.wins ? 'T wins' : 'T LOSES'} ${(Math.max(scn.turbine, rivalMs) / Math.min(scn.turbine, rivalMs)).toFixed(2)}x` +
          `${t.tie ? ` TIE: ${t.reasons.join('; ')}` : ''}`,
      );
      return scn;
    });

  say(`core (drift floor ${floors.default.toFixed(4)} ms, ${defaultRuns.length} runs)`);
  const core = rows(defaultTable, CORE, floors.default, 'default');
  say();
  say(`extended (drift floor ${floors.extended.toFixed(4)} ms, ${extendedRuns.length} runs)`);
  const extended = rows(extendedTable, EXTENDED, floors.extended, 'extended');

  const withControl = core.filter((r) => r.control !== null);
  const overhead = (k: Library) => r3(geomean(withControl.map((r) => r[k] / r.control!)));
  const fastest = (r: Scenario) => Math.min(r.turbine, r.drizzle, r.prisma);
  const toFastest = (k: Library) => r3(geomean(core.map((r) => r[k] / fastest(r))));

  const streamTable = combine(streamRuns);
  const stream = streamTable[0];
  if (!stream) throw new Error('stream suite: no scenario parsed');
  const streamArm = (name: string) => r3(arm(stream, name, 'stream suite'));

  const deep = extendedTable.find((r) => r.scenario === DEEP_OFFSET);
  if (!deep) throw new Error(`extended suite: no scenario "${DEEP_OFFSET}"`);

  // Latency: median over runs, per scenario, arm and RTT.
  const lat = new Map<string, Map<number, number[]>>();
  for (const r of latencyRuns) {
    for (const x of r.results) {
      if (x.scenario !== LATENCY_SCENARIO) continue;
      if (!lat.has(x.arm)) lat.set(x.arm, new Map());
      for (const [rtt, v] of Object.entries(x.byRtt)) {
        const byRtt = lat.get(x.arm)!;
        if (!byRtt.has(Number(rtt))) byRtt.set(Number(rtt), []);
        byRtt.get(Number(rtt))!.push(v);
      }
    }
  }
  const latArm = (name: string) => {
    const byRtt = lat.get(name);
    if (!byRtt) throw new Error(`latency suite: no "${name}" arm for "${LATENCY_SCENARIO}"`);
    return byRtt;
  };
  const rtts = [...latArm('Turbine pipeline').keys()].sort((a, b) => a - b);
  const latSeries = (name: string) =>
    rtts.map((rtt) => {
      const v = latArm(name).get(rtt);
      if (!v) throw new Error(`latency suite: "${name}" has no ${rtt} ms result`);
      return r3(median(v));
    });

  const { rounds, warmup } = header(defaultLogs[0]!);
  const out: BenchResults = {
    version: env.version,
    date: env.capturedAt.slice(0, 10),
    env: {
      machine: env.machine,
      node: env.node,
      postgres: env.postgres,
      pgDriver: env.pgDriver,
      drizzle: env.drizzle,
      drizzleRc: env.drizzleRc,
      prisma: env.prisma,
      rounds,
      warmup,
      runs: defaultRuns.length,
    },
    core,
    geomean: {
      overheadVsControl: {
        turbine: overhead('turbine'),
        drizzle: overhead('drizzle'),
        prisma: overhead('prisma'),
        scenarios: withControl.length,
      },
      ratioToFastest: {
        turbine: toFastest('turbine'),
        drizzle: toFastest('drizzle'),
        prisma: toFastest('prisma'),
        scenarios: core.length,
      },
    },
    extended,
    streaming: (
      [
        { arm: 'Turbine findManyStreamBatches', library: 'turbine', median: streamArm('T batches') },
        { arm: `Drizzle ${env.drizzleRc}`, library: 'drizzle', median: streamArm('Drizzle RC') },
        { arm: 'Turbine findManyStream (per row)', library: 'turbine', median: streamArm('T rows') },
        { arm: `Drizzle ${env.drizzle}`, library: 'drizzle', median: streamArm('Drizzle') },
        { arm: 'hand-written pg, keyset pages', library: 'control', median: streamArm('Raw') },
      ] as BenchResults['streaming']
    ).sort((a, b) => a.median - b.median || a.arm.localeCompare(b.arm)),
    deepPagination: {
      turbine: r3(arm(deep, 'Turbine', DEEP_OFFSET)),
      turbineForceCustomPlan: r3(arm(deep, 'Turbine +fCP', DEEP_OFFSET)),
      drizzle: r3(arm(deep, 'Drizzle', DEEP_OFFSET)),
      prisma: r3(arm(deep, 'Prisma 7', DEEP_OFFSET)),
      control: r3(arm(deep, 'Raw', DEEP_OFFSET)),
    },
    latency: {
      rtt: rtts,
      turbinePipeline: latSeries('Turbine pipeline'),
      drizzleTransaction: latSeries('Drizzle tx'),
      prismaTransaction: latSeries('Prisma 7 $tx'),
    },
    network: null,
  };
  assertShape(out);
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify(out, null, 2)}\n`);

  // Diagnostics for the write-up: everything below is derived from `out`.
  say();
  say(`geomean ${JSON.stringify(out.geomean)}`);
  say(
    `pairwise (geomean of X/Turbine): drizzle ${geomean(core.map((r) => r.drizzle / r.turbine)).toFixed(3)}` +
      ` prisma ${geomean(core.map((r) => r.prisma / r.turbine)).toFixed(3)}`,
  );
  say(
    `core wins: vs drizzle ${core.filter((r) => r.turbine < r.drizzle).length}/${core.length},` +
      ` vs prisma ${core.filter((r) => r.turbine < r.prisma).length}/${core.length}`,
  );
  say(
    `extended wins: vs drizzle ${extended.filter((r) => r.turbine < r.drizzle).length}/${extended.length},` +
      ` vs prisma ${extended.filter((r) => r.turbine < r.prisma).length}/${extended.length}`,
  );
  say(`streaming ${JSON.stringify(out.streaming)}`);
  say(`deep pagination ${JSON.stringify(out.deepPagination)}`);
  say(`latency ${JSON.stringify(out.latency)}`);
  say(controlDrift(dir));
  say();
  say(`turbine-orm ${env.version} at ${env.commit ?? 'unknown commit'}, ${env.machine}`);
  say(`postgres: ${env.postgresVersion}`);
  say(`wrote ${join(dir, 'results.json')}`);
  console.log(summary.join('\n'));
}

/**
 * machine-control.ts runs at both ends of the round with no Turbine code in
 * it. If the two disagree by much, the box moved under the run.
 */
function controlDrift(dir: string): string {
  const before = join(dir, 'control-before.log');
  const after = join(dir, 'control-after.log');
  if (!existsSync(before) || !existsSync(after)) return 'machine control: before/after logs missing';
  const a = jsonBlock<Record<string, unknown>>(before);
  const b = jsonBlock<Record<string, unknown>>(after);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(a)) {
    const w = b[k];
    if (typeof v !== 'number' || typeof w !== 'number') continue;
    parts.push(`${k} ${v.toFixed(3)} -> ${w.toFixed(3)} (${(((w - v) / v) * 100).toFixed(1)}%)`);
  }
  return `machine control before -> after: ${parts.join('; ')}`;
}

/** Refuse to write a file the site would misread: every figure finite and positive. */
function assertShape(r: BenchResults): void {
  const bad: string[] = [];
  const num = (path: string, v: unknown) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) bad.push(`${path} = ${String(v)}`);
  };
  if (!/^\d+\.\d+\.\d+/.test(r.version)) bad.push(`version = ${r.version}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) bad.push(`date = ${r.date}`);
  for (const [k, v] of Object.entries(r.env)) {
    if (typeof v === 'number') num(`env.${k}`, v);
    else if (typeof v !== 'string' || v === '') bad.push(`env.${k} = ${String(v)}`);
  }
  for (const [list, name] of [
    [r.core, 'core'],
    [r.extended, 'extended'],
  ] as const) {
    if (list.length === 0) bad.push(`${name} is empty`);
    for (const s of list) {
      for (const k of ['turbine', 'drizzle', 'prisma'] as const) num(`${name}.${s.id}.${k}`, s[k]);
      if (s.control !== null) num(`${name}.${s.id}.control`, s.control);
    }
  }
  for (const g of ['overheadVsControl', 'ratioToFastest'] as const) {
    for (const [k, v] of Object.entries(r.geomean[g])) num(`geomean.${g}.${k}`, v);
  }
  for (const s of r.streaming) num(`streaming.${s.arm}`, s.median);
  for (const [k, v] of Object.entries(r.deepPagination)) num(`deepPagination.${k}`, v);
  if (r.latency.rtt.length === 0) bad.push('latency.rtt is empty');
  for (const k of ['turbinePipeline', 'drizzleTransaction', 'prismaTransaction'] as const) {
    if (r.latency[k].length !== r.latency.rtt.length) bad.push(`latency.${k} has ${r.latency[k].length} values`);
    for (const [i, v] of r.latency[k].entries()) num(`latency.${k}[${i}]`, v);
  }
  if (bad.length) throw new Error(`results would not be publishable:\n  ${bad.join('\n  ')}`);
}

// --- main ----------------------------------------------------------------------

const [mode, dir] = process.argv.slice(2);
if ((mode !== 'env' && mode !== 'build') || !dir) {
  console.error('usage: npx tsx build-results.ts env|build <outdir>');
  process.exit(2);
}
try {
  if (mode === 'env') await captureEnv(dir);
  else build(dir);
} catch (err) {
  console.error(`build-results ${mode}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

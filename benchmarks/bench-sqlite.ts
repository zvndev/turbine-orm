/**
 * SQLite adapter for the original comparison catalog and shared Bench harness.
 * Exact Node 24.10 is required. --verify-only (default) is a correctness smoke,
 * --time is reserved for a serialized campaign after all implementations freeze.
 * Generate Prisma first: node benchmarks/node_modules/prisma/build/index.js generate --schema benchmarks/prisma/sqlite.prisma
 * node --import ./benchmarks/node_modules/tsx/dist/loader.mjs benchmarks/bench-sqlite.ts --verify-only --report /tmp/sqlite-correctness.json
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeJitRqbMapper } from 'drizzle-rc/relations';
import { makeJitQueryMapper } from 'drizzle-rc/utils';
import { Bench } from './bench-harness.js';
import { buildCatalog, disposeCatalog, requiredIds } from './sqlite-comparison-catalog.js';
import { auditDashboard, closeLanes, handleAudit, type Lane, names, openLanes } from './sqlite-comparison-clients.js';
import {
  assertCatalog,
  assertExact,
  type ComparisonScenario,
  nativeFixture,
  verifyScenarios,
} from './sqlite-equivalence.js';
import { seedHandleAudit, seedSqlite, volumes } from './sqlite-seed.js';
import {
  dependencyIdentities,
  resolveTurbine,
  treeIdentity,
  verifyInstalledArtifact,
} from './sqlite-comparison-identity.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const pkg = (name: string) =>
  JSON.parse(readFileSync(join(root, 'benchmarks/node_modules', name, 'package.json'), 'utf8')).version;
function count(key: string, fallback: number, min: number): number {
  const n = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(n) || n < min) throw new Error(`${key} must be a safe integer >= ${min}`);
  return n;
}
export async function runSqlite(args = process.argv.slice(2)): Promise<void> {
  const allowed = new Set(['--verify-only', '--time', '--quick', '--full', '--report', '--artifact', '--sha256']);
  for (let i = 0; i < args.length; i++) {
    if (!allowed.has(args[i]!)) throw new Error(`Unknown SQLite comparison argument: ${args[i]}`);
    if (['--report', '--artifact', '--sha256'].includes(args[i]!)) {
      const option = args[i]!;
      if (args.filter((a) => a === option).length !== 1) throw new Error(`Duplicate ${option}`);
      if (!args[++i] || args[i]!.startsWith('--')) throw new Error(`${option} needs a value`);
    }
  }
  if (args.includes('--time') && args.includes('--verify-only')) throw new Error('Choose --time or --verify-only');
  if (args.includes('--quick') && args.includes('--full')) throw new Error('Choose --quick or --full');
  const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const archive = option('--artifact'),
    archiveSha = option('--sha256');
  if (!!archive !== !!archiveSha) throw new Error('--artifact and --sha256 must be supplied together');
  if (args.includes('--time') && (!archive || !option('--report')))
    throw new Error('SQLite timing requires --artifact, --sha256 and --report');
  if (args.includes('--time') && process.env.SQLITE_COMPARISON_SERIALIZED !== '1')
    throw new Error('SQLite timing requires serial execution and SQLITE_COMPARISON_SERIALIZED=1');
  if (process.version !== 'v24.10.0')
    throw new Error(`Exact Node v24.10.0/native ABI required; got ${process.version}`);
  const fault = process.env.SQLITE_COMPARISON_FAULT ?? 'none';
  if (
    ![
      'none',
      'catalog',
      'arm',
      'value',
      'order',
      'type',
      'stream',
      'stream-order',
      'write-effect',
      'restore',
      'transaction',
      'coverage',
      'hot-input',
    ].includes(fault)
  )
    throw new Error('Unknown SQLite omission control');
  if (fault !== 'none' && args.includes('--time')) throw new Error('Omission controls cannot run timing');
  const reportIndex = args.indexOf('--report'),
    reportPath = reportIndex < 0 ? undefined : resolve(args[reportIndex + 1]!);
  const quick = args.includes('--quick'),
    timing = args.includes('--time');
  const rounds = count('ROUNDS', quick ? 3 : 200, 1),
    warmup = count('WARMUP', quick ? 1 : 20, 0),
    streamRounds = count('STREAM_ROUNDS', quick ? 1 : 15, 1),
    coldRounds = count('COLD_ROUNDS', quick ? 3 : 100, 1);
  const dir = mkdtempSync(join(tmpdir(), 'turbine-sqlite-comparison-')),
    file = join(dir, 'comparison.sqlite');
  // biome-ignore lint/suspicious/noExplicitAny: heterogeneous native evidence is serialized with exact source identity.
  const report: Record<string, any> = {
    schemaVersion: 1,
    engine: 'sqlite',
    operationCatalog: 'original-full-sqlite-v1',
    mode: timing ? 'timing' : 'correctness-only',
    fault,
    status: 'running',
    sampleSettings: { quick, rounds, warmup, streamRounds, coldRounds },
    identity: {
      base: '6052829e9c83e8549fca48932b30e9448cafcc9f',
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      branch: execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim(),
      worktree: root,
      cwd: process.cwd(),
      node: process.version,
      executable: process.execPath,
      executableSha256: sha(process.execPath),
      runtimeVersions: process.versions,
      sourceStatus: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }),
      abi: process.versions.modules,
      pid: process.pid,
      linuxProcessStat: readFileSync(`/proc/${process.pid}/stat`, 'utf8'),
      command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
      environment: Object.fromEntries(
        [
          'NODE_OPTIONS',
          'NODE_ENV',
          'TZ',
          'TSX_TSCONFIG_PATH',
          'SQLITE_COMPARISON_SERIALIZED',
          'SQLITE_COMPARISON_FAULT',
          'ROUNDS',
          'WARMUP',
          'STREAM_ROUNDS',
          'COLD_ROUNDS',
        ].map((name) => [name, process.env[name] ?? null]),
      ),
    },
    scope:
      'Generation, native introspection and the generated factory use the resolved Turbine package. Archive mode verifies actual installed bytes. Worktree source/local dist are separate recorded identities; neither implies artifact provenance or final support promotion.',
    volumes,
    versions: {
      drizzle: pkg('drizzle-orm'),
      drizzleRc: pkg('drizzle-rc'),
      prismaCli: pkg('prisma'),
      prisma: pkg('@prisma/client'),
      prismaAdapter: pkg('@prisma/adapter-better-sqlite3'),
      betterSqlite3: pkg('better-sqlite3'),
      nodeSqlite: process.versions.sqlite,
    },
    host: {
      platform: platform(),
      release: release(),
      cpus: cpus().length,
      cpu: cpus()[0]?.model,
      loadBefore: loadavg(),
    },
    cleanup: { directory: dir, file, closed: [], removed: false, errors: [] },
    results: [],
  };
  let lanes: Lane[] = [],
    scenarios: ComparisonScenario[] = [],
    admin: DatabaseSync | undefined,
    primary: unknown;
  try {
    report.turbineRuntime = resolveTurbine();
    report.sourceIdentity = treeIdentity(join(root, 'src'));
    report.localDistIdentity = existsSync(join(root, 'dist')) ? treeIdentity(join(root, 'dist')) : null;
    report.sourceDistScope = {
      sourceSha256: report.sourceIdentity.sha256,
      localDistSha256: report.localDistIdentity?.sha256 ?? null,
      localSqliteEntryMatchesRuntime: existsSync(join(root, 'dist/sqlite.js'))
        ? sha(join(root, 'dist/sqlite.js')) === report.turbineRuntime.entrySha256
        : null,
      provenance: 'Content identities, not proof that the supplied artifact was built from this source head',
    };
    report.dependencies = dependencyIdentities();
    if (archive) {
      if (report.turbineRuntime.route !== 'separately-installed-package')
        throw new Error('Archive evidence requires a separately installed Turbine package, not the worktree link');
      report.artifact = verifyInstalledArtifact(archive, archiveSha!, report.turbineRuntime.packageRoot, dir);
    } else report.artifact = { verified: false, scope: 'source/dist branch evidence only; no supplied artifact' };
    await seedSqlite(file);
    const resolverPath = join(root, 'benchmarks/generated/sqlite-turbine/runtime-identity.mjs');
    writeFileSync(resolverPath, "export const entry = import.meta.resolve('turbine-orm/sqlite');\n");
    const runtimeEntry = fileURLToPath((await import(pathToFileURL(resolverPath).href)).entry);
    assertExact('Generated factory runtime identity', runtimeEntry, report.turbineRuntime.entry);
    report.generatedIdentity = treeIdentity(join(root, 'benchmarks/generated'));
    admin = new DatabaseSync(file);
    admin.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    const fixture = nativeFixture(admin);
    lanes = await openLanes(file);
    assertExact(
      'Pinned comparison profile',
      {
        drizzle: report.versions.drizzle,
        drizzleRc: report.versions.drizzleRc,
        prisma: report.versions.prisma,
        prismaAdapter: report.versions.prismaAdapter,
        prismaCli: report.versions.prismaCli,
        betterSqlite3: report.versions.betterSqlite3,
      },
      {
        drizzle: '0.45.4',
        drizzleRc: '1.0.0-rc.5',
        prisma: '7.10.1',
        prismaAdapter: '7.10.1',
        prismaCli: '7.10.1',
        betterSqlite3: '12.11.1',
      },
    );
    const rc = lanes.find((l) => l.name === 'Drizzle RC')!;
    if (
      rc.db.dialect.mapperGenerators.relationalRows !== makeJitRqbMapper ||
      rc.db.dialect.mapperGenerators.rows !== makeJitQueryMapper
    )
      throw new Error('Drizzle RC JIT mapper not engaged');
    const relationSql = lanes
      .find((l) => l.name === 'Turbine')!
      .db.table('users')
      .buildFindMany({ limit: 1, with: { posts: true } }).sql;
    if (!relationSql.includes('json_object'))
      throw new Error('Raw relation object encoding does not match Turbine emitted SQL');
    report.turbineRelationEncoding = { emitted: 'object', sql: relationSql, defaultStrategy: 'auto' };
    report.versions.betterSqliteEmbedded = rc.handle.prepare('SELECT sqlite_version() v').get().v;
    report.settings = {
      node: admin.prepare('SELECT sqlite_version() sqliteVersion').get(),
      journal: admin.prepare('PRAGMA journal_mode').get(),
      synchronous: admin.prepare('PRAGMA synchronous').get(),
      foreignKeys: admin.prepare('PRAGMA foreign_keys').get(),
      connectionsPerArm: 1,
      pool: 'Embedded one handle per arm; no pool/network. Same WAL/FULL/foreign_keys settings are explicitly set on each handle.',
      prisma: await lanes
        .find((l) => l.name === 'Prisma 7')!
        .db.$queryRawUnsafe('SELECT sqlite_version() AS sqliteVersion'),
    };
    report.settings.perArm = lanes.map((lane) => {
      const scalar = (sql: string) => {
        const value = Object.values(lane.handle.prepare(sql).get())[0];
        // Prisma's official adapter enables safe integers on its underlying handle.
        return typeof value === 'bigint' ? Number(value) : value;
      };
      const observed = {
        journal: scalar('PRAGMA journal_mode'),
        synchronous: scalar('PRAGMA synchronous'),
        foreignKeys: scalar('PRAGMA foreign_keys'),
      };
      assertExact(`${lane.name} native connection settings`, observed, {
        journal: 'wal',
        synchronous: 2,
        foreignKeys: 1,
      });
      return {
        arm: lane.name,
        driver: lane.kind,
        nativePragmaIntegerType: typeof Object.values(lane.handle.prepare('PRAGMA foreign_keys').get())[0],
        driverVersion: lane.kind === 'node:sqlite' ? process.version : report.versions.betterSqlite3,
        sqliteVersion: scalar('SELECT sqlite_version()'),
        ...observed,
      };
    });
    report.streamImplementations = {
      Turbine: 'node:sqlite StatementSync.iterate through row API',
      'T batches': 'node:sqlite StatementSync.iterate through batch API',
      'T batches#2': 'duplicate native batch control',
      Raw: 'node:sqlite fresh 1000-row keyset pages',
      'Raw iterator': 'node:sqlite StatementSync.iterate',
      'Drizzle 0.45.4': 'better-sqlite3, benchmark keyset-page emulation',
      'Drizzle RC 1.0.0-rc.5':
        'better-sqlite3, benchmark keyset-page emulation; other RC drivers are outside this path',
      'Prisma 7.10.1': 'official better-sqlite3 adapter, benchmark keyset-page emulation',
    };
    report.dimensionScope = {
      cold: 'First model query on fresh connection after untimed connect/SELECT 1; warm process imports',
      warm: 'Original interleaved query catalog and original round/warmup configuration',
      throughput: 'unavailable: no concurrent throughput workload',
      resources: 'unavailable: no scoped CPU/RSS sampling',
      typesAndInstall: 'package identity/correctness only; no type-check/install-duration comparison',
      network: 'not applicable: embedded SQLite; no RTT simulation',
    };
    const built = buildCatalog(lanes, fixture, admin, file, fault);
    scenarios = built.scenarios;
    report.catalog = built.catalog;
    if (fault === 'coverage')
      report.catalog.splice(
        report.catalog.findIndex((r: { status: string }) => r.status === 'supported'),
        1,
      );
    if (fault === 'catalog') scenarios.pop();
    if (fault === 'arm') scenarios[0]!.arms = scenarios[0]!.arms.filter((a) => a.name !== 'Raw');
    assertCatalog(scenarios, requiredIds);
    for (const s of scenarios) {
      const expected = s.id.startsWith('strategy-')
        ? s.id === 'strategy-many'
          ? ['Turbine join', 'Turbine batched', 'Turbine auto']
          : ['Turbine join', 'Turbine batched', 'Turbine auto', 'Turbine flatten']
        : s.id === 'relations-tags'
          ? [...names, 'Drizzle RC junction']
          : s.id === 'stream-parity'
            ? [...names, 'T batches', 'T batches#2', 'Raw iterator']
            : s.id === 'deep-offset'
              ? [...names, 'Raw prepared']
              : [...names];
      assertExact(`${s.id} required arm catalog`, s.arms.map((a) => a.name).sort(), expected.sort());
    }
    // Native refusals are tested, never silently downgraded to a weaker API.
    const turbine = lanes.find((l) => l.name === 'Turbine')!;
    let refused = false;
    try {
      await turbine.db.table('posts').findMany({
        where: { orgId: 1, published: true },
        orderBy: { id: 'asc' },
        limit: 20,
        offset: 9000,
        forceCustomPlan: true,
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'TURBINE_E017') throw e;
      refused = true;
    }
    if (!refused) throw new Error('SQLite forceCustomPlan refusal missing');
    let prismaJoinRefused = false;
    try {
      await lanes
        .find((l) => l.name === 'Prisma 7')!
        .db.user.findMany({ take: 1, include: { posts: true }, relationLoadStrategy: 'join' });
    } catch (e) {
      if (!/Unknown argument.*relationLoadStrategy/s.test((e as Error).message)) throw e;
      prismaJoinRefused = true;
    }
    if (!prismaJoinRefused) throw new Error('Prisma SQLite join strategy refusal missing');

    report.transactions = [];
    for (const tx of [false, true])
      for (const lane of lanes)
        report.transactions.push(
          await auditDashboard(lane, tx, fault === 'transaction' && lane.name === 'Raw' ? false : tx),
        );
    report.preflight = [];
    await verifyScenarios(scenarios, fault, report.preflight);
    const cells = (rows: { id: string; arm: string }[]) => rows.map((r) => `${r.id}/${r.arm}`).sort();
    assertExact(
      'SQLite supported catalog/preflight coverage',
      cells(report.preflight),
      cells(report.catalog.filter((r: { status: string }) => r.status === 'supported')),
    );
    report.coverage = {
      scenarios: scenarios.length,
      supportedCells: report.preflight.length,
      catalogRows: report.catalog.length,
      refused: report.catalog.filter((r: { status: string }) => r.status === 'refused'),
      notApplicable: report.catalog.filter((r: { status: string }) => r.status === 'not-applicable'),
    };
    report.refusalControls = [
      'forceCustomPlan:TURBINE_E017',
      'Prisma SQLite relationLoadStrategy join:validation refusal',
    ];
    if (timing) {
      const contract = (await import('./bench-harness.js')) as { summarizeSamples?: unknown };
      if (typeof contract.summarizeSamples !== 'function')
        throw new Error('Final timing requires the PG-owned retained-sample Bench contract before execution');
      process.env.BENCH_RETAIN_SAMPLES = '1';
      console.log(
        'SQLite original catalog. Compare drivers and embedded SQLite versions explicitly; raw uses node:sqlite.',
      );
      // Keep options structurally compatible with Bench; the runtime guard
      // requires retained-sample support before measurements can start.
      const benchOptions = { rounds, warmup, retainSamples: true };
      const bench = new Bench(benchOptions);
      const pool = { query: async (sql: string) => admin!.prepare(sql).all() };
      const driftHead = await bench.driftProbe(pool, 'head');
      for (const s of scenarios) {
        try {
          await bench.interleave(s.scenario, s.arms, {
            rounds:
              s.group === 'cold'
                ? coldRounds
                : s.stream
                  ? streamRounds
                  : s.group === 'headline'
                    ? rounds
                    : quick
                      ? rounds
                      : Math.max(
                          10,
                          Math.floor(rounds / (s.id === 'large-50000' ? 10 : s.id === 'writes-bulk' ? 5 : 2)),
                        ),
            warmup: s.group === 'cold' ? 0 : s.stream ? 1 : warmup,
            note: s.note,
          });
        } finally {
          s.restore?.();
        }
      }
      const driftTail = await bench.driftProbe(pool, 'tail');
      bench.reportDrift([driftHead, driftTail]);
      report.results = bench.results;
      for (const result of report.results)
        for (const stat of result.stats)
          if (
            !Array.isArray(stat.samplesMs) ||
            stat.samplesMs.length !== stat.n ||
            !stat.sampleMethod ||
            !('p99' in stat) ||
            !stat.p99Status
          )
            throw new Error('Final timing requires the PG-owned retained-sample Bench contract');
      report.percentileScope =
        'Per-arm actual retained samples only; p50 arithmetic median, p95/p99 nearest rank. p99 unavailable below n=100 and unstable below n=1000. No aggregate percentile from medians.';
      report.drift = { driftHead, driftTail };
      report.timingScope =
        'Run serially on an idle machine using the tested artifact; timings require a matching artifact identity.';
    }
    report.status = 'passed';
  } catch (e) {
    primary = e;
    report.status = 'failed';
    report.error = { name: (e as Error).name, message: (e as Error).message, stack: (e as Error).stack };
  } finally {
    try {
      await disposeCatalog(scenarios);
    } catch (e) {
      report.cleanup.errors.push(String(e));
    }
    try {
      report.cleanup.closed = await closeLanes(lanes);
    } catch (e) {
      report.cleanup.errors.push(String(e));
    }
    try {
      admin?.close();
      report.cleanup.adminClosed = !!admin && !admin.isOpen;
      if (admin && !report.cleanup.adminClosed) report.cleanup.errors.push('Admin native handle failed to close');
    } catch (e) {
      report.cleanup.errors.push(String(e));
    }
    try {
      rmSync(dir, { recursive: true, force: true });
      report.cleanup.removed = !existsSync(dir);
    } catch (e) {
      report.cleanup.errors.push(String(e));
    }
    report.cleanup.handles = handleAudit;
    report.cleanup.seedHandles = seedHandleAudit;
    if (seedHandleAudit.some((h) => !h.closed)) report.cleanup.errors.push('Seed native closure audit failed');
    if (handleAudit.some((h) => !h.closed || !h.nativeClosed || h.transactionAtClose))
      report.cleanup.errors.push('Native handle closure audit failed');
    report.host.loadAfter = loadavg();
    report.hashes = Object.fromEntries(
      [
        'benchmarks/bench-sqlite.ts',
        'benchmarks/sqlite-seed.ts',
        'benchmarks/sqlite-comparison-catalog.ts',
        'benchmarks/sqlite-comparison-clients.ts',
        'benchmarks/sqlite-comparison-controls.ts',
        'benchmarks/sqlite-comparison-identity.ts',
        'benchmarks/sqlite-comparison-install.ts',
        'benchmarks/sqlite-comparison-run.ts',
        'benchmarks/evidence/native-gate-child.mjs',
        'benchmarks/sqlite-comparison-types.d.ts',
        'benchmarks/postgres-pagination/corpus.mjs',
        'benchmarks/sqlite-equivalence.ts',
        'benchmarks/sqlite-schema.ts',
        'benchmarks/sqlite-schema-rc.ts',
        'benchmarks/prisma/sqlite.prisma',
        'benchmarks/package-lock.json',
        'benchmarks/comparison-versions.json',
        'benchmarks/bench-harness.ts',
        'benchmarks/equivalence.ts',
        'package.json',
        'package-lock.json',
        'tsconfig.json',
        'benchmarks/tsconfig.json',
        'src/sqlite.ts',
        'src/query/builder.ts',
        'src/query/relations.ts',
        'dist/sqlite.js',
        'dist/query/builder.js',
        'dist/query/relations.js',
        'benchmarks/generated/sqlite-turbine/runtime-identity.mjs',
        'benchmarks/generated/sqlite-turbine/index.ts',
        'benchmarks/generated/sqlite-turbine/metadata.ts',
        'benchmarks/generated/sqlite-turbine/types.ts',
        'benchmarks/generated/prisma-sqlite/index.js',
        'benchmarks/generated/prisma-sqlite/schema.prisma',
      ]
        .filter((p) => existsSync(join(root, p)))
        .map((p) => [p, sha(join(root, p))]),
    );
    if (report.cleanup.errors.length) {
      report.status = 'failed';
      if (!primary) primary = new Error(`SQLite cleanup errors: ${report.cleanup.errors.join('; ')}`);
    }
    if (reportPath) writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    JSON.stringify({
      status: report.status,
      mode: report.mode,
      scenarios: scenarios.length,
      arms: report.preflight?.length,
      catalog: report.catalog?.length,
      versions: report.versions,
      cleanup: report.cleanup,
      report: reportPath,
    }),
  );
  if (primary) throw primary;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runSqlite().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });

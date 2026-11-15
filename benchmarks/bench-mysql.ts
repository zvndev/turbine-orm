/** Original full MySQL comparison. Setup/preflight never reports smoke timings as results. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Pool } from 'mysql2/promise';
import { type Arm, Bench } from './bench-harness.js';
import { type Adapter, createAdapter, createAdapters } from './mysql-comparison-adapters.js';
import { ARM_NAMES, bulkRows, catalog, ORIGINAL_MYSQL_IDS, type Scenario } from './mysql-comparison-catalog.js';
import { settleMysqlArmBackends } from './mysql-comparison-cleanup.js';
import {
  bind,
  connectionOptions,
  FIXTURE_TIME,
  makePool,
  packageVersions,
  poolSnapshots,
} from './mysql-comparison-config.js';
import { delayProxy } from './mysql-comparison-latency.js';
import { installedIdentity, mysqlBenchmarkHashes, nativeErrorChain } from './mysql-comparison-provenance.js';
import { driftMysql, interleaveMysql, type OperationSample, retainedResults } from './mysql-comparison-samples.js';
import {
  assertMysqlExact,
  correctnessControls,
  type Fixture,
  incrementExpected,
  postsNow,
  type Row,
  readMysqlFixture,
  restorePosts,
  resultHash,
  scratchNow,
} from './mysql-equivalence.js';

let interrupted: string | undefined;
const checkInterrupted = () => assert.ok(!interrupted, `interrupted ${interrupted}`);
const onTerm = () => {
  interrupted = 'SIGTERM';
};
const onInt = () => {
  interrupted = 'SIGINT';
};

const positive = (name: string, fallback: number, zero = false) => {
  const n = Number(process.env[name] ?? fallback);
  assert.ok(Number.isSafeInteger(n) && n >= (zero ? 0 : 1), `invalid ${name}`);
  return n;
};
const repository = process.env.MYSQL_COMPARISON_REPOSITORY ?? fileURLToPath(new URL('..', import.meta.url));
const executedDirectory = fileURLToPath(new URL('.', import.meta.url));
const sourceHash = (path: string) =>
  createHash('sha256')
    .update(readFileSync(resolve(repository, path)))
    .digest('hex');
function treeHashes(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const e of readdirSync(resolve(repository, root), { withFileTypes: true })) {
    const p = `${root}/${e.name}`;
    if (e.isDirectory()) Object.assign(entries, treeHashes(p));
    else if (e.isFile()) entries[p] = sourceHash(p);
  }
  return entries;
}
function fileHashes(root: string): Record<string, string> {
  const walk = (path: string): Record<string, string> =>
    Object.fromEntries(
      readdirSync(resolve(executedDirectory, path), { withFileTypes: true }).flatMap((entry): [string, string][] => {
        const key = `${path}/${entry.name}`;
        return entry.isDirectory()
          ? Object.entries(walk(key))
          : [
              [
                key,
                createHash('sha256')
                  .update(readFileSync(resolve(executedDirectory, key)))
                  .digest('hex'),
              ],
            ];
      }),
    );
  return walk(root);
}
export function coverage(scenarios: Scenario[]) {
  assert.equal(scenarios.length, 47, 'complete 47-entry catalog required');
  assert.deepEqual(
    scenarios.map((s) => s.id).sort(),
    [...ORIGINAL_MYSQL_IDS].sort(),
    'original catalog identity required',
  );
  assert.equal(scenarios.filter((s) => s.group === 'headline').length, 11, 'eleven headline scenarios required');
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length, 'duplicate catalog id');
  for (const [group, n] of Object.entries({
    headline: 11,
    large: 3,
    list: 2,
    relations: 4,
    agg: 1,
    writes: 5,
    strategy: 7,
    cold: 1,
    stream: 5,
    latency: 6,
    deep: 2,
  }))
    assert.equal(scenarios.filter((s) => s.group === group).length, n, `incomplete catalog ${group}`);
  return scenarios.map((s) => ({
    id: s.id,
    group: s.group,
    scenario: s.name,
    note: s.note,
    arms: ARM_NAMES.map((name) => ({
      name,
      status: s.unsupported?.[name] ? 'unsupported' : 'supported',
      reason: s.unsupported?.[name] ?? null,
    })),
  }));
}
async function prepare(pool: Pool, s: Scenario, f: Fixture) {
  if (s.write === 'increment') {
    await pool.execute(
      'UPDATE posts SET view_count=?, updated_at=? WHERE id=1',
      bind([f.posts[0]!.viewCount, f.posts[0]!.updatedAt]),
    );
    return;
  }
  if (!s.write) return;
  await pool.query('TRUNCATE TABLE bench_writes');
  if (s.write === 'bulk' || s.write === 'bulk-count') return;
  const slug = s.write === 'delete' ? 'delete' : s.write === 'upsert' ? 'upsert' : 'update';
  await pool.execute(
    'INSERT INTO bench_writes (id,org_id,slug,label,amount,active,created_at) VALUES (1,1,?,?,0,TRUE,?)',
    [slug, slug, FIXTURE_TIME],
  );
}
async function writeCheck(pool: Pool, s: Scenario, f: Fixture, result: unknown, i: number, label: string) {
  if (s.write === 'increment') {
    const after = await postsNow(pool);
    assertMysqlExact(`${label} write effect`, after, incrementExpected(f));
    assertMysqlExact(`${label} returning`, result, incrementExpected(f)[0]);
    return;
  }
  const rows = await scratchNow(pool);
  const slug = s.write === 'delete' ? 'delete' : s.write === 'upsert' ? 'upsert' : 'update';
  const row = {
    id: 1,
    orgId: 1,
    slug,
    label: slug,
    amount: s.write === 'delete' ? 0 : i,
    active: true,
    createdAt: FIXTURE_TIME,
  };
  const expected =
    s.write === 'bulk' || s.write === 'bulk-count'
      ? bulkRows.map((r, j) => ({ id: j + 1, ...r }))
      : s.write === 'delete'
        ? []
        : [row];
  assertMysqlExact(`${label} storage effect`, rows, expected);
  if (s.write === 'bulk-count') assertMysqlExact(`${label} count result`, result, { count: 1000 });
  else if (s.write !== 'bulk') assertMysqlExact(`${label} returning`, result, row);
  else if (Array.isArray(result) && result.length === 1000)
    assertMysqlExact(`${label} returned bulk rows`, result, expected);
  else {
    const native = Array.isArray(result) ? result[0] : result;
    assert.ok(native && typeof native === 'object', `${label} bulk result contract missing`);
    const n = (native as Row).count ?? (native as Row).affectedRows;
    assert.equal(Number(n), 1000, `${label} native affected count`);
  }
}
async function verify(
  pool: Pool,
  scenarios: Scenario[],
  adapters: Adapter[],
  f: Fixture,
  fault?: string,
  samples: Row[] = [],
) {
  assert.deepEqual(
    adapters.map((a) => a.name),
    [...ARM_NAMES],
    'complete five-arm roster required',
  );
  for (const s of scenarios)
    for (const adapter of adapters) {
      if (s.unsupported?.[adapter.name as (typeof ARM_NAMES)[number]]) continue;
      const inputs =
        s.id === 'headline.hot'
          ? Array.from({ length: 50 }, (_, i) => i)
          : s.write === 'update' || s.write === 'upsert'
            ? [7, 19]
            : [0];
      for (const i of inputs) {
        checkInterrupted();
        const label = `${s.id}/${adapter.name}[${i}]`;
        await prepare(pool, s, f);
        let current = adapter,
          temporary: Adapter[] | undefined;
        try {
          if (s.cold) {
            current = await createAdapter(adapter.name);
            temporary = [current];
            await current.warm();
          }
          let n = 0;
          const value = await s.run(
            current,
            i,
            s.stream
              ? (row) => {
                  assert.ok(n < f.comments.length, `${label}: extra streamed row`);
                  if (
                    fault === 'stream-drop' &&
                    s.id === 'headline.stream' &&
                    adapter.name === 'Turbine' &&
                    n === f.comments.length - 1
                  )
                    return;
                  assertMysqlExact(`${label} streamed row ${n}`, row, f.comments[n]);
                  n++;
                }
              : undefined,
          );
          if (s.stream) {
            assert.equal(n, 50000, `${label}: observed stream completeness`);
            assert.equal(value, 50000, `${label}: stream returned count`);
          } else if (s.write) {
            if (fault === 'write-effect' && s.write === 'increment' && adapter.name === 'Turbine')
              await pool.execute('UPDATE posts SET view_count=view_count-1 WHERE id=1');
            await writeCheck(pool, s, f, value, i, label);
          } else {
            const actual =
              fault === 'scalar' && s.id === 'headline.flat' && adapter.name === 'Turbine'
                ? (value as Row[]).map((r, j) => (j === 0 ? { ...r, name: 'corrupt' } : r))
                : value;
            assertMysqlExact(label, actual, s.expected!(f, i));
          }
          samples.push({
            scenario: s.id,
            arm: adapter.name,
            input: i,
            status: 'pass',
            hash: s.stream ? resultHash(f.comments) : resultHash(value),
          });
        } finally {
          if (temporary) for (const a of temporary) await a.close();
          if (s.write === 'increment') await restorePosts(pool, f);
          if (s.write && s.write !== 'increment') await pool.query('TRUNCATE TABLE bench_writes');
        }
      }
      if (s.id === 'stream.parity' && adapter.name === 'Turbine') {
        for (const name of ['T batches', 'T batches#2']) {
          let n = 0;
          const count = await adapter.stream('batches', (row) => {
            assertMysqlExact(`${s.id}/${name} streamed row ${n}`, row, f.comments[n]);
            n++;
          });
          assert.equal(n, 50000);
          assert.equal(count, 50000);
          samples.push({ scenario: s.id, arm: name, input: 0, status: 'pass', hash: resultHash(f.comments) });
        }
      }
      console.log(`[exact mysql preflight] ${s.id} / ${adapter.name}: ${inputs.length} input(s) OK`);
    }
  return samples;
}
export async function runMysqlComparison(options: { verifyOnly?: boolean } = {}) {
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) assert.ok(['--verify-only', '--catalog'].includes(flag), `unknown option ${flag}`);
  const scenarios = catalog(),
    coverageRows = coverage(scenarios);
  if (flags.has('--catalog')) {
    console.log(JSON.stringify({ format: 'mysql-comparison-catalog-v1', catalog: coverageRows }, null, 2));
    return;
  }
  const verifyOnly = options.verifyOnly ?? flags.has('--verify-only');
  assert.ok(
    verifyOnly || process.env.MYSQL_COMPARISON_SERIALIZED === '1',
    'timing requires serial execution and MYSQL_COMPARISON_SERIALIZED=1',
  );
  const fault = process.env.MYSQL_COMPARISON_FAULT;
  assert.ok(!fault || verifyOnly, 'failure controls are permitted only with --verify-only');
  assert.ok(
    !fault ||
      [
        'scalar',
        'stream-drop',
        'write-effect',
        'catalog-omit',
        'arm-omit',
        'seed-volume',
        'cleanup',
        'signal',
      ].includes(fault),
    'unknown failure control',
  );
  if (fault === 'catalog-omit') coverage(scenarios.filter((s) => s.id !== 'headline.l3'));
  const headlineRounds = positive('HEADLINE_ROUNDS', process.env.ROUNDS ? Number(process.env.ROUNDS) : 200);
  const extendedRounds = positive('EXTENDED_ROUNDS', process.env.ROUNDS ? Number(process.env.ROUNDS) : 100);
  const latencyRounds = positive('LATENCY_ROUNDS', process.env.ROUNDS ? Number(process.env.ROUNDS) : 25);
  const deepRounds = positive('DEEP_ROUNDS', process.env.ROUNDS ? Number(process.env.ROUNDS) : 150);
  const rounds = positive('ROUNDS', 100),
    warmup = positive('WARMUP', 10, true),
    streamRounds = positive('STREAM_ROUNDS', 15),
    coldRounds = positive('COLD_ROUNDS', Math.max(10, rounds));
  const groups = process.env.GROUPS?.split(',').map((g) => g.trim());
  if (groups)
    for (const g of groups)
      assert.ok(
        scenarios.some((s) => s.group === g),
        `unknown GROUPS entry ${g}`,
      );
  assert.ok(
    verifyOnly || !groups || process.env.MYSQL_COMPARISON_DIAGNOSTIC === '1',
    'partial timing requires explicit MYSQL_COMPARISON_DIAGNOSTIC=1; no complete-campaign claim',
  );
  const chosen = scenarios.filter((s) => !groups || groups.includes(s.group));
  assert.ok(chosen.length, 'no scenarios selected');
  const output = process.env.MYSQL_COMPARISON_OUTPUT;
  const report: Row = {
    format: 'mysql-comparison-v1',
    status: 'failure',
    verifyOnly,
    comparativeClaim: false,
    measurement:
      'Shared Bench measures outer calls; operationSamples retain inner call bounds with their own empirical summaries. Fixture setup, exact preflight, controls, client/pool warmup, restoration and close are untimed. Native ORM decoding, return emulation and declared result shaping are inside calls. verifyOnly produces no timing samples. Defaults retain original group round counts unless ROUNDS/WARMUP explicitly override them.',
    catalog: coverageRows,
    selected: chosen.map((s) => s.id),
    node: process.version,
    versions: packageVersions(),
    rounds,
    groupRounds: {
      headline: headlineRounds,
      extended: extendedRounds,
      stream: streamRounds,
      latency: latencyRounds,
      deep: deepRounds,
      cold: coldRounds,
    },
    warmup,
    streamRounds,
    coldRounds,
    command: [process.execPath, ...process.argv.slice(1)],
    cwd: process.cwd(),
    sourceScope: 'Actual installed explicit archive; benchmark worktree source identity is separate',
    installed: installedIdentity(),
    campaignScope: groups ? 'partial diagnostic' : 'complete original 47-entry catalog',
    acceptedComparativeTiming: false,
    executionScope: 'installed-artifact',
    catalogContract: 'mysql-original-47-v2',
    boundaryContract: 'mysql-native-boundaries-v1',
    oracleControlContract: 'mysql-oracle-controls-v1',
    unavailableDimensions: [
      'installation latency',
      'typecheck performance',
      'server CPU',
      'peak resource usage',
      'concurrent throughput',
    ],
    environment: Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        /^(MYSQL_COMPARISON_(MODE|BASE|SERIALIZED|DIAGNOSTIC|FAULT)|.*ROUNDS|WARMUP|RTTS|GROUPS|TZ|NODE_OPTIONS|LD_LIBRARY_PATH)$/.test(
          key,
        ),
      ),
    ),
    git: {
      base: process.env.MYSQL_COMPARISON_BASE ?? null,
      head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(),
      branch: execFileSync('git', ['branch', '--show-current'], { cwd: repository, encoding: 'utf8' }).trim(),
      status: execFileSync('git', ['status', '--short'], { cwd: repository, encoding: 'utf8' }).trim(),
    },
    hashes: {
      benchmarkLock: sourceHash('benchmarks/package-lock.json'),
      rootLock: sourceHash('package-lock.json'),
      source: treeHashes('src'),
      turbineGenerated: fileHashes('generated/turbine-mysql'),
      prismaGenerated: fileHashes('generated/prisma-mysql'),
    },
  };
  (report.hashes as Row).benchmark = mysqlBenchmarkHashes(executedDirectory);
  (report.hashes as Row).dist = Object.fromEntries(
    Object.entries((report.installed as ReturnType<typeof installedIdentity>).artifact.payload).filter(([path]) =>
      path.startsWith('dist/'),
    ),
  );
  const pool = makePool();
  let adapters: Adapter[] = [];
  let fixture: Fixture | undefined;
  const cleanup: Row = { adapters: [], proxies: [], fixtureRestored: false, oracleClosed: false };
  report.cleanup = cleanup;
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  try {
    const [server] = await pool.query(
      'SELECT VERSION() AS version, @@sql_mode AS sqlMode, @@port AS port, @@datadir AS dataDirectory, @@transaction_isolation AS isolationLevel, CONNECTION_ID() AS oracleConnectionId',
    );
    report.server = (server as Row[])[0];
    assert.equal((report.server as Row).version, '8.4.0', 'exact MySQL 8.4.0 required');
    const mode = String((report.server as Row).sqlMode).includes('NO_BACKSLASH_ESCAPES') ? 'no-backslash' : 'ordinary';
    if (process.env.MYSQL_COMPARISON_MODE)
      assert.equal(mode, process.env.MYSQL_COMPARISON_MODE, 'wrong native SQL mode');
    report.mode = mode;
    fixture = await readMysqlFixture(pool);
    report.fixtureHash = resultHash(fixture);
    report.controls = correctnessControls(fixture);
    if (fault === 'seed-volume') await pool.execute('DELETE FROM comments WHERE id=50000');
    if (fault === 'seed-volume') await readMysqlFixture(pool);
    adapters = await createAdapters();
    if (fault === 'arm-omit') {
      await adapters[4]!.close();
      adapters = adapters.slice(0, 4);
    }
    report.boundaries = [];
    for (const a of adapters)
      if (a.boundaries)
        (report.boundaries as unknown[]).push({
          arm: a.name,
          operation: 'capability refusals',
          proof: await a.boundaries(),
        });
    await pool.query('TRUNCATE TABLE bench_writes');
    try {
      const native = await adapters[0]!.bulk(bulkRows);
      assertMysqlExact('Turbine default createMany boundary', native, []);
      assertMysqlExact(
        'Turbine default createMany storage',
        await scratchNow(pool),
        bulkRows.map((r, i) => ({ id: i + 1, ...r })),
      );
      (report.boundaries as unknown[]).push({
        arm: 'Turbine',
        operation: 'default createMany',
        result: native,
        storedRows: 1000,
        status: 'returning unsupported; storage verified',
      });
    } finally {
      await pool.query('TRUNCATE TABLE bench_writes');
    }
    const escapeValue = "quote' slash\\ percent% underscore_ bang! 雪\n";
    for (const a of adapters) {
      const probe = async (value: string) => {
        await pool.query('TRUNCATE TABLE bench_writes');
        const result = await a.literalProbe(value);
        const rows = await scratchNow(pool);
        const expected = {
          id: 1,
          orgId: 1,
          slug: 'escape-probe',
          label: value,
          amount: 0,
          active: true,
          createdAt: FIXTURE_TIME,
        };
        assertMysqlExact(`${a.name} literal return`, result, expected);
        assertMysqlExact(`${a.name} literal storage`, rows, [expected]);
      };
      try {
        await probe('safe-original');
        let refusal: unknown;
        try {
          await probe(escapeValue);
        } catch (error) {
          refusal = error;
        }
        const unsupported = mode === 'no-backslash' && (a.name === 'Drizzle' || a.name === 'Drizzle RC');
        if (unsupported) {
          assert.ok(refusal, `${a.name} NBE text-interpolation boundary changed; re-audit`);
          assertMysqlExact(`${a.name} refused literal has no stored write`, await scratchNow(pool), []);
          (report.boundaries as unknown[]).push({
            arm: a.name,
            operation: 'escaped bound text',
            status: 'unsupported',
            scope:
              'NO_BACKSLASH_ESCAPES with native mysql2 text interpolation; original catalog corpus contains no such escapes',
            positive: 'safe-original exact',
            refusalStorage: 'independently verified empty after failed native write',
            error: (refusal as Error).message,
            errorChain: nativeErrorChain(refusal),
          });
        } else {
          if (refusal) throw refusal;
          (report.boundaries as unknown[]).push({ arm: a.name, operation: 'escaped bound text', status: 'pass' });
        }
      } finally {
        await pool.query('TRUNCATE TABLE bench_writes');
      }
    }
    assert.deepEqual(
      adapters.map((a) => a.name),
      [...ARM_NAMES],
      'complete five-arm roster required',
    );
    for (const a of adapters) {
      await pool.query('TRUNCATE TABLE bench_writes');
      try {
        let refusal: unknown;
        try {
          await a.bulkCount([
            { ...bulkRows[0]!, slug: 'duplicate-control' },
            { ...bulkRows[1]!, slug: 'duplicate-control' },
          ]);
        } catch (error) {
          refusal = error;
        }
        assert.ok(refusal, `${a.name} duplicate-key atomicity control unexpectedly accepted`);
        const errorChain = nativeErrorChain(refusal);
        assert.ok(
          errorChain.some(
            (e) => e.code === 'ER_DUP_ENTRY' || e.code === 'P2002' || /duplicate|unique/i.test(e.message),
          ),
          `${a.name} expected a native duplicate-key refusal: ${JSON.stringify(errorChain)}`,
        );
        assertMysqlExact(`${a.name} duplicate-key batch storage`, await scratchNow(pool), []);
        (report.boundaries as unknown[]).push({
          arm: a.name,
          operation: 'two-row duplicate-key bulk count',
          status: 'native refusal and zero stored rows verified',
          error: String(refusal),
          errorChain,
          scope: 'This batch only. No cross-chunk transaction, concurrency or shared-snapshot claim.',
        });
      } finally {
        await pool.query('TRUNCATE TABLE bench_writes');
      }
    }
    report.sessionSettings = [];
    for (const a of adapters) {
      const settings = (await a.settings()) as { sampledSession: Row[] };
      assert.equal(
        String(settings.sampledSession[0]!.sqlMode).includes('NO_BACKSLASH_ESCAPES'),
        mode === 'no-backslash',
        `${a.name} session SQL mode drift`,
      );
      (report.sessionSettings as Row[]).push({ arm: a.name, ...settings });
    }
    const [serverSettings] = await pool.query(
      "SHOW VARIABLES WHERE Variable_name IN ('version','version_compile_machine','version_compile_os','sql_mode','time_zone','system_time_zone','character_set_server','collation_server','transaction_isolation','autocommit','innodb_buffer_pool_size','innodb_flush_log_at_trx_commit','sync_binlog','log_bin','max_connections','max_prepared_stmt_count','performance_schema','optimizer_switch')",
    );
    report.serverSettings = serverSettings;
    report.transports = adapters.map((a) => ({
      name: a.name,
      protocol: a.protocol,
      poolLimit: 10,
      owner:
        a.name === 'Prisma 7' ? 'adapter; closed by $disconnect' : 'comparison; explicitly ends supplied mysql2 pool',
    }));
    report.preflight = [];
    await verify(
      pool,
      chosen.filter((s) => s.group !== 'latency'),
      adapters,
      fixture,
      fault,
      report.preflight as Row[],
    );
    if (fault === 'signal') {
      process.kill(process.pid, 'SIGTERM');
      await new Promise((r) => setImmediate(r));
    }
    checkInterrupted();
    const bench = new Bench({ rounds, warmup });
    const operationSamples: OperationSample[] = [];
    const operationResults: unknown[] = [];
    report.operationSamples = operationSamples;
    report.operationResults = operationResults;
    const driftSamples: OperationSample[] = [];
    report.driftSamples = driftSamples;
    if (!verifyOnly) {
      const driftHead = await driftMysql(bench, pool, 'head', driftSamples);
      for (const s of chosen.filter((s) => s.group !== 'latency')) {
        const supported = adapters.filter((a) => !s.unsupported?.[a.name as (typeof ARM_NAMES)[number]]);
        const fresh = new Map<string, Adapter[]>();
        const arms: Arm[] = supported.map((a) => ({
          name: a.name,
          setup: async () => {
            await prepare(pool, s, fixture!);
            if (s.cold) {
              const current = await createAdapter(a.name);
              fresh.set(a.name, [current]);
              await current.warm();
            }
          },
          fn: async (i, observe) => {
            checkInterrupted();
            if (s.cold) return s.run(fresh.get(a.name)!.find((c) => c.name === a.name)!, i, observe);
            return s.run(a, i, observe);
          },
        }));
        if (s.id === 'stream.parity') {
          const t = adapters.find((a) => a.name === 'Turbine')!;
          for (const name of ['T batches', 'T batches#2'])
            arms.push({ name, fn: (_i, observe) => t.stream('batches', observe) });
        }
        // Cold clients are released after the measured query, outside its sample.
        if (s.cold)
          for (const arm of arms) {
            const setup = arm.setup!;
            arm.setup = async (i) => {
              for (const a of fresh.get(arm.name) ?? []) await a.close();
              fresh.delete(arm.name);
              await setup(i);
            };
          }
        try {
          operationResults.push(
            await interleaveMysql(
              bench,
              s.name,
              arms,
              {
                rounds: s.cold
                  ? coldRounds
                  : s.stream
                    ? streamRounds
                    : s.group === 'headline'
                      ? headlineRounds
                      : s.group === 'deep'
                        ? deepRounds
                        : s.write === 'bulk' || s.write === 'bulk-count'
                          ? Math.max(15, Math.floor(extendedRounds / 5))
                          : s.id === 'large.comments-50000'
                            ? Math.max(10, Math.floor(extendedRounds / 10))
                            : s.id === 'large.wide'
                              ? Math.max(20, Math.floor(extendedRounds / 2))
                              : extendedRounds,
                warmup: s.cold
                  ? 0
                  : process.env.WARMUP
                    ? warmup
                    : s.group === 'headline'
                      ? 20
                      : s.stream
                        ? 2
                        : s.group === 'deep'
                          ? 25
                          : s.write === 'bulk' || s.write === 'bulk-count'
                            ? 3
                            : s.group === 'large'
                              ? 5
                              : 10,
                note: s.note,
                id: s.id,
                phase: s.cold ? 'first query after untimed connection establishment' : 'warmed client',
              },
              operationSamples,
            ),
          );
        } finally {
          for (const clients of fresh.values()) for (const c of clients) await c.close();
          if (s.write === 'increment') await restorePosts(pool, fixture);
          if (s.write && s.write !== 'increment') await pool.query('TRUNCATE TABLE bench_writes');
        }
      }
      const driftTail = await driftMysql(bench, pool, 'tail', driftSamples);
      bench.reportDrift([driftHead, driftTail]);
      report.drift = { head: driftHead, tail: driftTail };
    }
    const latency = chosen.filter((s) => s.group === 'latency');
    const latencyReports: Row[] = [];
    report.latency = latencyReports;
    if (latency.length) {
      const rtts = (process.env.RTTS ?? '0,1,5,25').split(',').map(Number);
      assert.ok(
        rtts.length > 0 &&
          new Set(rtts).size === rtts.length &&
          rtts.every((n) => Number.isFinite(n) && n >= 0 && n <= 1000),
        'invalid RTTS',
      );
      assert.ok(
        verifyOnly || process.env.MYSQL_COMPARISON_DIAGNOSTIC === '1' || JSON.stringify(rtts) === '[0,1,5,25]',
        'complete timing requires RTTS=0,1,5,25',
      );
      report.rtts = rtts;
      for (const rtt of rtts) {
        const original = process.env.MYSQL_COMPARISON_URL!;
        const proxy = await delayProxy(rtt);
        let through: Adapter[] = [];
        let probe: Pool | undefined;
        try {
          process.env.MYSQL_COMPARISON_URL = proxy.url;
          through = await createAdapters();
          probe = makePool();
          const verified: Row[] = [];
          const latencyRecord: Row = { rttMs: rtt, port: proxy.port, preflight: verified };
          latencyReports.push(latencyRecord);
          await verify(probe, latency, through, fixture, undefined, verified);
          const latencyBench = new Bench({ rounds: latencyRounds, warmup: process.env.WARMUP ? warmup : 3 });
          let measured: number | undefined;
          if (!verifyOnly) {
            measured = await driftMysql(latencyBench, probe, `RTT ${rtt}`, driftSamples);
            for (const s of latency)
              operationResults.push(
                await interleaveMysql(
                  latencyBench,
                  `${s.name}, RTT ${rtt}ms`,
                  through
                    .filter((a) => !s.unsupported?.[a.name as (typeof ARM_NAMES)[number]])
                    .map((a) => ({ name: a.name, fn: (i) => s.run(a, i) })),
                  {
                    note: s.note,
                    rounds: latencyRounds,
                    warmup: process.env.WARMUP ? warmup : 3,
                    id: s.id,
                    phase: 'warmed client through owned proxy',
                    rttMs: rtt,
                  },
                  operationSamples,
                ),
              );
          }
          Object.assign(latencyRecord, {
            measuredSelect1Ms: measured,
            results: retainedResults(latencyBench.results, operationSamples),
          });
        } finally {
          for (const a of through) await a.close();
          await probe?.end();
          await proxy.close();
          (cleanup.proxies as Row[]).push({ port: proxy.port, closed: true });
          process.env.MYSQL_COMPARISON_URL = original;
        }
      }
    }
    report.results = retainedResults(bench.results, operationSamples);
    report.sampleSummarySource =
      'All JSON result summaries are recomputed from retained operationSamples; drift medians from retained driftSamples. Shared Bench stdout has wider call bounds and is diagnostic only. No aggregate percentiles from cell medians.';
    assertMysqlExact('final fixture restoration', await readMysqlFixture(pool), fixture);
    cleanup.fixtureRestored = true;
    report.poolOwnership = adapters.map((a) => ({ arm: a.name, observation: a.ownership() }));
    checkInterrupted();
    report.status = 'pass';
  } catch (error) {
    report.error = error instanceof Error ? { name: error.name, message: error.message } : String(error);
    throw error;
  } finally {
    const errors: string[] = [];
    if (fixture && report.status !== 'pass')
      try {
        if (fault === 'seed-volume') {
          const c = fixture.comments[49999]!;
          await pool.execute(
            'INSERT INTO comments (id,post_id,user_id,body,created_at) VALUES (?,?,?,?,?)',
            bind([c.id, c.postId, c.userId, c.body, c.createdAt]),
          );
        }
        await restorePosts(pool, fixture);
        await pool.query('TRUNCATE TABLE bench_writes');
        assertMysqlExact('failure fixture restoration', await readMysqlFixture(pool), fixture);
        cleanup.fixtureRestored = true;
      } catch (error) {
        errors.push(`failure restoration: ${String(error)}`);
      }
    for (const a of adapters) {
      try {
        await a.close();
        (cleanup.adapters as Row[]).push({ arm: a.name, closed: true });
      } catch (error) {
        errors.push(`close ${a.name}: ${String(error)}`);
      }
    }
    try {
      const database = connectionOptions().database;
      const checks: Row[][] = [];
      cleanup.armBackendChecks = checks;
      await settleMysqlArmBackends(
        async () => {
          const [rows] = await pool.execute(
            'SELECT ID, DB, USER FROM information_schema.PROCESSLIST WHERE DB = ? AND ID <> CONNECTION_ID()',
            [database],
          );
          return rows as Row[];
        },
        (rows) => {
          checks.push(rows);
          cleanup.remainingArmBackends = rows;
        },
      );
    } catch (error) {
      errors.push(String(error));
    }
    try {
      await pool.end();
      cleanup.oracleClosed = true;
      cleanup.mysql2Pools = poolSnapshots();
      assert.ok(
        poolSnapshots().every((p) => p.closed && p.queued === 0),
        'a comparison mysql2 pool remained open or queued',
      );
    } catch (error) {
      errors.push(String(error));
    }
    if (fault === 'cleanup') errors.push('forced cleanup reporting fault after actual cleanup');
    cleanup.errors = errors;
    if (errors.length) {
      report.status = 'failure';
      process.exitCode = 1;
    }
    if (output) writeFileSync(resolve(output), JSON.stringify(report, null, 2) + '\n');
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
    console.log('\n=== JSON ===');
    console.log(JSON.stringify(report, null, 2));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runMysqlComparison().catch((error) => {
    if (process.env.MYSQL_COMPARISON_OUTPUT && !existsSync(process.env.MYSQL_COMPARISON_OUTPUT))
      writeFileSync(
        process.env.MYSQL_COMPARISON_OUTPUT,
        JSON.stringify({
          format: 'mysql-comparison-v1',
          status: 'failure',
          phase: 'admission',
          error: error instanceof Error ? error.message : String(error),
          cleanup: { backendAllocated: false },
        }) + '\n',
      );
    console.error('MySQL comparison error:', error);
    process.exitCode = 1;
  });

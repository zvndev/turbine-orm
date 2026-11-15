/** Real pinned correctness facts plus explicitly synthetic timing cells. No comparative timing. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { summarizeSamples } from './bench-harness.js';
import {
  assertComparisonRun,
  assertComparisonRuns,
  type ComparisonFinalManifest,
  type Engine,
  loadComparisonFinalManifest,
} from './comparison-results.js';

// biome-ignore lint/suspicious/noExplicitAny: serialized producer schemas differ deliberately.
type Report = Record<string, any>;
const directory = process.env.COMPARISON_POSITIVE_DIRECTORY;
assert.ok(directory, 'explicit frozen comparison report/manifest fixture directory required');
const root = fileURLToPath(new URL('..', import.meta.url));
const load = (name: string) => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const native = (engine: Engine, mode = 'ordinary'): Report => {
  const r = load(engine === 'sqlite' ? 'sqlite-native.json' : `mysql-${mode}.json`);
  if (engine === 'mysql') {
    // Historical correctness facts reused only as synthetic admission-shape fixtures.
    r.installed.artifact.mysqlEntry = r.installed.artifact.packageRoot + '/dist/mysql.js';
    r.installed.artifact.generationEntry = r.installed.artifact.packageRoot + '/dist/generate.js';
    r.hashes.benchmark['benchmarks/comparison-inventory.ts'] = 'e'.repeat(64);
  }
  return r;
};
const expected = (engine: Engine, mode = 'ordinary'): Report => {
  const e = load(engine === 'sqlite' ? 'sqlite-manifest.json' : `mysql-${mode}-manifest.json`);
  if (engine === 'mysql') {
    const r = native(engine, mode);
    for (const field of ['packageRoot', 'entry', 'requireEntry', 'mysqlEntry', 'generationEntry'])
      e.artifact[field] = r.installed.artifact[field];
    e.hashes.benchmark['benchmarks/comparison-inventory.ts'] = 'e'.repeat(64);
  }
  e.inventory = {
    repository: '/synthetic-admission-fixture/repository',
    benchmark: '/synthetic-admission-fixture/benchmark',
  };
  if (engine === 'sqlite') {
    const r = native(engine);
    for (const [name, item] of Object.entries(e.dependencies)) (item as Report).root = r.dependencies[name].packageRoot;
  }
  return e;
};
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fixtureClosure = (engine: Engine, e: Report) => {
  const paths = [
    'tsx/dist/loader.mjs',
    'esbuild/lib/main.js',
    '@esbuild/linux-x64/bin/esbuild',
    ...(engine === 'sqlite'
      ? ['bindings/bindings.js', 'file-uri-to-path/index.js', 'better-sqlite3/build/Release/better_sqlite3.node']
      : ['mysql2/promise.js', 'mariadb/promise.js']),
  ];
  const files = Object.fromEntries(
    paths.map((path) => [`/synthetic-admission-fixture/node_modules/${path}`, 'f'.repeat(64)]),
  );
  const add = (base: string, entries: Record<string, string>, strip = '') => {
    for (const [path, hash] of Object.entries(entries)) files[join(base, path.replace(strip, ''))] = hash;
  };
  if (engine === 'mysql') {
    files[e.runtime.executable] = e.runtime.sha256;
    add(e.artifact.packageRoot, e.artifact.payload);
    add(e.inventory.benchmark, e.hashes.benchmark, 'benchmarks/');
    for (const group of ['turbineGenerated', 'prismaGenerated']) add(e.inventory.benchmark, e.hashes[group]);
    for (const item of Object.values(e.packages) as Report[]) add(item.root, item.files);
  } else {
    files[e.node.executable] = e.node.sha256;
    add(e.artifact.installedPackageRoot, e.artifact.installedFiles);
    add(join(e.inventory.benchmark, 'generated'), e.generated.files);
    add(
      e.inventory.repository,
      Object.fromEntries(
        Object.entries(e.hashes as Record<string, string>).filter(([p]) => p.startsWith('benchmarks/')),
      ),
    );
    for (const item of Object.values(e.dependencies) as Report[]) add(item.root, item.files);
  }
  return { sha256: digest(files), files };
};
const stat = (name: string, n: number) => ({
  name,
  n,
  median: 1,
  avg: 1,
  p95: 1,
  min: 1,
  samplesMs: Array(n).fill(1),
  p99: n < 100 ? null : 1,
  p99Status: n < 100 ? 'unavailable-small-n' : n < 1000 ? 'unstable-tail' : 'estimated',
  sampleMethod: 'milliseconds; p50 arithmetic median; p95/p99 nearest rank',
});
function shape(engine: Engine, mode = 'ordinary'): { report: Report; manifest: ComparisonFinalManifest } {
  const r = native(engine, mode),
    e = expected(engine, mode);
  // These are disposable format fixtures. They are never final campaign evidence.
  r.admissionFixtureOnly = true;
  r.runtimeClosure = fixtureClosure(engine, e);
  e.runtimeClosure = fixtureClosure(engine, e);
  if (engine === 'sqlite') {
    r.mode = 'timing';
    const cfg = { quick: true, rounds: 1, warmup: 0, streamRounds: 1, coldRounds: 1 };
    r.sampleSettings = { ...cfg };
    e.sampleSettings = { ...cfg };
    for (const name of ['Turbine', 'Raw', 'Drizzle', 'Drizzle RC', 'Prisma 7'])
      r.cleanup.handles.push({
        id: r.cleanup.handles.length + 1,
        name,
        closed: true,
        nativeClosed: true,
        transactionAtClose: false,
      });
    const cells = r.catalog.filter((c: Report) => c.status === 'supported');
    r.results = [...new Set(cells.map((c: Report) => c.scenario))].map((scenario) => ({
      scenario,
      stats: cells
        .filter((c: Report) => c.scenario === scenario)
        .map((c: Report) => summarizeSamples(c.arm, [1], true)),
    }));
  } else {
    r.verifyOnly = false;
    const cfg = { headline: 1, extended: 1, stream: 1, latency: 1, deep: 1, cold: 1 };
    r.groupRounds = { ...cfg };
    r.warmup = 0;
    e.settings = { mode, groupRounds: { ...cfg }, warmup: 0 };
    r.operationSamples = [];
    r.operationResults = [];
    r.drift = { head: 1, tail: 1 };
    r.driftSamples = [];
    for (const section of [r, ...r.latency]) {
      const latency = section !== r;
      section.measuredSelect1Ms = 1;
      section.results = r.catalog
        .filter((c: Report) => (c.group === 'latency') === latency)
        .map((c: Report) => {
          const arms = c.arms.filter((a: Report) => a.status === 'supported').map((a: Report) => a.name);
          if (c.id === 'stream.parity') arms.push('T batches', 'T batches#2');
          const n = ['writes.bulk', 'writes.bulk-count'].includes(c.id)
            ? 15
            : c.id === 'large.comments-50000'
              ? 10
              : c.id === 'large.wide'
                ? 20
                : 1;
          const scenario = latency ? `${c.scenario}, RTT ${section.rttMs}ms` : c.scenario;
          for (const arm of arms)
            for (let round = 0; round < n; round++)
              r.operationSamples.push({
                scenario,
                scenarioId: c.id,
                arm,
                round,
                durationMs: 1,
                ...(latency ? { rttMs: section.rttMs } : {}),
                phase: latency
                  ? 'warmed client through owned proxy'
                  : c.group === 'cold'
                    ? 'first query after untimed connection establishment'
                    : 'warmed client',
              });
          r.operationResults.push({
            scenario,
            summary: arms.map((arm: string) => ({ arm, n, p50Ms: 1, avgMs: 1, minMs: 1, p95Ms: 1, p99Ms: null })),
          });
          return { scenario, stats: arms.map((arm: string) => stat(arm, n)) };
        });
    }
    for (const label of ['head', 'tail', 'RTT 0', 'RTT 1', 'RTT 5', 'RTT 25'])
      for (let round = 0; round < 500; round++)
        r.driftSamples.push({ scenario: `drift.${label}`, arm: 'oracle SELECT 1', round, durationMs: 1 });
  }
  return { report: r, manifest: e as ComparisonFinalManifest };
}
for (const engine of ['sqlite', 'mysql'] as const) {
  test(`${engine}: explicit external pinned manifest admits real correctness; unbound identities fail closed`, () => {
    assertComparisonRun(native(engine), engine, false, expected(engine) as ComparisonFinalManifest);
    assert.throws(() => assertComparisonRun(native(engine), engine, false), /Explicit final/);
    assert.throws(() => assertComparisonRun(native(engine), engine), /runtime-closure/);
    const { report, manifest } = shape(engine);
    assertComparisonRuns([report, structuredClone(report)], engine, manifest);
  });
  test(`${engine}: preserve catalog, closure, input and sample admission guards`, () => {
    const faults = [
      (r: Report) => r.catalog.pop(),
      (r: Report) => r.preflight.pop(),
      (r: Report) => {
        r.cleanup.errors.push('close failed');
      },
      (r: Report) => {
        r.error = 'failed';
      },
      (r: Report) => {
        r.hashes = {};
      },
      (r: Report) => r.results.pop(),
      (r: Report) => r.results[0].stats.pop(),
      (r: Report) => {
        r.results[0].stats[0].n = 0;
      },
      (r: Report) => {
        r.results[0].stats[0].median = NaN;
      },
      (r: Report) => {
        delete r.results[0].stats[0].samplesMs;
      },
      (r: Report) => r.results[0].stats[0].samplesMs.pop(),
      (r: Report) => {
        r.results[0].stats[0].samplesMs[0] = 999;
      },
      (r: Report) => {
        r.results[0].stats[0].p99 = 1;
      },
      (r: Report) => {
        r.results[0].stats[0].p99Status = 'estimated';
      },
      (r: Report) => {
        delete r.runtimeClosure;
      },
      (r: Report) => {
        r.runtimeClosure.files = {};
      },
    ];
    for (const fault of faults) {
      const { report, manifest } = shape(engine);
      fault(report);
      assert.throws(() => assertComparisonRun(report, engine, true, manifest));
    }
    const { report, manifest } = shape(engine),
      other = structuredClone(report);
    (engine === 'sqlite' ? other.identity : other.git).head = 'a'.repeat(40);
    assert.throws(() => assertComparisonRuns([report, other], engine, manifest));
  });
}

test('SQLite pinned producer contract: all 19 published held-out mutations are rejected', () => {
  const faults: ((r: Report) => void)[] = [
    (r) => {
      delete r.artifact;
    },
    (r) => {
      r.artifact.sha256 = '0'.repeat(64);
    },
    (r) => {
      r.artifact.verified = false;
    },
    (r) => {
      r.turbineRuntime.route = 'worktree-built-dist';
    },
    (r) => {
      delete r.identity.executableSha256;
    },
    (r) => {
      delete r.turbineRuntime.nativeIntrospectionEntrySha256;
    },
    (r) => {
      delete r.sourceIdentity;
    },
    (r) => {
      r.sourceIdentity.files = Object.fromEntries(Object.entries(r.sourceIdentity.files).slice(0, 1));
    },
    (r) => {
      delete r.localDistIdentity;
    },
    (r) => {
      r.localDistIdentity.files = {};
    },
    (r) => {
      delete r.generatedIdentity;
    },
    (r) => {
      r.hashes = Object.fromEntries(Object.entries(r.hashes).slice(0, 1));
    },
    (r) => {
      delete r.hashes['benchmarks/sqlite-comparison-identity.ts'];
    },
    (r) => {
      delete r.dependencies['better-sqlite3'];
    },
    (r) => {
      r.dependencies['better-sqlite3'].files = {};
    },
    (r) => {
      r.versions.prismaCli = '8.0.0-rc.33';
    },
    (r) => {
      r.preflight.find((v: Report) => v.id === 'headline-10').inputs.pop();
    },
    (r) => {
      r.identity.sourceStatus = ' M benchmarks/bench-sqlite.ts';
    },
    (r) => {
      r.refusalControls.pop();
    },
  ];
  for (const fault of faults) {
    const r = native('sqlite');
    fault(r);
    assert.throws(() => assertComparisonRun(r, 'sqlite', false, expected('sqlite') as ComparisonFinalManifest));
  }
});

test('SQLite retains existing native closure, transaction, value and refusal obligations', () => {
  const faults = [
    (r: Report) => {
      r.cleanup.handles[0].nativeClosed = false;
    },
    (r: Report) => r.cleanup.handles.pop(),
    (r: Report) => {
      r.cleanup.handles[0].name = 'Unknown';
    },
    (r: Report) => {
      r.preflight.find((v: Report) => v.id === 'headline-6').values = 0;
    },
    (r: Report) => {
      r.preflight.find((v: Report) => v.id === 'list-deep').values = 1;
    },
    (r: Report) => {
      r.transactions = [];
    },
    (r: Report) => r.transactions[0].events.pop(),
    (r: Report) => {
      r.transactions[0].events[0].transaction = true;
    },
    (r: Report) => {
      r.refusalControls = [];
    },
    (r: Report) => {
      delete r.hashes['src/sqlite.ts'];
    },
    (r: Report) => {
      delete r.dependencies['better-sqlite3'].files['build/Release/better_sqlite3.node'];
    },
    (r: Report) => {
      r.settings.perArm[4].nativePragmaIntegerType = 'number';
    },
    (r: Report) => {
      r.preflight.find((v: Report) => v.id !== 'headline-10').inputs = [];
    },
  ];
  for (const fault of faults) {
    const { report, manifest } = shape('sqlite');
    fault(report);
    assert.throws(() => assertComparisonRun(report, 'sqlite', true, manifest));
  }
});

test('shared sample admission recomputes tails at n=99/100/1000 with the published PG status contract', () => {
  for (const rounds of [99, 100, 1000]) {
    const { report, manifest } = shape('sqlite');
    report.sampleSettings.rounds = rounds;
    (manifest as Report).sampleSettings.rounds = rounds;
    for (const result of report.results) {
      const cell = report.catalog.find((c: Report) => c.scenario === result.scenario && c.status === 'supported');
      const n = cell.group === 'cold' || ['headline-6', 'stream-parity'].includes(cell.id) ? 1 : rounds;
      result.stats = result.stats.map((s: Report) => ({
        ...s,
        n,
        samplesMs: Array.from({ length: n }, (_, i) => i + 1),
        min: 1,
        median: (n + 1) / 2,
        avg: (n + 1) / 2,
        p95: Math.ceil(n * 0.95),
        p99: n < 100 ? null : Math.ceil(n * 0.99),
        p99Status: n < 100 ? 'unavailable-small-n' : n < 1000 ? 'unstable-tail' : 'estimated',
      }));
    }
    assertComparisonRun(report, 'sqlite', true, manifest);
    const changed = structuredClone(report);
    changed.results[0].stats[0].median += 0.25;
    assert.throws(() => assertComparisonRun(changed, 'sqlite', true, manifest), /differs from retained samples/);
    changed.results[0].stats[0].median -= 0.25;
    changed.results[0].stats[0].p99Status = rounds < 100 ? 'estimated' : 'unavailable-small-n';
    assert.throws(() => assertComparisonRun(changed, 'sqlite', true, manifest));
  }
});

test('SQLite accepts actual structured sample metadata and rejects altered quantile contracts', () => {
  for (const field of ['unit', 'p50', 'p95', 'p99', 'scope']) {
    const { report, manifest } = shape('sqlite');
    report.results[0].stats[0].sampleMethod[field] = 'incorrect';
    assert.throws(() => assertComparisonRun(report, 'sqlite', true, manifest));
  }
  const { report, manifest } = shape('sqlite');
  delete report.results[0].stats[0].sampleMethod;
  assert.throws(() => assertComparisonRun(report, 'sqlite', true, manifest));
});

test('MySQL binds actual installed entry paths independently of the claimed payload', () => {
  for (const field of ['packageRoot', 'entry', 'requireEntry', 'mysqlEntry', 'generationEntry']) {
    const r = native('mysql');
    r.installed.artifact[field] = '/unrelated/installed-entry.js';
    assert.throws(() => assertComparisonRun(r, 'mysql', false, expected('mysql') as ComparisonFinalManifest));
  }
});

test('MySQL: complete external source/dist/generated/driver/runtime/archive provenance is mandatory', () => {
  const faults = [
    (r: Report) => {
      delete r.installed;
    },
    (r: Report) => {
      delete r.hashes;
    },
    (r: Report) => {
      delete r.installed.runtime;
    },
    (r: Report) => {
      delete r.installed.artifact;
    },
    (r: Report) => {
      r.installed.artifact.sha256 = '0'.repeat(64);
    },
    (r: Report) => {
      r.installed.runtime.node = 'v26.12.0';
    },
    (r: Report) => {
      delete r.installed.runtime.sha256;
    },
    (r: Report) => {
      r.installed.packages.mysql2.entries = [];
    },
    (r: Report) => {
      r.installed.installedLock = {};
    },
    ...['source', 'dist', 'benchmark', 'turbineGenerated', 'prismaGenerated'].flatMap((group) => [
      (r: Report) => {
        delete r.hashes[group];
      },
      (r: Report) => {
        r.hashes[group] = Object.fromEntries(Object.entries(r.hashes[group]).slice(0, 1));
      },
    ]),
    (r: Report) => {
      delete r.hashes.benchmark['benchmarks/mysql-comparison-provenance.ts'];
    },
    (r: Report) => {
      r.installed.packages.mysql2.files = {};
    },
    (r: Report) => {
      r.executionScope = 'local-source-dist';
    },
  ];
  for (const fault of faults) {
    const r = native('mysql');
    fault(r);
    assert.throws(() => assertComparisonRun(r, 'mysql', false, expected('mysql') as ComparisonFinalManifest));
  }
  const r = native('mysql'),
    e = expected('mysql');
  for (const group of ['source', 'dist', 'benchmark', 'turbineGenerated', 'prismaGenerated']) {
    r.hashes[group] = { 'unrelated.d.ts': 'a'.repeat(64) };
    e.hashes[group] = { 'unrelated.d.ts': 'a'.repeat(64) };
  }
  assert.throws(() => assertComparisonRun(r, 'mysql', false, e as ComparisonFinalManifest));
  const missing = expected('mysql');
  delete missing.packages;
  assert.throws(() => assertComparisonRun(native('mysql'), 'mysql', false, missing as ComparisonFinalManifest));
});

test('MySQL: exact versioned boundaries and negative-oracle ledgers survive both SQL modes', () => {
  for (const mode of ['ordinary', 'no-backslash']) {
    assertComparisonRun(native('mysql', mode), 'mysql', false, expected('mysql', mode) as ComparisonFinalManifest);
    const faults = [
      (r: Report) => {
        delete r.boundaries;
      },
      (r: Report) => {
        r.boundaries = [];
      },
      (r: Report) => r.boundaries.pop(),
      (r: Report) => {
        delete r.controls;
      },
      (r: Report) => r.controls.pop(),
      (r: Report) => {
        r.boundaryContract = 'unversioned';
      },
      (r: Report) => {
        r.oracleControlContract = 'unversioned';
      },
      (r: Report) => {
        r.boundaries.find((b: Report) => b.operation === 'capability refusals').proof.pipelineSupported = true;
      },
      (r: Report) => {
        r.boundaries.find((b: Report) => b.operation === 'default createMany').storedRows = 0;
      },
      (r: Report) => {
        r.boundaries.find((b: Report) => b.operation === 'escaped bound text' && b.arm === 'Drizzle').status =
          mode === 'ordinary' ? 'unsupported' : 'pass';
      },
      (r: Report) => {
        r.boundaries.find((b: Report) => b.operation === 'two-row duplicate-key bulk count').errorChain = [];
      },
    ];
    if (mode === 'no-backslash')
      faults.push((r) => {
        delete r.boundaries.find((b: Report) => b.operation === 'escaped bound text' && b.arm === 'Drizzle RC')
          .refusalStorage;
      });
    for (const fault of faults) {
      const r = native('mysql', mode);
      fault(r);
      assert.throws(() => assertComparisonRun(r, 'mysql', false, expected('mysql', mode) as ComparisonFinalManifest));
    }
  }
});

test('MySQL retains correctness-input, server, transport and repeat-profile guards', () => {
  const faults = [
    (r: Report) => {
      r.server.version = '8.4.1';
    },
    (r: Report) => {
      r.server.sqlMode = 'NO_ENGINE_SUBSTITUTION';
    },
    (r: Report) => {
      r.server.isolationLevel = 'READ-UNCOMMITTED';
    },
    (r: Report) => {
      r.transports[0].poolLimit = 1;
    },
    (r: Report) => {
      r.transports[0].protocol = 'different protocol';
    },
    (r: Report) => {
      r.fixtureHash = 'a'.repeat(64);
    },
    (r: Report) => {
      delete r.server.isolationLevel;
    },
    (r: Report) => {
      delete r.fixtureHash;
    },
    (r: Report) => {
      Object.assign(
        r.preflight.find((v: Report) => v.scenario === 'headline.hot' && v.arm === 'Turbine' && v.input === 49),
        { scenario: 'headline.flat', input: 999 },
      );
    },
    (r: Report) => r.operationSamples.pop(),
    (r: Report) => {
      r.operationSamples[0].round = 999;
    },
    (r: Report) => r.driftSamples.pop(),
  ];
  for (const fault of faults) {
    const { report, manifest } = shape('mysql'),
      other = structuredClone(report);
    fault(other);
    assert.throws(() => assertComparisonRuns([report, other], 'mysql', manifest));
  }
  const { report, manifest } = shape('mysql'),
    equivalent = structuredClone(report);
  Object.assign(equivalent.server, { port: 1, dataDirectory: '/different-owned-service/', oracleConnectionId: 999 });
  equivalent.server.sqlMode = equivalent.server.sqlMode.split(',').reverse().join(',');
  equivalent.transports.reverse();
  assertComparisonRuns([report, equivalent], 'mysql', manifest);
});

test('actual collectors refuse declaration-only fixtures before output', (t) => {
  const scratch = mkdtempSync(join(root, 'node_modules/.comparison-collector-test-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const bench = join(scratch, 'benchmarks');
  mkdirSync(bench);
  for (const name of readdirSync(join(root, 'benchmarks')).filter((name) => name.endsWith('.ts')))
    copyFileSync(join(root, 'benchmarks', name), join(bench, name));
  for (const engine of ['sqlite', 'mysql'] as const) {
    const out = join(scratch, engine);
    mkdirSync(out);
    const output = join(out, `${engine}-results.json`),
      manifestPath = join(out, 'explicit-final-manifest.json');
    const prefix = engine === 'sqlite' ? 'SQLITE_COMPARISON' : 'MYSQL_COMPARISON';
    const put = (report: Report, manifest: ComparisonFinalManifest) => {
      writeFileSync(join(out, `${engine}-run1.json`), JSON.stringify(report));
      writeFileSync(join(out, `${engine}-run1.runtime-closure.json`), JSON.stringify(report.runtimeClosure));
      writeFileSync(manifestPath, JSON.stringify(manifest));
    };
    const invoke = (bound = true) =>
      spawnSync(
        process.execPath,
        ['--import', join(root, 'node_modules/tsx/dist/loader.mjs'), join(bench, 'build-results.ts'), engine, out],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 20000,
          env: {
            ...process.env,
            [`${prefix}_FINAL_MANIFEST`]: bound ? manifestPath : '',
            [`${prefix}_FINAL_MANIFEST_SHA256`]: createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
          },
        },
      );
    const { report, manifest } = shape(engine);
    put(report, manifest);
    const pass = invoke();
    assert.notEqual(pass.status, 0, 'A declaration-only fixture is not independently verified final evidence');
    assert.equal(existsSync(output), false);
    assert.notEqual(invoke(false).status, 0);
    assert.equal(existsSync(output), false);
    const faults =
      engine === 'mysql'
        ? [
            (r: Report) => {
              delete r.boundaries;
            },
            (r: Report) => {
              delete r.controls;
            },
            (r: Report) => {
              r.hashes.dist = {};
            },
            (r: Report) => r.results[0].stats[0].samplesMs.pop(),
          ]
        : [
            (r: Report) => {
              delete r.artifact;
            },
            (r: Report) => {
              r.sourceIdentity.files = {};
            },
            (r: Report) => {
              delete r.hashes['benchmarks/sqlite-comparison-run.ts'];
            },
            (r: Report) => r.preflight.find((v: Report) => v.id === 'headline-10').inputs.pop(),
          ];
    for (const fault of faults) {
      const changed = structuredClone(report);
      fault(changed);
      put(changed, manifest);
      assert.notEqual(invoke().status, 0);
      assert.equal(existsSync(output), false);
    }
    put(report, manifest);
    writeFileSync(join(out, `${engine}-run3.json`), JSON.stringify(report));
    assert.notEqual(invoke().status, 0);
    assert.equal(existsSync(output), false);
    assert.throws(() =>
      loadComparisonFinalManifest(
        engine,
        manifestPath,
        createHash('sha256').update(readFileSync(manifestPath)).digest('hex'),
      ),
    );
    assert.throws(() => loadComparisonFinalManifest(engine, manifestPath, '0'.repeat(64)), /manifest hash changed/);
  }
});

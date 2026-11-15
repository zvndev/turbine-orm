/** Runnable negative controls, no database service and no timing campaign. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { admit, argumentsFor, bundlePlugin, root, sha } from './optional-sqlite-runner.mjs';
import { isDeepStrictEqual as workerEqual } from './optional-sqlite-util.mjs';

const deps = createRequire(join(root, 'benchmarks/optional-sqlite-deps/package.json'));
const directory = mkdtempSync(join(tmpdir(), 'turbine-optional-sqlite-control-'));
after(() => {
  rmSync(directory, { recursive: true, force: true });
  deps('esbuild').stop();
});
try {
  const outfile = join(directory, 'contract.mjs');
  await deps('esbuild').build({
    entryPoints: [join(root, 'benchmarks/optional-sqlite-contract.mjs')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    plugins: [bundlePlugin({ artifact: root })],
    logLevel: 'silent',
  });
  const contract = await import(pathToFileURL(outfile));
  const {
    assertContractReport,
    assertExact,
    arms,
    operations,
    controlIds,
    catalog,
    summary,
    expected,
    runContract,
    dimensions,
    decodeRaw,
  } = contract;
  const shape = (platform) => ({
    catalog,
    preflight: operations.flatMap((operation) =>
      arms.map((arm) => ({
        operation,
        arm,
        exact: true,
        effectExact: true,
        values: operation === 'flat-100' ? 700 : operation === 'nullable-17' ? 68 : 7,
      })),
    ),
    controls: controlIds[platform].map((id) => ({ id, passed: true })),
    samples: [],
    results: [],
    dimensions: dimensions(),
  });
  test('complete contract shape is admitted for both distinct platforms', () => {
    for (const platform of ['d1', 'libsql']) assertContractReport(shape(platform), platform, { mode: 'preflight' });
  });
  for (const [name, fault] of [
    [
      'omitted arm',
      (report) => {
        report.preflight = report.preflight.filter((cell) => cell.arm !== 'Drizzle RC 1.0.0-rc.5');
      },
    ],
    [
      'omitted operation',
      (report) => {
        report.preflight = report.preflight.filter((cell) => cell.operation !== 'delete-returning');
      },
    ],
    [
      'duplicate cell',
      (report) => {
        report.preflight[0] = report.preflight[1];
      },
    ],
    [
      'missing rollback/refusal',
      (report) => {
        report.controls.pop();
      },
    ],
    [
      'failed control',
      (report) => {
        report.controls[0].passed = false;
      },
    ],
    [
      'missing exact effects',
      (report) => {
        delete report.preflight[0].effectExact;
      },
    ],
    [
      'lost result values',
      (report) => {
        report.preflight[0].values--;
      },
    ],
    [
      'unaccepted preflight timing',
      (report) => {
        report.samples.push({ milliseconds: [1] });
      },
    ],
  ])
    test(`reject ${name}`, () => {
      for (const platform of ['d1', 'libsql']) {
        const report = shape(platform);
        fault(report);
        assert.throws(() => assertContractReport(report, platform, { mode: 'preflight' }));
      }
    });
  test('exact oracle rejects ordering, nullability, loss of keys and integer rounding', () => {
    const rows = expected('flat-100');
    assert.throws(() => assertExact('order', [...rows].reverse(), rows));
    assert.throws(() => assertExact('null', [{ ...rows[0], avatarUrl: '' }], [rows[0]]));
    const missing = { ...rows[0] };
    delete missing.lastLoginAt;
    assert.throws(() => assertExact('key', [missing], [rows[0]]));
    assert.throws(() => assertExact('integer', { id: 9007199254740992 }, { id: 9007199254740993n }));
  });
  test('Worker comparator shim preserves undefined, null, ordering and missing keys', () => {
    const value = Object.assign(Object.create(null), { a: undefined, b: null, rows: [1, 2] });
    assert.equal(workerEqual(value, { a: undefined, b: null, rows: [1, 2] }), true);
    assert.equal(workerEqual(value, { b: null, rows: [1, 2] }), false);
    assert.equal(workerEqual(value, { a: undefined, b: '', rows: [1, 2] }), false);
    assert.equal(workerEqual(value, { a: undefined, b: null, rows: [2, 1] }), false);
  });
  test('executing a contract with an omitted arm refuses before work', async () => {
    await assert.rejects(
      runContract(
        arms.slice(1).map((name) => ({ name })),
        () => {},
        { mode: 'preflight' },
      ),
      /required arms/,
    );
  });
  test('p99 derives only from actual samples, small n unavailable', () => {
    assert.equal(summary([]).p99, null);
    assert.equal(summary([1, 3]).p50, 2);
    assert.equal(summary([1, 3]).p99, null);
    assert.equal(summary(Array.from({ length: 100 }, (_, i) => i + 1)).p99, 99);
  });
  test('synthetic Bench control retains only post-warmup samples and rejects sample omissions', async () => {
    let rows = [];
    const options = { mode: 'campaign', rounds: 3, warmup: 1 };
    const report = await runContract(
      arms.map((name) => ({
        name,
        run: async (operation) => {
          rows = operation === 'insert-returning' || operation === 'update-returning' ? [expected(operation)] : [];
          return expected(operation);
        },
      })),
      async (operation) => (operation === 'inspect' ? rows : undefined),
      options,
    );
    report.controls = controlIds.libsql.map((id) => ({ id, passed: true }));
    assertContractReport(report, 'libsql', options);
    assert.equal(report.samples.length, 30);
    assert.ok(report.results.every((result) => result.n === 3 && result.p99 === null));
    for (const [label, mutate] of [
      [
        'missing results',
        (r) => {
          r.results = [];
        },
      ],
      [
        'omitted result',
        (r) => {
          r.results.pop();
        },
      ],
      [
        'duplicate result',
        (r) => {
          r.results[0] = r.results[1];
        },
      ],
      [
        'invented count',
        (r) => {
          r.results[0].n++;
        },
      ],
      [
        'invented median',
        (r) => {
          r.results[0].p50 = 123;
        },
      ],
      [
        'invented tail',
        (r) => {
          r.results[0].p95 = 456;
        },
      ],
      [
        'invented p99',
        (r) => {
          r.results[0].p99 = 789;
        },
      ],
      [
        'invalid throughput',
        (r) => {
          r.results[0].throughput.operationsPerSecond = -1;
        },
      ],
      [
        'invented throughput',
        (r) => {
          r.results[0].throughput.operationsPerSecond *= 2;
        },
      ],
      [
        'missing dimensions',
        (r) => {
          delete r.dimensions;
        },
      ],
      [
        'invented available metric',
        (r) => {
          r.dimensions.firstQuery = { available: true, p50: 1 };
        },
      ],
    ]) {
      const changed = structuredClone(report);
      mutate(changed);
      assert.throws(() => assertContractReport(changed, 'libsql', options), undefined, label);
    }
    report.samples[0].milliseconds.pop();
    assert.throws(() => assertContractReport(report, 'libsql', options), /sample count/);
  });
  test('single-row raw operations refuse missing and extra result rows', () => {
    for (const operation of ['pk-1', 'insert-returning', 'update-returning', 'delete-returning']) {
      assert.throws(() => decodeRaw(operation, []), /cardinality/);
      assert.throws(() => decodeRaw(operation, [{}, {}]), /cardinality/);
    }
  });
  test('admission requires explicit immutable archive, exact runtime and new output', () => {
    const artifact = join(directory, 'archive.tgz');
    writeFileSync(artifact, 'identity-control');
    const args = {
      artifact,
      sha256: sha(artifact),
      'artifact-head': 'a'.repeat(40),
      output: join(directory, 'new-output'),
      mode: 'preflight',
      'runtime-control': true,
    };
    admit(args);
    assert.throws(() => admit({ ...args, sha256: '0'.repeat(64) }), /hash mismatch/);
    assert.throws(() => admit({ ...args, 'artifact-head': '' }), /source head/);
    assert.throws(() => admit({ ...args, mode: 'campaign' }), /Runtime controls/);
    assert.throws(
      () => admit({ ...args, 'runtime-control': false, mode: 'campaign', 'allow-missing-d1-factory': true }),
      /preflight only/,
    );
    assert.throws(() => admit({ ...args, output: directory }), /new directory/);
    assert.throws(() => argumentsFor(['--mode', 'preflight', '--mode', 'campaign']), /Duplicate/);
    assert.throws(() => argumentsFor(['--unknown', 'value']), /Unknown/);
  });
} catch (error) {
  rmSync(directory, { recursive: true, force: true });
  deps('esbuild').stop();
  throw error;
}

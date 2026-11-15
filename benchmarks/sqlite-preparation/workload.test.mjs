import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SqlitePool } from '../../src/sqlite.ts';
import { test } from 'node:test';
import { controls } from './controls.mjs';
import { ARMS, CAPACITY, CASES, execute, Preparation, route } from './workload.mjs';

test('all native and production decoding routes verify every operation and final effect', async () => {
  let checked = 0;
  for (const arm of ARMS) {
    for (const name of CASES) {
      const r = route(arm, name === 'decode-wide');
      try {
        const result = await execute(r, name, 128);
        assert.equal(result.checkedResults, name === 'transaction' ? 512 : 128);
        checked += result.checkedResults;
        if (arm.endsWith('reuse') && name !== 'shapes-churn') assert.ok(result.timedHits > 0);
        if (!arm.endsWith('reuse')) assert.equal(result.timedHits, 0);
      } finally {
        await r.close();
      }
    }
  }
  assert.equal(checked, 7680);
});

test('lifecycle, stream, schema, error and binding controls execute natively', async () => {
  const result = await controls();
  assert.equal(result.length, 14);
  assert.equal(result.filter((r) => r.status === 'passed-current-decode').length, 2);
  assert.equal(result.filter((r) => r.passed).length, 14);
});

test('LRU limits references, refreshes hits and does not cache preparation failures', () => {
  const db = new DatabaseSync(':memory:');
  const p = new Preparation(db, true, 2);
  try {
    const first = p.prepare('SELECT 1');
    p.prepare('SELECT 2');
    assert.equal(p.prepare('SELECT 1'), first);
    p.prepare('SELECT 3');
    assert.deepStrictEqual([...p.entries.keys()], ['SELECT 1', 'SELECT 3']);
    assert.throws(() => p.prepare('SELECT missing FROM missing'));
    assert.equal(p.entries.size, 2);
    assert.equal(p.peak, 2);
    p.invalidate();
    assert.equal(p.entries.size, 0);
  } finally {
    p.invalidate();
    db.close();
  }
});

test('native bindings clear omitted values and recover after step/binding failures', () => {
  const db = new DatabaseSync(':memory:');
  const p = new Preparation(db, true);
  try {
    const stmt = p.prepare('SELECT :p1 AS value');
    assert.equal(stmt.get({ p1: 3 }).value, 3);
    assert.equal(stmt.get({}).value, null);
    assert.throws(() => stmt.get({ unknown: 4 }));
    assert.equal(stmt.get({ p1: 5 }).value, 5);
    db.function('checked_value', (n) => {
      if (n === 'bad') throw new Error('step failure');
      return n;
    });
    const step = p.prepare('SELECT checked_value(:p1) AS value');
    assert.throws(() => step.get({ p1: 'bad' }), /step failure/);
    assert.equal(step.get({ p1: 'good' }).value, 'good');
    assert.equal(p.entries.size, 2);
  } finally {
    p.invalidate();
    db.close();
  }
});

for (const fault of ['row', 'count', 'effect', 'missing-execution']) {
  test(`exact result/effect oracle rejects injected ${fault} fault`, async () => {
    const r = route('pool-reuse');
    const query = r.query.bind(r);
    try {
      r.query = async (...args) => {
        if (fault === 'missing-execution') return { rows: [], rowCount: 1 };
        if (fault === 'effect') {
          // Plausible reported success, but no native write actually ran.
          return { rows: [], rowCount: 1 };
        }
        const result = await query(...args);
        if (fault === 'row') result.rows[0].payload = { wrong: true };
        else result.rowCount = 0;
        return result;
      };
      const name = fault === 'effect' ? 'write-run' : 'read';
      await assert.rejects(execute(r, name, 3), fault === 'effect' ? /independent final native effect/ : /operation 0/);
    } finally {
      await r.close();
    }
  });
}

test('bounds oracle rejects deliberate unbounded candidate', async () => {
  const r = route('native-reuse');
  r.preparation.capacity = CAPACITY * 8;
  try {
    await execute(r, 'shapes-churn', CAPACITY * 4);
    assert.throws(() => assert.ok(r.preparation.entries.size <= CAPACITY));
  } finally {
    await r.close();
  }
});

test('fresh native control really prepares once per query and reuse avoids warm prepares', async () => {
  for (const arm of ARMS) {
    const r = route(arm);
    try {
      const first = await execute(r, 'read', 128);
      const warm = await execute(r, 'read', 128);
      assert.equal(first.timedPrepares, arm.endsWith('reuse') ? 1 : 128);
      assert.equal(warm.timedPrepares, arm.endsWith('reuse') ? 0 : 128);
    } finally {
      await r.close();
    }
  }
});

test('report validator rejects removed samples, incorrect effects and unbounded retention', async () => {
  const { validate } = await import('./validate.mjs');
  // Modeled report for structural validator fault injection, never native evidence.
  const config = { rounds: 4, iterations: 128, capacity: CAPACITY };
  const report = {
    format: 'sqlite-preparation-v1',
    runtime: {
      node: 'v24.10.0',
      executable: 'modeled-node',
      platform: 'linux',
      arch: 'x64',
      binarySha256: 'a'.repeat(64),
      sqlite: { version: 'test-fixture', source: 'modeled-source-id' },
    },
    source: {
      head: 'a'.repeat(40),
      branch: 'fixture',
      status: '',
      worktree: '/modeled',
      files: Object.fromEntries(
        [
          'src/sqlite.ts',
          ...['run', 'workload', 'controls', 'memory', 'validate', 'workload.test'].map(
            (n) => `benchmarks/sqlite-preparation/${n}.mjs`,
          ),
        ].map((n) => [n, 'a'.repeat(64)]),
      ),
    },
    dependencies: { lockSha256: 'a'.repeat(64), tsx: '4.0.0' },
    config,
    samples: [],
    controls: await controls(),
    memory: ARMS.map((arm) => ({
      arm,
      checkedResults: 8192,
      snapshots: [
        'before-fixture',
        'fixture',
        'after-4096-shapes',
        'after-8192-shapes',
        'references-cleared',
        'handle-closed',
      ].map((phase) => ({
        phase,
        rss: 1,
        heapUsed: 1,
        preparation: { prepares: 0, hits: 0, evictions: 0, retained: 0, peak: 0 },
      })),
    })),
    comparisons: CASES.flatMap((name) =>
      ['native', 'pool'].map((family) => ({
        name,
        family,
        freshMedianMs: 1,
        reuseMedianMs: 1,
        pairedMedianMs: 0,
        controlMedianMs: 0,
        deltaRangeMs: [0, 0],
        controlRangeMs: [0, 0],
        pairedFreshMinusReuseMs: [0, 0, 0, 0],
        identicalFreshMinusControlMs: [0, 0, 0, 0],
      })),
    ),
    cleanup: { nativeHandlesClosed: true, memoryChildrenExited: true, servicesStarted: 0, fixtureFilesCreated: 0 },
  };
  for (const name of CASES)
    for (const arm of ARMS)
      for (const phase of ['cold', 'warm'])
        for (let round = 0; round < 4; round++) {
          const n = phase === 'cold' ? 1 : 128;
          const operations = n * (name === 'transaction' ? 4 : 1);
          const timedPrepares = arm.endsWith('reuse') && phase === 'warm' && name !== 'shapes-churn' ? 0 : operations;
          report.samples.push({
            name,
            arm,
            phase,
            round,
            order: ARMS,
            ms: 1,
            cpuMicros: 1,
            operations,
            checkedResults: operations,
            counter: name.startsWith('write-') ? n : name === 'transaction' ? Math.ceil(n / 2) : 0,
            preparation: {
              prepares: timedPrepares,
              hits: operations - timedPrepares,
              evictions: 0,
              retained: 0,
              peak: 0,
            },
            timedPrepares,
            timedHits: operations - timedPrepares,
          });
        }
  assert.equal(validate(report).samples, 336);
  assert.equal(validate(report).documentedUnsupported, 0);
  const historical = structuredClone(report);
  for (const c of historical.controls.filter((c) => c.control === 'external-schema-decoder-invalidation')) {
    c.status = 'unsupported-existing-stale-decode';
    delete c.passed;
    c.observed = [{ v: true }];
  }
  assert.equal(validate(historical).documentedUnsupported, 2);
  const mislabeled = structuredClone(historical);
  mislabeled.controls.find((c) => c.control === 'external-schema-decoder-invalidation').observed = [{ v: 1 }];
  assert.throws(() => validate(mislabeled));
  for (const mutate of [
    (r) => {
      delete r.source.files['src/sqlite.ts'];
    },
    (r) => {
      delete r.source.files['benchmarks/sqlite-preparation/workload.mjs'];
    },
    (r) => {
      delete r.runtime.sqlite.source;
    },
    (r) => {
      delete r.dependencies;
    },
    (r) => {
      delete r.source.head;
    },
    (r) => {
      delete r.source.branch;
    },
    (r) => {
      for (const key of Object.keys(r.source.files)) r.source.files[key] = 'not-a-sha256';
    },
    (r) => {
      r.controls[1] = structuredClone(r.controls[0]);
    },
    (r) => {
      r.comparisons[0].name = 'invented';
    },
    (r) => {
      r.comparisons[0].pairedMedianMs = 999;
    },
    (r) => {
      r.comparisons[0].pairedFreshMinusReuseMs[0] = 999;
    },
    (r) => {
      r.comparisons[1] = structuredClone(r.comparisons[0]);
    },
    ...['prepares', 'hits', 'evictions', 'retained', 'peak'].map((key) => (r) => {
      r.samples.find((s) => s.arm.endsWith('reuse')).preparation[key] = -1;
    }),
    (r) => {
      r.controls.find((c) => c.control === 'external-schema-decoder-invalidation' && c.arm === 'pool-reuse').observed =
        [{ v: true }];
    },
    (r) => {
      r.controls.find((c) => c.control === 'external-schema-decoder-invalidation' && c.arm === 'pool-reuse').arm =
        'pool-fresh';
    },
    (r) => {
      r.controls.find((c) => c.control === 'external-schema-decoder-invalidation' && c.arm === 'pool-reuse').status =
        'success-without-verification';
    },
    (r) => {
      r.controls.find((c) => c.control === 'external-schema-decoder-invalidation' && c.arm === 'pool-reuse').freshPool =
        [{ v: true }];
    },
    (r) => r.samples.pop(),
    (r) => {
      r.samples[0].checkedResults--;
    },
    (r) => {
      r.samples[0].counter++;
    },
    (r) => {
      r.samples[0].preparation.retained = CAPACITY + 1;
    },
    (r) => {
      r.samples[0].timedPrepares++;
    },
    (r) => {
      r.memory[0].checkedResults = 0;
    },
    (r) => {
      r.cleanup.nativeHandlesClosed = false;
    },
    (r) => {
      r.runtime.node = 'v26.12.0';
    },
  ]) {
    const broken = structuredClone(report);
    mutate(broken);
    assert.throws(() => validate(broken));
  }
});

test('failed owned factory control still disconnects its native handle', async () => {
  const query = SqlitePool.prototype.query;
  let count = 0,
    db;
  SqlitePool.prototype.query = async function (text, ...args) {
    const result = await query.call(this, text, ...args);
    if ((typeof text === 'string' ? text : text.text) === 'SELECT $1 AS n' && ++count === 2) {
      db = this.db;
      result.rows = [{ n: 999 }];
    }
    return result;
  };
  try {
    await assert.rejects(controls(), /999|deep/);
    assert.ok(db, 'control must reach owned factory');
    assert.throws(() => db.prepare('SELECT 123'), /closed|not open/i);
  } finally {
    SqlitePool.prototype.query = query;
    if (db)
      try {
        db.close();
      } catch {}
  }
});

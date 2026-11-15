import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setImmediate } from 'node:timers/promises';
import { campaignReport } from './report.mjs';
import os from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    candidate: { type: 'string' },
    out: { type: 'string' },
    rounds: { type: 'string', default: '12' },
    iterations: { type: 'string', default: '5000' },
  },
});
assert.ok(values.base && values.candidate && values.out, '--base, --candidate and --out required');
assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'exact measurement runtime required');
assert.equal(typeof global.gc, 'function', '--expose-gc required');
const rounds = Number(values.rounds),
  iterations = Number(values.iterations);
const ARMS = ['base', 'candidate', 'control'];
assert.ok(
  Number.isSafeInteger(rounds) && rounds >= 6 && rounds <= 96 && rounds % (ARMS.length * 2) === 0,
  'complete forward/reverse rotation cycles required',
);
assert.ok(Number.isSafeInteger(iterations) && iterations >= 128 && iterations <= 100000);
const hash = (data) => createHash('sha256').update(data).digest('hex');
const manifest = (path) => {
  const m = JSON.parse(readFileSync(`${path}.json`));
  assert.equal(hash(readFileSync(path)), m.artifactSha256, 'immutable bundle hash');
  return m;
};
const names = [
  'read-dollar',
  'read-named',
  'read-empty',
  'decode-wide',
  'read-many',
  'write-run',
  'write-returning',
  'transaction',
  'shapes-fit',
  'shapes-churn',
  'long-sql',
  'oversized-sql',
];
const read = 'SELECT id,enabled,payload,huge,bytes FROM items WHERE id=';
const expected = (id) => ({
  id,
  enabled: id % 2 === 1,
  payload: { id },
  huge: String(9007199254740993n + BigInt(id)),
  bytes: Uint8Array.of(id, 255),
});
function fixture(Pool, lifecycle, label) {
  const f = lifecycle.own(new DatabaseSync(':memory:'), label);
  const db = f.db;
  db.exec(
    'CREATE TABLE items(id INTEGER PRIMARY KEY,enabled BOOLEAN,payload TEXT,huge INTEGER,bytes BLOB); CREATE TABLE counter(n INTEGER); INSERT INTO counter VALUES(0)',
  );
  const insert = db.prepare(
    "INSERT INTO items VALUES(:id,:id%2,json_object('id',:id),9007199254740993+:id,:bytes)",
  );
  for (let id = 1; id <= 32; id++) insert.run({ id: BigInt(id), bytes: Uint8Array.of(id, 255) });
  f.pool = new Pool(db, {
    schema: { tables: { items: { columns: [{ name: 'payload', pgType: 'json' }] } } },
  });
  return f;
}
function workload(name, count) {
  const ops = [];
  let counter = 0;
  const longSuffix = ` /* ${'long '.repeat(200)} */`;
  const oversizedSuffix = ` /* ${'x'.repeat(34000)} */`;
  const push = (sql, params, rows, rowCount = rows.length) =>
    ops.push({ sql, params, expected: { rows, rowCount } });
  for (let i = 0; i < count; i++) {
    const id = ((i * 17) % 32) + 1;
    switch (name) {
      case 'read-empty':
        push(`${read}$1`, [99], []);
        break;
      case 'decode-wide':
        push(
          `SELECT ${Array.from({ length: 24 }, (_, j) => `enabled AS b${j}`).join(',')} FROM items WHERE id=$1`,
          [id],
          [Object.fromEntries(Array.from({ length: 24 }, (_, j) => [`b${j}`, id % 2 === 1]))],
        );
        break;
      case 'read-many':
        push(
          'SELECT id,enabled,payload,huge,bytes FROM items ORDER BY id',
          [],
          Array.from({ length: 32 }, (_, j) => expected(j + 1)),
        );
        break;
      case 'write-run':
        push('UPDATE counter SET n=n+$1', [1], [], 1);
        counter++;
        break;
      case 'write-returning':
        push('UPDATE counter SET n=n+$1 RETURNING n', [1], [{ n: ++counter }]);
        break;
      case 'transaction':
        push('BEGIN', [], [], 1);
        push('UPDATE counter SET n=n+$1', [1], [], 1);
        push('SELECT n FROM counter', [], [{ n: counter + 1 }]);
        push(i % 2 ? 'ROLLBACK' : 'COMMIT', [], [], 1);
        if (i % 2 === 0) counter++;
        break;
      default: {
        const suffix =
          name === 'shapes-fit'
            ? ` /* shape ${i % 16} */`
            : name === 'shapes-churn'
              ? ` /* shape ${i % 512} */`
              : name === 'long-sql'
                ? longSuffix
                : name === 'oversized-sql'
                  ? oversizedSuffix
                  : '';
        push(`${read}${name === 'read-named' ? ':p1' : '$1'}${suffix}`, [id], [expected(id)]);
      }
    }
  }
  return { ops, counter };
}
async function execute(f, w) {
  const outputs = [];
  const cpu = process.cpuUsage(),
    start = performance.now();
  for (const op of w.ops) outputs.push(await f.pool.query(op.sql, op.params));
  const ms = performance.now() - start,
    used = process.cpuUsage(cpu);
  assert.equal(outputs.length, w.ops.length);
  for (let i = 0; i < outputs.length; i++) {
    const { rows, rowCount } = outputs[i];
    assert.deepEqual({ rows, rowCount }, w.ops[i].expected, `operation ${i}`);
  }
  assert.equal(
    f.db.prepare('SELECT n FROM counter').get().n,
    w.counter,
    'independent native effect',
  );
  assert.equal(f.db.isTransaction, false);
  return {
    ms,
    usPerOperation: (ms * 1000) / outputs.length,
    checkedResults: outputs.length,
    checkedRows: outputs.reduce((n, r) => n + r.rows.length, 0),
    cpuMicros: used.user + used.system,
  };
}
const lifecycle = campaignReport(values.out, {
  format: 'sqlite-query-cost-v1',
  startedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    executable: process.execPath,
    binarySha256: hash(readFileSync(process.execPath)),
  },
  config: {
    rounds,
    iterations,
    warmupIterations: 256,
    arms: ARMS,
    orderPolicy: 'complete all three positions before reversing; complete six-round cycles',
  },
  host: { cpu: os.cpus()[0]?.model, cpus: os.cpus().length, loadBefore: os.loadavg() },
  samples: [],
  comparisons: [],
  limitation:
    'Descriptive shared-host evidence; no general performance or native memory claim. Warmups excluded from counts.',
});
const report = lifecycle.report;
try {
  const base = manifest(values.base),
    candidate = manifest(values.candidate);
  assert.equal(base.lockSha256, candidate.lockSha256);
  assert.equal(base.esbuild, candidate.esbuild);
  assert.deepEqual(Object.keys(base.inputs), Object.keys(candidate.inputs));
  for (const file of Object.keys(base.inputs)) {
    if (file !== 'src/sqlite.ts')
      assert.equal(base.inputs[file], candidate.inputs[file], `same shared source: ${file}`);
  }
  const modules = {
    base: await import(pathToFileURL(resolve(values.base))),
    candidate: await import(pathToFileURL(resolve(values.candidate))),
  };
  modules.control = modules.base;
  report.source = {
    base,
    candidate,
    harnessSha256: hash(
      Buffer.concat([
        readFileSync(new URL(import.meta.url)),
        readFileSync(new URL('./report.mjs', import.meta.url)),
      ]),
    ),
  };
  const probe = lifecycle.own(new DatabaseSync(':memory:'), 'native-version-probe');
  report.runtime.sqlite = {
    ...probe.db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS source').get(),
  };
  await lifecycle.close(probe);
  lifecycle.save();
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const name of names) {
    const w = workload(name, iterations),
      warmup = workload(name, 256);
    for (let round = 0; round < rounds; round++) {
      const order = Math.floor(round / ARMS.length) % 2 ? [...ARMS].reverse() : ARMS;
      const rotated = [...order.slice(round % ARMS.length), ...order.slice(0, round % ARMS.length)];
      for (const arm of rotated) {
        try {
          const f = fixture(modules[arm].SqlitePool, lifecycle, `${name}/${round}/${arm}`);
          await execute(f, warmup);
          f.db.exec('UPDATE counter SET n=0');
          global.gc();
          report.samples.push({ name, round, arm, order: rotated, ...(await execute(f, w)) });
        } catch (error) {
          lifecycle.fail(error);
          throw error;
        } finally {
          // fixture setup is owned even when it throws before returning a pool.
          await lifecycle.closeLast();
          lifecycle.save();
        }
        if (report.cleanupErrors.length)
          throw new Error('Fixture cleanup failed; see cleanupErrors');
        await setImmediate(); // deliver supported termination between measured arms
      }
    }
    const samples = report.samples.filter((s) => s.name === name);
    const series = (arm) =>
      samples
        .filter((s) => s.arm === arm)
        .sort((a, b) => a.round - b.round)
        .map((s) => s.usPerOperation);
    const b = series('base'),
      c = series('candidate'),
      control = series('control');
    const delta = b.map((v, i) => v - c[i]),
      noise = b.map((v, i) => v - control[i]);
    report.comparisons.push({
      name,
      baseMedianUs: median(b),
      candidateMedianUs: median(c),
      pairedMedianSavedUs: median(delta),
      pairedSavedUs: delta,
      identicalControlSavedUs: noise,
      identicalControlMedianUs: median(noise),
      candidateFasterRounds: delta.filter((v) => v > 0).length,
    });
    process.stderr.write(`verified ${name}\n`);
  }
  report.host.loadAfter = os.loadavg();
} catch (error) {
  lifecycle.fail(error);
} finally {
  if (!(await lifecycle.finish())) {
    console.error(report.failure ?? report.cleanupErrors.join('\n'));
    process.exitCode = 1;
  }
}

/** Multirow result construction, cold SQL-text admission and native-DDL supplement.
 * Uses the main query-cost harness's native ownership/failure/checkpoint machinery.
 * Timings include query promises and output retention. DDL cases include native DDL.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { campaignReport } from './report.mjs';

const { values } = parseArgs({ options: {
  base: { type: 'string' }, candidate: { type: 'string' }, out: { type: 'string' },
  rounds: { type: 'string', default: '12' }, iterations: { type: 'string', default: '1000' },
} });
assert.ok(values.base && values.candidate && values.out, '--base, --candidate and --out required');
assert.ok(['v22.16.0', 'v24.10.0'].includes(process.version), 'exact measurement runtime required');
assert.equal(typeof global.gc, 'function', '--expose-gc required');
const rounds = Number(values.rounds), iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 6 && rounds <= 96 && rounds % 6 === 0, 'complete forward/reverse rotation cycles required');
assert.ok(Number.isSafeInteger(iterations) && iterations >= 128 && iterations <= 10000);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const manifest = (file) => {
  const m = JSON.parse(readFileSync(`${file}.json`));
  assert.equal(hash(readFileSync(file)), m.artifactSha256, 'immutable bundle hash');
  return m;
};
const arms = ['base', 'candidate', 'control'];
const names = ['multirow-wide', 'multirow-untyped', 'multirow-returning', 'cold-read', 'cold-write', 'native-ddl'];
const width = 24, rowCount = 32;
const projection = Array.from({ length: width }, (_, j) => `b AS b${j}`).join(',');
const wide = (id) => Object.fromEntries(Array.from({ length: width }, (_, j) => [`b${j}`, id % 2 === 1]));
const expectedItems = Array.from({ length: rowCount }, (_, i) => ({ id: i + 1, b: (i + 1) % 2 === 1 }));
const lifecycle = campaignReport(values.out, {
  format: 'sqlite-result-cost-v1', startedAt: new Date().toISOString(),
  runtime: { node: process.version, executable: process.execPath, binarySha256: hash(readFileSync(process.execPath)) },
  config: { rounds, iterations, warmupIterations: 64, arms, width, rowCount,
    orderPolicy: 'complete all three positions before reversing; complete six-round cycles' },
  host: { cpu: os.cpus()[0]?.model, cpus: os.cpus().length, loadBefore: os.loadavg() },
  samples: [], comparisons: [],
  limitation: 'Descriptive shared-host evidence, not a parity or global speed claim. Cold means unique SQL text, not a new process or native statement cache. DDL timing includes native replacement. Warmups excluded.',
});
const report = lifecycle.report;
function fixture(Pool, label) {
  const f = lifecycle.own(new DatabaseSync(':memory:'), label);
  f.db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY,b BOOLEAN,n INTEGER);
    CREATE TABLE counter(n INTEGER); INSERT INTO counter VALUES(0);
    CREATE TABLE changing(v BOOLEAN); INSERT INTO changing VALUES(1),(0)`);
  const insert = f.db.prepare('INSERT INTO items VALUES(?, ?, 0)');
  for (let id = 1; id <= rowCount; id++) insert.run(id, id % 2);
  f.pool = new Pool(f.db);
  return f;
}
function workload(name, count, phase) {
  return Array.from({ length: count }, (_, i) => {
    switch (name) {
      case 'multirow-wide': return { sql: `SELECT ${projection} FROM items ORDER BY id`, rows: expectedItems.map(({ id }) => wide(id)) };
      case 'multirow-untyped': return { sql: 'SELECT id,b+0 AS stored FROM items ORDER BY id', rows: expectedItems.map(({ id }) => ({ id, stored: id % 2 })) };
      case 'multirow-returning': return { sql: 'UPDATE items SET n=n+1 RETURNING id,b,n', rows: expectedItems.map((item) => ({ ...item, n: i + 1 })) };
      case 'cold-read': {
        const id = i % rowCount + 1;
        return { sql: `SELECT id,b FROM items WHERE id=$1 /* ${phase}/${i} */`, params: [id], rows: [expectedItems[id - 1]] };
      }
      case 'cold-write': return { sql: `UPDATE counter SET n=n+$1 /* ${phase}/${i} */`, params: [1], rows: [], rowCount: 1 };
      case 'native-ddl': {
        const boolean = i % 2 === 0;
        return { ddl: `DROP TABLE changing; CREATE TABLE changing(v ${boolean ? 'BOOLEAN' : 'INTEGER'}); INSERT INTO changing VALUES(1),(0)`,
          sql: 'SELECT v AS value FROM changing ORDER BY rowid', rows: [{ value: boolean ? true : 1 }, { value: boolean ? false : 0 }] };
      }
      default: throw new Error(`Unknown case ${name}`);
    }
  });
}
async function execute(f, name, ops) {
  const outputs = [], cpu = process.cpuUsage(), start = performance.now();
  for (const op of ops) {
    if (op.ddl) f.db.exec(op.ddl);
    outputs.push(await f.pool.query(op.sql, op.params ?? []));
  }
  const ms = performance.now() - start, used = process.cpuUsage(cpu);
  assert.equal(outputs.length, ops.length, 'every operation returns a checked result');
  for (let i = 0; i < ops.length; i++) {
    const { rows, rowCount } = outputs[i];
    assert.deepEqual({ rows, rowCount }, { rows: ops[i].rows, rowCount: ops[i].rowCount ?? ops[i].rows.length }, `operation ${i}`);
  }
  assert.equal(f.db.prepare('SELECT n FROM counter').get().n, name === 'cold-write' ? ops.length : 0, 'independent native counter effect');
  assert.equal(f.db.prepare('SELECT sum(n) AS n FROM items').get().n, name === 'multirow-returning' ? rowCount * ops.length : 0, 'independent native returning effect');
  assert.equal(f.db.isTransaction, false, 'no transaction survives a sample');
  return { ms, usPerOperation: ms * 1000 / outputs.length, cpuMicros: used.user + used.system,
    checkedResults: outputs.length, checkedRows: outputs.reduce((n, r) => n + r.rows.length, 0),
    nativeDdlReplacements: name === 'native-ddl' ? ops.length : 0 };
}
try {
  const base = manifest(values.base), candidate = manifest(values.candidate);
  assert.equal(base.lockSha256, candidate.lockSha256);
  assert.equal(base.esbuild, candidate.esbuild);
  assert.deepEqual(Object.keys(base.inputs), Object.keys(candidate.inputs));
  for (const file of Object.keys(base.inputs)) if (file !== 'src/sqlite.ts') assert.equal(base.inputs[file], candidate.inputs[file], `same shared source: ${file}`);
  report.source = { base, candidate, harnessSha256: hash(Buffer.concat([readFileSync(new URL(import.meta.url)), readFileSync(new URL('./report.mjs', import.meta.url))])) };
  const modules = { base: await import(pathToFileURL(resolve(values.base))), candidate: await import(pathToFileURL(resolve(values.candidate))) };
  modules.control = modules.base;
  const probe = lifecycle.own(new DatabaseSync(':memory:'), 'native-version-probe');
  report.runtime.sqlite = { ...probe.db.prepare('SELECT sqlite_version() AS version,sqlite_source_id() AS source').get() };
  await lifecycle.close(probe);
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const name of names) {
    const ops = workload(name, iterations, 'timed'), warm = workload(name, 64, 'warmup');
    for (let round = 0; round < rounds; round++) {
      const order = Math.floor(round / arms.length) % 2 ? [...arms].reverse() : arms;
      const rotated = [...order.slice(round % arms.length), ...order.slice(0, round % arms.length)];
      for (const arm of rotated) {
        try {
          const f = fixture(modules[arm].SqlitePool, `${name}/${round}/${arm}`);
          await execute(f, name, warm);
          f.db.exec('UPDATE counter SET n=0; UPDATE items SET n=0');
          global.gc();
          report.samples.push({ name, round, arm, order: rotated, ...(await execute(f, name, ops)) });
        } catch (error) {
          lifecycle.fail(error);
          throw error;
        } finally {
          await lifecycle.closeLast();
          lifecycle.save();
        }
        if (report.cleanupErrors.length) throw new Error('Fixture cleanup failed; see cleanupErrors');
        await setImmediate();
      }
    }
    const samples = report.samples.filter((s) => s.name === name);
    const series = (arm) => samples.filter((s) => s.arm === arm).sort((a, b) => a.round - b.round).map((s) => s.usPerOperation);
    const b = series('base'), c = series('candidate'), control = series('control');
    const delta = b.map((x, i) => x - c[i]), noise = b.map((x, i) => x - control[i]);
    report.comparisons.push({ name, baseMedianUs: median(b), candidateMedianUs: median(c), pairedMedianSavedUs: median(delta), pairedSavedUs: delta,
      identicalControlSavedUs: noise, identicalControlMedianUs: median(noise), candidateFasterRounds: delta.filter((v) => v > 0).length });
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

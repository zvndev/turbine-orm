import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectedRows, options, spec, summarize, summarizeFanout, verifyCallerPool, verifyCommittedRows, verifyRows } from './contract.mjs';

test('preflight refuses timing, implicit artifact and unprepared collection', () => {
  const common = ['--artifact', '/explicit.tgz', '--sha256', 'a'.repeat(64), '--out', '/out', '--scratch', '/scratch'];
  assert.equal(options(common).rounds, 0);
  assert.throws(() => options([]), /Explicit --artifact/);
  assert.throws(() => options([...common, '--mode', 'preflight', '--rounds', '3']), /never collects/);
  assert.throws(() => options([...common, '--mode', 'collect', '--rounds', '3']), /prepared --lock/);
  assert.throws(() => options([...common, '--warmup', 'NaN']));
  assert.throws(() => options([...common, '--rounds', '-1']));
  assert.throws(() => options([...common, '--out', '/other']), /duplicate/);
  assert.equal(options([...common, '--mode', 'collect', '--rounds', '100', '--lock', '/prepared-lock']).rounds, 100);
});

test('percentiles use individual retained calls and disclose insufficient tails', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({ fullDrainMs: i + 1 }));
  assert.deepEqual([summarize(samples).p50, summarize(samples).p95, summarize(samples).p99], [50.5, 95, 99]);
  assert.equal(summarize(samples.slice(0, 19)).p95, null);
  assert.equal(summarize(samples.slice(0, 99)).p99, null);
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([{ fullDrainMs: NaN }]));
});

test('equivalence controls reject omissions, duplicates, leaks, order and payload changes', () => {
  verifyRows(expectedRows());
  for (const mutate of [
    (rows) => rows.slice(1),
    (rows) => [...rows, rows[0]],
    (rows) => rows.reverse(),
    (rows) => rows.map((row) => ({ ...row, secret: 'leaked' })),
    (rows) => rows.map((row) => ({ ...row, title: 'wrong' })),
    (rows) => rows.map((row) => ({ ...row, id: row.id + 1 })),
  ]) assert.throws(() => verifyRows(mutate(expectedRows())));
});

test('committed effects preserve off-tenant identities as well as selected writes', () => {
  const rows = Array.from({ length: spec.rows }, (_, i) => ({ id: i + 1, tenant_id: (i + 1) % 2,
    title: [1, 3].includes(i + 1) ? 'committed-control' : 'x'.repeat(spec.payloadBytes), secret: 'private' }));
  verifyCommittedRows(rows);
  for (const [key, value] of [['id', 130], ['tenant_id', 1], ['title', 'wrong'], ['secret', 'wrong']]) {
    const changed = structuredClone(rows); changed[127][key] = value;
    assert.throws(() => verifyCommittedRows(changed));
  }
});

test('fanout statistics count independent rounds, preserve complete consumers, and omit query throughput', () => {
  const samples = Array.from({ length: 20 }, (_, round) => Array.from({ length: spec.liveConsumers }, (_, consumer) =>
    ({ round, consumer, fullDrainMs: round + consumer + 1 }))).flat();
  const statistics = summarizeFanout(samples, 20);
  assert.equal(statistics.n, 20);
  assert.equal(statistics.p50, 17.5);
  assert.equal(statistics.p95, 26);
  assert.equal(statistics.p99, null);
  assert.equal('serialCallsPerSecond' in statistics, false);
  for (const mutate of [
    (rows) => rows.pop(),
    (rows) => { rows[0].consumer = 8; },
    (rows) => { rows[0].round = 20; },
    (rows) => { rows[0].fullDrainMs = NaN; },
  ]) {
    const changed = structuredClone(samples); mutate(changed);
    assert.throws(() => summarizeFanout(changed, 20));
  }
});

test('facade teardown requires a live caller pool and a successful caller query', async () => {
  let calls = 0;
  await verifyCallerPool({ ended: false, query: async () => { calls++; return {rows:[{n:1}]}; } }, 'control');
  assert.equal(calls, 1);
  await assert.rejects(verifyCallerPool({ended:true}, 'heldout'), /facade ended caller pool/);
  await assert.rejects(verifyCallerPool({ended:false, query:async () => {throw new Error('closed');}}, 'heldout'), /closed/);
});

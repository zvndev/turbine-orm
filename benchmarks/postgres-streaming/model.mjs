import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const FORMAT = 'postgres-streaming-v1';
export const ARMS = ['raw', 'rows', 'batches'];
export const profiles = [
  { id: 'small', count: 257, batch: 32, payload: 256, delay: 0 },
  { id: 'large', count: 4097, batch: 32, payload: 256, delay: 0 },
  { id: 'slow', count: 4097, batch: 32, payload: 256, delay: 2 },
  { id: 'wide', count: 17, batch: 8, payload: 131072, delay: 2 },
  { id: 'early', count: 1025, batch: 32, payload: 256, delay: 0 },
  { id: 'abort', count: 65, batch: 8, payload: 256, delay: 0 },
];
export function cases() {
  return profiles.flatMap((p, index) => (index % 2 ? [...ARMS].reverse() : ARMS).map(arm => ({ ...p, arm, key: `${p.id}-${arm}` })));
}
export const columns = ['id', 'enabled', 'huge', 'amount', 'prefs', 'stamp', 'bytes', 'label', 'payload'];
export const projection = columns.map(c => `"${c}"`).join(', ');
export function selectSQL(c) {
  const table = c.id === 'abort' ? 'slow_items' : 'items';
  return `SELECT ${columns.map(k => `"${table}"."${k}"`).join(', ')} FROM "${table}" ORDER BY "id" ASC`;
}
export function expected(id, size) {
  return { id, enabled: id % 2 === 0, huge: String(9007199254740993n + BigInt(id)), amount: `${id}.1250`,
    prefs: { n: id, text: 'λ' }, stamp: new Date(Date.UTC(2020, 0, 1, 0, 0, id)),
    bytes: Buffer.from([id % 256, 0, 255]), label: `row-${id}-λ`, payload: 'x'.repeat(size) };
}
export const canonical = row => JSON.stringify(columns.map(k => Buffer.isBuffer(row[k]) ? { hex: row[k].toString('hex') } : row[k]));
export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function sink(size) {
  const actual = createHash('sha256'), oracle = createHash('sha256');
  let rows = 0, bytes = 0, maximum = 0;
  return {
    add(row) {
      const wanted = expected(++rows, size);
      assert.deepEqual(row, wanted, `Exact row/value/order ${rows}`);
      const text = canonical(row), want = canonical(wanted);
      actual.update(text + '\n'); oracle.update(want + '\n');
      const n = Buffer.byteLength(text); bytes += n; maximum = Math.max(maximum, n);
      return n;
    },
    finish() { return { rows, bytes, maxRowBytes: maximum, sha256: actual.digest('hex'), expectedSha256: oracle.digest('hex') }; },
  };
}
export function successful(report) {
  assert.equal(report.status, 'passed', 'Passing status required');
  assert.deepEqual(report.errors, [], 'Retained primary/finalization failures refuse success');
  assert.equal(report.signal, null, 'Interrupted report refuses success');
  assert.deepEqual(report.cleanupErrors, [], 'Cleanup errors refuse success');
}

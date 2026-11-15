import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function assertNativeRuntime(version) {
  assert.ok(['v22.16.0', 'v24.10.0'].includes(version), `native requires exact Node22.16.0/24.10.0; got ${version}`);
}
export const FORMAT = 'sqlite-relations-v1';
export const ARMS = ['raw', 'join', 'batched', 'flatten', 'stream-join', 'stream-flatten'];
export const CASES = ['small', 'large', 'skewed', 'wide'];
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ?
  Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const integer = (_, v) => {
  if (typeof v !== 'bigint') return v;
  assert.ok(v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER), 'fixture native integer must be exact');
  return Number(v);
};
export const bytes = value => Buffer.byteLength(JSON.stringify(value, integer));
export const plain = value => JSON.parse(JSON.stringify(value, integer));
export function fixture(name, scale = 1) {
  assert.ok(CASES.includes(name));
  assert.ok(Number.isSafeInteger(scale) && scale >= 1 && scale <= 16);
  const parents = [], children = [], owners = [];
  for (let id = 1; id <= 10 * scale; id++) {
    owners.push({ id, label: id % 3 ? `owner-${id}` : null });
    parents.push({ id, rank: Math.floor((id - 1) / 2), label: `parent-${id}`, ownerId: id % 3 ? id : null });
    const count = name === 'large' ? 32 * scale : name === 'skewed' ? (id === 2 ? 96 * scale : id % 3) : id % 5;
    for (let n = 0; n < count; n++) {
      const cid = id * 10000 + n;
      children.push({ id: cid, parentId: id, rank: Math.floor(n / 2), note: n % 3 ? `child-${cid}` : null,
        payload: `${id}:${n}:λ🙂:` + 'x'.repeat(name === 'wide' ? 4096 * scale : 16) });
    }
  }
  return { parents, children, owners };
}
export function windows(window) {
  assert.ok(['all', 'page'].includes(window));
  return window === 'all' ? { parentOffset: 0, parentLimit: 10, childOffset: 0, childLimit: null } :
    { parentOffset: 1, parentLimit: 7, childOffset: 1, childLimit: 3 };
}
export function expected(input, window) {
  const w = windows(window);
  // Independent value oracle: no ORM, generated SQL, native result or decoder input.
  return [...input.parents].sort((a, b) => a.rank - b.rank || a.id - b.id)
    .slice(w.parentOffset, w.parentOffset + w.parentLimit).map(p => {
      const owner = input.owners.find(o => o.id === p.ownerId);
      const all = input.children.filter(c => c.parentId === p.id).sort((a, b) => a.rank - b.rank || b.id - a.id);
      return { id: p.id, rank: p.rank, label: p.label, ownerId: p.ownerId,
        owner: owner ? { id: owner.id, label: owner.label } : null,
        children: all.slice(w.childOffset, w.childLimit === null ? undefined : w.childOffset + w.childLimit)
          .map(({ id, rank, note, payload }) => ({ id, rank, note, payload })) };
    });
}
export function checkSample(sample, input) {
  assert.ok(ARMS.includes(sample.arm), 'known arm');
  const value = expected(input, sample.window);
  assert.ok(value.length > 0 && value.some(p => p.children.length > 0), 'nonempty oracle');
  assert.deepEqual(sample.value, value, 'exact independent nested values/order/window');
  assert.equal(sample.valueHash, digest(value), 'exact value hash');
  assert.equal(sample.deliveredBytes, bytes(value), 'delivered UTF-8 JSON bytes');
  const reads = sample.audit.filter(e => /^SELECT\b/i.test(e.sql));
  assert.ok(reads.length > 0, 'native reads required');
  assert.ok(reads.every(e => e.rows >= 0 && e.bytes >= 0 && e.plan?.length > 0) && reads.some(e => e.rows > 0 && e.bytes > 0), 'native rows/bytes/plans required');
  assert.equal(sample.queries, reads.length, 'actual native query count');
  assert.equal(sample.nativeRows, reads.reduce((n, e) => n + e.rows, 0));
  assert.equal(sample.nativeBytes, reads.reduce((n, e) => n + e.bytes, 0));
  if (sample.arm.startsWith('stream-')) {
    assert.ok(reads.every(e => e.method === 'iterate'), 'stream used materializing route');
    assert.ok(reads.every(e => e.iteratorClosed), 'native iterator cleanup');
    assert.ok(sample.batches.every(n => n > 0 && n <= 2), 'parent batch bound');
    assert.equal(sample.batches.reduce((a, b) => a + b, 0), value.length, 'all streamed parents');
    assert.equal(sample.maxParentBytes, Math.max(...value.map(bytes)), 'parent payload observation');
  } else assert.ok(reads.every(e => e.method === 'all'), 'materialized route identity');
  if (sample.arm === 'join' || sample.arm === 'flatten' || sample.arm.startsWith('stream-')) assert.equal(reads.length, 1);
  if (sample.arm.includes('flatten')) assert.match(reads[0].sql, /LEFT JOIN/, 'flatten to-one actually engaged');
  if (sample.arm === 'batched') assert.ok(reads.length >= 3, 'batched followups actually executed');
  assert.equal(sample.transactionRetained, true, 'caller snapshot retained');
  assert.ok(sample.ms >= 0 && Number.isFinite(sample.ms));
  assert.ok(sample.memoryBefore.rss > 0 && sample.memoryAfter.rss > 0 && sample.resourceAfter.maxRSS > 0);
  return true;
}
export function checkReport(r) {
  assert.equal(r.format, FORMAT);
  assert.equal(r.status, 'passed');
  assert.deepEqual(r.failures, [], 'sticky failures');
  assert.equal(r.rejectedSample, undefined, 'failed sample cannot survive in successful report');
  assert.equal(r.signal, null, 'sticky OS signal');
  assert.ok(r.provenance?.runtime?.binarySha256 && r.provenance?.lockSha256 && r.provenance?.files?.['benchmarks/sqlite-relations/oracle.mjs'], 'provenance required');
  assert.ok(r.proof?.sqlite?.sourceId && r.proof?.loadedPg?.entrySha256, 'native identity proof');
  assert.equal(r.proof.prerequisites, true, 'native prerequisites');
  assert.equal(r.samples.length, CASES.length * 2 * ARMS.length * r.rounds, 'complete nonempty matrix');
  const keys = new Set();
  for (const s of r.samples) {
    const key = `${s.name}/${s.window}/${s.arm}/${s.round}`;
    assert.ok(!keys.has(key), 'duplicate sample'); keys.add(key);
    assert.ok(Number.isSafeInteger(s.round) && s.round >= 0 && s.round < r.rounds);
    checkSample(s, fixture(s.name, r.scale));
  }
  assert.deepEqual(r.proof.effects?.map(e => e.name), CASES, 'complete independent effect proof');
  assert.ok(r.proof.effects.every(e => e.unchanged && e.parents > 0 && e.children > 0 && e.owners > 0));
  for (const e of r.proof.effects) assert.equal(e.inputHash, digest(fixture(e.name, r.scale)), 'exact source fixture hash');
  assert.equal(r.proof.refusal.code, 'TURBINE_E017', 'unsupported encoding refusal');
  assert.equal(r.proof.refusal.nativeReads, 0, 'unsupported never timed as success');
  assert.equal(r.cleanup.handleClosed, true, 'native handle closure proof');
  assert.equal(r.cleanup.transactionClosed, true);
  assert.equal(r.cleanup.childExited, true, 'child exit proof');
  assert.equal(r.cleanup.pidAbsent, true); assert.equal(r.cleanup.groupAbsent, true);
  assert.equal(r.cleanup.pathAbsent, true, 'owned directory cleanup');
  assert.equal(r.cleanup.servicesStarted, 0);
  return { samples: r.samples.length, exactValues: true, nativeRouteProof: true };
}

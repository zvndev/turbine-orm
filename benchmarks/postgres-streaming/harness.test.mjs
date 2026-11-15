import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cases, sink, expected } from './model.mjs';
import { sample, log, campaign } from './test-model.mjs';
import { validateSample, validateCampaign, validateDeliveryDemand } from './validate.mjs';
import { rootDriver } from './driver.mjs';

test('positive prerequisites: complete synthetic sample matrix', () => {
  for (const c of cases()) { const s = sample(c); assert.equal(validateSample(s, log(s)), true); }
});
test('positive prerequisite: complete synthetic campaign', () => { assert.equal(validateCampaign(campaign()), true); });
const mutations = [
  ['FETCH ALL', s => { s.trace.find(t => /^FETCH/.test(t.sql)).sql = 'FETCH ALL FROM "guard_cursor"'; }, /Bounded server FETCH quantity/],
  ['omitted cursor route', s => { s.trace = s.trace.filter(t => !/^(?:DECLARE|FETCH)/.test(t.sql)); s.measureTraceEnd = s.trace.length; }, /Exactly one native cursor DECLARE/],
  ['driver buffering', s => { s.trace.find(t => /^FETCH/.test(t.sql)).retainedRowsMax = 9999; }, /Driver full-result retention/],
  ['native row omission', s => { s.trace.find(t => /^FETCH/.test(t.sql)).nativeRows--; }, /Actual driver dataRow count/],
  ['wrong projection', s => { s.select = s.select.replace('"items"."payload", ', ''); s.select += ' LIMIT 1'; }, /Independent exact SELECT identity/],
  ['wrong portal owner', s => { s.portalProbePid++; }, /pg_cursors must be read/],
  ['wrong backend', s => { s.observedBackend.pid++; }, /Independent backend ownership/],
  ['held portal', s => { s.portal.is_holdable = true; }, /Transaction-owned portal/],
  ['missing transaction', s => { s.observedBackend.xact_start = null; }, /Transaction start/],
  ['JS row omission', s => { s.result.rows--; }, /Exact delivered row count/],
  ['payload truncation', s => { s.batches[0].bytes--; }, /Exact complete batch payload/],
  ['digest contradiction', s => { s.result.sha256 = 'bad'; }, /Independent full-value digest/],
  ['leaked portal', s => { s.reuse.portals = 1; }, /No portal survives/],
  ['lost connection reuse', s => { s.reuse.pid++; }, /same physical backend/],
  ['RSS contradiction', s => { s.memory.rssPeak = 0; }, /RSS endpoints covered/],
  ['retained primary failure', s => { s.errors.push({ message: 'failed' }); }, /Retained primary/],
  ['retained cleanup failure', s => { s.cleanupErrors.push({ message: 'failed' }); }, /Cleanup errors refuse/],
  ['interrupted success', s => { s.signal = 'SIGTERM'; }, /Interrupted report/],
];
for (const [name, mutate, reason] of mutations) test(`rejects ${name}`, () => {
  const s = sample(); assert.equal(validateSample(s, log(s)), true);
  mutate(s); assert.throws(() => validateSample(s, log(s)), reason);
});
test('rejects missing independent server FETCH', () => {
  const s = sample(); const native = log(s); assert.equal(validateSample(s, native), true);
  assert.throws(() => validateSample(s, native.split('\n').filter(l => !l.includes('FETCH')).join('\n')), /Independent server\/driver/);
});
test('rejects false cancellation claim', () => {
  const s = sample(cases().find(c => c.key === 'abort-batches')); assert.equal(validateSample(s, log(s)), true);
  s.abortRejected = false; assert.throws(() => validateSample(s, log(s)), /Pending public pull/);
});
test('rejects missing independent cleanup', () => {
  const r = campaign(); assert.equal(validateCampaign(r), true);
  r.observers[0].databases = 1; assert.throws(() => validateCampaign(r), /Independent observer: database absent/);
});
test('rejects incomplete campaign matrix', () => {
  const r = campaign(); assert.equal(validateCampaign(r), true);
  r.samples.pop(); assert.throws(() => validateCampaign(r), /Complete ordered campaign/);
});
test('rejects vacuous process and path cleanup audits', () => {
  const r = campaign(); assert.equal(validateCampaign(r), true);
  const groups = r.cleanup.audit.groups; r.cleanup.audit.groups = [];
  assert.throws(() => validateCampaign(r), /Every worker, bundler, initializer and service group/);
  r.cleanup.audit.groups = groups; r.cleanup.audit.paths = [];
  assert.throws(() => validateCampaign(r), /All service root\/data\/socket paths/);
});
test('exact-value sink refuses changed binary or unsafe bigint', () => {
  const s = sink(10); s.add(expected(1, 10));
  assert.throws(() => s.add({ ...expected(2, 10), huge: Number(expected(2, 10).huge) }), /Exact row\/value\/order/);
  assert.throws(() => sink(10).add({ ...expected(1, 10), bytes: Buffer.from([1]) }), /Exact row\/value\/order/);
});
test('root lock identity defeats a shadow driver installation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pg-stream-driver-'));
  try {
    mkdirSync(join(dir, 'benchmarks/node_modules/pg'), { recursive: true });
    writeFileSync(join(dir, 'package.json'), '{}');
    const names = ['pg', 'pg-pool', 'pg-protocol', 'pg-types', 'pg-connection-string'];
    const packages = {};
    for (const name of names) {
      const p = join(dir, 'node_modules', name); mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'package.json'), JSON.stringify({ name, version: '1.0.0', main: 'index.js',
        dependencies: name === 'pg' ? Object.fromEntries(names.slice(1).map(n => [n, '1.0.0'])) : {} }));
      writeFileSync(join(p, 'index.js'), 'module.exports = { identity: "root" };');
      packages[`node_modules/${name}`] = { version: '1.0.0', integrity: 'test-model-only' };
    }
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages }));
    writeFileSync(join(dir, 'benchmarks/node_modules/pg/index.js'), 'throw new Error("shadow driver executed");');
    writeFileSync(join(dir, 'benchmarks/node_modules/pg/package.json'), '{"name":"pg","version":"9.0.0","main":"index.js"}');
    assert.equal(rootDriver(dir).pg.identity, 'root');
    assert.equal(Object.keys(rootDriver(dir).identity.dependencies).length, 4, 'Nonempty transitive identity prerequisite');
    packages['node_modules/pg'].version = '2.0.0';
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages }));
    assert.throws(() => rootDriver(dir), /Driver must match root lock/);
    packages['node_modules/pg'].version = '1.0.0'; packages['node_modules/pg-protocol'].version = '2.0.0';
    writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ packages }));
    assert.throws(() => rootDriver(dir), /Driver dependency must match root lock/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('rejects cursor prefetch beyond consumer demand', () => {
  const trace = [{ sql: 'BEGIN' }, { sql: 'FETCH 32 FROM "cursor"' }];
  assert.doesNotThrow(() => validateDeliveryDemand(trace, 1, 32));
  trace.push({ sql: 'FETCH 32 FROM "cursor"' });
  assert.throws(() => validateDeliveryDemand(trace, 1, 32), /FETCH must follow consumer demand/);
  assert.doesNotThrow(() => validateDeliveryDemand(trace, 33, 32));
});
test('rejects missing owned identities and contradictory cleanup registries', () => {
  const controls = [
    [r => { r.processes[0].pid = null; }, /Every owned process PID/],
    [r => { r.processes[1].pid = r.processes[0].pid; }, /Unique owned process/],
    [r => { r.processes.pop(); }, /Complete owned process registry/],
    [r => { delete r.port; }, /Owned service port/],
    [r => { delete r.observerPid; }, /Owned observer/],
    [r => { r.samples[0].sessionIds = []; }, /Owned sample session/],
    [r => { r.samples[0].sessionIds = [45678]; }, /Measured\/reused backend/],
    [r => { r.cleanup.audit.groups[0].pid++; }, /Cleanup process registry/],
  ];
  for (const [mutate, reason] of controls) {
    const r = campaign(); assert.equal(validateCampaign(r), true);
    mutate(r); assert.throws(() => validateCampaign(r), reason);
  }
});
test('rejects an undeclared executed-source manifest omission', () => {
  const r = campaign(); assert.equal(validateCampaign(r), true);
  delete r.provenance.inputs['source-0'];
  assert.throws(() => validateCampaign(r), /Complete executed source manifest/);
});

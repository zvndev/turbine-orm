/** Installed comparator preservation, including observable element reads. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const installed = resolve(process.env.READ_COMPARATOR_PACKAGE ?? 'dist/..');
const baseline = process.env.READ_COMPARATOR_BASELINE;
const report = { runtime: process.version, installed, baseline, checks: [], controls: [] };
function comparator(directory, format, mutate = (text) => text, counted = false) {
  const file = `${directory}/dist/${format === 'cjs' ? 'cjs/' : ''}query/builder.js`;
  const text = readFileSync(file, 'utf8');
  const start = text.indexOf('function cacheParamValueEqual(');
  const second = text.indexOf('function cacheParamsEqual(', start);
  const end = text.indexOf('\n/**', second);
  assert.ok(start > 0 && second > start && end > second, 'exact emitted comparator identity');
  const source = text.slice(start, end);
  const context = { Date, ArrayBuffer, Uint8Array, Object, Number, Array, calls: 0 };
  const modified = mutate(source);
  const instrumented = counted
    ? modified.replace('function cacheParamValueEqual(a, b) {', 'function cacheParamValueEqual(a, b) { calls++;')
    : modified;
  return {
    compare: vm.runInNewContext(`${instrumented};cacheParamsEqual`, context),
    calls: () => context.calls,
    source,
  };
}
function observable(compare, variant) {
  const events = [], sentinel = new Error('exact indexed sentinel');
  let a, b;
  if (variant === 'length') {
    a = new Proxy([1, 2], { get(target, key, receiver) { events.push(`a:${String(key)}`); return Reflect.get(target, key, receiver); } });
    b = new Proxy([1, 2], { get(target, key, receiver) { events.push(`b:${String(key)}`); return Reflect.get(target, key, receiver); } });
  } else {
    a = [1, 2]; b = [1, 2];
    Object.defineProperty(a, '0', { get() {
      events.push('a:0');
      if (variant === 'reenter') {
        assert.equal(compare([{ nested: [NaN, -0] }], [{ nested: [NaN, 0] }]), true);
        b[1] = 7;
      }
      if (variant === 'throw-a') throw sentinel;
      return variant === 'unequal' ? { n: 1 } : 1;
    } });
    Object.defineProperty(b, '0', { get() {
      events.push('b:0');
      if (variant === 'throw-b') throw sentinel;
      return variant === 'unequal' ? { n: 1 } : 1;
    } });
    Object.defineProperty(a, '1', { get() { events.push('a:1'); return 2; } });
  }
  try { return { result: compare(a, b), events }; }
  catch (error) { assert.equal(error, sentinel); return { thrown: 'exact sentinel', events }; }
}

for (const format of ['esm', 'cjs']) {
  const current = comparator(installed, format), previous = baseline && comparator(baseline, format);
  test(`${format}: ordered keys and structural parameter values preserve outcomes`, () => {
    const proxy = new Proxy({}, { get() { throw new Error('equal reference must not be inspected'); }, ownKeys() { throw new Error('equal reference must not be enumerated'); } });
    const shared = { value: 1 }, invalid = new Date(NaN);
    const pairs = [
      [[NaN, -0, null, undefined, proxy, shared], [NaN, 0, null, undefined, proxy, shared], true],
      [[invalid], [invalid], true], [[new Date(NaN)], [new Date(NaN)], false],
      [[new Date(1)], [new Date(2)], false], [[new Date(1)], [new Date(1)], true],
      [[new Uint8Array([0, 255])], [new Uint8Array([0, 255])], true],
      [[new Uint8Array([0, 255])], [new Uint8Array([0, 254])], false],
      [[[1, NaN, null]], [[1, NaN, null]], true], [[[1, 2]], [[2, 1]], false],
      [[{ a: 1, b: [2] }], [{ b: [2], a: 1 }], true], [[{ a: 1 }], [{ a: 2 }], false],
      [[{ a: undefined }], [{}], false], [[1], ['1'], false], [[1n], [1], false],
      [[, 1], [undefined, 1], true], [[1], [1, 2], false],
    ];
    const keys = ['id', 'at', 'amount', 'constructor', '__proto__', 'a\0b', 'a\0c', 'é', 'é', '1', '01', '😀'];
    for (const x of keys) for (const y of keys) pairs.push([[x], [y], x === y]);
    pairs.push([['a', 'b'], ['b', 'a'], false]);
    for (const [a, b, expected] of pairs) {
      assert.equal(current.compare(a, b), expected);
      if (previous) assert.equal(current.compare(a, b), previous.compare(a, b));
    }
    report.checks.push({ format, valueCases: pairs.length });
  });
  test(`${format}: single ordered indexed reads, length probes, reentry and exact errors`, () => {
    for (const variant of ['length', 'equal', 'unequal', 'reenter', 'throw-a', 'throw-b']) {
      const result = observable(current.compare, variant);
      if (previous) assert.deepEqual(result, observable(previous.compare, variant));
      if (variant === 'length') assert.deepEqual(result.events, ['a:length', 'b:length', 'a:length', 'a:0', 'b:0', 'a:length', 'a:1', 'b:1', 'a:length']);
      else if (variant === 'throw-a') assert.deepEqual(result.events, ['a:0']);
      else if (variant === 'throw-b') assert.deepEqual(result.events, ['a:0', 'b:0']);
      else assert.deepEqual(result.events, ['a:0', 'b:0', 'a:1']);
      if (variant === 'reenter') assert.equal(result.result, false);
    }
    // A length trap may change the next indexed value or throw before either read.
    const error = new Error('exact length sentinel');
    const events = [];
    const a = new Proxy([1], { get(target, key, receiver) { events.push(String(key)); if (key === 'length') throw error; return Reflect.get(target, key, receiver); } });
    assert.throws(() => current.compare(a, [1]), (thrown) => thrown === error);
    assert.deepEqual(events, ['length']);
    const lengthMutation = (compare) => {
      const reads = []; let checks = 0;
      const right = [1, 2, 3];
      const left = new Proxy([1, 2, 3], { get(target, key, receiver) {
        reads.push(String(key));
        if (key === 'length' && ++checks === 3) { target.length = 1; right[1] = 99; }
        return Reflect.get(target, key, receiver);
      } });
      return { result: compare(left, right), reads };
    };
    assert.deepEqual(lengthMutation(current.compare), { result: true, reads: ['length', 'length', '0', 'length'] });
    if (previous) assert.deepEqual(lengthMutation(current.compare), lengthMutation(previous.compare));
    const childError = new Error('exact structural getter sentinel');
    const child = Object.defineProperty({}, 'field', { enumerable: true, get() { throw childError; } });
    assert.throws(() => current.compare([child], [{ field: 1 }]), (thrown) => thrown === childError);
    report.checks.push({ format, orderedReads: true, perIterationLength: true, exactErrors: true, reentry: true });
  });
  test(`${format}: exact extraction proves equal primitives skip structural dispatch`, () => {
    const measured = comparator(installed, format, undefined, true);
    const keys = Array.from({ length: 39 }, (_, i) => `column_${i}`);
    assert.equal(measured.compare(keys, keys.slice()), true);
    assert.equal(measured.calls(), 0);
    const legacy = comparator(installed, format, (source) => source.replace('av !== bv && !cacheParamValueEqual(av, bv)', '!cacheParamValueEqual(av, bv)').replace(/if \(av === bv\)\s*continue;\s*/, ''), true);
    assert.equal(legacy.compare(keys, keys.slice()), true);
    assert.equal(legacy.calls(), 39, 'useful omission control for redundant dispatch');
    const repeated = comparator(installed, format, (source) => source.replaceAll('cacheParamValueEqual(av, bv)', 'cacheParamValueEqual(a[i], b[i])'));
    assert.notDeepEqual(observable(repeated.compare, 'unequal'), observable(current.compare, 'unequal'));
    const missing = comparator(installed, format, (source) => source.replaceAll('cacheParamValueEqual(av, bv)', 'false'));
    assert.equal(missing.compare([{ n: 1 }], [{ n: 1 }]), false);
    assert.equal(current.compare([{ n: 1 }], [{ n: 1 }]), true);
    report.controls.push({ format, skippedDispatch: 39, repeatedReadDetected: true, lostStructuralFallbackDetected: true });
  });
  test(`${format}: actual installed row parser preserves same-width changed shapes`, async () => {
    const require = createRequire(`${installed}/package.json`);
    const api = format === 'esm' ? await import(`${installed}/dist/index.js`) : require(`${installed}/dist/cjs/index.js`);
    const schema = api.schemaDefToMetadata(api.defineSchema({ rows: { id: { type: 'integer', primaryKey: true }, at: { type: 'timestamp' }, amount: { type: 'double' }, label: { type: 'text' } } }));
    const { QueryInterface } = format === 'esm' ? await import(`${installed}/dist/query/index.js`) : require(`${installed}/dist/cjs/query/index.js`);
    const q = new QueryInterface(null, 'rows', schema, undefined, { warnOnUnlimited: false, logger: {} });
    const d = q.buildFindMany();
    const rows = [{ id: 1, amount: 'Infinity' }, { amount: 'NaN', id: 2 }, { label: 'changed', at: '2024-02-29' }];
    const parsed = d.transform({ rows, rowCount: rows.length });
    assert.deepEqual(parsed.map(Object.keys), rows.map(Object.keys));
    assert.equal(parsed[0].amount, Infinity); assert.ok(Number.isNaN(parsed[1].amount)); assert.equal(parsed[2].at.toISOString(), '2024-02-29T00:00:00.000Z');
    const ctx = q.ctx;
    const plan = ctx.rowDecodePlan('rows', ['id', 'at']);
    assert.deepEqual(Object.keys(plan), ['cols', 'fields', 'kinds']);
    report.checks.push({ format, actualInstalled: true, shapeOrder: true, planContract: true });
  });
}
process.on('exit', () => { if (process.env.READ_COMPARATOR_REPORT) writeFileSync(process.env.READ_COMPARATOR_REPORT, JSON.stringify(report, null, 2)); });

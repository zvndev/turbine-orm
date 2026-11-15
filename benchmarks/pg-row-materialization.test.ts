import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../src/dialect.js';
import { QueryInterface } from '../src/query/index.js';
import type { SchemaMetadata } from '../src/schema.js';
import { mockTable } from '../src/test/helpers.js';

function fixture() {
  const table = mockTable('samples', [
    { name: 'id', field: 'id' },
    { name: 'label', field: 'label' },
    { name: 'amount', field: 'amount', pgType: 'money' },
    { name: 'score', field: 'score', pgType: 'float8' },
    { name: 'prototype_column', field: '__proto__' },
    { name: 'second_prototype', field: '__proto__' },
    { name: 'tail', field: 'tail' },
  ]);
  const calls: unknown[] = [];
  const schema: SchemaMetadata = { tables: { samples: table }, enums: {} };
  const q = new QueryInterface<Record<string, unknown>>(null!, 'samples', schema, undefined, {
    logger: {}, warnOnUnlimited: false,
    dialect: { ...postgresDialect, decodeColumnValue: type => type === 'money' ? value => { calls.push(value); return Number(value); } : undefined },
  });
  const read = (rows: Record<string, unknown>[]) => q.buildFindMany().transform({ rows, rowCount: rows.length });
  return { q, calls, read };
}

describe('compiled scalar assignments', () => {
  it('keeps mixed conversion, own prototype keys, input ownership and output order', () => {
    const { calls, read } = fixture();
    const raw = Object.freeze({ id: 7, label: 'one', amount: '12', score: 'Infinity', prototype_column: 'data', tail: null });
    const out = read([raw])[0]!;
    assert.deepEqual(Object.keys(out), ['id', 'label', 'amount', 'score', '__proto__', 'tail']);
    assert.deepEqual(out, { id: 7, label: 'one', amount: 12, score: Infinity, ['__proto__']: 'data', tail: null });
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.equal(Object.getOwnPropertyDescriptor(out, '__proto__')?.value, 'data');
    assert.deepEqual(calls, ['12']);
    assert.equal(raw.amount, '12');
  });

  it('snapshots the current row plan before a getter reenters with a different classification', () => {
    const { q, read, calls } = fixture();
    const nested = q.buildFindMany({ select: { amount: true, label: true } });
    const raw = { id: 9, get label() {
      assert.deepEqual(nested.transform({ rows: [{ amount: '3', label: 'inner' }], rowCount: 1 }), [{ amount: 3, label: 'inner' }]);
      return 'outer';
    }, amount: '11', score: 'NaN', tail: 'last' };
    const out = read([raw])[0]!;
    assert.deepEqual(Object.keys(out), ['id', 'label', 'amount', 'score', 'tail']);
    assert.equal(out.amount, 11);
    assert.ok(Number.isNaN(out.score));
    assert.equal(out.tail, 'last');
    assert.deepEqual(calls, ['3', '11']);
  });

  it('retains each-row shape verification for same-width reordered and heterogeneous rows', () => {
    const { read, calls } = fixture();
    const result = read([{ label: 'one', amount: '2' }, { amount: '3', label: 'two' }, { score: '-Infinity', tail: 'three' }, { tail: 'four', score: 'NaN' }]);
    assert.deepEqual(result.map(Object.keys), [['label', 'amount'], ['amount', 'label'], ['score', 'tail'], ['tail', 'score']]);
    assert.deepEqual(result.slice(0, 3), [{ label: 'one', amount: 2 }, { amount: 3, label: 'two' }, { score: -Infinity, tail: 'three' }]);
    assert.ok(Number.isNaN(result[3]!.score));
    assert.deepEqual(calls, ['2', '3']);
  });

  it('does not let a reentrant all-plain projection suppress an outer conversion', () => {
    const { q, read, calls } = fixture();
    const inner = q.buildFindMany({ select: { label: true, tail: true } });
    const raw = { get id() {
      assert.deepEqual(inner.transform({ rows: [{ label: 'inner', tail: 'plain' }], rowCount: 1 }), [{ label: 'inner', tail: 'plain' }]);
      return 4;
    }, amount: '19' };
    assert.deepEqual(read([raw]), [{ id: 4, amount: 19 }]);
    assert.deepEqual(calls, ['19']);
  });

  it('does not read later getters after a throwing earlier plain assignment', () => {
    const { read, calls } = fixture();
    const events: unknown[] = [], failure = new Error('assignment sentinel');
    Object.defineProperty(Object.prototype, 'label', { configurable: true, set(value) { events.push(value); throw failure; } });
    try {
      assert.throws(() => read([{ id: 1, label: 'stop', get amount() { events.push('unread'); return '4'; } }]), error => error === failure);
      assert.deepEqual(events, ['stop']);
      assert.deepEqual(calls, []);
    } finally { Reflect.deleteProperty(Object.prototype, 'label'); }
  });

  it('keeps inherited setter changes, lazy descriptors and source key snapshots', () => {
    const { read } = fixture();
    const events: unknown[] = [];
    const failure = new Error('lazy sentinel');
    Object.defineProperty(Object.prototype, 'label', { configurable: true, set(value) {
      events.push(value);
      Object.defineProperty(this, 'label', { enumerable: true, configurable: true, get() { throw failure; } });
      Object.defineProperty(Object.prototype, 'tail', { configurable: true, set(next) { events.push(next); Object.defineProperty(this, 'tail', { value: next, enumerable: true }); } });
    } });
    const raw: Record<string, unknown> = { id: 1, label: 'one', get tail() { raw.extra = 'later'; return 'last'; } };
    try {
      const out = read([raw])[0]!;
      assert.deepEqual(events, ['one', 'last']);
      assert.deepEqual(Object.keys(out), ['id', 'label', 'tail']);
      assert.equal(Object.getOwnPropertyDescriptor(out, 'label')?.get instanceof Function, true);
      assert.throws(() => out.label, error => error === failure);
      assert.equal(out.tail, 'last');
      assert.equal(raw.extra, 'later');
    } finally { Reflect.deleteProperty(Object.prototype, 'label'); Reflect.deleteProperty(Object.prototype, 'tail'); }
  });

  it('preserves integer-key ordering and destination collisions', () => {
    const { read } = fixture();
    const result = read([{ tail: 'last', '2': 'second', label: 'first', '1': 'first' }, { prototype_column: 'a', second_prototype: 'b' }]);
    assert.deepEqual(Object.keys(result[0]!), ['1', '2', 'tail', 'label']);
    assert.equal(Object.getOwnPropertyDescriptor(result[1]!, '__proto__')?.value, 'b');
    assert.equal(Object.getPrototypeOf(result[1]), Object.prototype);
  });
});

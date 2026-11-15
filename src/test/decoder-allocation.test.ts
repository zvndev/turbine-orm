/** Row parser reuse must preserve raw row ownership and ordered cell effects. */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function fixture() {
  const table = mockTable('samples', [
    { name: 'id', field: 'id' },
    { name: 'created_at', field: 'createdAt', pgType: 'timestamp' },
    { name: 'score', field: 'score', pgType: 'float8' },
    { name: 'scores', field: 'scores', pgType: '_float8' },
    { name: 'amount', field: 'amount', pgType: 'money' },
    { name: 'label', field: 'label', pgType: 'text' },
  ]);
  table.dateColumns = new Set(['created_at']);
  const schema: SchemaMetadata = { tables: { samples: table }, enums: {} };
  const calls: unknown[] = [];
  const q = new QueryInterface<Record<string, unknown>>(null!, 'samples', schema, undefined, {
    warnOnUnlimited: false,
    logger: {},
    dialect: {
      ...postgresDialect,
      decodeColumnValue: (type) =>
        type === 'money'
          ? (value) => {
              calls.push(value);
              return value === 'missing' ? undefined : Number(value);
            }
          : undefined,
    },
  });
  return { q, table, calls };
}

function apply(q: QueryInterface<Record<string, unknown>>, rows: Record<string, unknown>[]) {
  return q.buildFindMany().transform({ rows, rowCount: rows.length });
}

describe('row decoder allocation and reuse boundaries', () => {
  it('keeps ordered conversion, error identity and later getter laziness', () => {
    const { q } = fixture();
    apply(q, [{ created_at: null, label: 'warm' }]);
    const events: string[] = [];
    const failure = new Error('cell conversion failed');
    const raw = {
      get created_at() {
        events.push('date');
        return {
          toString() {
            events.push('coerce');
            throw failure;
          },
        };
      },
      get label() {
        events.push('label');
        return 'unread';
      },
    };
    assert.throws(
      () => apply(q, [raw]),
      (error) => error === failure,
    );
    assert.deepEqual(events, ['date', 'coerce']);
  });

  it('does not overwrite an in-flight plan during reentrant parsing of another projection', () => {
    const { q } = fixture();
    const outer = q.buildFindMany();
    const inner = q.buildFindMany({ select: { score: true, label: true } });
    const row = {
      id: 7,
      get created_at() {
        assert.deepEqual(inner.transform({ rows: [{ score: 'Infinity', label: 'inner' }], rowCount: 1 }), [
          { score: Infinity, label: 'inner' },
        ]);
        return '2024-02-29 12:34:56';
      },
      score: 'NaN',
      label: 'outer',
    };
    const out = outer.transform({ rows: [row], rowCount: 1 })[0]!;
    assert.deepEqual(Object.keys(out), ['id', 'createdAt', 'score', 'label']);
    assert.equal((out.createdAt as Date).toISOString(), '2024-02-29T12:34:56.000Z');
    assert.ok(Number.isNaN(out.score));
    assert.equal(out.label, 'outer');
  });

  it('keeps malformed and already-decoded cells, sparse arrays and large integer values', () => {
    const { q, calls } = fixture();
    const invalid = new Date(NaN);
    const sparse: unknown[] = [];
    sparse.length = 4;
    sparse[1] = ['NaN', 'Infinity', '-Infinity', null, -0];
    sparse[3] = new Uint8Array([7, 11]);
    const raw = { id: 9007199254740993n, created_at: invalid, score: 'invalid', scores: sparse, amount: null };
    const out = apply(q, [raw])[0]!;
    assert.equal(out.id, raw.id);
    assert.equal(out.createdAt, invalid);
    assert.equal(out.score, 'invalid');
    assert.equal(0 in (out.scores as unknown[]), false);
    assert.equal(2 in (out.scores as unknown[]), false);
    assert.deepEqual((out.scores as unknown[])[1], [NaN, Infinity, -Infinity, null, -0]);
    assert.equal((out.scores as unknown[])[3], sparse[3]);
    assert.deepEqual(calls, []);
    assert.deepEqual((sparse[1] as unknown[]).slice(0, 3), ['NaN', 'Infinity', '-Infinity']);
    assert.notEqual(out, raw);
    assert.equal(apply(q, [{ amount: '17' }])[0]!.amount, 17);
    assert.equal(apply(q, [{ amount: 'missing' }])[0]!.amount, undefined);
    assert.deepEqual(calls, ['17', 'missing']);
  });

  it('keeps alias collisions, own __proto__ data and output descriptors', () => {
    const { q, table } = fixture();
    Object.defineProperty(table.reverseColumnMap, 'raw_proto', { value: '__proto__', enumerable: true });
    table.reverseColumnMap.alias_id = 'id';
    const payload = { tenant: 'own' };
    const raw = Object.assign(Object.create({ hidden: 'inherited' }), { id: 1, alias_id: 2, raw_proto: payload });
    Object.defineProperty(raw, 'nonenumerable', { value: 9 });
    const out = apply(q, [raw])[0]!;
    assert.deepEqual(Object.keys(out), ['id', '__proto__']);
    assert.equal(out.id, 2);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
    assert.deepEqual(Object.getOwnPropertyDescriptor(out, '__proto__'), {
      value: payload,
      configurable: true,
      enumerable: true,
      writable: true,
    });
    assert.equal(Object.hasOwn(raw, '__proto__'), false);
  });

  it('preserves inherited setter effects instead of pre-seeding output fields', () => {
    const { q, table } = fixture();
    table.reverseColumnMap.label = 'decoderAllocationSetter';
    const values: unknown[] = [];
    Object.defineProperty(Object.prototype, 'decoderAllocationSetter', {
      configurable: true,
      set(value: unknown) {
        values.push(value);
      },
    });
    try {
      const out = apply(q, [
        { id: 1, label: 'first' },
        { label: 'second', id: 2 },
      ]);
      assert.deepEqual(values, ['first', 'second']);
      assert.deepEqual(out, [{ id: 1 }, { id: 2 }]);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'decoderAllocationSetter');
    }
  });

  it('retains snapshots when a getter changes subsequent raw keys', () => {
    const { q } = fixture();
    const raw: Record<string, unknown> = {
      get id() {
        delete raw.label;
        raw.score = 'Infinity';
        return 8;
      },
      label: 'before',
    };
    const out = apply(q, [raw])[0]!;
    assert.deepEqual(Object.keys(out), ['id', 'label']);
    assert.equal(out.id, 8);
    assert.equal(out.label, undefined);
    assert.equal(Object.hasOwn(out, 'score'), false);
    assert.deepEqual(apply(q, [raw]), [{ id: 8, score: Infinity }]);
  });
});

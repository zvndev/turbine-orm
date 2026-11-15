import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { UnsupportedFeatureError, ValidationError } from '../errors.js';
import { mysqlDialect } from '../mysql.js';
import type { PgCompatPool } from '../pg-types.js';
import { col } from '../query/column-ref.js';
import { QueryInterface, type QueryInterfaceOptions, UNSAFE } from '../query/index.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

const schema = {
  enums: {},
  tables: {
    users: mockTable('users', [
      { name: 'id', field: 'id' },
      { name: 'tenant_id', field: 'tenantId' },
      { name: 'email', field: 'email', pgType: 'text', unique: true },
      { name: 'payload', field: 'payload', pgType: 'jsonb' },
      { name: 'secret', field: 'secret', pgType: 'text', pii: true },
    ]),
  },
};

for (const cache of ['every-hit', 'off', false] as const) {
  const options: QueryInterfaceOptions = {
    diagnostics: { advice: false, cacheCheck: cache === false ? 'off' : cache },
    sqlCache: cache !== false,
  };
  describe(`ordinary equality reads, cache ${cache}`, () => {
    it('reuses shapes with current values, key order and undefined pruning', () => {
      const q = makeQuery('users', schema, options);
      const args = { where: { tenantId: 2, id: 1 } };
      const first = q.buildFindUnique(args);
      assert.deepEqual(first.params, [1, 2]);
      args.where.id = 9;
      args.where.tenantId = 3;
      const second = q.buildFindUnique(args);
      const permuted = q.buildFindUnique({ where: { id: 9, tenant_id: 3, email: undefined } });
      assert.equal(second.sql, first.sql);
      assert.equal(permuted.sql, first.sql);
      assert.deepEqual(first.params, [1, 2], 'an earlier deferred read retains its own bindings');
      assert.deepEqual(second.params, [9, 3]);
      assert.deepEqual(permuted.params, [9, 3]);
      assert.doesNotMatch(first.sql, /"secret"/);
    });

    it('keeps empty, constant and nonunique selectors refused after warming', () => {
      const q = makeQuery('users', schema, options);
      q.buildFindUnique({ where: { id: 1 } });
      for (const where of [
        {},
        { id: undefined },
        { id: { notIn: [] } },
        { NOT: { OR: [] } },
        { tenantId: 2 },
        { id: NaN },
      ]) {
        assert.throws(() => q.buildFindUnique({ where }), ValidationError);
      }
      assert.throws(() => q.buildFindUnique({ where: { id: col('id') } }), ValidationError);
      assert.throws(() => q.buildFindUnique({ where: { email: null } }), ValidationError);
      const inherited = Object.assign(Object.create({ id: 1 }), { tenantId: 2 });
      assert.throws(() => q.buildFindUnique({ where: inherited }), ValidationError);
      const hidden = Object.defineProperty({ tenantId: 2 }, 'id', { value: 1 });
      assert.throws(() => q.buildFindUnique({ where: hidden }), ValidationError);
      assert.match(q.buildFindUnique({ where: { id: { equals: 1 } } }).sql, /WHERE "id" = /);
    });

    it('does not retain eligibility when a reused predicate changes shape', () => {
      const q = makeQuery('users', schema, options);
      const args = { where: { id: 1 as unknown } };
      q.buildFindUnique(args);
      args.where.id = { equals: 2 };
      assert.deepEqual(q.buildFindUnique(args).params, [2]);
      args.where.id = { not: null };
      assert.throws(() => q.buildFindUnique(args), ValidationError);
      args.where.id = undefined;
      assert.throws(() => q.buildFindUnique(args), ValidationError);
      args.where.id = 3n;
      assert.deepEqual(q.buildFindUnique(args).params, [3n]);
      assert.deepEqual(
        q.buildFindUnique({ where: { id: 1, payload: { path: ['x'], equals: undefined } } }).params,
        [1],
      );
    });

    it('revalidates mutable Date operands on cold and warmed reads', () => {
      const q = makeQuery('users', schema, options);
      const date = new Date(0);
      const args = { where: { id: 1, email: date } };
      q.buildFindUnique(args);
      date.setTime(Number.NaN);
      assert.throws(() => q.buildFindUnique(args), /Invalid Date/);
      assert.throws(() => makeQuery('users', schema, options).buildFindUnique(args), /Invalid Date/);
      assert.throws(() => q.buildFindUnique({ where: { email: date } }), /Invalid Date/);
      date.setTime(0);
      assert.deepEqual(q.buildFindUnique(args).params, [date, 1]);
    });

    it('revalidates filter properties added to binary operands after warming', () => {
      const binarySchema = {
        enums: {},
        tables: { binary_keys: mockTable('binary_keys', [{ name: 'id', field: 'id', pgType: 'bytea' }]) },
      };
      for (const dialect of [undefined, sqliteDialect, mysqlDialect]) {
        for (const create of [
          () => new Uint8Array([0, 15, 255]),
          () => Buffer.from([0, 15, 255]),
          () => new DataView(new Uint8Array([0, 15, 255]).buffer),
        ]) {
          for (const properties of [{ hasKey: 'x' }, { has: 1 }, { distance: { to: [1, 2], metric: 'cosine' } }]) {
            const value = create();
            const q = makeQuery('binary_keys', binarySchema, { ...options, dialect });
            const args = { where: { id: value } };
            const plain = q.buildFindUnique(args);
            assert.equal(plain.params[0], value);
            Object.assign(value, properties);
            const expected = dialect && 'distance' in properties ? UnsupportedFeatureError : ValidationError;
            assert.throws(() => q.buildFindUnique(args), expected);
            assert.throws(
              () => makeQuery('binary_keys', binarySchema, { ...options, dialect }).buildFindUnique(args),
              expected,
            );
            for (const key of Object.keys(properties)) Reflect.deleteProperty(value, key);
            const restored = q.buildFindUnique(args);
            assert.equal(restored.sql, plain.sql);
            assert.equal(restored.params[0], value);
          }
        }
      }
    });

    it('retains dynamic filters, projection guards and complete decoding', () => {
      let tenant = 2;
      const q = makeQuery('users', schema, { ...options, globalFilters: { users: () => ({ tenantId: tenant }) } });
      const first = q.buildFindUnique({ where: { id: 1 } });
      tenant = 7;
      const second = q.buildFindUnique({ where: { id: 1 } });
      assert.equal(first.sql, second.sql);
      assert.deepEqual(first.params, [1, 2]);
      assert.deepEqual(second.params, [1, 7]);
      assert.deepEqual(q.buildFindUnique({ where: { id: 1 }, skipGlobalFilters: UNSAFE }).params, [1]);
      assert.throws(() => q.buildFindUnique({ where: { id: 1 }, select: { secret: true } }), ValidationError);
      assert.deepEqual(second.transform({ rows: [{ id: 1, tenant_id: 7, email: 'x', payload: null }], rowCount: 1 }), {
        id: 1,
        tenantId: 7,
        email: 'x',
        payload: null,
      });
      assert.equal(second.transform({ rows: [], rowCount: 0 }), null);
    });
  });
}

describe('ordinary public read dispatch', () => {
  it('keeps combinator names structural even when a column has the same name', () => {
    for (const name of ['AND', 'OR', 'NOT']) {
      const table = mockTable('operators', [{ name, field: name }], {}, [name]);
      const q = makeQuery('operators', { enums: {}, tables: { operators: table } });
      assert.throws(() => q.buildFindUnique({ where: { [name]: 1 } }), ValidationError);
    }
  });

  it('retains middleware result transformation, repeat next calls and error identity', async () => {
    const error = new Error('read failure');
    let fail = false;
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        if (fail) throw error;
        return { rows: [{ id: 1 }], rowCount: 1 };
      },
    } as unknown as PgCompatPool;
    const q = new QueryInterface(pool, 'users', schema, [
      async (params, next) => {
        const first = await next(params);
        assert.deepEqual(await next(params), first);
        return { value: first };
      },
    ]);
    assert.deepEqual(await q.findUnique({ where: { id: 1 } }), { value: { id: 1 } });
    assert.equal(calls, 2);
    fail = true;
    await assert.rejects(q.findUnique({ where: { id: 1 } }), (actual) => actual === error);
  });

  it('refuses a changed middleware argument and still reports synchronous builder failures as rejections', async () => {
    const q = new QueryInterface({} as PgCompatPool, 'users', schema, [
      async (params, next) => next({ ...params, args: { where: { id: 2 } } }),
    ]);
    await assert.rejects(q.findUnique({ where: { id: 1 } }), /args\.where\.id/);
    const direct = new QueryInterface({} as PgCompatPool, 'users', schema);
    await assert.rejects(direct.findUnique({ where: {} }), ValidationError);
    await assert.rejects(direct.findMany({ select: {} }), ValidationError);
    await assert.rejects(direct.findUniqueOrThrow({ where: {} }), ValidationError);
    await assert.rejects(direct.findFirstOrThrow({ select: {} }), ValidationError);
  });

  it('keeps engine text coercion and JSON/object predicates on their existing paths', () => {
    for (const dialect of [undefined, sqliteDialect, mysqlDialect]) {
      const q = makeQuery('users', schema, { dialect, diagnostics: { cacheCheck: 'every-hit' } });
      const query = q.buildFindUnique({ where: { email: 0 } });
      assert.deepEqual(query.params, [dialect === mysqlDialect ? '0' : 0]);
      assert.match(query.sql, /email/);
      assert.throws(() => q.buildFindUnique({ where: { id: { bad: 1 } } }), ValidationError);
      assert.throws(() => q.buildFindUnique({ where: { id: 1, unknown: 2 } }), ValidationError);
    }
  });
});

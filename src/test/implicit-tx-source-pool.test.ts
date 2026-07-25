/**
 * turbine-orm: the implicit transaction opened for a nested write
 *
 * `QueryInterface.runInImplicitTx` builds a `TransactionClient` for the nested
 * write engine. It used to omit the 5th `sourcePool` argument, so the
 * transaction-scoped proxy pool lost the parent pool's `readonly` guard and
 * `capabilities`: a read-only client's nested write slipped past the E018
 * guard, and an older engine fell back to the full capability set inside the
 * transaction. It also lacked a `began` flag, so a failing BEGIN was followed
 * by a ROLLBACK on a connection that never opened a transaction.
 *
 * Run: npx tsx --test src/test/implicit-tx-source-pool.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ReadOnlyError } from '../errors.js';
import { PowqlInterface } from '../powql.js';
import { QueryInterface } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    users: mockTable(
      'users',
      [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'user_id',
          referenceKey: 'id',
        },
      },
    ),
    posts: mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'user_id', field: 'userId' },
    ]),
  },
  enums: {},
};

interface Harness {
  // biome-ignore lint/suspicious/noExplicitAny: mock pool stands in for pg.Pool
  pool: any;
  statements: string[];
  /** Pools handed to the transaction-scoped table accessors. */
  childPools: { readonly?: boolean; capabilities?: unknown }[];
}

function createHarness(opts: { readonly?: boolean; capabilities?: unknown; failBegin?: boolean }): Harness {
  const statements: string[] = [];
  const childPools: { readonly?: boolean; capabilities?: unknown }[] = [];

  const query = async (textOrConfig: string | { text: string }, _values?: unknown[]) => {
    const text = typeof textOrConfig === 'string' ? textOrConfig : textOrConfig.text;
    statements.push(text);
    if (opts.failBegin && text === 'BEGIN') throw new Error('begin refused');
    return { rows: [{ id: 1, name: 'Alice' }], rowCount: 1 };
  };

  const client = { query, release() {} };
  const pool: Record<string, unknown> = { query, connect: async () => client };
  if (opts.readonly !== undefined) pool.readonly = opts.readonly;
  if (opts.capabilities !== undefined) pool.capabilities = opts.capabilities;

  return { pool, statements, childPools };
}

describe('runInImplicitTx: source pool passthrough', () => {
  it("a read-only pool's E018 guard still fires for a nested write", async () => {
    const harness = createHarness({ readonly: true });

    const qi = new QueryInterface<Record<string, unknown>>(harness.pool, 'users', schema, undefined, {
      // The transaction-scoped accessors are built through this factory (the
      // PowDB wiring), so they read `readonly` off the proxy pool.
      queryInterfaceFactory: (pool, name, sch, middlewares, options) =>
        new PowqlInterface(pool as never, name, sch, middlewares as never, options) as never,
    });

    await assert.rejects(
      () => qi.create({ data: { name: 'Alice', posts: { create: [{ title: 'Hi' }] } } } as never),
      (err: unknown) => {
        assert.ok(err instanceof ReadOnlyError, `expected ReadOnlyError, got ${String(err)}`);
        assert.equal(err.code, 'TURBINE_E018');
        return true;
      },
    );
  });

  it('carries readonly + capabilities onto the transaction-scoped accessor pool', async () => {
    const capabilities = { nativeRaw: false };
    const harness = createHarness({ readonly: false, capabilities });

    const qi = new QueryInterface<Record<string, unknown>>(harness.pool, 'users', schema, undefined, {
      queryInterfaceFactory: (pool, name, sch, middlewares, options) => {
        harness.childPools.push(pool as unknown as { readonly?: boolean; capabilities?: unknown });
        return new QueryInterface(pool, name, sch, middlewares, options) as never;
      },
    });

    await qi.create({ data: { name: 'Alice', posts: { create: [{ title: 'Hi' }] } } } as never);

    assert.ok(harness.childPools.length > 0, 'nested write must build transaction-scoped accessors');
    for (const child of harness.childPools) {
      assert.equal(child.readonly, false, 'readonly flag must carry into the transaction');
      assert.equal(child.capabilities, capabilities, 'capabilities must carry into the transaction');
    }
  });

  it('a failing BEGIN does not emit a stray ROLLBACK', async () => {
    const harness = createHarness({ failBegin: true });
    const qi = new QueryInterface<Record<string, unknown>>(harness.pool, 'users', schema);

    await assert.rejects(
      () => qi.create({ data: { name: 'Alice', posts: { create: [{ title: 'Hi' }] } } } as never),
      /begin refused/,
    );

    assert.deepEqual(harness.statements, ['BEGIN'], 'no ROLLBACK on a transaction that never began');
  });
});

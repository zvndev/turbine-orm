import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { postgresDialect } from '../dialect.js';
import { mssqlDialect } from '../mssql.js';
import { MysqlPool, mysqlDialect } from '../mysql.js';
import type { BuilderCtx } from '../query/where.js';
import { parseWriteRow, planCreateMany } from '../query/writes.js';
import { sqliteDialect } from '../sqlite.js';
import { makeQuery, mockTable } from './helpers.js';

function metadata() {
  return {
    enums: {},
    tables: {
      items: mockTable('items', [
        { name: 'id', field: 'id', pgType: 'int4' },
        { name: 'label', field: 'label', pgType: 'text' },
        { name: 'secret', field: 'secret', pgType: 'text' },
      ]),
    },
  };
}

describe('write planning observation order', () => {
  for (const base of [postgresDialect, sqliteDialect, mysqlDialect, mssqlDialect]) {
    it(`${base.name} observes both sizing hooks before building execution chunks`, () => {
      const calls: number[] = [];
      const sentinel = { phase: 'second sizing build' };
      const dialect = {
        ...base,
        buildBulkInsertStatement(input: Parameters<typeof base.buildBulkInsertStatement>[0]) {
          calls.push(input.rowValues.length);
          if (input.rowValues.length === 2) throw sentinel;
          return base.buildBulkInsertStatement.call(this, input);
        },
      };
      const qi = makeQuery('items', metadata(), { dialect });
      const ctx = (qi as unknown as { ctx: BuilderCtx }).ctx;
      assert.throws(
        () => planCreateMany(ctx, { data: [{ id: 1 }, { id: 2 }, { id: 3 }] }),
        (error) => error === sentinel,
      );
      assert.deepEqual(calls, [1, 2]);
    });
  }

  it('reads the return policy after each row parse, including reentrant metadata changes', () => {
    const meta = metadata().tables.items;
    const events: string[] = [];
    let visits = 0;
    Object.defineProperty(meta.primaryKey, Symbol.iterator, {
      value() {
        events.push('primaryKey');
        return Array.prototype[Symbol.iterator].call(this);
      },
    });
    const ctx = {
      table: 'items',
      tableMeta: meta,
      parseRow(row: Record<string, unknown>) {
        events.push(`parse:${++visits}`);
        meta.columns[2]!.pii = visits === 2;
        return { ...row };
      },
    } as unknown as BuilderCtx;
    assert.deepEqual(parseWriteRow(ctx, { id: 1, secret: 'first' }), { id: 1, secret: 'first' });
    assert.deepEqual(parseWriteRow(ctx, { id: 2, secret: 'second' }), { id: 2 });
    assert.deepEqual(events, ['parse:1', 'primaryKey', 'parse:2', 'primaryKey']);
  });

  it('preserves a later metadata getter failure after parsing that row', () => {
    const meta = metadata().tables.items;
    const events: string[] = [];
    let visits = 0;
    Object.defineProperty(meta.columns[2]!, 'pii', {
      get() {
        events.push('pii');
        if (visits === 2) throw 0;
        return false;
      },
    });
    const ctx = {
      table: 'items',
      tableMeta: meta,
      parseRow(row: Record<string, unknown>) {
        events.push(`parse:${++visits}`);
        return { ...row };
      },
    } as unknown as BuilderCtx;
    parseWriteRow(ctx, { id: 1 });
    assert.throws(
      () => parseWriteRow(ctx, { id: 2 }),
      (error) => error === 0,
    );
    assert.deepEqual(events, ['parse:1', 'pii', 'parse:2', 'pii']);
  });

  it('keeps MySQL bulk list detection separate from the current iterator values it binds', async () => {
    const calls: { sql: string; values: unknown }[] = [];
    const run = async (sql: string, values?: unknown): Promise<[unknown, unknown]> => {
      calls.push({ sql, values });
      return [{ affectedRows: 1 }, []];
    };
    const pool = new MysqlPool({
      query: run,
      execute: run,
      async getConnection() {
        return { query: run, execute: run, release() {} };
      },
      async end() {},
    });
    const built = mysqlDialect.buildBulkInsertStatement({
      table: '`items`',
      columns: ['`id`', '`label`'],
      columnArrayTypes: [],
      rowValues: [[1, 'initial']],
    });
    const reads: number[] = [];
    Object.defineProperty(built.params, 1, {
      get() {
        reads.push(reads.length + 1);
        return reads.length === 1 ? 'scan' : 'bound';
      },
    });
    await pool.query(built.sql, built.params);
    assert.deepEqual(reads, [1, 2]);
    assert.deepEqual(calls, [{ sql: 'INSERT INTO `items` (`id`, `label`) VALUES (?, ?)', values: [1, 'bound'] }]);
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OptimisticLockError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

const schema: SchemaMetadata = {
  tables: {
    posts: mockTable('posts', [
      { name: 'id', field: 'id' },
      { name: 'title', field: 'title', pgType: 'text' },
      { name: 'version', field: 'version' },
    ]),
  },
  enums: {},
};

describe('optimistic locking', () => {
  it('adds version check to WHERE and increment to SET', () => {
    const q = makeQuery('posts', schema);
    const deferred = q.buildUpdate({
      where: { id: 1 } as never,
      data: { title: 'new title' } as never,
      optimisticLock: { field: 'version', expected: 3 },
    });

    assert.ok(deferred.sql.includes('SET'), `SQL should contain SET: ${deferred.sql}`);
    assert.ok(deferred.sql.includes('"version" = "version" + 1'), `SQL should auto-increment version: ${deferred.sql}`);
    assert.ok(deferred.sql.includes('WHERE'), `SQL should contain WHERE: ${deferred.sql}`);
    assert.ok(
      deferred.params.includes(3),
      `Params should include expected version 3: ${JSON.stringify(deferred.params)}`,
    );
  });

  it('throws OptimisticLockError when no rows returned', () => {
    const q = makeQuery('posts', schema);
    const deferred = q.buildUpdate({
      where: { id: 1 } as never,
      data: { title: 'new title' } as never,
      optimisticLock: { field: 'version', expected: 5 },
    });

    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: mock pg result
      () => deferred.transform({ rows: [], rowCount: 0 } as any),
      (err: unknown) => {
        assert.ok(err instanceof OptimisticLockError);
        assert.equal(err.table, 'posts');
        assert.equal(err.versionField, 'version');
        assert.equal(err.expectedVersion, 5);
        assert.equal(err.code, 'TURBINE_E015');
        return true;
      },
    );
  });

  it('returns the updated row on success', () => {
    const q = makeQuery('posts', schema);
    const deferred = q.buildUpdate({
      where: { id: 1 } as never,
      data: { title: 'updated' } as never,
      optimisticLock: { field: 'version', expected: 2 },
    });

    const result = deferred.transform({
      rows: [{ id: 1, title: 'updated', version: 3 }],
      rowCount: 1,
      // biome-ignore lint/suspicious/noExplicitAny: mock pg result
    } as any);
    assert.deepEqual(result, { id: 1, title: 'updated', version: 3 });
  });

  it('still throws NotFoundError without optimistic lock', () => {
    const q = makeQuery('posts', schema);
    const deferred = q.buildUpdate({
      where: { id: 999 } as never,
      data: { title: 'x' } as never,
    });

    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: mock pg result
      () => deferred.transform({ rows: [], rowCount: 0 } as any),
      (err: unknown) => {
        assert.equal((err as { code: string }).code, 'TURBINE_E001');
        return true;
      },
    );
  });

  it('does not cache optimistic lock queries', () => {
    const q = makeQuery('posts', schema);
    const d1 = q.buildUpdate({
      where: { id: 1 } as never,
      data: { title: 'a' } as never,
      optimisticLock: { field: 'version', expected: 1 },
    });
    const d2 = q.buildUpdate({
      where: { id: 1 } as never,
      data: { title: 'a' } as never,
      optimisticLock: { field: 'version', expected: 2 },
    });

    assert.notEqual(d1.params[d1.params.length - 1], d2.params[d2.params.length - 1]);
    assert.equal(d1.params[d1.params.length - 1], 1);
    assert.equal(d2.params[d2.params.length - 1], 2);
  });
});

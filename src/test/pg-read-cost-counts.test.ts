import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PgCompatQueryResult } from '../pg-types.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'display_name', field: 'displayName', pgType: 'text' },
      { name: '_count__stored', field: 'storedCount', pgType: 'text' },
      { name: 'count_alias', field: '_count__posts', pgType: 'text' },
      { name: 'prototype_column', field: '__proto__', pgType: 'text' },
      { name: '_count', field: '_count', pgType: 'jsonb' },
      { name: 'at', field: 'at', pgType: 'timestamptz' },
      { name: 'score', field: 'score', pgType: 'float8' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
      tags: {
        type: 'manyToMany',
        name: 'tags',
        from: 'users',
        to: 'tags',
        foreignKey: 'id',
        referenceKey: 'id',
        through: { table: 'user_tags', sourceKey: 'user_id', targetKey: 'tag_id' },
      },
    },
  );
  users.dateColumns.add('at');
  return {
    enums: {},
    tables: {
      users,
      posts: mockTable('posts', [
        { name: 'id', field: 'id' },
        { name: 'user_id', field: 'userId' },
      ]),
      tags: mockTable('tags', [{ name: 'id', field: 'id' }]),
      user_tags: mockTable('user_tags', [
        { name: 'user_id', field: 'userId' },
        { name: 'tag_id', field: 'tagId' },
      ]),
    },
  };
}

for (const jsonEncoding of ['object', 'positional'] as const)
  describe(`count materialization: ${jsonEncoding}`, () => {
    function read(rows: Record<string, unknown>[]) {
      const q = makeQuery('users', schema(), { jsonEncoding });
      const deferred = q.buildFindMany({ with: { _count: { posts: true, tags: true } } } as never);
      return deferred.transform({
        rows,
        rowCount: rows.length,
        command: 'SELECT',
        oid: 0,
        fields: [],
      } as PgCompatQueryResult);
    }

    it('preserves all scalar values, exact key order and own prototypes without mutating the driver rows', () => {
      const at = new Date('2025-01-02T03:04:05Z');
      const raw = Object.freeze({
        id: 1,
        display_name: 'reader',
        at,
        score: '-Infinity',
        _count__posts: '3',
        _count__tags: 0,
      });
      const result = read([raw])[0]!;
      assert.deepEqual(Object.keys(result), ['id', 'displayName', 'at', 'score', '_count']);
      assert.deepEqual(result, { id: 1, displayName: 'reader', at, score: -Infinity, _count: { posts: 3, tags: 0 } });
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.equal(Object.getPrototypeOf(result._count), Object.prototype);
      assert.equal(result.at, at);
      assert.equal(raw._count__posts, '3');
    });

    it('keeps stored count-like fields and the position of an existing _count property', () => {
      const result = read([
        { _count: { old: 1 }, id: 2, _count__stored: 'stored', display_name: 'n', _count__posts: 4 },
      ])[0]!;
      assert.deepEqual(Object.keys(result), ['_count', 'id', 'storedCount', 'displayName']);
      assert.deepEqual(result, { _count: { posts: 4 }, id: 2, storedCount: 'stored', displayName: 'n' });
    });

    it('retains the ordinary-column mapping and overwrite order when a field resembles a generated count alias', () => {
      assert.deepEqual(read([{ id: 1, count_alias: '99', _count__posts: '2' }]), [{ id: 1, _count: { posts: 2 } }]);
      assert.deepEqual(read([{ _count__posts: '2', id: 1, count_alias: '99' }]), [{ id: 1, _count: { posts: 99 } }]);
    });

    it('handles prototype keys, numeric suffixes, unknown aliases and null/undefined coercion', () => {
      const row = Object.assign(Object.create(null), {
        id: 3,
        prototype_column: 'safe data',
        _count____proto__: 9,
        _count__constructor: '4',
        _count__2: '2',
        _count__unrecognized: null,
        _count__posts: undefined,
      });
      const result = read([row])[0]!;
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      assert.ok(Object.hasOwn(result, '__proto__'));
      assert.equal(Object.getOwnPropertyDescriptor(result, '__proto__')?.value, 'safe data');
      assert.ok(
        Object.hasOwn(result, '_count____proto__'),
        'the legacy count object setter never creates this count key',
      );
      assert.equal(result._count____proto__, 9);
      const count = result._count as Record<string, number>;
      assert.deepEqual(Object.keys(count), ['2', 'constructor', 'unrecognized', 'posts']);
      assert.equal(count.constructor, 4);
      assert.equal(count.unrecognized, 0);
      assert.ok(Number.isNaN(count.posts));
      assert.equal(Object.hasOwn(count, '__proto__'), false);
    });

    it('rechecks each projection and row order on successive heterogeneous rows', () => {
      const result = read([
        { id: 1, display_name: 'a', _count__posts: '2' },
        { display_name: 'b', id: 2, _count__tags: '3' },
        { id: 3 },
      ]);
      assert.deepEqual(result, [
        { id: 1, displayName: 'a', _count: { posts: 2 } },
        { displayName: 'b', id: 2, _count: { tags: 3 } },
        { id: 3 },
      ]);
      assert.deepEqual(Object.keys(result[1]!), ['displayName', 'id', '_count']);
    });

    it('reads every scalar before coercing counts and preserves coercion error identity/order', () => {
      const events: string[] = [];
      const sentinel = new Error('count conversion refused');
      const count = {
        valueOf() {
          events.push('coerce count');
          throw sentinel;
        },
      };
      const raw = {
        get _count__posts() {
          events.push('read count');
          return count;
        },
        get display_name() {
          events.push('read scalar');
          return 'a';
        },
      };
      assert.throws(
        () => read([raw]),
        (error) => error === sentinel,
      );
      assert.deepEqual(events, ['read count', 'read scalar', 'coerce count']);
      assert.throws(() => read([{ _count__posts: Symbol('bad count') }]), TypeError);
    });

    it('does not read or replace accessors created by scalar setters while folding counts', () => {
      const query = makeQuery('users', schema(), { jsonEncoding }).buildFindMany({
        with: { _count: { posts: true, tags: true } },
      } as never);
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'displayName');
      const sentinel = new Error('lazy scalar getter');
      const symbol = Symbol('setter metadata');
      const events: string[] = [];
      Object.defineProperty(Object.prototype, 'displayName', {
        configurable: true,
        set() {
          events.push('set');
          Object.defineProperty(this, 'displayName', {
            enumerable: true,
            configurable: true,
            get() {
              events.push('get');
              throw sentinel;
            },
          });
          Object.defineProperty(this, symbol, { value: 'private', enumerable: false });
        },
      });
      try {
        for (const counts of [{}, { _count__posts: '2' }, { _count__posts: '2', _count__tags: '3' }]) {
          events.length = 0;
          const rows = query.transform({
            rows: [
              { id: 1, display_name: 'a', ...counts },
              { id: 2, display_name: 'b', ...counts },
            ],
            rowCount: 2,
            command: 'SELECT',
            oid: 0,
            fields: [],
          } as PgCompatQueryResult);
          assert.deepEqual(events, ['set', 'set']);
          for (const row of rows) {
            assert.equal(typeof Object.getOwnPropertyDescriptor(row, 'displayName')?.get, 'function');
            assert.deepEqual(Object.getOwnPropertyDescriptor(row, symbol), {
              value: 'private',
              writable: false,
              enumerable: false,
              configurable: false,
            });
            assert.throws(
              () => row.displayName,
              (error) => error === sentinel,
            );
            for (const key of Object.keys(counts)) assert.equal(Object.hasOwn(row, key), false);
          }
        }
      } finally {
        if (previous) Object.defineProperty(Object.prototype, 'displayName', previous);
        else Reflect.deleteProperty(Object.prototype, 'displayName');
      }
    });
  });

/**
 * An unknown `orderBy` key is REFUSED, on every shape orderBy accepts.
 *
 * This replaces a dev-only warning that printed `Unknown orderBy field "x" for
 * table "y". This will cause a runtime error.` and then let compilation
 * continue into the code that throws for the same key with a better message.
 * The warning was pure duplication: it predicted an exception raised a few
 * lines later, it only ran outside production, and it was a second copy of the
 * key-resolution rules that could drift from the real one.
 *
 * Removing a warning is only safe if the throw genuinely covers every shape the
 * warning covered, so that is what these cases pin. All six were measured
 * warning-and-throwing before the removal; if a future change makes one of them
 * silently accept an unknown key, this file fails rather than the defect
 * shipping behind a warning nobody reads.
 *
 * Two of the shapes throw `RelationError` (E005) rather than `ValidationError`
 * (E003), because an object value shaped like a relation ordering is read as
 * naming a relation. Both are a refusal, which is the property under test; the
 * exact class is asserted per case so a change of class is visible rather than
 * silent.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RelationError, ValidationError } from '../errors.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'profile', field: 'profile', pgType: 'jsonb' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
    },
  );
  users.primaryKey = ['id'];

  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  posts.primaryKey = ['id'];

  return { enums: {}, tables: { users, posts } };
}

const q = () => makeQuery('users', schema());

// biome-ignore lint/suspicious/noExplicitAny: these args are deliberately invalid
type Any = any;

describe('orderBy: an unknown field is refused on every shape', () => {
  const cases: [label: string, orderBy: unknown, error: typeof ValidationError | typeof RelationError][] = [
    ['plain direction', { nmae: 'asc' }, ValidationError],
    ['OrderBySpec', { nmae: { sort: 'asc', nulls: 'last' } }, ValidationError],
    ['JSON path', { nmae: { path: ['a'], sort: 'asc' } }, ValidationError],
    ['array form', [{ nmae: 'asc' }], ValidationError],
    // Object values shaped like a relation ordering: read as naming a relation,
    // so the refusal comes from the relation resolver instead.
    ['relation _count shape', { nmae: { _count: 'desc' } }, RelationError],
    ['relation target-column shape', { nmae: { title: 'asc' } }, RelationError],
  ];

  for (const [label, orderBy, error] of cases) {
    it(`refuses an unknown key: ${label}`, () => {
      assert.throws(
        () => q().buildFindMany({ orderBy } as Any),
        (err: unknown) => {
          assert.ok(err instanceof error, `${label}: expected ${error.name}, got ${String(err)}`);
          return true;
        },
        label,
      );
    });
  }

  it('a known key still works on each of those shapes', () => {
    // The control. Without it, a change that refused EVERY orderBy would pass
    // every case above.
    assert.doesNotThrow(() => q().buildFindMany({ orderBy: { name: 'asc' } } as Any));
    assert.doesNotThrow(() => q().buildFindMany({ orderBy: { name: { sort: 'asc', nulls: 'last' } } } as Any));
    assert.doesNotThrow(() => q().buildFindMany({ orderBy: [{ name: 'asc' }] } as Any));
    assert.doesNotThrow(() => q().buildFindMany({ orderBy: { profile: { path: ['a'], sort: 'asc' } } } as Any));
    assert.doesNotThrow(() => q().buildFindMany({ orderBy: { posts: { _count: 'desc' } } } as Any));
  });

  it('refuses in production too, where the old warning never ran', () => {
    // The warning was gated on NODE_ENV !== 'production'. The throw is not, and
    // that difference is the entire argument for the warning being redundant:
    // the signal a production deployment gets is unchanged.
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      assert.throws(() => q().buildFindMany({ orderBy: { nmae: 'asc' } } as Any), ValidationError);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

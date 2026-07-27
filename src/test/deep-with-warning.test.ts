/**
 * turbine-orm, deep-`with` dev advisory text
 *
 * The advisory fires from `findMany` on a `with` tree deeper than 5, before any
 * SQL is built, and it has to carry the same four parts as the other strategy
 * notes: the condition, the MECHANISM (which plan shape the depth produces and
 * what it costs), the fix, and the escape hatch. The old text named only the
 * condition ("consider splitting into separate queries"), which leaves the
 * reader guessing at why depth is expensive and whether it is expensive at all.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type pg from 'pg';
import { QueryInterface } from '../query/index.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

afterEach(() => resetWarnOnce(WARN_NS.deepWith));

/** users → posts → author (back to users), so a `with` tree can nest freely. */
function schema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
    },
  );
  const posts = mockTable(
    'posts',
    [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
    ],
    {
      author: {
        type: 'belongsTo',
        name: 'author',
        from: 'posts',
        to: 'users',
        foreignKey: 'user_id',
        referenceKey: 'id',
      },
    },
  );
  return { tables: { users, posts }, enums: {} };
}

/** Pool stub that answers every statement with an empty result set. */
function stubPool(): pg.Pool {
  return {
    query: async () => ({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }),
  } as unknown as pg.Pool;
}

/**
 * Alternate posts/author to build a `with` tree of the requested depth. Level 0
 * hangs off `users`, so the outermost key is always `posts`.
 */
function nest(depth: number, level = 0): Record<string, unknown> {
  const key = level % 2 === 0 ? 'posts' : 'author';
  return depth <= 1 ? { [key]: true } : { [key]: { with: nest(depth - 1, level + 1) } };
}

async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.warn;
  const captured: string[] = [];
  console.warn = (...args: unknown[]) => captured.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return captured;
}

describe('deep-with dev advisory', () => {
  it('names the mechanism, the fix, and the escape hatch', async () => {
    const q = new QueryInterface(stubPool(), 'users', schema(), [], { relationLoadStrategy: 'join' });
    const warnings = await captureWarnings(() => q.findMany({ limit: 10, with: nest(6) } as never));
    const deep = warnings.filter((w) => /Deep with clause/.test(w));
    assert.equal(deep.length, 1, `expected one deep-with advisory, got ${JSON.stringify(warnings)}`);
    const line = deep[0] as string;
    assert.match(line, /depth 6/);
    assert.match(line, /re-evaluates once per row of the level above/);
    assert.match(line, /multiplies down the tree/);
    assert.match(line, /relationLoadStrategy: 'batched'/);
    assert.match(line, /NODE_ENV=production/);
  });

  it('stays quiet at depth 5 and once per table beyond it', async () => {
    const q = new QueryInterface(stubPool(), 'users', schema(), [], { relationLoadStrategy: 'join' });
    const shallow = await captureWarnings(() => q.findMany({ limit: 10, with: nest(5) } as never));
    assert.equal(shallow.filter((w) => /Deep with clause/.test(w)).length, 0);
    await captureWarnings(() => q.findMany({ limit: 10, with: nest(6) } as never));
    const again = await captureWarnings(() => q.findMany({ limit: 10, with: nest(7) } as never));
    assert.equal(again.filter((w) => /Deep with clause/.test(w)).length, 0);
  });
});

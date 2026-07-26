/**
 * turbine-orm, deterministic key-order tests for the batched relation loader.
 *
 * Object key order is observable output (callers `JSON.stringify` results into
 * HTTP bodies, ETags and cache keys), so the batched strategy must produce the
 * SAME key order as the join strategy, on every run. The follow-up queries run
 * concurrently, so before the fix the `_count` entries (and the sibling relation
 * keys) were inserted in whichever statement finished first.
 *
 * These tests are deterministic rather than probabilistic: the fake pool delays
 * each statement by a per-table amount chosen so that completion order is the
 * EXACT REVERSE of the order the join strategy emits. Any implementation that
 * keys off completion order fails every single run, not sometimes.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QueryInterface } from '../query/index.js';
import type { RelationDef, SchemaMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

// ---------------------------------------------------------------------------
// Fixture: users with four hasMany relations whose declaration order, spec
// order and alphabetical order are all different, so a test that passes cannot
// be passing by coincidence.
// ---------------------------------------------------------------------------

/** Relation name → child table, in metadata declaration order. */
const RELS: [string, string][] = [
  ['zeta', 'c_zeta'],
  ['alpha', 'c_alpha'],
  ['mid', 'c_mid'],
  ['beta', 'c_beta'],
];

function makeSchema(): SchemaMetadata {
  const relations: Record<string, RelationDef> = {};
  for (const [name, table] of RELS) {
    relations[name] = {
      type: 'hasMany',
      name,
      from: 'users',
      to: table,
      foreignKey: 'user_id',
      referenceKey: 'id',
    };
  }
  const tables: Record<string, ReturnType<typeof mockTable>> = {
    users: mockTable(
      'users',
      [
        { name: 'id', field: 'id' },
        { name: 'name', field: 'name', pgType: 'text' },
      ],
      relations,
    ),
  };
  for (const [, table] of RELS) {
    tables[table] = mockTable(table, [
      { name: 'id', field: 'id' },
      { name: 'user_id', field: 'userId' },
    ]);
  }
  return { enums: {}, tables } as unknown as SchemaMetadata;
}

/**
 * A fake pg pool whose responses are delayed per child table, so completion
 * order is fully controlled by `delayByTable` (ms). Statements that name no
 * child table (the base query) resolve immediately.
 */
function makeDelayedPool(delayByTable: Record<string, number>) {
  const completed: string[] = [];
  const pool = {
    query: async (sql: string) => {
      const table = /FROM "(\w+)"/.exec(sql)?.[1] ?? '';
      const delay = delayByTable[table] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      completed.push(table);
      if (/COUNT\(\*\)/.test(sql)) return { rows: [{ k: 1, c: 2 }], rowCount: 1 };
      if (table === 'users') {
        return { rows: [{ id: 1, name: 'alice' }], rowCount: 1 };
      }
      return { rows: [{ id: 9, user_id: 1 }], rowCount: 1 };
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal pg pool shim for tests
  return { pool: pool as any, completed };
}

function usersQi(pool: unknown, strategy: 'batched' | 'join') {
  return new QueryInterface(
    // biome-ignore lint/suspicious/noExplicitAny: fake pool
    pool as any,
    'users',
    makeSchema(),
    [],
    { preparedStatements: false, warnOnUnlimited: false, relationLoadStrategy: strategy },
  );
}

/**
 * Delays that make completion order the reverse of `order`: the first entry
 * waits longest. 20ms steps keep the ordering unambiguous on a busy runner.
 */
function reverseDelays(order: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  order.forEach((table, i) => {
    out[table] = (order.length - i) * 20;
  });
  return out;
}

/** The relation/_count aliases the JOIN plan projects, in SELECT-list order. */
function joinRelationKeys(withClause: Record<string, unknown>): string[] {
  const { sql } = usersQi(null, 'join').buildFindMany({ with: withClause } as never);
  const keys: string[] = [];
  for (const m of sql.matchAll(/AS "([^"]+)"/g)) {
    const alias = m[1]!;
    if (alias.startsWith('_count__')) {
      if (!keys.includes('_count')) keys.push('_count');
      continue;
    }
    keys.push(alias);
  }
  return keys;
}

describe('batched loader, `_count` key order', () => {
  it('follows the _count spec order even when every count finishes in reverse', async () => {
    const spec = { zeta: true, alpha: true, mid: true, beta: true };
    const expected = ['zeta', 'alpha', 'mid', 'beta'];
    const { pool, completed } = makeDelayedPool(reverseDelays(expected.map((r) => `c_${r}`)));
    const rows = await usersQi(pool, 'batched').findMany({ with: { _count: spec } } as never);

    // The delays really did invert the order the counts were issued in, so a
    // completion-ordered implementation cannot accidentally pass.
    assert.deepEqual(
      completed.filter((t) => t.startsWith('c_')),
      ['c_beta', 'c_mid', 'c_alpha', 'c_zeta'],
    );
    const count = (rows[0] as { _count: Record<string, number> })._count;
    assert.deepEqual(Object.keys(count), expected);
    assert.deepEqual(count, { zeta: 2, alpha: 2, mid: 2, beta: 2 });
  });

  it('`_count: true` follows metadata declaration order (join parity)', async () => {
    const expected = RELS.map(([name]) => name);
    const { pool } = makeDelayedPool(reverseDelays(RELS.map(([, table]) => table)));
    const rows = await usersQi(pool, 'batched').findMany({ with: { _count: true } } as never);
    const count = (rows[0] as { _count: Record<string, number> })._count;
    assert.deepEqual(Object.keys(count), expected);
  });

  it('is identical across repeated runs with shuffled completion order', async () => {
    const spec = { zeta: true, alpha: true, mid: true, beta: true };
    const seen = new Set<string>();
    for (let run = 0; run < 8; run++) {
      // Rotate the delays every run so a different count wins each time.
      const tables = RELS.map(([name]) => `c_${name}`);
      const rotated = [...tables.slice(run % tables.length), ...tables.slice(0, run % tables.length)];
      const { pool } = makeDelayedPool(reverseDelays(rotated));
      const rows = await usersQi(pool, 'batched').findMany({ with: { _count: spec } } as never);
      seen.add(JSON.stringify((rows[0] as { _count: unknown })._count));
    }
    assert.equal(seen.size, 1, `expected one distinct _count key order, got ${[...seen].join(' | ')}`);
  });
});

describe('batched loader, parent key order matches the join plan', () => {
  it('relations sort like the join SELECT list and `_count` lands last', async () => {
    const withClause = { zeta: true, alpha: true, _count: { mid: true } };
    // Delays: the relation the join plan emits FIRST resolves LAST.
    const { pool } = makeDelayedPool({ ...reverseDelays(['c_alpha', 'c_zeta']), c_mid: 5 });
    const rows = await usersQi(pool, 'batched').findMany({ with: withClause } as never);

    const keys = Object.keys(rows[0] as Record<string, unknown>);
    const relationKeys = keys.filter((k) => k === '_count' || k === 'alpha' || k === 'zeta');
    assert.deepEqual(relationKeys, joinRelationKeys(withClause));
    // And the base columns still lead, untouched.
    assert.deepEqual(keys.slice(0, 2), ['id', 'name']);
  });

  it('is identical across repeated runs (relations plus _count)', async () => {
    const withClause = { zeta: true, alpha: true, mid: true, _count: { beta: true, zeta: true } };
    const seen = new Set<string>();
    const tables = ['c_zeta', 'c_alpha', 'c_mid'];
    for (let run = 0; run < 8; run++) {
      const rotated = [...tables.slice(run % tables.length), ...tables.slice(0, run % tables.length)];
      const { pool } = makeDelayedPool({ ...reverseDelays(rotated), c_beta: 5 });
      const rows = await usersQi(pool, 'batched').findMany({ with: withClause } as never);
      seen.add(JSON.stringify(rows[0]));
    }
    assert.equal(seen.size, 1, `expected one distinct serialization, got ${seen.size}`);
    assert.deepEqual(
      Object.keys(JSON.parse([...seen][0]!)),
      ['id', 'name', ...joinRelationKeys(withClause)],
      'batched key order must equal the join plan',
    );
  });
});

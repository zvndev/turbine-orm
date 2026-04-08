/**
 * turbine-orm — Unlimited findMany warning tests
 *
 * Verifies TASK-2.3: calling `findMany()` without an explicit `limit`/`take`
 * triggers a one-time `console.warn` per table. The warning is on by default
 * (`warnOnUnlimited` defaults to `true`) and can be silenced by passing
 * `warnOnUnlimited: false` in the QueryInterface options.
 *
 * Build-only tests — uses a stub pool that resolves with an empty result so
 * `findMany()` can be invoked without a real database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type pg from 'pg';
import { QueryInterface } from '../query.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function buildSchema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email', field: 'email', pgType: 'text' },
  ]);
  return { tables, enums: {} };
}

/** Minimal pg.Pool stub that returns an empty result set for any query. */
function stubPool(): pg.Pool {
  return {
    query: async () => ({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }),
  } as unknown as pg.Pool;
}

/** Capture all console.warn calls during `fn()` and return them. */
async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.warn;
  const captured: string[] = [];
  console.warn = (...args: unknown[]) => {
    captured.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return captured;
}

describe('findMany unlimited-query warning', () => {
  it('warns when limit is omitted (default behaviour)', async () => {
    const q = new QueryInterface(stubPool(), 'users', buildSchema());
    const warnings = await captureWarnings(() => q.findMany());
    assert.equal(warnings.length, 1, 'expected exactly one warning');
    assert.match(warnings[0]!, /findMany on "users"/);
    assert.match(warnings[0]!, /no limit/);
    assert.match(warnings[0]!, /warnOnUnlimited: false/);
  });

  it('does NOT warn when limit is provided', async () => {
    const q = new QueryInterface(stubPool(), 'users', buildSchema());
    const warnings = await captureWarnings(() => q.findMany({ limit: 10 }));
    assert.equal(warnings.length, 0);
  });

  it('does NOT warn when take is provided', async () => {
    const q = new QueryInterface(stubPool(), 'users', buildSchema());
    const warnings = await captureWarnings(() => q.findMany({ take: 10 }));
    assert.equal(warnings.length, 0);
  });

  it('does NOT warn when cursor pagination is used', async () => {
    const q = new QueryInterface(stubPool(), 'users', buildSchema());
    const warnings = await captureWarnings(() => q.findMany({ cursor: { id: 1 } as never }));
    assert.equal(warnings.length, 0);
  });

  it('dedupes — warns at most once per table per QueryInterface', async () => {
    const q = new QueryInterface(stubPool(), 'users', buildSchema());
    const warnings = await captureWarnings(async () => {
      await q.findMany();
      await q.findMany();
      await q.findMany();
    });
    assert.equal(warnings.length, 1, 'expected dedupe to suppress repeats');
  });

  it('opt-out: passing warnOnUnlimited: false silences the warning', async () => {
    const q = new QueryInterface(stubPool(), 'users', buildSchema(), undefined, {
      warnOnUnlimited: false,
    });
    const warnings = await captureWarnings(() => q.findMany());
    assert.equal(warnings.length, 0);
  });

  it('does NOT warn when defaultLimit is configured', async () => {
    const q = new QueryInterface(stubPool(), 'users', buildSchema(), undefined, {
      defaultLimit: 100,
    });
    const warnings = await captureWarnings(() => q.findMany());
    assert.equal(warnings.length, 0, 'defaultLimit means caller has opted into a bound');
  });

  it('resetUnlimitedWarnings() re-enables the warning for tests', async () => {
    const q = new QueryInterface(stubPool(), 'users', buildSchema());
    const first = await captureWarnings(() => q.findMany());
    assert.equal(first.length, 1);
    const second = await captureWarnings(() => q.findMany());
    assert.equal(second.length, 0, 'second call deduped');
    q.resetUnlimitedWarnings();
    const third = await captureWarnings(() => q.findMany());
    assert.equal(third.length, 1, 'reset re-enables the warning');
  });
});

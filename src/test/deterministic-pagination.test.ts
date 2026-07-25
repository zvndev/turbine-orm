/**
 * turbine-orm, deterministic pagination (unordered LIMIT / OFFSET)
 *
 * An unordered `LIMIT` is non-deterministic on Postgres: the same query can
 * return different rows once the heap changes underneath it, so a row may
 * appear on two pages or on none. Core surfaces that two ways:
 *
 *   1. a dev-mode, once-per-shape warning naming the primary key to order by;
 *   2. an OPT-IN `implicitPkOrdering` config flag that fills in a PK-ascending
 *      `ORDER BY` for a paginating query that declares none.
 *
 * The flag is OFF by default: switching it on would change the SQL existing
 * applications already emit. These tests assert both the behavior with it on
 * and the byte-identical SQL with it off.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type pg from 'pg';
import { QueryInterface } from '../query/index.js';
import { resetWarnOnce, WARN_NS } from '../query/warn-registry.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

afterEach(() => resetWarnOnce(WARN_NS.unorderedPage));

/** users (single PK), events (composite PK), logs (no PK). */
function schema(): SchemaMetadata {
  const tables: Record<string, TableMetadata> = {};
  tables.users = mockTable('users', [
    { name: 'id', field: 'id' },
    { name: 'email', field: 'email', pgType: 'text' },
  ]);
  const events = mockTable('events', [
    { name: 'org_id', field: 'orgId' },
    { name: 'seq', field: 'seq' },
    { name: 'body', field: 'body', pgType: 'text' },
  ]);
  events.primaryKey = ['org_id', 'seq'];
  events.uniqueColumns = [['org_id', 'seq']];
  tables.events = events;
  const logs = mockTable('logs', [
    { name: 'message', field: 'message', pgType: 'text' },
    { name: 'at', field: 'at', pgType: 'text' },
  ]);
  logs.primaryKey = [];
  logs.uniqueColumns = [];
  tables.logs = logs;
  return { tables, enums: {} };
}

function stubPool(): pg.Pool {
  return {
    query: async () => ({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] }),
  } as unknown as pg.Pool;
}

async function captureWarnings(fn: () => Promise<unknown>): Promise<string[]> {
  const original = console.warn;
  const out: string[] = [];
  console.warn = (...a: unknown[]) => out.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return out.filter((w) => /NOT\s+deterministic/.test(w));
}

describe('unordered-page warning', () => {
  it('fires exactly once per shape for a paginating query with no orderBy', async () => {
    const q = new QueryInterface(stubPool(), 'users', schema(), []);
    const warnings = await captureWarnings(async () => {
      await q.findMany({ limit: 50 });
      await q.findMany({ limit: 50 });
      await q.findMany({ limit: 25 }); // same shape, different value
    });
    assert.equal(warnings.length, 1, 'once per shape');
    assert.match(warnings[0]!, /findMany on "users" paginates \(limit\)/);
    assert.match(warnings[0]!, /orderBy: \{ id: 'asc' \}/);
    assert.match(warnings[0]!, /implicitPkOrdering: true/);
  });

  it('does not fire when an orderBy is present', async () => {
    const q = new QueryInterface(stubPool(), 'users', schema(), []);
    const warnings = await captureWarnings(async () => {
      await q.findMany({ limit: 50, orderBy: { email: 'asc' } });
      await q.findMany({ offset: 10, limit: 5, orderBy: [{ email: 'desc' }] });
    });
    assert.equal(warnings.length, 0);
  });

  it('does not fire for an unpaginated query or a distinct shape', async () => {
    const q = new QueryInterface(stubPool(), 'users', schema(), []);
    const warnings = await captureWarnings(async () => {
      await q.findMany();
      await q.findMany({ limit: 5, distinct: ['email'] as never });
      await q.findMany({ cursor: {} as never }); // no defined key: emits no seek at all
    });
    assert.equal(warnings.length, 0);
  });

  it('fires for a cursor seek with no orderBy, naming the cursor field', async () => {
    const q = new QueryInterface(stubPool(), 'users', schema(), []);
    const warnings = await captureWarnings(() => q.findMany({ limit: 5, cursor: { email: 'a@b.c' } as never }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /paginates \(cursor\+limit\)/);
    assert.match(warnings[0]!, /`cursor` seek with no orderBy/);
    // Recommends the CURSOR field, not the primary key, when the two differ.
    assert.match(warnings[0]!, /orderBy: \{ email: 'asc' \}/);
    assert.doesNotMatch(warnings[0]!, /\{ id: 'asc' \}/);
  });

  it('fires for a bare cursor with no limit (a seek is itself pagination)', async () => {
    const q = new QueryInterface(stubPool(), 'users', schema(), []);
    const warnings = await captureWarnings(() => q.findMany({ cursor: { id: 1 } as never }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /paginates \(cursor\)/);
  });

  it('does not fire for a cursor with an explicit orderBy', async () => {
    const q = new QueryInterface(stubPool(), 'users', schema(), []);
    const warnings = await captureWarnings(() =>
      q.findMany({ limit: 5, cursor: { id: 1 } as never, orderBy: { id: 'asc' } }),
    );
    assert.equal(warnings.length, 0);
  });

  it('treats an empty orderBy as no orderBy at all', async () => {
    const q = new QueryInterface(stubPool(), 'users', schema(), []);
    const warnings = await captureWarnings(() => q.findMany({ limit: 5, orderBy: [] }));
    assert.equal(warnings.length, 1);
  });

  it('fires for offset-only pagination and names a composite PK in full', async () => {
    const q = new QueryInterface(stubPool(), 'events', schema(), []);
    const warnings = await captureWarnings(() => q.findMany({ offset: 100 }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /paginates \(offset\)/);
    assert.match(warnings[0]!, /\[\{ orgId: 'asc' \}, \{ seq: 'asc' \}\]/);
  });

  it('falls back to generic advice on a PK-less table', async () => {
    const q = new QueryInterface(stubPool(), 'logs', schema(), []);
    const warnings = await captureWarnings(() => q.findMany({ limit: 10 }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /orderBy` on a unique column/);
  });

  it('honors warnOnUnlimited: a per-call false silences it, a per-call true forces it', async () => {
    const off = new QueryInterface(stubPool(), 'users', schema(), [], { warnOnUnlimited: false });
    assert.equal((await captureWarnings(() => off.findMany({ limit: 10 }))).length, 0);
    assert.equal((await captureWarnings(() => off.findMany({ limit: 10, warnOnUnlimited: true }))).length, 1);

    resetWarnOnce(WARN_NS.unorderedPage);
    const on = new QueryInterface(stubPool(), 'users', schema(), []);
    assert.equal((await captureWarnings(() => on.findMany({ limit: 10, warnOnUnlimited: false }))).length, 0);
    assert.equal((await captureWarnings(() => on.findMany({ limit: 10 }))).length, 1);
  });

  it('is silent under NODE_ENV=production and when implicitPkOrdering is on', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const q = new QueryInterface(stubPool(), 'users', schema(), []);
      assert.equal((await captureWarnings(() => q.findMany({ limit: 10 }))).length, 0);
    } finally {
      process.env.NODE_ENV = prev;
    }
    resetWarnOnce(WARN_NS.unorderedPage);
    const ordered = new QueryInterface(stubPool(), 'users', schema(), [], { implicitPkOrdering: true });
    assert.equal((await captureWarnings(() => ordered.findMany({ limit: 10 }))).length, 0);
  });

  it('still fires with implicitPkOrdering on when nothing is actually injected', async () => {
    // PK-less table: the flag has nothing to order by, so the page stays
    // non-deterministic and the caller needs to hear about it.
    const noPk = new QueryInterface(stubPool(), 'logs', schema(), [], { implicitPkOrdering: true });
    assert.equal((await captureWarnings(() => noPk.findMany({ limit: 10 }))).length, 1);

    resetWarnOnce(WARN_NS.unorderedPage);
    // Multi-field cursor: `a > $1 AND b > $2` is not a composite keyset seek, so
    // no ordering is injected (see cursorOrderBy) and the warning stands.
    const events = new QueryInterface(stubPool(), 'events', schema(), [], { implicitPkOrdering: true });
    const warnings = await captureWarnings(() => events.findMany({ limit: 10, cursor: { orgId: 1, seq: 2 } as never }));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /paginates \(cursor\+limit\)/);
  });
});

describe('implicitPkOrdering (opt-in)', () => {
  it('adds PK-ascending ordering to a paginating query with no orderBy', () => {
    const q = makeQuery('users', schema(), { implicitPkOrdering: true });
    assert.match(q.buildFindMany({ limit: 50 }).sql, /ORDER BY "id" ASC LIMIT \$1/);
    assert.match(q.buildFindMany({ take: 50 }).sql, /ORDER BY "id" ASC LIMIT \$1/);
    assert.match(q.buildFindMany({ offset: 50 }).sql, /ORDER BY "id" ASC OFFSET \$1/);
  });

  it('orders on every column of a composite PK, in declaration order', () => {
    const q = makeQuery('events', schema(), { implicitPkOrdering: true });
    assert.match(q.buildFindMany({ limit: 10 }).sql, /ORDER BY "org_id" ASC, "seq" ASC/);
  });

  it('an explicit orderBy always wins', () => {
    const q = makeQuery('users', schema(), { implicitPkOrdering: true });
    const sql = q.buildFindMany({ limit: 10, orderBy: { email: 'desc' } }).sql;
    assert.match(sql, /ORDER BY "email" DESC/);
    assert.doesNotMatch(sql, /"id" ASC/);
  });

  it('leaves a PK-less table untouched', () => {
    const q = makeQuery('logs', schema(), { implicitPkOrdering: true });
    assert.doesNotMatch(q.buildFindMany({ limit: 10 }).sql, /ORDER BY/);
  });

  it('leaves an unpaginated query untouched', () => {
    const q = makeQuery('users', schema(), { implicitPkOrdering: true });
    assert.doesNotMatch(q.buildFindMany({}).sql, /ORDER BY/);
  });

  it('orders a cursor seek on the CURSOR field, not the primary key', () => {
    const q = makeQuery('users', schema(), { implicitPkOrdering: true });
    // A seek on `email` ordered by `id` would walk the table in an order the
    // seek does not follow, so the injected order matches the cursor field.
    const sql = q.buildFindMany({ limit: 10, cursor: { email: 'a@b.c' } as never }).sql;
    assert.match(sql, /WHERE "users"\."email" > \$1 ORDER BY "email" ASC LIMIT \$2/);
    assert.doesNotMatch(sql, /"id" ASC/);
    // Cursor on the PK: same field either way.
    assert.match(
      q.buildFindMany({ limit: 10, cursor: { id: 1 } as never }).sql,
      /WHERE "users"\."id" > \$1 ORDER BY "id" ASC LIMIT \$2/,
    );
  });

  it('injects nothing for an ambiguous multi-field cursor', () => {
    const q = makeQuery('events', schema(), { implicitPkOrdering: true });
    // `org_id > $1 AND seq > $2` is a conjunction, not `(org_id, seq) > (...)`:
    // no ORDER BY makes that seek sound, so none is invented.
    assert.doesNotMatch(q.buildFindMany({ limit: 10, cursor: { orgId: 1, seq: 2 } as never }).sql, /ORDER BY/);
  });

  it('an explicit orderBy still wins over a cursor seek', () => {
    const q = makeQuery('users', schema(), { implicitPkOrdering: true });
    const sql = q.buildFindMany({ limit: 10, cursor: { id: 1 } as never, orderBy: { email: 'desc' } }).sql;
    assert.match(sql, /ORDER BY "email" DESC/);
    assert.doesNotMatch(sql, /"id" ASC/);
  });

  it('treats an empty orderBy as absent instead of emitting a bare ORDER BY', () => {
    // Regression: `orderBy: []` used to compile to `ORDER BY  LIMIT $1`
    // (syntax error at or near "LIMIT").
    const plain = makeQuery('users', schema());
    assert.equal(plain.buildFindMany({ limit: 10, orderBy: [] }).sql, plain.buildFindMany({ limit: 10 }).sql);
    assert.doesNotMatch(plain.buildFindMany({ limit: 10, orderBy: [] }).sql, /ORDER BY/);
    // An object whose every value is undefined is equally empty.
    assert.doesNotMatch(plain.buildFindMany({ orderBy: { email: undefined } as never }).sql, /ORDER BY/);
    // ...and the implicit-ordering path sees it as absent too.
    const q = makeQuery('users', schema(), { implicitPkOrdering: true });
    assert.match(q.buildFindMany({ limit: 10, orderBy: [] }).sql, /ORDER BY "id" ASC LIMIT \$1/);
  });

  it('with the flag OFF the emitted SQL is byte-identical to the plain build', () => {
    const shapes: Record<string, unknown>[] = [{ limit: 50 }, { take: 10, offset: 5 }, { offset: 7 }, {}];
    for (const table of ['users', 'events', 'logs']) {
      const plain = makeQuery(table, schema());
      const explicitlyOff = makeQuery(table, schema(), { implicitPkOrdering: false });
      for (const args of shapes) {
        const a = plain.buildFindMany(args as never);
        const b = explicitlyOff.buildFindMany(args as never);
        assert.equal(b.sql, a.sql, `${table} ${JSON.stringify(args)}`);
        assert.deepEqual(b.params, a.params);
        assert.doesNotMatch(a.sql, /"id" ASC/);
      }
    }
    // Cursor shapes too (users only: the other fixtures have no such columns).
    const plainUsers = makeQuery('users', schema());
    const offUsers = makeQuery('users', schema(), { implicitPkOrdering: false });
    for (const args of [{ limit: 5, cursor: { id: 1 } }, { cursor: { email: 'a@b.c' } }]) {
      const a = plainUsers.buildFindMany(args as never);
      const b = offUsers.buildFindMany(args as never);
      assert.equal(b.sql, a.sql, JSON.stringify(args));
      assert.deepEqual(b.params, a.params);
      assert.doesNotMatch(a.sql, /ORDER BY/);
    }
  });
});

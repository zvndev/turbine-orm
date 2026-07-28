/**
 * The three PRIVILEGE options and the UNSAFE sentinel that gates them.
 *
 * The bug: `skipGlobalFilters`, `includePii` and `allowFullTableScan` are
 * ordinary siblings of `where` on the query-args object, so a handler written
 * as `findMany({ ...req.body })` let a REQUEST BODY turn them on. The verified
 * reproduction is the first test below: the same call, plus one JSON key, and
 * the tenant predicate is gone from the emitted SQL.
 *
 * The fix is a symbol. `JSON.parse` cannot produce one, so the escalation is
 * structurally impossible rather than discouraged, and a literal `true` THROWS
 * (E003) instead of being ignored, so a stale legitimate caller gets an
 * immediate error rather than silently-narrower results.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { createPrismaCompatClient } from '../prisma-compat.js';
import { unlockNestedWriteTx } from '../query/builder.js';
import type { GlobalFilters, QueryInterfaceOptions } from '../query/index.js';
import { UNSAFE } from '../query/index.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

/** users (with a PII-tagged column) + posts, enough for every flag. */
function schema(): SchemaMetadata {
  const users = mockTable(
    'users',
    [
      { name: 'id', field: 'id' },
      { name: 'name', field: 'name', pgType: 'text' },
      { name: 'email', field: 'email', pgType: 'text' },
      { name: 'tenant_id', field: 'tenantId', pgType: 'text' },
    ],
    {
      posts: { type: 'hasMany', name: 'posts', from: 'users', to: 'posts', foreignKey: 'user_id', referenceKey: 'id' },
    },
  );
  users.primaryKey = ['id'];
  const emailCol = users.columns.find((c) => c.name === 'email');
  if (emailCol) emailCol.pii = true;

  const posts = mockTable('posts', [
    { name: 'id', field: 'id' },
    { name: 'user_id', field: 'userId' },
    { name: 'title', field: 'title', pgType: 'text' },
  ]);
  posts.primaryKey = ['id'];
  return { enums: {}, tables: { users, posts } };
}

const TENANT_FILTER: GlobalFilters = { users: { tenantId: 't1' }, posts: { tenantId: 't1' } };

function usersQuery(options?: QueryInterfaceOptions) {
  return makeQuery('users', schema(), { globalFilters: TENANT_FILTER, ...options });
}

/**
 * The attacker's channel: a parsed request body. Everything an attacker can
 * put on the args object goes through here, which is the entire point of the
 * symbol (this function cannot return one).
 */
function requestBody(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The reproduction
// ---------------------------------------------------------------------------

describe('privilege flags: the mass-assignment escalation is structurally impossible', () => {
  it('a spread request body cannot remove the tenant filter (the verified reproduction)', () => {
    const normal = usersQuery().buildFindMany({ where: { name: 'x' } });
    assert.match(normal.sql, /"tenant_id"/, 'baseline: the global filter is in the SQL');

    // The attack: one extra JSON key on the same handler.
    const attack = requestBody('{"where":{"name":"x"},"skipGlobalFilters":true}');
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: the whole point is that this is untyped at the boundary
      () => usersQuery().buildFindMany(attack as any),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.equal(err.code, 'TURBINE_E003');
        assert.match(err.message, /skipGlobalFilters/);
        return true;
      },
      'a JSON-carried `true` must be refused, not honored and not ignored',
    );
  });

  it('the named-table array form is refused too (it is the same breach, one step longer)', () => {
    const attack = requestBody('{"where":{"name":"x"},"skipGlobalFilters":["users"]}');
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: untyped boundary
      () => usersQuery().buildFindMany(attack as any),
      /must be the `UNSAFE` symbol/,
    );
  });

  it('a spread request body cannot unlock the PII projection', () => {
    const normal = usersQuery().buildFindMany({});
    assert.doesNotMatch(normal.sql, /"email"/, 'baseline: the PII column is excluded');

    const attack = requestBody('{"includePii":true}');
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: untyped boundary
      () => usersQuery().buildFindMany(attack as any),
      /`includePii` must be the `UNSAFE` symbol/,
    );
  });

  it('a spread request body cannot disarm the empty-where mass-mutation guard', () => {
    const attack = requestBody('{"where":{},"data":{"name":"pwned"},"allowFullTableScan":true}');
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: untyped boundary
      () => usersQuery().buildUpdateMany(attack as any),
      /`allowFullTableScan` must be the `UNSAFE` symbol/,
    );
  });

  it('a literal true is refused even when the mutation HAS a predicate (never silently accepted)', () => {
    // The guard itself would not fire here, so an escalation attempt on a
    // normal request would otherwise go completely unreported.
    assert.throws(
      () =>
        usersQuery().buildUpdateMany({
          where: { id: 1 },
          data: { name: 'x' },
          allowFullTableScan: true as unknown as typeof UNSAFE,
        }),
      /`allowFullTableScan` must be the `UNSAFE` symbol/,
    );
  });

  it('the refusal names the option and shows the import, so the fix is in the message', () => {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: untyped boundary
      usersQuery().buildFindMany(requestBody('{"includePii":true}') as any);
      assert.fail('expected a refusal');
    } catch (err) {
      const message = (err as Error).message;
      assert.match(message, /includePii/);
      assert.match(message, /import \{ UNSAFE \} from 'turbine-orm'/);
      assert.match(message, /received true/);
    }
  });
});

// ---------------------------------------------------------------------------
// The sentinel still does its job
// ---------------------------------------------------------------------------

describe('privilege flags: UNSAFE unlocks each option exactly as the boolean used to', () => {
  it('skipGlobalFilters: UNSAFE drops the tenant predicate', () => {
    const { sql } = usersQuery().buildFindMany({ where: { name: 'x' }, skipGlobalFilters: UNSAFE });
    // Assert on the PREDICATE, not the whole statement: `tenant_id` is still a
    // projected column (the PII-tagged schema forces an explicit column list).
    const predicate = sql.slice(sql.indexOf('WHERE'));
    assert.doesNotMatch(predicate, /"tenant_id"/);
    assert.match(predicate, /"name"/);
  });

  it('skipGlobalFilters: [UNSAFE, table] drops it on the named table only', () => {
    const { sql } = usersQuery().buildFindMany({
      where: { name: 'x' },
      with: { posts: true },
      skipGlobalFilters: [UNSAFE, 'posts'],
    });
    assert.match(sql, /"users"\."tenant_id"|"tenant_id" = \$/, 'own table keeps its filter');
    const postsSubquery = sql.slice(sql.indexOf('posts'));
    assert.doesNotMatch(postsSubquery, /t0\."tenant_id"/, 'the named relation target skips its filter');
  });

  it('includePii: UNSAFE returns the PII column', () => {
    const { sql } = usersQuery().buildFindMany({ includePii: UNSAFE });
    assert.match(sql, /"users"\.\*/, 'the opted-in projection is the plain `*` shape');
  });

  it('allowFullTableScan: UNSAFE lets a deliberate unconditional mutation through', () => {
    // The global filter is still applied (it never satisfied the guard and is
    // not disabled by it); what the flag unlocks is the empty USER predicate.
    const { sql } = usersQuery().buildDeleteMany({ where: {}, allowFullTableScan: UNSAFE });
    assert.equal(sql, 'DELETE FROM "users" WHERE "tenant_id" = $1');
    const unfiltered = makeQuery('users', schema()).buildDeleteMany({ where: {}, allowFullTableScan: UNSAFE });
    assert.equal(unfiltered.sql, 'DELETE FROM "users"');
  });
});

// ---------------------------------------------------------------------------
// Falsy values, and the identity of the symbol itself
// ---------------------------------------------------------------------------

describe('privilege flags: an off flag is a no-op, not a refusal', () => {
  it('false / null / undefined mean "not enabled" and do not throw', () => {
    for (const off of [false, null, undefined]) {
      const { sql } = usersQuery().buildFindMany({
        where: { name: 'x' },
        skipGlobalFilters: off as unknown as typeof UNSAFE,
        includePii: off as unknown as typeof UNSAFE,
      });
      assert.match(sql, /"tenant_id"/, `skipGlobalFilters: ${String(off)} must leave the filter in place`);
      assert.doesNotMatch(sql, /"email"/, `includePii: ${String(off)} must leave PII excluded`);
    }
  });

  it('a different symbol is refused (only THIS sentinel counts)', () => {
    assert.throws(
      () => usersQuery().buildFindMany({ includePii: Symbol('includePii') as unknown as typeof UNSAFE }),
      /received a different symbol/,
    );
  });
});

describe('privilege flags: the sentinel survives a dual-package install', () => {
  it('UNSAFE is the global-registry symbol, so the ESM and CJS copies agree', () => {
    // A plain Symbol() would be a distinct value in each built copy of the
    // package, and a consumer importing UNSAFE from one while calling into the
    // other would have every privileged call refused.
    assert.equal(UNSAFE, Symbol.for('turbine-orm.UNSAFE'));
    assert.equal(typeof UNSAFE, 'symbol');
  });

  it('the sentinel cannot round-trip through JSON in any form', () => {
    assert.equal(JSON.stringify({ skipGlobalFilters: UNSAFE }), '{}');
    assert.equal(JSON.parse(JSON.stringify({ includePii: UNSAFE })).includePii, undefined);
  });
});

// ---------------------------------------------------------------------------
// Coverage across the operation surface (one missed entry point is the bug)
// ---------------------------------------------------------------------------

describe('privilege flags: every operation that declares an option enforces it', () => {
  const attempts: [string, () => unknown][] = [
    ['findMany', () => usersQuery().buildFindMany({ includePii: true as unknown as typeof UNSAFE })],
    [
      'findUnique',
      () => usersQuery().buildFindUnique({ where: { id: 1 }, includePii: true as unknown as typeof UNSAFE }),
    ],
    ['count', () => usersQuery().buildCount({ skipGlobalFilters: true as unknown as typeof UNSAFE })],
    ['aggregate', () => usersQuery().buildAggregate({ _count: true, includePii: true as unknown as typeof UNSAFE })],
    ['groupBy', () => usersQuery().buildGroupBy({ by: ['name'], includePii: true as unknown as typeof UNSAFE })],
    [
      'update',
      () =>
        usersQuery().buildUpdate({
          where: { id: 1 },
          data: { name: 'x' },
          allowFullTableScan: true as unknown as typeof UNSAFE,
        }),
    ],
    [
      'updateMany',
      () =>
        usersQuery().buildUpdateMany({
          where: { id: 1 },
          data: { name: 'x' },
          allowFullTableScan: true as unknown as typeof UNSAFE,
        }),
    ],
    [
      'delete',
      () => usersQuery().buildDelete({ where: { id: 1 }, allowFullTableScan: true as unknown as typeof UNSAFE }),
    ],
    [
      'deleteMany',
      () => usersQuery().buildDeleteMany({ where: { id: 1 }, allowFullTableScan: true as unknown as typeof UNSAFE }),
    ],
    [
      'upsert',
      () =>
        usersQuery().buildUpsert({
          where: { id: 1 },
          create: { id: 1 },
          update: { name: 'x' },
          skipGlobalFilters: true as unknown as typeof UNSAFE,
        }),
    ],
  ];

  for (const [name, run] of attempts) {
    it(`${name} refuses a literal true`, () => {
      assert.throws(run, ValidationError, `${name} accepted a plain boolean privilege flag`);
    });
  }
});

// ---------------------------------------------------------------------------
// The prisma-compat surface is the same surface
// ---------------------------------------------------------------------------

describe('privilege flags: prisma-compat forwards them, and core is the single judge', () => {
  // biome-ignore lint/suspicious/noExplicitAny: test harness plumbing
  type Any = any;

  /**
   * A compat client over REAL QueryInterfaces (null pool). A refused call
   * throws ValidationError during the build; an accepted one gets past the
   * build and dies on the absent pool, which is how these tests tell "refused"
   * from "honored" without a database.
   */
  function compat() {
    const sch = schema();
    const db = { schema: sch, table: (t: string) => makeQuery(t, sch, { globalFilters: TENANT_FILTER }) };
    return createPrismaCompatClient<{ User: { Row: { id: number; name: string } } }>(db as unknown as TurbineClient, {
      enums: {},
      models: {
        User: {
          table: 'users',
          accessor: 'users',
          fields: { id: 'id', name: 'name', email: 'email', tenantId: 'tenantId' },
          relations: {},
          compoundUniques: {},
        },
      },
    }) as Any;
  }

  it('a Prisma-shaped args object carrying `true` gets the same refusal', async () => {
    await assert.rejects(
      () => compat().User.findMany({ where: { name: 'x' }, skipGlobalFilters: true }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError, `expected E003, got ${String(err)}`);
        assert.match((err as Error).message, /must be the `UNSAFE` symbol/);
        return true;
      },
      'compat must not launder a plain boolean into core',
    );
  });

  it('a compat caller can still legitimately opt in with the sentinel', async () => {
    // Gets PAST validation and fails on the null pool instead: proof the
    // sentinel survived the translation rather than being stripped.
    await assert.rejects(
      () => compat().User.findMany({ where: { name: 'x' }, skipGlobalFilters: UNSAFE }),
      (err: unknown) => {
        assert.ok(!(err instanceof ValidationError), `sentinel was refused: ${String(err)}`);
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// The one internal caller that legitimately needs the flag
// ---------------------------------------------------------------------------

describe('privilege flags: the nested-write bridge keeps relation `set` working', () => {
  it('rewrites updateMany({ allowFullTableScan: true }) into the sentinel, and touches nothing else', () => {
    // nested-write.ts clears a `set` relation with an INTERNAL, fully-derived
    // FK predicate plus `allowFullTableScan: true`. Without this bridge every
    // nested `set` would throw the privilege refusal.
    const seen: Record<string, unknown>[] = [];
    const handle = {
      updateMany(args: Record<string, unknown>) {
        seen.push(args);
        return { count: 0 };
      },
      update(args: Record<string, unknown>) {
        seen.push(args);
        return {};
      },
    };
    const wrapped = unlockNestedWriteTx({ table: (_name: string) => handle as Record<string, unknown> });

    (wrapped.table('posts').updateMany as (a: Record<string, unknown>) => unknown)({
      where: { userId: 1 },
      data: { userId: null },
      allowFullTableScan: true,
    });
    assert.equal(seen[0]?.allowFullTableScan, UNSAFE, 'the internal `true` must become the sentinel');
    assert.deepEqual(seen[0]?.where, { userId: 1 }, 'nothing else about the call changes');

    // Narrow by design: no other operation gains an escape hatch, and a call
    // that never asked for the flag is passed through untouched.
    (wrapped.table('posts').update as (a: Record<string, unknown>) => unknown)({
      where: { id: 1 },
      data: { title: 'x' },
      allowFullTableScan: true,
    });
    assert.equal(seen[1]?.allowFullTableScan, true, 'update is not rewritten');
    (wrapped.table('posts').updateMany as (a: Record<string, unknown>) => unknown)({
      where: { id: 1 },
      data: { title: 'x' },
    });
    assert.equal('allowFullTableScan' in (seen[2] ?? {}), false, 'no flag is invented');
  });
});

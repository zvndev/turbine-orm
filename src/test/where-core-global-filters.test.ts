/**
 * Global filters fail closed. A filter that resolves to `undefined`, or holds an
 * `undefined` anywhere inside it, throws E003 at every place a filter is read:
 * the query's own table, relation subqueries, relation filters, relation
 * `_count` and ordering, and every mutation. It used to be dropped, so a
 * request whose tenant context was missing (`{ tenantId: undefined }`) read and
 * wrote every tenant's rows.
 *
 * `null` and `{}` stay the explicit "no filter for this call" values: neither
 * is what a missing value produces.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { GlobalFilters } from '../query/index.js';
import { UNSAFE } from '../query/types.js';
import { resolveGlobalFilterFrom } from '../query/where.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';
import { accounts } from './where-core-fixture.js';

const HOLE = /Global filter for "(accounts|posts)" has an undefined value at "tenantId"/;

function tenantScoped(table: 'accounts' | 'posts', tenant: () => number | undefined) {
  return accounts({ globalFilters: { [table]: () => ({ tenantId: tenant() }) } });
}

describe('fail closed on the query table', () => {
  const q = tenantScoped('accounts', () => undefined);
  const ops: [string, () => unknown][] = [
    ['findMany', () => q.buildFindMany({ where: { age: 1 } } as never)],
    ['findFirst', () => q.buildFindFirst({ where: { age: 1 } } as never)],
    ['findUnique', () => q.buildFindUnique({ where: { id: 1 } } as never)],
    ['count', () => q.buildCount({} as never)],
    ['aggregate', () => q.buildAggregate({ _sum: { age: true } } as never)],
    ['groupBy', () => q.buildGroupBy({ by: ['age'], _count: true } as never)],
    ['update', () => q.buildUpdate({ where: { id: 1 }, data: { age: 2 } } as never)],
    ['updateMany', () => q.buildUpdateMany({ where: { age: 1 }, data: { age: 2 } } as never)],
    ['delete', () => q.buildDelete({ where: { id: 1 } } as never)],
    ['deleteMany', () => q.buildDeleteMany({ where: { age: 1 } } as never)],
    ['upsert', () => q.buildUpsert({ where: { id: 1 }, create: { id: 1, age: 1 }, update: { age: 2 } } as never)],
  ];
  for (const [label, run] of ops) {
    it(label, () => {
      assert.throws(run, (err: unknown) => {
        assert.ok(err instanceof ValidationError, `${label}: got ${String(err)}`);
        assert.match(err.message, HOLE);
        assert.match(err.message, /skipGlobalFilters: UNSAFE/);
        return true;
      });
    });
  }
});

describe('fail closed on a relation target', () => {
  const q = tenantScoped('posts', () => undefined);
  const ops: [string, () => unknown][] = [
    ['with subquery', () => q.buildFindMany({ with: { posts: true } } as never)],
    ['relation filter', () => q.buildFindMany({ where: { posts: { some: { views: 1 } } } } as never)],
    ['relation _count', () => q.buildFindMany({ with: { _count: { posts: true } } } as never)],
    ['relation _count ordering', () => q.buildFindMany({ orderBy: { posts: { _count: 'desc' } } } as never)],
  ];
  for (const [label, run] of ops) {
    it(label, () => assert.throws(run, HOLE));
  }
});

describe('what still means "no filter"', () => {
  it('skipGlobalFilters: UNSAFE, whole query and per table', () => {
    const q = tenantScoped('accounts', () => undefined);
    assert.doesNotThrow(() => q.buildFindMany({ skipGlobalFilters: UNSAFE } as never));
    const r = tenantScoped('posts', () => undefined);
    const { sql } = r.buildFindMany({ with: { posts: true }, skipGlobalFilters: [UNSAFE, 'posts'] } as never);
    assert.doesNotMatch(sql, /tenant_id" = \$/);
  });

  for (const [label, filter] of [
    ['a function returning null', () => null],
    ['a function returning {}', () => ({})],
    ['a static null', null],
    ['a static {}', {}],
  ] as const) {
    it(label, () => {
      const q = accounts({ globalFilters: { accounts: filter } as unknown as GlobalFilters });
      const { sql } = q.buildFindMany({ where: { age: 1 } } as never);
      assert.doesNotMatch(sql, /tenant_id" = \$/);
    });
  }

  it('a present tenant filters as before', () => {
    const { sql, params } = tenantScoped('accounts', () => 7).buildFindMany({ where: { age: 1 } } as never);
    assert.match(sql, /"tenant_id" = \$2/);
    assert.deepEqual(params.slice(0, 2), [1, 7]);
  });
});

describe('the resolution rule', () => {
  const resolve = (filter: unknown) =>
    resolveGlobalFilterFrom({ accounts: filter } as unknown as GlobalFilters, 'accounts', undefined);

  it('a filter resolving to undefined', () => {
    assert.throws(() => resolve(() => undefined), /Global filter for "accounts" resolved to undefined/);
  });

  it('an undefined deep inside, reported by key path only', () => {
    assert.throws(
      () => resolve({ tenantId: { in: [1, undefined] }, region: 'secret-region' }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /undefined value at "tenantId\.in\[1\]"/);
        assert.ok(!err.message.includes('secret-region'), 'values never reach the message');
        return true;
      },
    );
    assert.throws(() => resolve({ OR: [{ tenantId: 1 }, { orgId: undefined }] }), /at "OR\[1\]\.orgId"/);
  });

  it('a filter that is not a where object', () => {
    assert.throws(() => resolve(() => 5), /must be a where object \(or a function returning one\), received number/);
    assert.throws(() => resolve(() => [{ tenantId: 1 }]), /received an array/);
  });

  it('a table with no filter configured', () => {
    assert.equal(resolveGlobalFilterFrom({ posts: { tenantId: 1 } }, 'accounts', undefined), null);
    assert.equal(resolveGlobalFilterFrom({ posts: { tenantId: 1 } }, 'toString', undefined), null);
  });
});

// ---------------------------------------------------------------------------
// Live: a missing tenant reads and writes nothing.
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
const live = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

async function runSql(statements: string[]): Promise<{ rows: Record<string, unknown>[] }[]> {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const out: { rows: Record<string, unknown>[] }[] = [];
  try {
    for (const sql of statements) out.push(await pool.query(sql));
  } finally {
    await pool.end();
  }
  return out;
}

describe('live: a missing tenant context', () => {
  let db: TurbineClient;
  let schema: SchemaMetadata;
  let tenant: number | undefined;

  live.before(async () => {
    await runSql([
      'DROP TABLE IF EXISTS wc_gf_notes, wc_gf_items',
      'CREATE TABLE wc_gf_items (id int PRIMARY KEY, tenant_id int NOT NULL, name text NOT NULL)',
      'CREATE TABLE wc_gf_notes (id int PRIMARY KEY, item_id int NOT NULL REFERENCES wc_gf_items(id), tenant_id int NOT NULL)',
      "INSERT INTO wc_gf_items VALUES (1, 1, 'a1'), (2, 1, 'a2'), (3, 2, 'b1')",
      'INSERT INTO wc_gf_notes VALUES (1, 1, 1), (2, 3, 2)',
    ]);
    schema = await introspect({ connectionString: DATABASE_URL!, include: ['wc_gf_items', 'wc_gf_notes'] });
    db = new TurbineClient(
      {
        connectionString: DATABASE_URL!,
        poolSize: 2,
        warnOnUnlimited: false,
        globalFilters: {
          wcGfItems: () => ({ tenantId: tenant }),
          wcGfNotes: () => ({ tenantId: tenant }),
        },
      },
      schema,
    );
  });

  live.after(async () => {
    await db?.disconnect();
    await runSql(['DROP TABLE IF EXISTS wc_gf_notes, wc_gf_items']);
  });

  live.it('reads and mutations refuse; no row changes', async () => {
    tenant = undefined;
    const items = db.table('wc_gf_items');
    await assert.rejects(items.findMany({} as never), HOLE_LIVE);
    await assert.rejects(items.count({} as never), HOLE_LIVE);
    await assert.rejects(items.updateMany({ where: { name: { not: 'x' } }, data: { name: 'x' } } as never), HOLE_LIVE);
    await assert.rejects(items.deleteMany({ where: { id: { gt: 0 } } } as never), HOLE_LIVE);
    const [all] = await runSql(['SELECT id, name FROM wc_gf_items ORDER BY id']);
    assert.deepEqual(all!.rows, [
      { id: 1, name: 'a1' },
      { id: 2, name: 'a2' },
      { id: 3, name: 'b1' },
    ]);
  });

  live.it('the batched loader resolves the relation target filter itself', async () => {
    tenant = undefined;
    const notesOnly = new TurbineClient(
      {
        connectionString: DATABASE_URL!,
        poolSize: 1,
        warnOnUnlimited: false,
        globalFilters: { wcGfNotes: () => ({ tenantId: tenant }) },
      },
      schema,
    );
    try {
      const relation = Object.keys(schema.tables.wc_gf_items!.relations)[0]!;
      const items = notesOnly.table('wc_gf_items');
      await assert.rejects(
        items.findMany({ with: { [relation]: true }, relationLoadStrategy: 'batched' } as never),
        /Global filter for "wc_gf_notes" has an undefined value at "tenantId"/,
      );
      tenant = 1;
      const rows = (await items.findMany({
        with: { [relation]: true },
        relationLoadStrategy: 'batched',
        orderBy: { id: 'asc' },
      } as never)) as Record<string, unknown>[];
      assert.deepEqual(
        rows.map((r) => (r[relation] as unknown[]).length),
        [1, 0, 0],
        'tenant 1 sees its own note only',
      );
    } finally {
      await notesOnly.disconnect();
    }
  });

  live.it('a present tenant sees only its rows', async () => {
    tenant = 2;
    const rows = (await db.table('wc_gf_items').findMany({ orderBy: { id: 'asc' } } as never)) as { id: number }[];
    assert.deepEqual(
      rows.map((r) => r.id),
      [3],
    );
  });
});

const HOLE_LIVE = /Global filter for "wc_gf_(items|notes)" has an undefined value at "tenantId"/;

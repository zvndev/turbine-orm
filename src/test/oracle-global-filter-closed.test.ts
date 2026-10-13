/**
 * Oracle 8: global filters fail closed.
 *
 * A tenant filter is a security boundary. Its value comes from request context,
 * and context goes missing: a background job, a route that skipped the auth
 * middleware, an AsyncLocalStorage store that was never entered. When the filter
 * function then returns `{ tenantId: undefined }` the right outcome is a typed
 * error, not "no filter".
 *
 * Two halves, both checked against raw SQL:
 *
 *   undefined tenant   every read and write method that applies the filter must
 *                      throw a typed ValidationError (E003) naming the table, even
 *                      on a SQL-cache hit (each method is warmed with a defined
 *                      tenant first), and a write that throws must leave every row
 *                      as it was. Four ways of resolving to "nothing" are tried.
 *   defined tenant     every method sees and touches only that tenant's rows. The
 *                      child table carries rows of OTHER tenants on each parent
 *                      ("strays"), so a relation subquery that forgets the child's
 *                      filter shows up as a wrong child list.
 *
 * `create` and `createMany` are never filtered (they have no WHERE), so they are
 * not asserted here.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/oracle-global-filter-closed.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import type pg from 'pg';
import { TurbineClient } from '../client.js';
import { UNSAFE } from '../query/index.js';
import { skipGate } from './helpers.js';
import { DATABASE_URL, SKIP } from './oracle/env.js';
import { Failures } from './oracle/failures.js';
import { dumpJson, ids, rawReader, rawWriter, runScript } from './oracle/raw.js';
import {
  attempt,
  describeError,
  introspectTables,
  makeClient,
  type OracleClient,
  show,
  stable,
} from './oracle/util.js';

const FILE = 'oracle-global-filter-closed.test.ts';
const { it, before, after } = skipGate(SKIP, 'DATABASE_URL not set');

const DOCS = 'orc_g_docs';
const NOTES = 'orc_g_notes';

const DDL = `
DROP TABLE IF EXISTS ${NOTES}, ${DOCS} CASCADE;
CREATE TABLE ${DOCS} (
  id int PRIMARY KEY,
  tenant_id int NOT NULL,
  title text NOT NULL,
  score int
);
CREATE TABLE ${NOTES} (
  id int PRIMARY KEY,
  doc_id int NOT NULL REFERENCES ${DOCS}(id) ON DELETE CASCADE,
  tenant_id int NOT NULL,
  body text NOT NULL
);
CREATE INDEX ON ${NOTES}(doc_id);
`;

/** 12 docs, 4 per tenant. Each doc has two notes of its own tenant and one stray from the next tenant. */
function seedSql(): string {
  const out = [`TRUNCATE ${NOTES}, ${DOCS};`];
  let noteId = 1;
  for (let id = 1; id <= 12; id++) {
    const tenant = Math.floor((id - 1) / 4) + 1;
    out.push(`INSERT INTO ${DOCS} VALUES (${id}, ${tenant}, 'doc ${id}', ${id * 10});`);
    for (const body of ['a', 'b']) out.push(`INSERT INTO ${NOTES} VALUES (${noteId++}, ${id}, ${tenant}, '${body}');`);
    out.push(`INSERT INTO ${NOTES} VALUES (${noteId++}, ${id}, ${(tenant % 3) + 1}, 'stray');`);
  }
  return out.join('\n');
}

const OTHER_TENANT_IDS = [1, 2, 3, 4, 9, 10, 11, 12];

/** What the filter function returns; swapped per test. */
let resolveTenant: () => unknown = () => ({ tenantId: 2 });
const asTenant = (tenant: number): void => {
  resolveTenant = () => ({ tenantId: tenant });
};

let db: OracleClient;
let reader: pg.Client;
let writer: pg.Client;
let schema: Awaited<ReturnType<typeof introspectTables>>;

const docs = () => db.t(DOCS);

interface Method {
  name: string;
  write: boolean;
  run: () => Promise<unknown>;
}

const collect = async (iter: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const item of iter) out.push(item);
  return out;
};

const METHODS: Method[] = [
  { name: 'findMany', write: false, run: () => docs().findMany({ orderBy: { id: 'asc' } }) },
  { name: 'findFirst', write: false, run: () => docs().findFirst({ orderBy: { id: 'asc' } }) },
  { name: 'findFirstOrThrow', write: false, run: () => docs().findFirstOrThrow({ orderBy: { id: 'asc' } }) },
  { name: 'findUnique', write: false, run: () => docs().findUnique({ where: { id: 5 } }) },
  { name: 'findUniqueOrThrow', write: false, run: () => docs().findUniqueOrThrow({ where: { id: 5 } }) },
  { name: 'count', write: false, run: () => docs().count() },
  { name: 'aggregate', write: false, run: () => docs().aggregate({ _count: true, _sum: { score: true } }) },
  { name: 'groupBy', write: false, run: () => docs().groupBy({ by: ['tenantId'], _count: true }) },
  { name: 'findManyStream', write: false, run: () => collect(docs().findManyStream({ orderBy: { id: 'asc' } })) },
  {
    name: 'findManyStreamBatches',
    write: false,
    run: () => collect(docs().findManyStreamBatches({ orderBy: { id: 'asc' } })),
  },
  {
    name: 'findMany with a child table (the child filter)',
    write: false,
    run: () => docs().findMany({ orderBy: { id: 'asc' }, with: { notes: { orderBy: { id: 'asc' } } } }),
  },
  {
    name: 'findMany with a relation filter',
    write: false,
    run: () => docs().findMany({ where: { notes: { some: { body: 'a' } } }, orderBy: { id: 'asc' } }),
  },
  { name: 'buildFindMany', write: false, run: async () => docs().buildFindMany({ orderBy: { id: 'asc' } }) },
  { name: 'buildCount', write: false, run: async () => docs().buildCount() },
  {
    name: 'findMany inside $transaction',
    write: false,
    run: () => db.$transaction(async (tx) => tx.table(DOCS).findMany({ orderBy: { id: 'asc' } })),
  },
  { name: 'update', write: true, run: () => docs().update({ where: { id: 5 }, data: { title: 'W' } }) },
  {
    name: 'updateMany',
    write: true,
    run: () => docs().updateMany({ where: { score: { gte: 0 } }, data: { title: 'W' } }),
  },
  { name: 'delete', write: true, run: () => docs().delete({ where: { id: 5 } }) },
  { name: 'deleteMany', write: true, run: () => docs().deleteMany({ where: { score: { gte: 0 } } }) },
  {
    name: 'upsert',
    write: true,
    run: () => docs().upsert({ where: { id: 5 }, create: { id: 5, tenantId: 2, title: 'C' }, update: { title: 'W' } }),
  },
  {
    name: 'updateMany inside $transaction',
    write: true,
    run: () =>
      db.$transaction(async (tx) => tx.table(DOCS).updateMany({ where: { score: { gte: 0 } }, data: { title: 'W' } })),
  },
];

async function state(): Promise<string> {
  return stable({
    docs: await dumpJson(reader, DOCS),
    notes: await dumpJson(reader, NOTES),
  });
}

describe('oracle: global filters fail closed and scope every method', () => {
  before(async () => {
    await runScript(DATABASE_URL!, DDL + seedSql());
    schema = await introspectTables(DATABASE_URL!, [DOCS, NOTES], {
      [DOCS]: { orcGNotes: 'notes' },
      [NOTES]: { orcGDoc: 'doc' },
    });
    db = makeClient(DATABASE_URL!, schema, {
      globalFilters: { [DOCS]: () => resolveTenant(), [NOTES]: () => resolveTenant() } as never,
    });
    reader = await rawReader(DATABASE_URL!);
    writer = await rawWriter(DATABASE_URL!);
  });

  after(async () => {
    await db?.disconnect();
    await reader?.end();
    await writer?.end();
    if (!SKIP) await runScript(DATABASE_URL!, `DROP TABLE IF EXISTS ${NOTES}, ${DOCS} CASCADE`);
  });

  const RESOLUTIONS: [string, () => unknown][] = [
    ['filter returns { tenantId: undefined }', () => ({ tenantId: undefined })],
    ['filter returns undefined', () => undefined],
    ['filter returns { tenantId: { equals: undefined } }', () => ({ tenantId: { equals: undefined } })],
    [
      'filter returns { OR: [{ tenantId: undefined }, { tenantId: 1 }] }',
      () => ({ OR: [{ tenantId: undefined }, { tenantId: 1 }] }),
    ],
  ];

  for (const [label, resolution] of RESOLUTIONS) {
    it(`${label}: every method throws a typed E003 and writes change nothing`, async () => {
      const failures = new Failures(FILE, 2);
      await writer.query(seedSql());
      const initial = await state();

      for (const method of METHODS) {
        // Warm the SQL cache with a defined tenant so the empty one meets a template that already exists.
        asTenant(2);
        await attempt(method.run);
        if (method.write) await writer.query(seedSql());

        resolveTenant = resolution;
        failures.checked(2);
        const run = await attempt(method.run);
        asTenant(2);
        const after = await state();

        if (run.ok) {
          failures.add(
            `${method.name}: ran without a tenant filter`,
            `filter resolved to nothing, yet the call returned ${stable(run.value).slice(0, 160)}`,
          );
        } else {
          const err = run.error as { code?: string; message?: string };
          if (err.code !== 'TURBINE_E003') {
            failures.add(`${method.name}: threw something other than a typed E003`, describeError(run.error));
          } else if (!String(err.message).includes(DOCS) && !String(err.message).includes(NOTES)) {
            failures.add(`${method.name}: the error does not name the table`, describeError(run.error));
          }
        }
        if (after !== initial) {
          failures.add(
            `${method.name}: changed rows although the tenant was missing`,
            `${method.write ? 'write' : 'read'} left the tables different from the start`,
          );
          await writer.query(seedSql());
        }
      }
      failures.assertClean(label, METHODS.length * 2);
    });
  }

  it('a defined tenant: every read method returns only that tenant, children included', async () => {
    const failures = new Failures(FILE, 3);
    asTenant(2);
    const tenantDocs = await ids(reader, `SELECT id FROM ${DOCS} WHERE tenant_id = 2 ORDER BY id`);
    const sum = Number(
      ((await reader.query(`SELECT sum(score) AS s FROM ${DOCS} WHERE tenant_id = 2`)).rows[0] as { s: string }).s,
    );
    const notesOf = async (docId: number): Promise<number[]> =>
      ids(reader, `SELECT id FROM ${NOTES} WHERE doc_id = ${docId} AND tenant_id = 2 ORDER BY id`);

    const check = async (
      name: string,
      run: () => Promise<unknown>,
      verify: (value: unknown) => string | null,
    ): Promise<void> => {
      failures.checked();
      const result = await attempt(run);
      if (!result.ok) {
        failures.add(`${name}: threw`, describeError(result.error));
        return;
      }
      const problem = verify(result.value);
      if (problem) failures.add(`${name}: ${problem}`, `tenant 2 owns docs ${tenantDocs.join(',')}`);
    };
    const idsOf = (rows: unknown): number[] => (rows as { id: number }[]).map((r) => r.id);
    const expectIds = (want: number[]) => (value: unknown) =>
      stable(idsOf(value)) === stable(want) ? null : `returned ids ${stable(idsOf(value))}, expected ${stable(want)}`;

    await check('findMany', () => docs().findMany({ orderBy: { id: 'asc' } }), expectIds(tenantDocs));
    await check(
      'findFirst',
      () => docs().findFirst({ orderBy: { id: 'asc' } }),
      (v) => ((v as { id: number }).id === 5 ? null : `returned id ${(v as { id: number }).id}`),
    );
    await check(
      'findFirstOrThrow',
      () => docs().findFirstOrThrow({ orderBy: { id: 'asc' } }),
      (v) => ((v as { id: number }).id === 5 ? null : `returned id ${(v as { id: number }).id}`),
    );
    await check(
      'findUnique (own row)',
      () => docs().findUnique({ where: { id: 5 } }),
      (v) => ((v as { id: number } | null)?.id === 5 ? null : "did not find the tenant's own row"),
    );
    await check(
      "findUnique (another tenant's row)",
      () => docs().findUnique({ where: { id: 1 } }),
      (v) => (v === null ? null : `returned tenant ${(v as { tenantId: number }).tenantId}'s row`),
    );
    await check(
      "findUniqueOrThrow (another tenant's row)",
      async () => (await attempt(() => docs().findUniqueOrThrow({ where: { id: 1 } }))).ok,
      (v) => (v === false ? null : "found another tenant's row"),
    );
    await check(
      'count',
      () => docs().count(),
      (v) => (v === tenantDocs.length ? null : `counted ${v}, expected ${tenantDocs.length}`),
    );
    await check(
      'count with a user filter',
      () => docs().count({ where: { score: { gte: 0 } } }),
      (v) => (v === tenantDocs.length ? null : `counted ${v}, expected ${tenantDocs.length}`),
    );
    await check(
      'aggregate',
      () => docs().aggregate({ _count: true, _sum: { score: true } }),
      (v) => {
        const a = v as { _count: number; _sum: { score: number | string } };
        return a._count === tenantDocs.length && Number(a._sum.score) === sum
          ? null
          : `got ${show(a)}, expected count ${tenantDocs.length} sum ${sum}`;
      },
    );
    await check(
      'groupBy',
      () => docs().groupBy({ by: ['tenantId'], _count: true }),
      (v) => {
        const groups = v as { tenantId: number; _count: number }[];
        return groups.length === 1 && groups[0]?.tenantId === 2 && groups[0]._count === tenantDocs.length
          ? null
          : `got ${show(groups)}`;
      },
    );
    await check(
      'findManyStream',
      async () => collect(docs().findManyStream({ orderBy: { id: 'asc' } })),
      expectIds(tenantDocs),
    );
    await check(
      'findManyStreamBatches',
      async () => (await collect(docs().findManyStreamBatches({ orderBy: { id: 'asc' } }))).flat(),
      expectIds(tenantDocs),
    );
    await check(
      'findManyStream with children',
      async () =>
        collect(docs().findManyStream({ orderBy: { id: 'asc' }, with: { notes: { orderBy: { id: 'asc' } } } })),
      (v) => {
        const bad = (v as { id: number; notes: { tenantId: number }[] }[]).filter((d) =>
          d.notes.some((n) => n.tenantId !== 2),
        );
        return bad.length === 0 ? null : `docs ${bad.map((d) => d.id).join(',')} carry notes of another tenant`;
      },
    );

    for (const strategy of ['join', 'batched', 'auto'] as const) {
      failures.checked();
      const result = await attempt(() =>
        docs().findMany({
          orderBy: { id: 'asc' },
          with: { notes: { orderBy: { id: 'asc' } } },
          relationLoadStrategy: strategy,
        }),
      );
      if (!result.ok) {
        failures.add(`findMany with children [${strategy}]: threw`, describeError(result.error));
        continue;
      }
      for (const doc of result.value as { id: number; notes: { id: number }[] }[]) {
        const want = await notesOf(doc.id);
        if (stable(doc.notes.map((n) => n.id)) !== stable(want)) {
          failures.add(
            `findMany with children [${strategy}]: a child list is wrong`,
            `doc ${doc.id}: got notes ${doc.notes.map((n) => n.id).join(',')}, expected ${want.join(',')} (the stray note belongs to another tenant)`,
          );
        }
      }
    }

    await check(
      'relation filter some(body: "stray")',
      () => docs().findMany({ where: { notes: { some: { body: 'stray' } } }, orderBy: { id: 'asc' } }),
      expectIds([]),
    );
    await check(
      'relation filter none(body: "stray")',
      () => docs().findMany({ where: { notes: { none: { body: 'stray' } } }, orderBy: { id: 'asc' } }),
      expectIds(tenantDocs),
    );
    await check(
      'relation filter every(body in a,b)',
      () => docs().findMany({ where: { notes: { every: { body: { in: ['a', 'b'] } } } }, orderBy: { id: 'asc' } }),
      expectIds(tenantDocs),
    );
    failures.assertClean('defined tenant reads', 19);
  });

  it("a defined tenant: writes touch only that tenant's rows", async () => {
    const failures = new Failures(FILE, 3);
    asTenant(2);

    const outsiders = async (): Promise<string> => {
      const d = (await dumpJson(reader, DOCS)).filter((r) => OTHER_TENANT_IDS.includes(r.id as number));
      const n = (await dumpJson(reader, NOTES)).filter((r) => OTHER_TENANT_IDS.includes(r.doc_id as number));
      return stable({ d, n });
    };

    const scenarios: {
      name: string;
      run: () => Promise<unknown>;
      expectThrows?: boolean;
      verify?: () => Promise<string | null>;
    }[] = [
      {
        name: 'updateMany',
        run: () => docs().updateMany({ where: { score: { gte: 0 } }, data: { title: 'W' } }),
        verify: async () => {
          const titles = await ids(reader, `SELECT id FROM ${DOCS} WHERE title = 'W' ORDER BY id`);
          return stable(titles) === stable([5, 6, 7, 8])
            ? null
            : `titles changed on docs ${titles.join(',')}, expected 5,6,7,8`;
        },
      },
      { name: 'update (own row)', run: () => docs().update({ where: { id: 5 }, data: { title: 'W' } }) },
      {
        name: "update (another tenant's row)",
        run: () => docs().update({ where: { id: 1 }, data: { title: 'W' } }),
        expectThrows: true,
      },
      { name: "delete (another tenant's row)", run: () => docs().delete({ where: { id: 1 } }), expectThrows: true },
      {
        name: 'deleteMany',
        run: () => docs().deleteMany({ where: { score: { gte: 0 } } }),
        verify: async () => {
          const left = await ids(reader, `SELECT id FROM ${DOCS} ORDER BY id`);
          return stable(left) === stable(OTHER_TENANT_IDS)
            ? null
            : `docs left: ${left.join(',')}, expected only the other tenants' ${OTHER_TENANT_IDS.join(',')}`;
        },
      },
      {
        name: "upsert onto another tenant's row",
        run: () =>
          docs().upsert({ where: { id: 1 }, create: { id: 1, tenantId: 2, title: 'C' }, update: { title: 'W' } }),
        expectThrows: true,
      },
      {
        name: 'upsert (own row)',
        run: () =>
          docs().upsert({ where: { id: 5 }, create: { id: 5, tenantId: 2, title: 'C' }, update: { title: 'W' } }),
        verify: async () => {
          const t = await ids(reader, `SELECT id FROM ${DOCS} WHERE title = 'W'`);
          return stable(t) === stable([5]) ? null : `upsert changed docs ${t.join(',')}, expected only 5`;
        },
      },
      {
        name: 'updateMany in $transaction',
        run: () =>
          db.$transaction(async (tx) =>
            tx.table(DOCS).updateMany({ where: { score: { gte: 0 } }, data: { title: 'W' } }),
          ),
      },
    ];

    for (const s of scenarios) {
      await writer.query(seedSql());
      const outsidersBefore = await outsiders();
      failures.checked();
      const run = await attempt(s.run);
      if (s.expectThrows && run.ok)
        failures.add(`${s.name}: succeeded on a row outside the tenant`, `returned ${stable(run.value).slice(0, 160)}`);
      if (!s.expectThrows && !run.ok)
        failures.add(`${s.name}: threw on the tenant's own rows`, describeError(run.error));
      if ((await outsiders()) !== outsidersBefore) {
        failures.add(
          `${s.name}: modified another tenant's rows`,
          'rows of tenants 1 and 3 differ from their initial state',
        );
      }
      if (s.verify && run.ok) {
        const problem = await s.verify();
        if (problem) failures.add(`${s.name}: wrong rows affected`, problem);
      }
    }
    failures.assertClean('defined tenant writes', scenarios.length);
  });

  it('skipGlobalFilters: UNSAFE is the explicit way to see every tenant, with or without a tenant', async () => {
    const failures = new Failures(FILE);
    for (const [label, setup] of [
      ['tenant 2', () => asTenant(2)],
      [
        'no tenant',
        () => {
          resolveTenant = () => ({ tenantId: undefined });
        },
      ],
    ] as const) {
      setup();
      failures.checked(2);
      const rows = await attempt(() => docs().findMany({ skipGlobalFilters: UNSAFE, orderBy: { id: 'asc' } }));
      const count = await attempt(() => docs().count({ skipGlobalFilters: UNSAFE }));
      if (!rows.ok || (rows.value as unknown[]).length !== 12)
        failures.add(
          `findMany with UNSAFE (${label})`,
          rows.ok ? `returned ${(rows.value as unknown[]).length} rows, expected 12` : describeError(rows.error),
        );
      if (!count.ok || count.value !== 12)
        failures.add(
          `count with UNSAFE (${label})`,
          count.ok ? `counted ${count.value}, expected 12` : describeError(count.error),
        );
    }
    asTenant(2);
    failures.assertClean('skipGlobalFilters: UNSAFE', 4);
  });

  it('construction: a key that names no table, or a filter column that does not exist, throws E003', async () => {
    const failures = new Failures(FILE);
    const build = (filters: Record<string, unknown>) =>
      attempt(async () => {
        const client = new TurbineClient(
          { connectionString: DATABASE_URL, globalFilters: filters as never, warnOnUnlimited: false },
          schema,
        );
        await client.disconnect();
        return client;
      });
    const cases: [string, Record<string, unknown>, string][] = [
      ['misspelled table key', { orc_g_docz: { tenantId: 1 } }, DOCS],
      ['static filter on a column that does not exist', { [DOCS]: { tenentId: 1 } }, 'tenentId'],
      ['function filter under a misspelled table key', { orc_g_doc: () => ({ tenantId: 1 }) }, DOCS],
    ];
    for (const [label, filters, hint] of cases) {
      failures.checked();
      const result = await build(filters);
      if (result.ok) {
        failures.add(
          `${label}: accepted`,
          `globalFilters ${show(filters)} did not throw at construction, so the filter is silently never applied`,
        );
        continue;
      }
      const err = result.error as { code?: string; message?: string };
      if (err.code !== 'TURBINE_E003')
        failures.add(`${label}: threw something other than E003`, describeError(result.error));
      else if (!String(err.message).includes(hint))
        failures.add(`${label}: the error carries no did-you-mean for "${hint}"`, describeError(result.error));
    }

    // The accessor spelling of a table name: either honored or refused, never silently ignored.
    failures.checked();
    const accessor = await attempt(async () => {
      const client = makeClient(DATABASE_URL!, schema, { globalFilters: { orcGDocs: { tenantId: 2 } } as never });
      try {
        return await client.t(DOCS).count();
      } finally {
        await client.disconnect();
      }
    });
    if (accessor.ok && accessor.value !== 4) {
      failures.add(
        'accessor-spelled table key was silently ignored',
        `count() returned ${accessor.value} with globalFilters { orcGDocs: { tenantId: 2 } }, expected 4 (honored) or a construction error`,
      );
    }
    failures.assertClean('global filter construction', 4);
    assert.ok(true);
  });
  it('construction: the did-you-mean offers the one-edit-away column, not a shorter name that merely appears inside the typo', async () => {
    const failures = new Failures(FILE);
    const cases: [string, Record<string, unknown>, string][] = [
      ['static filter column typo', { [DOCS]: { tenentId: 1 } }, 'tenantId'],
      ['static filter column typo, snake spelling', { [DOCS]: { tenent_id: 1 } }, 'tenantId'],
      ['table key typo', { orc_g_docz: { tenantId: 1 } }, DOCS],
    ];
    for (const [label, filters, wanted] of cases) {
      failures.checked();
      const result = await attempt(async () => {
        const client = new TurbineClient(
          { connectionString: DATABASE_URL, globalFilters: filters as never, warnOnUnlimited: false },
          schema,
        );
        await client.disconnect();
        return client;
      });
      if (result.ok) {
        failures.add(`${label}: accepted`, `globalFilters ${show(filters)} did not throw`);
        continue;
      }
      const message = String((result.error as { message?: string }).message);
      const suggested = /Did you mean "([^"]+)"/.exec(message)?.[1];
      if (suggested !== wanted)
        failures.add(
          `${label}: the suggestion is not the near-miss`,
          `suggested ${show(suggested)}, expected "${wanted}"; message: ${message.slice(0, 200)}`,
        );
    }
    failures.assertClean('global filter did-you-mean', 3);
  });
});

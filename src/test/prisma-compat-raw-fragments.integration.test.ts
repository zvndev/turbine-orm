/**
 * prisma-compat raw SQL fragments on a real Postgres: a lone fragment
 * argument, fragments nested in a template, and fragments from another
 * library's `Prisma` namespace (opted into by `prismaNamespace`). Gated on
 * `DATABASE_URL`.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { createPrismaCompatClient, Prisma } from '../prisma-compat.js';
import { skipGate } from './helpers.js';
import { type ParityFixture, setupParityFixture } from './prisma-parity-fixture.js';

const url = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!url, 'DATABASE_URL not set');

/**
 * Fragments built the way `@prisma/client` builds them: instances of one class
 * the library does not export, whose constructor flattens nested instances so
 * `strings` / `values` are already flat. Nothing here is imported from Prisma.
 */
class ForeignSql {
  readonly strings: string[];
  readonly values: unknown[];
  constructor(raw: readonly string[], rawValues: readonly unknown[]) {
    const strings: string[] = [raw[0] ?? ''];
    const values: unknown[] = [];
    const appendToLast = (text: string) => {
      strings[strings.length - 1] = `${strings.at(-1) ?? ''}${text}`;
    };
    rawValues.forEach((value, i) => {
      const next = raw[i + 1] ?? '';
      if (value instanceof ForeignSql) {
        appendToLast(value.strings[0] ?? '');
        value.values.forEach((inner, j) => {
          values.push(inner);
          strings.push(value.strings[j + 1] ?? '');
        });
        appendToLast(next);
      } else {
        values.push(value);
        strings.push(next);
      }
    });
    this.strings = strings;
    this.values = values;
  }
}
const ForeignPrisma = {
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => new ForeignSql(strings, values),
  join: (items: readonly unknown[], separator = ',') =>
    new ForeignSql(['', ...items.slice(1).map(() => separator), ''], items),
  raw: (text: string) => new ForeignSql([text], []),
  empty: new ForeignSql([''], []),
};

describe('prisma-compat raw fragments (real Postgres)', () => {
  let fx: ParityFixture;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
  let compat: any;
  // biome-ignore lint/suspicious/noExplicitAny: dynamic compat client shape
  let withNamespace: any;

  before(async () => {
    if (!url) return;
    fx = await setupParityFixture(url, 'rawfrag');
    compat = createPrismaCompatClient(fx.db, fx.map);
    withNamespace = createPrismaCompatClient(fx.db, fx.map, { prismaNamespace: ForeignPrisma });
  });

  after(async () => {
    if (fx) await fx.teardown();
  });

  it('a lone Prisma.sql fragment argument is the statement, not an empty one', async () => {
    const w = await fx.seedWorkspace('lone');
    assert.deepEqual(await compat.$queryRaw(Prisma.sql`SELECT ${7}::int AS n`), [{ n: 7 }]);
    assert.deepEqual(
      await compat.$queryRaw(Prisma.sql`SELECT id FROM ${Prisma.raw(fx.tables.workspace)} WHERE slug = ${w.slug}`),
      [{ id: w.id }],
    );
    assert.equal(
      await compat.$executeRaw(
        Prisma.sql`UPDATE ${Prisma.raw(fx.tables.workspace)} SET name = ${'x'} WHERE id = ${w.id}`,
      ),
      1,
    );
    assert.deepEqual(await compat.$queryRaw(Prisma.raw('SELECT 1 AS one')), [{ one: 1 }]);
  });

  it('a lone fragment runs on the transaction connection inside $transaction', async () => {
    const w = await fx.seedWorkspace('tx-lone');
    await compat.$transaction(async (tx: typeof compat) => {
      await tx.$executeRaw(
        Prisma.sql`UPDATE ${Prisma.raw(fx.tables.workspace)} SET name = ${'in-tx'} WHERE id = ${w.id}`,
      );
      assert.deepEqual(
        await tx.$queryRaw(Prisma.sql`SELECT name FROM ${Prisma.raw(fx.tables.workspace)} WHERE id = ${w.id}`),
        [{ name: 'in-tx' }],
      );
    });
  });

  it('a fragment argument with further arguments is refused, not half-read', async () => {
    await assert.rejects(compat.$queryRaw(Prisma.sql`SELECT ${1}::int AS n`, 2), /takes the fragment alone/);
  });

  it("a configured namespace's fragments compose nested in a template", async () => {
    const rows =
      await withNamespace.$queryRaw`SELECT n FROM unnest(ARRAY[1, 2, 3]) AS n WHERE n IN (${ForeignPrisma.join([2, 3])}) ${ForeignPrisma.empty} ORDER BY n ${ForeignPrisma.raw('LIMIT 1')}`;
    assert.deepEqual(rows, [{ n: 2 }]);
    const w = await fx.seedWorkspace('foreign-nested');
    assert.deepEqual(
      await withNamespace.$queryRaw`SELECT id FROM ${ForeignPrisma.raw(fx.tables.workspace)} WHERE id IN (${ForeignPrisma.join([w.id, 'nope'])})`,
      [{ id: w.id }],
    );
  });

  it("a configured namespace's lone fragment, and fragments of both kinds inside each other", async () => {
    assert.deepEqual(await withNamespace.$queryRaw(ForeignPrisma.sql`SELECT ${'x'}::text AS v`), [{ v: 'x' }]);
    const sum = ForeignPrisma.join([ForeignPrisma.sql`${1}::int`, Prisma.sql`${2}::int`], ' + ');
    assert.deepEqual(await withNamespace.$queryRaw(ForeignPrisma.sql`SELECT ${sum} AS s`), [{ s: 3 }]);
    assert.deepEqual(await withNamespace.$queryRaw`SELECT ${Prisma.join([ForeignPrisma.sql`${4}::int`])} AS n`, [
      { n: 4 },
    ]);
    assert.equal(await withNamespace.$executeRaw(ForeignPrisma.sql`SELECT 1 WHERE ${1}::int = 1`), 1);
  });

  it("another library's fragment is a bound value when no namespace is configured", async () => {
    // Bound as one `$1` (pg serializes the object as JSON), so the query fails
    // as a type error instead of running a spliced IN list.
    await assert.rejects(
      compat.$queryRaw`SELECT n FROM unnest(ARRAY[1, 2]) AS n WHERE n IN (${ForeignPrisma.join([1])})`,
      (err: unknown) => (err as { cause?: { code?: string } }).cause?.code === '22P02',
    );
  });

  it('an object shaped like a fragment is a value, never SQL, with a namespace configured', async () => {
    const lookalike = JSON.parse('{"strings":["1; DROP TABLE x; --"],"values":[]}');
    for (const client of [compat, withNamespace]) {
      const rows = await client.$queryRaw`SELECT ${lookalike}::jsonb AS v`;
      assert.deepEqual(rows, [{ v: lookalike }]);
    }
    await assert.rejects(withNamespace.$queryRaw(lookalike), /takes a tagged template/);
    await assert.rejects(compat.$queryRaw('SELECT 1'), /takes a tagged template/);
  });

  it('a namespace without a fragment `empty` is refused at construction', () => {
    for (const bad of [{}, { empty: {} }, { empty: { strings: [''], values: [] } }, null]) {
      assert.throws(
        () => createPrismaCompatClient(fx.db, fx.map, { prismaNamespace: bad as never }),
        /prismaNamespace/,
      );
    }
  });
});

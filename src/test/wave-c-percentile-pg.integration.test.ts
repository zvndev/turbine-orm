/**
 * `_percentile` against a live PostgreSQL, checked against a JS reference.
 *
 * The reference is the definition PostgreSQL documents and implements:
 * `percentile_cont` interpolates linearly between the two values around
 * position p * (n - 1) of the sorted non-NULL values; `percentile_disc`
 * returns the first value whose position k / n reaches p. Seeded data carries
 * NULLs, an int8 past 2^53, a numeric with a scale, dates, timestamps and an
 * infinity, so each value is also checked to read back the way the column
 * itself reads.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/wave-c-percentile-pg.integration.test.ts
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { tableAccessorName } from '../global-filters-config.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const TABLE = 'wcp_samples';

interface Sample {
  route: string;
  f8: number | null;
  i4: number | null;
  num: string | null;
  ts: string | null;
  d: string | null;
}

/** Deterministic samples: three routes, about one value in six NULL. */
function samples(): Sample[] {
  let seed = 20261013;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const maybe = <V>(v: V): V | null => (next() < 0.16 ? null : v);
  const rows: Sample[] = [];
  for (const route of ['a', 'b', 'c']) {
    const n = route === 'a' ? 23 : route === 'b' ? 17 : 9;
    for (let i = 0; i < n; i++) {
      rows.push({
        route,
        f8: maybe(Math.round(next() * 1e6) / 1e3),
        i4: maybe(Math.floor(next() * 500)),
        num: maybe((Math.floor(next() * 1e6) / 1e3).toFixed(3)),
        ts: maybe(new Date(Date.UTC(2024, 0, 1) + Math.floor(next() * 3e10)).toISOString()),
        d: maybe(new Date(Date.UTC(2024, 0, 1) + Math.floor(next() * 400) * 864e5).toISOString().slice(0, 10)),
      });
    }
  }
  return rows;
}

function cont(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const pos = p * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

function disc<V>(values: readonly V[], p: number, compare: (x: V, y: V) => number): V | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort(compare);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

const byNumber = (x: number, y: number) => x - y;
const byText = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
const present = <V>(values: readonly (V | null)[]): V[] => values.filter((v): v is V => v !== null);

function close(actual: unknown, expected: number | null, label: string): void {
  if (expected === null) {
    assert.equal(actual, null, label);
    return;
  }
  assert.equal(typeof actual, 'number', `${label}: ${String(actual)}`);
  assert.ok(
    Math.abs((actual as number) - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
    `${label}: ${actual} vs ${expected}`,
  );
}

describe('_percentile: live PostgreSQL', () => {
  let raw: pg.Client;
  let schema: SchemaMetadata;
  let db: TurbineClient;
  const data = samples();
  const clients: TurbineClient[] = [];
  const client = (config: Record<string, unknown> = {}) => {
    const c = new TurbineClient({ connectionString: DATABASE_URL, warnOnUnlimited: false, ...config }, schema);
    clients.push(c);
    return c;
  };
  const t = () => db.table(TABLE);

  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await raw.query(`CREATE TABLE ${TABLE} (
      id SERIAL PRIMARY KEY,
      route TEXT NOT NULL,
      f8 DOUBLE PRECISION,
      i4 INTEGER,
      i8 BIGINT,
      num NUMERIC(12, 3),
      iv INTERVAL,
      ts TIMESTAMPTZ,
      d DATE
    )`);
    for (const r of data) {
      await raw.query(`INSERT INTO ${TABLE} (route, f8, i4, num, ts, d) VALUES ($1, $2, $3, $4, $5, $6)`, [
        r.route,
        r.f8,
        r.i4,
        r.num,
        r.ts,
        r.d,
      ]);
    }
    await raw.query(`INSERT INTO ${TABLE} (route, i8) VALUES ('big', 2), ('big', 9007199254740993)`);
    await raw.query(`INSERT INTO ${TABLE} (route, ts) VALUES ('inf', '2024-01-01T00:00:00Z'), ('inf', 'infinity')`);
    await raw.query(`INSERT INTO ${TABLE} (route, iv) VALUES ('iv', '1 hour'), ('iv', '3 hours')`);
    schema = await introspect({ connectionString: DATABASE_URL!, include: [TABLE] });
    db = client();
  });
  after(async () => {
    for (const c of clients) await c.disconnect().catch(() => {});
    if (!raw) return;
    await raw.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await raw.end();
  });

  const inMain = (rows: readonly Sample[]) => rows.filter((r) => ['a', 'b', 'c'].includes(r.route));

  it('aggregate: cont and disc, scalar and array, against the reference', async () => {
    const ps = [0, 0.1, 0.25, 0.5, 0.9, 0.95, 1];
    const rows = inMain(data);
    const out = (await t().aggregate({
      where: { route: { in: ['a', 'b', 'c'] } },
      _percentile: {
        f8: { p: ps },
        i4: { p: 0.5 },
        num: { p: ps, method: 'disc' },
        ts: { p: ps, method: 'disc' },
        d: { p: 0.5, method: 'disc' },
        route: { p: [0.2, 0.8], method: 'disc' },
      },
    })) as { _percentile: Record<string, unknown> };
    const pct = out._percentile;

    const f8 = present(rows.map((r) => r.f8));
    (pct.f8 as unknown[]).forEach((v, i) => {
      close(v, cont(f8, ps[i]!), `f8 p=${ps[i]}`);
    });
    close(pct.i4, cont(present(rows.map((r) => r.i4)), 0.5), 'i4 cont over int4');

    const num = present(rows.map((r) => r.num));
    assert.deepEqual(
      pct.num,
      ps.map((p) => disc(num, p, (x, y) => Number(x) - Number(y))),
      'numeric disc stays exact text, scale included',
    );

    const ts = present(rows.map((r) => r.ts));
    const tsOut = pct.ts as Date[];
    assert.ok(tsOut.every((v) => v instanceof Date));
    assert.deepEqual(
      tsOut.map((v) => v.toISOString()),
      ps.map((p) => disc(ts, p, byText)),
    );

    const d = disc(present(rows.map((r) => r.d)), 0.5, byText);
    assert.ok(pct.d instanceof Date);
    assert.equal(
      (pct.d as Date).toISOString(),
      `${d}T00:00:00.000Z`,
      'a date reads at UTC midnight, as the column does',
    );

    assert.deepEqual(pct.route, [
      disc(
        rows.map((r) => r.route),
        0.2,
        byText,
      ),
      disc(
        rows.map((r) => r.route),
        0.8,
        byText,
      ),
    ]);
  });

  it('numeric: cont is a number, disc scalar and array agree and stay exact', async () => {
    const out = (await t().aggregate({
      where: { route: 'a' },
      _percentile: { num: { p: 0.5, method: 'disc' } },
    })) as { _percentile: { num: unknown } };
    const arr = (await t().aggregate({
      where: { route: 'a' },
      _percentile: { num: { p: [0.5], method: 'disc' } },
    })) as { _percentile: { num: unknown[] } };
    assert.equal(typeof out._percentile.num, 'string');
    assert.deepEqual(arr._percentile.num, [out._percentile.num]);
    const contOut = (await t().aggregate({ where: { route: 'a' }, _percentile: { num: { p: 0.5 } } })) as {
      _percentile: { num: unknown };
    };
    close(
      contOut._percentile.num,
      cont(present(data.filter((r) => r.route === 'a').map((r) => r.num)).map(Number), 0.5),
      'numeric cont',
    );
  });

  it('groupBy: per-group values against the reference, NULL-only groups give null', async () => {
    const groups = (await t().groupBy({
      by: ['route'],
      _percentile: { f8: { p: [0.25, 0.75] }, i4: { p: 0.5, method: 'disc' } },
      orderBy: { route: 'asc' },
    })) as unknown as { route: string; _percentile: { f8: number[] | null; i4: number | null } }[];
    assert.deepEqual(
      groups.map((g) => g.route),
      ['a', 'b', 'big', 'c', 'inf', 'iv'],
    );
    for (const g of groups) {
      const rows = data.filter((r) => r.route === g.route);
      const f8 = present(rows.map((r) => r.f8));
      if (f8.length === 0) {
        assert.equal(g._percentile.f8, null, `${g.route}: no f8 values`);
      } else {
        g._percentile.f8!.forEach((v, i) => {
          close(v, cont(f8, [0.25, 0.75][i]!), `${g.route} f8`);
        });
      }
      assert.equal(g._percentile.i4, disc(present(rows.map((r) => r.i4)), 0.5, byNumber), `${g.route} i4`);
    }
  });

  it('zero rows give null in both forms', async () => {
    const out = (await t().aggregate({
      where: { route: 'none' },
      _percentile: { f8: { p: 0.5 }, i4: { p: [0.5, 0.9], method: 'disc' } },
    })) as { _percentile: Record<string, unknown> };
    assert.deepEqual(out._percentile, { f8: null, i4: null });
  });

  it('int8: an exact number while it fits, the text past 2^53, in both forms', async () => {
    const arr = (await t().aggregate({
      where: { route: 'big' },
      _percentile: { i8: { p: [0, 1], method: 'disc' } },
    })) as {
      _percentile: { i8: unknown };
    };
    assert.deepEqual(arr._percentile.i8, [2, '9007199254740993']);
    const scalar = (await t().aggregate({
      where: { route: 'big' },
      _percentile: { i8: { p: 1, method: 'disc' } },
    })) as {
      _percentile: { i8: unknown };
    };
    assert.equal(scalar._percentile.i8, '9007199254740993');
  });

  it("an infinity reads as findMany reads it, element by element ('preserve' and 'null')", async () => {
    for (const reading of ['preserve', 'null'] as const) {
      const c = client({ temporalInfinity: reading });
      const ts = c.table<{ ts: unknown }>(TABLE);
      const [, infRow] = await ts.findMany({ where: { route: 'inf' }, orderBy: { id: 'asc' } });
      const arr = (await ts.aggregate({
        where: { route: 'inf' },
        _percentile: { ts: { p: [0, 1], method: 'disc' } },
      })) as {
        _percentile: { ts: unknown[] };
      };
      const [first, last] = arr._percentile.ts;
      assert.ok(first instanceof Date);
      assert.equal((first as Date).toISOString(), '2024-01-01T00:00:00.000Z');
      assert.deepEqual(last, infRow!.ts, `${reading}: the array element matches the row`);
      assert.equal(last, reading === 'null' ? null : Number.POSITIVE_INFINITY);
      const scalar = (await ts.aggregate({
        where: { route: 'inf' },
        _percentile: { ts: { p: 1, method: 'disc' } },
      })) as {
        _percentile: { ts: unknown };
      };
      assert.deepEqual(scalar._percentile.ts, infRow!.ts);
    }
  });

  it('interval: cont interpolates and reads as the column does', async () => {
    const out = (await t().aggregate({ where: { route: 'iv' }, _percentile: { iv: { p: 0.5 } } })) as {
      _percentile: { iv: unknown };
    };
    const [row] = await t().findMany({ where: { route: 'iv' }, orderBy: { id: 'asc' }, limit: 1 });
    assert.equal(
      Object.getPrototypeOf(out._percentile.iv),
      Object.getPrototypeOf((row as { iv: unknown }).iv),
      'same reading as the column',
    );
    assert.deepEqual({ ...(out._percentile.iv as object) }, { hours: 2 });
  });

  it('a global filter scopes the rows', async () => {
    const scoped = client({ globalFilters: { [tableAccessorName(TABLE)]: { route: 'b' } } });
    const out = (await scoped.table(TABLE).aggregate({ _percentile: { f8: { p: 0.5 } } })) as {
      _percentile: { f8: unknown };
    };
    close(out._percentile.f8, cont(present(data.filter((r) => r.route === 'b').map((r) => r.f8)), 0.5), 'route b');
  });
});

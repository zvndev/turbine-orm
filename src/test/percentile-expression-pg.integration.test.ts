/**
 * `_percentile` over an expression against a live PostgreSQL, checked against
 * the same percentile written by hand in SQL.
 *
 * Seeded rows carry NULL timestamps (a percentile skips them), a group with no
 * rows after filtering, two zone-less timestamps, and a numeric column, so the
 * expression forms are each compared with the statement a developer would
 * have written themselves.
 *
 * Run: DATABASE_URL=postgres://... npx tsx --test src/test/percentile-expression-pg.integration.test.ts
 */

// biome-ignore-all lint/suspicious/noThenProperty: expr.case arms are { when, then }, the SQL CASE spelling; never thenable

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { col, expr, UNSAFE } from '../index.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

const DATABASE_URL = process.env.DATABASE_URL;
const { it, before, after } = skipGate(!DATABASE_URL, 'DATABASE_URL not set');

const TABLE = 'pctx_jobs';

function close(actual: unknown, expected: unknown, label: string): void {
  if (expected === null) {
    assert.equal(actual, null, label);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), `${label}: ${String(actual)}`);
    assert.equal((actual as unknown[]).length, expected.length, label);
    for (const [i, e] of expected.entries()) close((actual as unknown[])[i], e, `${label}[${i}]`);
    return;
  }
  const want = Number(expected);
  assert.equal(typeof actual, 'number', `${label}: ${String(actual)}`);
  assert.ok(
    Math.abs((actual as number) - want) <= 1e-9 * Math.max(1, Math.abs(want)),
    `${label}: ${actual} vs ${want}`,
  );
}

describe('_percentile over an expression: live PostgreSQL', () => {
  let raw: pg.Client;
  let schema: SchemaMetadata;
  let db: TurbineClient;

  /** One value from a hand-written statement. */
  const handWritten = async (sql: string, params: unknown[] = []): Promise<unknown> =>
    (await raw.query(sql, params)).rows[0]?.v ?? null;

  before(async () => {
    raw = new pg.Client({ connectionString: DATABASE_URL });
    await raw.connect();
    await raw.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await raw.query(`CREATE TABLE ${TABLE} (
      id SERIAL PRIMARY KEY,
      kind TEXT NOT NULL,
      requested_at TIMESTAMPTZ NOT NULL,
      ready_at TIMESTAMPTZ,
      queued_at TIMESTAMP,
      started_at TIMESTAMP,
      cost NUMERIC(10, 3),
      tries INTEGER NOT NULL
    )`);
    let seed = 91013;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let i = 0; i < 60; i++) {
      const requested = Date.UTC(2026, 0, 1) + Math.floor(next() * 864e5);
      const ready = next() < 0.15 ? null : new Date(requested + Math.floor(next() * 9e5)).toISOString();
      const queued = new Date(requested).toISOString().replace('Z', '');
      const started = new Date(requested + Math.floor(next() * 6e4)).toISOString().replace('Z', '');
      await raw.query(
        `INSERT INTO ${TABLE} (kind, requested_at, ready_at, queued_at, started_at, cost, tries) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          ['a', 'b', 'c'][i % 3],
          new Date(requested).toISOString(),
          ready,
          queued,
          started,
          (Math.floor(next() * 1e6) / 1e3).toFixed(3),
          Math.floor(next() * 6),
        ],
      );
    }
    schema = await introspect({ connectionString: DATABASE_URL!, include: [TABLE] });
    db = new TurbineClient({ connectionString: DATABASE_URL, warnOnUnlimited: false }, schema);
  });

  after(async () => {
    await db?.disconnect().catch(() => {});
    if (!raw) return;
    await raw.query(`DROP TABLE IF EXISTS ${TABLE}`);
    await raw.end();
  });

  const t = () => db.table(TABLE);
  const WAIT = expr.secondsBetween(col('requestedAt'), col('readyAt'));

  it('secondsBetween matches EXTRACT(EPOCH FROM ...), cont and disc, scalar and array', async () => {
    const out = (await t().aggregate({
      _percentile: {
        wait: { of: WAIT, p: [0.5, 0.95, 0.99] },
        waitDisc: { of: WAIT, p: 0.9, method: 'disc' },
        ms: { of: expr.mul(WAIT, 1000), p: 0.5 },
      },
    } as never)) as { _percentile: Record<string, unknown> };
    const epoch = 'EXTRACT(EPOCH FROM ready_at - requested_at)';
    close(
      out._percentile.wait,
      await handWritten(
        `SELECT percentile_cont(ARRAY[0.5, 0.95, 0.99]) WITHIN GROUP (ORDER BY ${epoch}) AS v FROM ${TABLE}`,
      ),
      'wait',
    );
    close(
      out._percentile.waitDisc,
      await handWritten(`SELECT percentile_disc(0.9) WITHIN GROUP (ORDER BY ${epoch}) AS v FROM ${TABLE}`),
      'waitDisc',
    );
    close(
      out._percentile.ms,
      await handWritten(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ${epoch} * 1000) AS v FROM ${TABLE}`),
      'ms',
    );
  });

  it('groupBy with a where and a case expression matches, group by group', async () => {
    const groups = (await t().groupBy({
      by: ['kind'],
      where: { tries: { lt: 5 } },
      orderBy: { kind: 'asc' },
      _percentile: {
        weighted: {
          of: expr.case([{ when: { tries: { gt: 2 } }, then: expr.mul(col('cost'), 2) }], col('cost')),
          p: 0.75,
        },
      },
    } as never)) as Array<{ kind: string; _percentile: { weighted: unknown } }>;
    const expected = await raw.query(
      `SELECT kind, percentile_cont(0.75) WITHIN GROUP (ORDER BY CASE WHEN tries > 2 THEN cost * 2 ELSE cost END) AS v
       FROM ${TABLE} WHERE tries < 5 GROUP BY kind ORDER BY kind`,
    );
    assert.deepEqual(
      groups.map((g) => g.kind),
      expected.rows.map((r) => r.kind),
    );
    for (const [i, g] of groups.entries()) close(g._percentile.weighted, expected.rows[i].v, `group ${g.kind}`);
  });

  it('zone-less timestamps, and null over zero rows', async () => {
    const out = (await t().aggregate({
      _percentile: { start: { of: expr.secondsBetween(col('queuedAt'), col('startedAt')), p: 0.5 } },
    } as never)) as { _percentile: { start: unknown } };
    close(
      out._percentile.start,
      await handWritten(
        `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM started_at - queued_at)) AS v FROM ${TABLE}`,
      ),
      'start',
    );
    const empty = (await t().aggregate({
      where: { kind: 'none' },
      _percentile: { wait: { of: WAIT, p: [0.5, 0.9] }, one: { of: WAIT, p: 0.5 } },
    } as never)) as { _percentile: Record<string, unknown> };
    assert.deepEqual(empty._percentile, { wait: null, one: null });
  });

  it('a PII column read by the expression needs includePii, then matches', async () => {
    const tagged: SchemaMetadata = structuredClone(schema);
    const cost = tagged.tables[TABLE]!.columns.find((c) => c.name === 'cost')!;
    (cost as { pii?: boolean }).pii = true;
    const piiDb = new TurbineClient({ connectionString: DATABASE_URL, warnOnUnlimited: false }, tagged);
    try {
      const args = { _percentile: { c: { of: expr.add(col('cost'), 1), p: 0.5 } } };
      await assert.rejects(
        piiDb.table(TABLE).aggregate(args as never),
        (e: Error) => e instanceof ValidationError && /"cost"/.test(e.message),
      );
      const out = (await piiDb.table(TABLE).aggregate({ ...args, includePii: UNSAFE } as never)) as {
        _percentile: { c: unknown };
      };
      close(
        out._percentile.c,
        await handWritten(`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY cost + 1) AS v FROM ${TABLE}`),
        'pii',
      );
    } finally {
      await piiDb.disconnect();
    }
  });

  it('runs repeatedly under its prepared name with the same answers', async () => {
    const first = (await t().aggregate({ _percentile: { w: { of: WAIT, p: 0.5 } } } as never)) as {
      _percentile: { w: unknown };
    };
    for (let i = 0; i < 7; i++) {
      const again = (await t().aggregate({ _percentile: { w: { of: WAIT, p: 0.5 } } } as never)) as {
        _percentile: { w: unknown };
      };
      assert.equal(again._percentile.w, first._percentile.w);
    }
  });
});

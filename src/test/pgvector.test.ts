/**
 * turbine-orm — pgvector similarity search tests
 *
 * Covers two things:
 *
 *  1. **Build-only (no DB, PRIMARY gate).** Uses `makeQuery()` with a mock table
 *     carrying a `vector` column to assert the generated SQL/params for:
 *       - KNN orderBy → `"embedding" <=> $1::vector ASC`, LIMIT as a separate param.
 *       - each metric → correct operator (l2 → <->, cosine → <=>, ip → <#>).
 *       - distance WHERE filter → `"embedding" <-> $1::vector < $2`, both bound.
 *       - injection / validation: non-number `to`, unknown metric, distance op on
 *         a non-vector column all throw ValidationError; a malicious string in
 *         `to` never reaches the SQL text.
 *       - fingerprint: two KNN queries differing only in metric produce
 *         different cached SQL (no cache collision).
 *
 *  2. **Integration (DATABASE_URL-gated AND extension-gated).** pgvector may not
 *     be installed; without DATABASE_URL the tests register as skipped via
 *     skipGate(), and `t.skip()` covers a missing extension — never failed.
 *
 * Run: npx tsx --test src/test/pgvector.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import pg from 'pg';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { introspect } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable, skipGate } from './helpers.js';

// ---------------------------------------------------------------------------
// Build-only (no DB) — PRIMARY gate
// ---------------------------------------------------------------------------

/** A schema with an `items` table that has an `embedding` vector column. */
function vectorSchema(): SchemaMetadata {
  const items = mockTable('items', [
    { name: 'id', field: 'id', pgType: 'int8' },
    { name: 'title', field: 'title', pgType: 'text' },
    { name: 'embedding', field: 'embedding', pgType: 'vector' },
  ]);
  return { tables: { items } } as unknown as SchemaMetadata;
}

function qi() {
  return makeQuery('items', vectorSchema());
}

describe('pgvector — build-only', () => {
  it('KNN orderBy emits "<=> $1::vector ASC" and binds the [...] string; LIMIT is separate', () => {
    const q = qi();
    const { sql, params } = q.buildFindMany({
      orderBy: { embedding: { distance: { to: [0.1, 0.2, 0.3], metric: 'cosine' } } },
      limit: 5,
    });

    assert.match(sql, /ORDER BY "embedding" <=> \$1::vector ASC/);
    assert.match(sql, /LIMIT \$2/);
    assert.equal(params[0], '[0.1,0.2,0.3]');
    assert.equal(params[1], 5);
    // The raw array must never be interpolated into the SQL text.
    assert.ok(!sql.includes('0.1'), 'query vector value must not appear in SQL text');
  });

  it('direction: desc inverts the sort', () => {
    const q = qi();
    const { sql } = q.buildFindMany({
      orderBy: { embedding: { distance: { to: [1, 2, 3], metric: 'cosine', direction: 'desc' } } },
    });
    assert.match(sql, /ORDER BY "embedding" <=> \$1::vector DESC/);
  });

  it('each metric maps to the correct operator', () => {
    const cases: Array<[string, string]> = [
      ['l2', '<->'],
      ['cosine', '<=>'],
      ['ip', '<#>'],
    ];
    for (const [metric, op] of cases) {
      const q = qi();
      const { sql } = q.buildFindMany({
        orderBy: { embedding: { distance: { to: [1, 2, 3], metric: metric as 'l2' } } },
      });
      assert.ok(
        sql.includes(`"embedding" ${op} $1::vector`),
        `metric ${metric} should emit operator ${op}; got: ${sql}`,
      );
    }
  });

  it('distance WHERE filter emits "<-> $1::vector < $2" with both params bound in order', () => {
    const q = qi();
    const { sql, params } = q.buildFindMany({
      where: { embedding: { distance: { to: [0.4, 0.5, 0.6], metric: 'l2', lt: 0.3 } } },
    });
    assert.match(sql, /WHERE "embedding" <-> \$1::vector < \$2/);
    assert.equal(params[0], '[0.4,0.5,0.6]');
    assert.equal(params[1], 0.3);
  });

  it('distance WHERE supports lte / gt / gte', () => {
    const ops: Array<['lte' | 'gt' | 'gte', string]> = [
      ['lte', '<='],
      ['gt', '>'],
      ['gte', '>='],
    ];
    for (const [key, op] of ops) {
      const q = qi();
      const { sql } = q.buildFindMany({
        where: { embedding: { distance: { to: [1, 2, 3], metric: 'cosine', [key]: 0.5 } } },
      });
      assert.ok(sql.includes(`<=> $1::vector ${op} $2`), `comparator ${key} → ${op}; got: ${sql}`);
    }
  });

  // -------------------------------------------------------------------------
  // Injection / validation
  // -------------------------------------------------------------------------

  it('a non-number element in `to` (orderBy) throws ValidationError', () => {
    const q = qi();
    assert.throws(
      () =>
        q.buildFindMany({
          // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
          orderBy: { embedding: { distance: { to: [1, 'x' as any, 3], metric: 'cosine' } } },
        }),
      ValidationError,
    );
  });

  it('NaN / Infinity in `to` throws ValidationError', () => {
    const q = qi();
    assert.throws(
      () => q.buildFindMany({ orderBy: { embedding: { distance: { to: [1, Number.NaN, 3], metric: 'l2' } } } }),
      ValidationError,
    );
    const q2 = qi();
    assert.throws(
      () =>
        q2.buildFindMany({
          where: { embedding: { distance: { to: [Number.POSITIVE_INFINITY], metric: 'l2', lt: 1 } } },
        }),
      ValidationError,
    );
  });

  it('an unknown metric throws ValidationError', () => {
    const q = qi();
    assert.throws(
      () =>
        q.buildFindMany({
          // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid metric
          orderBy: { embedding: { distance: { to: [1, 2, 3], metric: 'manhattan' as any } } },
        }),
      ValidationError,
    );
  });

  it('a distance op on a non-vector column throws ValidationError', () => {
    const q = qi();
    assert.throws(
      () => q.buildFindMany({ where: { title: { distance: { to: [1, 2, 3], metric: 'l2', lt: 0.3 } } } }),
      ValidationError,
    );
    const q2 = qi();
    assert.throws(
      () => q2.buildFindMany({ orderBy: { title: { distance: { to: [1, 2, 3], metric: 'l2' } } } }),
      ValidationError,
    );
  });

  it('a malicious string in `to` never reaches the SQL text (rejected before binding)', () => {
    const q = qi();
    const evil = '1]); DROP TABLE items;--';
    assert.throws(
      () =>
        q.buildFindMany({
          // biome-ignore lint/suspicious/noExplicitAny: malicious payload
          where: { embedding: { distance: { to: [evil as any], metric: 'l2', lt: 1 } } },
        }),
      ValidationError,
    );
    // Even if a build somehow produced SQL, the payload must not be present.
    // (Build threw, so there is no SQL — assert via a guarded re-run.)
    let leaked = false;
    try {
      const { sql } = q.buildFindMany({
        // biome-ignore lint/suspicious/noExplicitAny: malicious payload
        where: { embedding: { distance: { to: [evil as any], metric: 'l2', lt: 1 } } },
      });
      leaked = sql.includes('DROP TABLE');
    } catch {
      leaked = false;
    }
    assert.equal(leaked, false, 'malicious payload must never appear in SQL');
  });

  it('a distance filter with no comparator throws ValidationError', () => {
    const q = qi();
    assert.throws(
      // biome-ignore lint/suspicious/noExplicitAny: missing comparator on purpose
      () => q.buildFindMany({ where: { embedding: { distance: { to: [1, 2, 3], metric: 'l2' } as any } } }),
      ValidationError,
    );
  });

  // -------------------------------------------------------------------------
  // Fingerprint / cache
  // -------------------------------------------------------------------------

  it('two KNN queries differing only in metric produce different SQL (no cache collision)', () => {
    const q = qi(); // same instance → shares the SQL template cache
    const cosine = q.buildFindMany({
      orderBy: { embedding: { distance: { to: [1, 2, 3], metric: 'cosine' } } },
      limit: 5,
    });
    const l2 = q.buildFindMany({
      orderBy: { embedding: { distance: { to: [1, 2, 3], metric: 'l2' } } },
      limit: 5,
    });
    assert.ok(cosine.sql.includes('<=>'), 'cosine SQL uses <=>');
    assert.ok(l2.sql.includes('<->'), 'l2 SQL uses <->');
    assert.notEqual(cosine.sql, l2.sql, 'differing metrics must not collide on a cached SQL string');
  });

  it('WHERE distance filters differing only in metric produce different SQL', () => {
    const q = qi();
    const a = q.buildFindMany({ where: { embedding: { distance: { to: [1, 2, 3], metric: 'cosine', lt: 0.5 } } } });
    const b = q.buildFindMany({ where: { embedding: { distance: { to: [1, 2, 3], metric: 'ip', lt: 0.5 } } } });
    assert.ok(a.sql.includes('<=>'));
    assert.ok(b.sql.includes('<#>'));
    assert.notEqual(a.sql, b.sql);
  });
});

// ---------------------------------------------------------------------------
// Integration (DATABASE_URL-gated AND extension-gated)
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL;
let HAS_VECTOR = false;

// Probe the extension synchronously-ish before declaring the suite. node:test
// evaluates the module top-to-bottom, so we resolve the probe in `before` and
// rely on it being installed; if the probe fails each test calls `t.skip()`.
const SKIP_DB = !DATABASE_URL;
if (SKIP_DB) {
  console.log('⚠ Skipping pgvector integration tests: DATABASE_URL not set');
}

// We cannot await the probe before declaring the suite, so we always declare
// it and skip individual probes inside `it` when the extension is unavailable.
const dbDescribe = describe;

dbDescribe('pgvector — integration', () => {
  // Without DATABASE_URL these tests register as skipped (visible in the
  // reporter summary) and the before/after hooks become no-ops.
  const { it, before, after } = skipGate(SKIP_DB, 'DATABASE_URL not set');
  let client: TurbineClient | undefined;
  let schema: SchemaMetadata | undefined;

  before(async () => {
    const probe = new pg.Client({ connectionString: DATABASE_URL });
    await probe.connect();
    try {
      await probe.query('CREATE EXTENSION IF NOT EXISTS vector');
      HAS_VECTOR = true;
    } catch {
      HAS_VECTOR = false;
      console.log('⚠ Skipping pgvector live assertions: vector extension not available');
    }
    if (HAS_VECTOR) {
      await probe.query('DROP TABLE IF EXISTS _w3_items');
      await probe.query('CREATE TABLE _w3_items (id serial PRIMARY KEY, embedding vector(3))');
      await probe.query(
        `INSERT INTO _w3_items (embedding) VALUES ('[1,0,0]'), ('[0,1,0]'), ('[0.9,0.1,0]'), ('[0,0,1]')`,
      );
      schema = await introspect({ connectionString: DATABASE_URL! });
      client = new TurbineClient({ connectionString: DATABASE_URL!, poolSize: 2 }, schema);
      await client.connect();
    }
    await probe.end();
  });

  after(async () => {
    if (HAS_VECTOR && client) {
      try {
        await client.sql`DROP TABLE IF EXISTS _w3_items`;
      } catch {
        /* best-effort cleanup */
      }
      await client.disconnect();
    }
  });

  it('KNN findMany returns rows ordered nearest-first', async (t) => {
    if (!HAS_VECTOR || !client) {
      // Report a genuine skip (not a hollow passing no-op) so CI without the
      // pgvector extension doesn't show this as a proven assertion.
      t.skip('vector extension not available');
      return;
    }
    const items = client.table<{ id: number }>('_w3_items');
    const rows = await items.findMany({
      orderBy: { embedding: { distance: { to: [1, 0, 0], metric: 'l2' } } },
      limit: 2,
    });
    assert.equal(rows.length, 2);
    // Nearest to [1,0,0] is [1,0,0] itself, then [0.9,0.1,0].
    // Row insertion order: id 1 = [1,0,0], id 3 = [0.9,0.1,0].
    assert.equal(rows[0]!.id, 1);
    assert.equal(rows[1]!.id, 3);
  });
});

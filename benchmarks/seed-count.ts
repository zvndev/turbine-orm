/**
 * Seed the `_count` relation-strategy benchmark database.
 *
 * Shape mirrors the reported workload: a small-ish parent catalogue table and a
 * large child table whose FK back to the parent may or may not be indexed.
 *
 *   item_type      , PARENTS parent rows (default 10,000)
 *   inventory_item , CHILD_ROWS rows, UNIFORM spread over the parents
 *   inventory_hot  , CHILD_ROWS rows, SKEWED (top 10 parents hold ~50%)
 *
 * Neither child FK is indexed at seed time. The benchmark creates and drops
 * `idx_inventory_item_type_id` / `idx_inventory_hot_type_id` itself so the
 * indexed and unindexed arms run against byte-identical data.
 *
 * Deterministic: every value derives from the row ordinal, no randomness, so
 * repeat runs are comparable.
 *
 * Run with:
 *   DATABASE_URL=postgres://postgres:postgres@localhost:55501/countbench npx tsx benchmarks/seed-count.ts
 */

import pg from 'pg';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const PARENTS = Number(process.env['PARENTS'] ?? 10_000);
const CHILD_ROWS = Number(process.env['CHILD_ROWS'] ?? 200_000);

const SCHEMA_SQL = `
DROP TABLE IF EXISTS inventory_hot CASCADE;
DROP TABLE IF EXISTS inventory_item CASCADE;
DROP TABLE IF EXISTS item_type CASCADE;

CREATE TABLE item_type (
  id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name  TEXT NOT NULL,
  code  TEXT NOT NULL
);

CREATE TABLE inventory_item (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_id  BIGINT NOT NULL REFERENCES item_type(id),
  sku      TEXT NOT NULL,
  qty      INTEGER NOT NULL
);

CREATE TABLE inventory_hot (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type_id  BIGINT NOT NULL REFERENCES item_type(id),
  sku      TEXT NOT NULL,
  qty      INTEGER NOT NULL
);
`;

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });
  const t0 = Date.now();

  console.log('creating schema...');
  await pool.query(SCHEMA_SQL);

  console.log(`seeding ${PARENTS.toLocaleString()} item_type rows...`);
  await pool.query(
    `INSERT INTO item_type (name, code)
     SELECT 'Type ' || g, 'T' || lpad(g::text, 6, '0')
     FROM generate_series(1, $1) g`,
    [PARENTS],
  );

  // Uniform: child i belongs to parent ((i - 1) % PARENTS) + 1.
  console.log(`seeding ${CHILD_ROWS.toLocaleString()} inventory_item rows (uniform)...`);
  await pool.query(
    `INSERT INTO inventory_item (type_id, sku, qty)
     SELECT ((g - 1) % $2) + 1, 'SKU' || lpad(g::text, 9, '0'), (g % 500)
     FROM generate_series(1, $1) g`,
    [CHILD_ROWS, PARENTS],
  );

  // Skewed: half the rows land on parents 1..10, the rest spread uniformly.
  console.log(`seeding ${CHILD_ROWS.toLocaleString()} inventory_hot rows (skewed)...`);
  await pool.query(
    `INSERT INTO inventory_hot (type_id, sku, qty)
     SELECT CASE WHEN g <= $1 / 2 THEN ((g - 1) % 10) + 1 ELSE ((g - 1) % $2) + 1 END,
            'SKU' || lpad(g::text, 9, '0'), (g % 500)
     FROM generate_series(1, $1) g`,
    [CHILD_ROWS, PARENTS],
  );

  console.log('analyzing...');
  await pool.query('ANALYZE item_type; ANALYZE inventory_item; ANALYZE inventory_hot;');

  const sizes = await pool.query<{ rel: string; rows: string; size: string }>(
    `SELECT relname AS rel, n_live_tup::text AS rows, pg_size_pretty(pg_total_relation_size(relid)) AS size
     FROM pg_stat_user_tables ORDER BY relname`,
  );
  for (const r of sizes.rows) console.log(`  ${r.rel.padEnd(16)} ${r.rows.padStart(9)} rows  ${r.size}`);

  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

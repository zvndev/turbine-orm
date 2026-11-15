// Shared fixture setup accepts its caller's explicit native client; no driver import.
import { fixture } from './corpus.mjs';

export const DDL = `
CREATE TABLE items (id integer PRIMARY KEY, score integer, bucket integer NOT NULL, label text NOT NULL);
CREATE TABLE tiny (LIKE items INCLUDING ALL);
CREATE TABLE parents (id integer PRIMARY KEY);
CREATE TABLE children (id integer PRIMARY KEY, parent integer NOT NULL REFERENCES parents(id), label text NOT NULL);
CREATE INDEX items_score_id ON items (score ASC NULLS LAST, id ASC) INCLUDE (bucket, label);
CREATE INDEX items_bucket_score_id ON items (bucket, score ASC NULLS LAST, id ASC) INCLUDE (label);
CREATE INDEX items_desc_score_id ON items (score DESC NULLS LAST, id ASC) INCLUDE (bucket, label);
CREATE INDEX children_parent_id ON children(parent, id);
ALTER TABLE items ALTER COLUMN score SET STATISTICS 1000;
ALTER TABLE items ALTER COLUMN bucket SET STATISTICS 1000;
`;
export async function setup(client) {
  await client.query(DDL);
  await client.query('BEGIN');
  try {
    for (const name of ['items', 'tiny']) {
      const rows = fixture(name === 'tiny' ? 17 : undefined);
      for (let i = 0; i < rows.length; i += 1000) {
        const chunk = rows.slice(i, i + 1000);
        const params = chunk.flatMap((r) => [r.id, r.score, r.bucket, r.label]);
        const binds = chunk.map((_, n) => `($${n * 4 + 1},$${n * 4 + 2},$${n * 4 + 3},$${n * 4 + 4})`).join(',');
        await client.query(`INSERT INTO ${name} VALUES ${binds}`, params);
      }
    }
    for (let id = 1; id <= 4; id++) {
      await client.query('INSERT INTO parents VALUES ($1)', [id]);
      for (let n = 1; n <= 13; n++) await client.query('INSERT INTO children VALUES ($1,$2,$3)', [(id - 1) * 13 + n, id, `child:${id}:${n}`]);
    }
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  for (const name of ['items', 'tiny', 'parents', 'children']) await client.query(`VACUUM (ANALYZE) ${name}`);
  await client.query('CHECKPOINT');
  return {
    ddl: DDL,
    indexes: (await client.query("SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY tablename,indexname")).rows,
    statistics: (await client.query("SELECT tablename,attname,null_frac,n_distinct,most_common_vals,most_common_freqs,correlation FROM pg_stats WHERE schemaname='public' ORDER BY tablename,attname")).rows,
    tables: (await client.query("SELECT relname,reltuples,relpages FROM pg_class WHERE relname IN ('items','tiny','parents','children') ORDER BY relname")).rows,
    settings: (await client.query("SELECT name,setting FROM pg_settings WHERE name IN ('fsync','synchronous_commit','full_page_writes','shared_buffers','random_page_cost','effective_cache_size','default_statistics_target','plan_cache_mode','jit','max_connections') ORDER BY name")).rows,
  };
}


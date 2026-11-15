/**
 * Fixed-width, file-backed stream resource probe. Run in separate processes:
 * node --expose-gc --import tsx src/test/sqlite-native-stream-memory.ts 20000
 * node --expose-gc --import tsx src/test/sqlite-native-stream-memory.ts 200000
 * No returned rows are collected. This measures a simple primary-key scan,
 * not arbitrary SQLite execution workspace, BLOB size or nested relation fanout.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { turbineSqlite } from '../sqlite.js';

const count = Number(process.argv[2]);
assert.ok(Number.isSafeInteger(count) && count >= 20000 && count <= 1000000);
const { DatabaseSync } = createRequire(process.cwd())('node:sqlite') as typeof import('node:sqlite');
const folder = mkdtempSync(join(tmpdir(), 'turbine-native-stream-'));
const path = join(folder, 'rows.db');
const payloadBytes = 1024;
let raw: InstanceType<typeof DatabaseSync> | undefined;
try {
  const seed = new DatabaseSync(path);
  seed.exec(`PRAGMA journal_mode=OFF; PRAGMA cache_size=-2048;
    CREATE TABLE items(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
    WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM n WHERE id<${count})
    INSERT INTO items SELECT id, replace(hex(zeroblob(${payloadBytes / 2})), '0', 'x') FROM n;`);
  seed.close();
  raw = new DatabaseSync(path);
  raw.exec('PRAGMA cache_size=-2048; PRAGMA temp_store=FILE');
  const prepare = raw.prepare.bind(raw);
  raw.prepare = (sql) => {
    const stmt = prepare(sql);
    stmt.all = () => {
      throw new Error('resource probe must not materialize with .all()');
    };
    return stmt;
  };
  const schema = schemaDefToMetadata(
    defineSchema({ items: { id: { type: 'integer', primaryKey: true }, payload: { type: 'text' } } }),
  );
  const db = turbineSqlite(raw, schema, { logger: {}, warnOnUnlimited: false });
  const table = db.table<{ id: number; payload: string }>('items');
  // Warm the exact native path before the baseline, with bounded warmup rows.
  for await (const batch of table.findManyStreamBatches({
    batchSize: 1024,
    limit: 10000,
    orderBy: { id: 'asc' },
    idleTimeoutMs: 0,
  })) {
    assert.ok(batch.length <= 1024);
  }
  global.gc?.();
  const before = process.memoryUsage();
  let peakRss = before.rss;
  let peakHeap = before.heapUsed;
  let rows = 0;
  let batches = 0;
  for await (const batch of table.findManyStreamBatches({
    batchSize: 1024,
    orderBy: { id: 'asc' },
    idleTimeoutMs: 0,
  })) {
    for (const row of batch) {
      assert.equal(row.id, ++rows);
      assert.equal(row.payload.length, payloadBytes);
      assert.equal(row.payload.charCodeAt(0), 120);
      assert.equal(row.payload.charCodeAt(payloadBytes - 1), 120);
    }
    batches++;
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
  }
  assert.equal(rows, count);
  global.gc?.();
  const after = process.memoryUsage();
  process.stdout.write(
    `${JSON.stringify({ rows, payloadBytes, batchSize: 1024, batches, beforeRss: before.rss, peakRss, afterRss: after.rss, beforeHeap: before.heapUsed, peakHeap, afterHeap: after.heapUsed, rssGrowth: peakRss - before.rss, retainedRssGrowth: after.rss - before.rss, heapGrowth: peakHeap - before.heapUsed, retainedHeapGrowth: after.heapUsed - before.heapUsed })}\n`,
  );
  await db.disconnect();
} finally {
  raw?.close();
  rmSync(folder, { recursive: true, force: true });
}

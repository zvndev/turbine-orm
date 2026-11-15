/** Logical bytea schemas and nullable native BLOBs must survive every read strategy. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const native = (() => {
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const { it } = skipGate(!native, 'requires node:sqlite (Node >= 22.5)');
it('bytea alias and BLOB null/empty/nonempty values match direct, join, batched and flatten reads', async () => {
  const raw = new native!.DatabaseSync(':memory:');
  const metadata = schemaDefToMetadata(
    defineSchema({
      parents: { id: { type: 'integer', primaryKey: true } },
      children: {
        id: { type: 'integer', primaryKey: true },
        parentId: { type: 'integer', references: 'parents.id' },
        bytes: { type: 'bytea' },
      },
    }),
  );
  raw.exec(`CREATE TABLE parents(id INTEGER PRIMARY KEY);CREATE TABLE children(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parents(id),bytes BLOB);
    INSERT INTO parents VALUES(1);INSERT INTO children VALUES(1,1,NULL),(2,1,x''),(3,1,x'00ff')`);
  const db = turbineSqlite(raw, metadata, { logger: {} });
  const relation = Object.entries(metadata.tables.parents!.relations).find(([, r]) => r.to === 'children')![0];
  const expected = [
    { id: 1, parentId: 1, bytes: null },
    { id: 2, parentId: 1, bytes: new Uint8Array() },
    { id: 3, parentId: 1, bytes: Uint8Array.of(0, 255) },
  ];
  try {
    assert.deepEqual(await db.table('children').findMany({ orderBy: { id: 'asc' } }), expected);
    for (const pgType of ['bytea', 'BLOB']) {
      const childMeta = metadata.tables.children!;
      childMeta.pgTypes!.bytes = pgType;
      childMeta.columns.find((c) => c.name === 'bytes')!.pgType = pgType;
      for (const relationLoadStrategy of ['join', 'batched', 'flatten'] as const)
        assert.deepEqual(
          await db
            .table('parents')
            .findMany({ with: { [relation]: { orderBy: { id: 'asc' } } }, relationLoadStrategy }),
          [{ id: 1, [relation]: expected }],
        );
    }
  } finally {
    await db.disconnect();
    raw.close();
  }
});

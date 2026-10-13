/**
 * turbine-orm: deferred queries on PowDB, through the public client.
 *
 * `db.pipeline(...)` and `$transaction([...])` take prebuilt statements, which
 * PowDB cannot produce. The accessor's `build*` methods must refuse with the
 * typed UnsupportedFeatureError (E017) that names the alternative, not fail
 * with `TypeError: ... is not a function`.
 *
 * Embedded PowDB, no server. Skips where the addon has no prebuilt binary.
 *
 * Run: npx tsx --test src/test/table-client-powdb-deferred.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { UnsupportedFeatureError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import type { ColumnMetadata, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

function col(name: string, tsType: string, pgType: string, opts: Partial<ColumnMetadata> = {}): ColumnMetadata {
  return {
    name,
    field: name,
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: `${pgType}[]`,
    ...opts,
  };
}

const columns = [col('id', 'number', 'int8', { isGenerated: true, hasDefault: true }), col('name', 'string', 'text')];
const schema: SchemaMetadata = {
  enums: {},
  tables: {
    member: {
      name: 'member',
      columns,
      columnMap: { id: 'id', name: 'name' },
      reverseColumnMap: { id: 'id', name: 'name' },
      dateColumns: new Set(),
      pgTypes: { id: 'int8', name: 'text' },
      allColumns: ['id', 'name'],
      primaryKey: ['id'],
      uniqueColumns: [['id']],
      relations: {},
      indexes: [],
    } as unknown as TableMetadata,
  },
} as SchemaMetadata;

// biome-ignore lint/suspicious/noExplicitAny: TurbineClient table accessors are dynamically typed at this seam.
type DB = any;

async function withDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-deferred-'));
  const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, schema, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(schema)) await db.rawUnsafe(stmt);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

function isDeferredRefusal(method: string) {
  return (err: unknown) => {
    assert.ok(err instanceof UnsupportedFeatureError, `expected E017 for ${method}, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E017');
    assert.match(err.message, new RegExp(`deferred query \\(${method}\\)`));
    assert.match(err.message, /db\.\$transaction\(async \(tx\) => \.\.\.\)/);
    return true;
  };
}

describe('PowDB: deferred queries are refused with E017', () => {
  it('db.pipeline(db.member.buildFindMany()) throws E017, not a TypeError', async () => {
    await withDb(async (db) => {
      await assert.rejects(async () => db.pipeline(db.member.buildFindMany()), isDeferredRefusal('buildFindMany'));
      await assert.rejects(
        async () => db.pipeline(db.member.buildCount(), db.member.buildFindFirst({ where: { id: 1 } })),
        isDeferredRefusal('buildCount'),
      );
    });
  });

  it('$transaction([...]) with a deferred write throws E017 and writes nothing', async () => {
    await withDb(async (db) => {
      await assert.rejects(
        async () => db.$transaction([db.member.buildCreate({ data: { name: 'a' } })]),
        isDeferredRefusal('buildCreate'),
      );
      assert.equal(await db.member.count(), 0);
    });
  });

  it('the refusal names an alternative that works: the same write in an interactive transaction', async () => {
    await withDb(async (db) => {
      await db.$transaction(async (tx: DB) => {
        await tx.member.create({ data: { name: 'a' } });
      });
      assert.equal(await db.member.count(), 1);
    });
  });

  it('inside a transaction, tx.member.buildUpdate() refuses the same way', async () => {
    await withDb(async (db) => {
      await assert.rejects(
        db.$transaction(async (tx: DB) => tx.member.buildUpdate({ where: { id: 1 }, data: { name: 'b' } })),
        isDeferredRefusal('buildUpdate'),
      );
    });
  });

  it('cacheStats() answers through the client accessor', async () => {
    await withDb(async (db) => {
      assert.deepEqual(db.member.cacheStats(), { hits: 0, misses: 0, hitRate: 0, size: 0 });
    });
  });
});

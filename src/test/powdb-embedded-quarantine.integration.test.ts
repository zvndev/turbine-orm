/**
 * The live embedded engine: on @zvndev/powdb-embedded 0.20.0 a second failed
 * write on one handle (after a first failed write whose rollback worked, and
 * the rows replaced) fails its ROLLBACK with `bad heap superblock magic`, after
 * which reads return wrong rows. The caller whose ROLLBACK failed gets a
 * ConnectionError (E004) naming it, from a nested write's implicit transaction
 * and from `$transaction` alike, and every later operation on the client is
 * refused the same way instead of reading or writing the damaged database.
 * The pool mechanics are pinned against fake handles in
 * powdb-embedded-quarantine.test.ts.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { ConnectionError } from '../errors.js';
import { UNSAFE } from '../index.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { skipGate } from './helpers.js';

let embeddedAvailable = false;
try {
  const mod = await import('@zvndev/powdb-embedded');
  embeddedAvailable = typeof mod.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

const schema = schemaDefToMetadata(
  defineSchema({
    p: {
      id: { type: 'integer', primaryKey: true },
      version: { type: 'integer', notNull: true },
      note: { type: 'text' },
    },
    c: {
      id: { type: 'integer', primaryKey: true },
      parentId: { type: 'integer', notNull: true, references: 'p.id' },
      note: { type: 'text' },
    },
  }),
);

type Db = Awaited<ReturnType<typeof turbinePowDB>>;

async function withDatabase(run: (db: Db) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-powdb-quarantine-'));
  const db = await turbinePowDB({ embedded: dir }, schema, { warnOnUnlimited: false });
  try {
    for (const statement of powqlSchemaDDL(schema)) await db.rawUnsafe(statement);
    await run(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function reset(db: Db): Promise<void> {
  await db.table('c').deleteMany({ where: {}, allowFullTableScan: UNSAFE });
  await db.table('p').deleteMany({ where: {}, allowFullTableScan: UNSAFE });
  await db.table('p').create({ data: { id: 1, version: 5, note: 'original' } });
  await db.table('c').create({ data: { id: 7, parentId: 1, note: 'existing' } });
}

/** Whatever the engine does, the caller is told the truth: the original row, or a refusal naming the ROLLBACK. */
function isQuarantine(err: unknown): boolean {
  return err instanceof ConnectionError && /A ROLLBACK on the embedded PowDB database failed/.test(err.message);
}

async function assertRefusesEverything(db: Db): Promise<void> {
  await assert.rejects(db.table('p').findUnique({ where: { id: 1 } }), isQuarantine);
  await assert.rejects(db.table('p').create({ data: { id: 2, version: 5, note: 'later' } }), isQuarantine);
  await assert.rejects(
    db.$transaction(async (tx) => {
      await tx.table('p').findMany({ limit: 1 });
    }),
    isQuarantine,
  );
}

describe('embedded PowDB after a failed ROLLBACK', () => {
  it('a nested write whose ROLLBACK failed reports it, and the client refuses what follows', async () => {
    await withDatabase(async (db) => {
      const rel = Object.keys(schema.tables.p!.relations)[0]!;
      await reset(db);
      await assert.rejects(
        db.table('p').update({ where: { id: 999 }, data: { note: 'missing', [rel]: { create: { id: 8 } } } }),
      );
      await reset(db);
      const outcome = await db
        .table('p')
        .update({ where: { id: 1 }, data: { note: 'edited', [rel]: { create: { id: 7, note: 'duplicate' } } } })
        .catch((err: unknown) => err);
      if (!isQuarantine(outcome)) {
        // An engine whose ROLLBACK works keeps the row as it was.
        assert.deepEqual(await db.table('p').findUnique({ where: { id: 1 } }), { id: 1, version: 5, note: 'original' });
        return;
      }
      await assertRefusesEverything(db);
    });
  });

  it('a $transaction whose cleanup ROLLBACK failed reports it, and the client refuses what follows', async () => {
    await withDatabase(async (db) => {
      await reset(db);
      await assert.rejects(
        db.$transaction(async (tx) => {
          await tx.table('p').update({ where: { id: 999 }, data: { note: 'missing' } });
        }),
      );
      await reset(db);
      const outcome = await db
        .$transaction(async (tx) => {
          await tx.table('p').update({ where: { id: 1 }, data: { note: 'edited' } });
          await tx.table('c').create({ data: { id: 7, parentId: 1, note: 'duplicate' } });
        })
        .catch((err: unknown) => err);
      if (!isQuarantine(outcome)) {
        assert.deepEqual(await db.table('p').findUnique({ where: { id: 1 } }), { id: 1, version: 5, note: 'original' });
        return;
      }
      await assertRefusesEverything(db);
    });
  });
});

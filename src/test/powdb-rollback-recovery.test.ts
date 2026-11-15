/** A failed rollback must not put a corrupt embedded handle back in service. Fails until fixed. */
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

describe('embedded PowDB rollback recovery', () => {
  it('retains the correct parent or fails closed after a second failed nested write', async () => {
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
    const dir = mkdtempSync(join(tmpdir(), 'turbine-powdb-rollback-recovery-'));
    const db = await turbinePowDB({ embedded: dir }, schema, { warnOnUnlimited: false });
    try {
      for (const statement of powqlSchemaDDL(schema)) await db.rawUnsafe(statement);
      const reset = async () => {
        await db.table('c').deleteMany({ where: {}, allowFullTableScan: UNSAFE });
        await db.table('p').deleteMany({ where: {}, allowFullTableScan: UNSAFE });
        await db.table('p').create({ data: { id: 1, version: 5, note: 'original' } });
        await db.table('c').create({ data: { id: 7, parentId: 1, note: 'existing' } });
      };
      const rel = Object.keys(schema.tables.p!.relations)[0]!;
      assert.ok(rel, 'the parent has a child relation');
      await reset();
      await assert.rejects(
        db.table('p').update({
          where: { id: 999 },
          data: { note: 'missing', [rel]: { create: { id: 8, note: 'new' } } },
        }),
      );
      assert.deepEqual(await db.table('p').findUnique({ where: { id: 1 } }), {
        id: 1,
        version: 5,
        note: 'original',
      });
      await reset();
      await assert.rejects(
        db.table('p').update({
          where: { id: 1 },
          data: { note: 'edited', [rel]: { create: { id: 7, note: 'duplicate' } } },
        }),
      );
      let parent: unknown;
      try {
        parent = await db.table('p').findUnique({ where: { id: 1 } });
      } catch (error) {
        assert.ok(error instanceof ConnectionError, 'an unusable handle reports a connection error');
        await assert.rejects(db.table('p').create({ data: { id: 2, version: 5, note: 'later' } }), ConnectionError);
        return;
      }
      assert.deepEqual(parent, {
        id: 1,
        version: 5,
        note: 'original',
      });
      await db.$transaction(async (tx) => {
        await tx.table('p').update({ where: { id: 1 }, data: { note: 'after' } });
      });
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

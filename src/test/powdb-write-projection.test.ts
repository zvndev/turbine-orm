/**
 * turbine-orm, `select` / `omit` on PowDB single-row writes (live, embedded)
 *
 * PowqlInterface is a PARALLEL implementation of the query surface, so an
 * argument the SQL engines honour and PowDB ignores is two engines disagreeing
 * about what a call returns. PowQL's `returning` keyword takes no column list,
 * so PowDB narrows the returned ROW rather than the statement: the result must
 * be identical to the SQL engines' (write-projection.test.ts), including the
 * refusals and the PII rule, even though the byte saving is SQL-only.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { ValidationError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import type { SchemaMetadata } from '../schema.js';
import { mockTable, skipGate } from './helpers.js';

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

function schema(): SchemaMetadata {
  const inbox = mockTable('inbox', [
    { name: 'id', field: 'id' },
    { name: 'kind', field: 'kind', pgType: 'text' },
    { name: 'body', field: 'body', pgType: 'text' },
    { name: 'secret', field: 'secret', pgType: 'text', pii: true },
  ]);
  for (const c of inbox.columns) {
    if (c.name === 'id') c.hasDefault = false;
    if (c.pgType === 'text') {
      c.tsType = 'string';
      c.nullable = c.name !== 'kind';
    }
  }
  return { tables: { inbox }, enums: {} };
}

type Inbox = { id: number; kind: string; body: string | null; secret: string | null };

describe('PowDB write select / omit', () => {
  it('create, update, upsert and delete return exactly the projection', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-powdb-wp-'));
    const s = schema();
    const db = await turbinePowDB({ embedded: dir }, s, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(s)) await db.raw([stmt] as unknown as TemplateStringsArray);
      const t = db.table<Inbox>('inbox');

      const created = await t.create({
        data: { id: 1, kind: 'a', body: 'x'.repeat(500), secret: 's' },
        select: { id: true },
      });
      assert.deepEqual(created, { id: 1 });

      const omitted = await t.create({ data: { id: 2, kind: 'b', body: 'y', secret: 's2' }, omit: { body: true } });
      assert.deepEqual(omitted, { id: 2, kind: 'b' }, 'omit leaves PII out, as on the SQL engines');

      const withPii = await t.create({ data: { id: 3, kind: 'c', secret: 'shh' }, select: { id: true, secret: true } });
      assert.deepEqual(withPii, { id: 3, secret: 'shh' }, 'an explicit select of PII is the opt-in');

      const updated = await t.update({ where: { id: 1 }, data: { kind: 'a2' }, select: { kind: true } });
      assert.deepEqual(updated, { kind: 'a2' });

      const upserted = await t.upsert({
        where: { id: 2 },
        create: { id: 2, kind: 'never' },
        update: { kind: 'b2' },
        select: { kind: true },
      });
      assert.deepEqual(upserted, { kind: 'b2' }, 'the reselect path drops the PK it forced in');

      const deleted = await t.delete({ where: { id: 3 }, omit: { body: true } });
      assert.deepEqual(deleted, { id: 3, kind: 'c' });

      const whole = await t.update({ where: { id: 1 }, data: { kind: 'a3' } });
      assert.deepEqual(Object.keys(whole).sort(), ['body', 'id', 'kind'], 'no projection: the default PII strip only');
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a bad projection before writing, with the SQL engines’ messages', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'turbine-powdb-wp-'));
    const s = schema();
    const db = await turbinePowDB({ embedded: dir }, s, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(s)) await db.raw([stmt] as unknown as TemplateStringsArray);
      const t = db.table<Inbox>('inbox');
      await assert.rejects(
        t.create({ data: { id: 9, kind: 'z' }, select: { kynd: true } as never }),
        (err) => err instanceof ValidationError && /kynd/.test(err.message),
      );
      await assert.rejects(
        t.create({ data: { id: 9, kind: 'z' }, select: { id: true }, omit: { kind: true } }),
        (err) => err instanceof ValidationError,
      );
      assert.equal(await t.count(), 0, 'nothing was written');
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

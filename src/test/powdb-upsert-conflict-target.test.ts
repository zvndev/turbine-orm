/**
 * PowDB `upsert` conflicts on the columns `where` names (live, embedded).
 *
 * On the SQL engines an upsert's `where` KEYS are its conflict target
 * (`ON CONFLICT (<where keys>)`) and `create` supplies the values compared.
 * PowqlInterface is a parallel implementation, and its native
 * `upsert … on .col` statement always named the primary key, whatever `where`
 * said. So `upsert({ where: { email } })` never found the row that already had
 * that email: it inserted a second row, or failed on the unique index,
 * depending on whether the engine enforced it.
 *
 * The matrix in powdb-option-observability.test.ts could not see this: its
 * probe changed the where VALUE, which is inert by design on every engine, and
 * read as a change only because each run bound a fresh random key.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
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
  const member = mockTable('member', [
    { name: 'id', field: 'id' },
    { name: 'email', field: 'email', pgType: 'text' },
    { name: 'name', field: 'name', pgType: 'text' },
  ]);
  for (const c of member.columns) {
    if (c.name === 'id') c.hasDefault = false;
    if (c.pgType === 'text') c.tsType = 'string';
  }
  member.uniqueColumns = [['id'], ['email']];
  return { tables: { member }, enums: {} };
}

type Member = { id: number; email: string; name: string };

async function withDb(fn: (t: ReturnType<Awaited<ReturnType<typeof turbinePowDB>>['table']>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-powdb-upsert-'));
  const s = schema();
  const db = await turbinePowDB({ embedded: dir }, s, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(s)) await db.raw([stmt] as unknown as TemplateStringsArray);
    const t = db.table<Member>('member');
    await t.create({ data: { id: 1, email: 'a@x.test', name: 'A' } });
    await fn(t as never);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('PowDB upsert: the conflict target is what `where` names', () => {
  it('an upsert keyed on a unique non-PK column updates the row that has it', async () => {
    await withDb(async (t) => {
      const row = (await t.upsert({
        where: { email: 'a@x.test' },
        create: { id: 2, email: 'a@x.test', name: 'never' },
        update: { name: 'A2' },
      })) as Member;
      assert.equal(row.id, 1, 'the existing row, not a new one with the create key');
      assert.equal(row.name, 'A2');
      assert.equal(await t.count(), 1, 'nothing was inserted');
    });
  });

  it('and inserts when no row has it', async () => {
    await withDb(async (t) => {
      const row = (await t.upsert({
        where: { email: 'b@x.test' },
        create: { id: 2, email: 'b@x.test', name: 'B' },
        update: { name: 'never' },
      })) as Member;
      assert.deepEqual(row, { id: 2, email: 'b@x.test', name: 'B' });
      assert.equal(await t.count(), 2);
    });
  });

  it('a primary-key upsert still takes the native statement and behaves the same', async () => {
    await withDb(async (t) => {
      const updated = (await t.upsert({
        where: { id: 1 },
        create: { id: 1, email: 'a@x.test', name: 'never' },
        update: { name: 'A3' },
      })) as Member;
      assert.equal(updated.name, 'A3');
      assert.equal(await t.count(), 1);
    });
  });
});

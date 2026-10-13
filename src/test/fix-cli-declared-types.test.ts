/**
 * A `tsType` declared in a `defineSchema()` file is for generated code only.
 *
 * `ColumnMetadata.tsType` is what the engines branch on (PowDB maps it to a
 * column type, MySQL decides boolean normalization from it), so a declared type
 * must never replace it. The declared type travels in `declaredTsType`, which
 * only `generateTypes` reads. Covers the metadata shape, the generated files,
 * a live embedded PowDB create/read, and a live MySQL join read.
 *
 * Run: MYSQL_URL=mysql://root@127.0.0.1:3306 MYSQL_FIX_CLI_DATABASE=turbine_dev_fix_cli \
 *   npx tsx --test src/test/fix-cli-declared-types.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { generateMetadata, generateTypes } from '../generate.js';
import { mysqlDialect, turbineMysql } from '../mysql.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { skipGate } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: table accessors are dynamically typed at this seam
type Db = any;

const MYSQL_URL = process.env.MYSQL_URL ?? process.env.MYSQL_TEST_URL ?? '';
const MYSQL_DATABASE = process.env.MYSQL_FIX_CLI_DATABASE ?? 'turbine_dev_fix_cli';

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const powdbGate = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');
const mysqlGate = skipGate(!MYSQL_URL, 'requires MYSQL_URL / MYSQL_TEST_URL pointing at a MySQL 8 server');

// Branded types are the usual reason to declare one on a scalar column.
const ID = "import('./brand.js').ItemId";
const WHEN = "import('./brand.js').Instant";
const FLAG = "import('./brand.js').Flag";

const def = defineSchema({
  fcd_items: {
    id: { type: 'serial', primaryKey: true },
    ref: { type: 'integer', notNull: true, tsType: ID },
    seenAt: { type: 'timestamptz', tsType: WHEN },
    active: { type: 'boolean', notNull: true, tsType: FLAG },
    settings: { type: 'jsonb', tsType: '{ theme: string }' },
    label: { type: 'text' },
  },
  fcd_notes: {
    id: { type: 'serial', primaryKey: true },
    itemId: { type: 'integer', notNull: true, references: 'fcd_items.id' },
    done: { type: 'boolean', notNull: true, tsType: FLAG },
  },
});

describe('a declared tsType in the metadata', () => {
  const meta = schemaDefToMetadata(def);
  const items = meta.tables.fcd_items;
  const column = (name: string) => items?.columns.find((c) => c.name === name);

  it('leaves tsType as the type mapped from the database type', () => {
    assert.equal(column('ref')?.tsType, 'number');
    assert.equal(column('seen_at')?.tsType, 'Date | null');
    assert.equal(column('active')?.tsType, 'boolean');
    assert.equal(column('settings')?.tsType, 'unknown | null');
    assert.equal(column('label')?.tsType, 'string | null');
  });

  it('carries the declared type, bare, in declaredTsType only', () => {
    const declared = (name: string) => (column(name) as { declaredTsType?: string } | undefined)?.declaredTsType;
    assert.equal(declared('ref'), ID);
    assert.equal(declared('seen_at'), WHEN);
    assert.equal(declared('active'), FLAG);
    assert.equal(declared('settings'), '{ theme: string }');
    assert.equal(declared('label'), undefined, 'a column that declared nothing has no declaredTsType');
    assert.equal('declaredTsType' in (column('label') ?? {}), false);
  });

  it('types.ts uses the declared types and adds | null for a nullable column', () => {
    const out = generateTypes(meta, { noTimestamp: true });
    assert.match(out, new RegExp(`\\n {2}ref: ${ID.replace(/[().]/g, '\\$&')};`));
    assert.match(out, new RegExp(`\\n {2}seenAt: ${WHEN.replace(/[().]/g, '\\$&')} \\| null;`));
    assert.match(out, new RegExp(`\\n {2}active: ${FLAG.replace(/[().]/g, '\\$&')};`));
    assert.match(out, /\n {2}settings: \{ theme: string \} \| null;/);
    assert.match(out, /\n {2}label: string \| null;/);
  });

  it('metadata.ts, the runtime copy, keeps the mapped type and never names the declared one', () => {
    const out = generateMetadata(meta, { noTimestamp: true });
    assert.match(out, /name: 'ref'[^}]*tsType: 'number'/);
    assert.match(out, /name: 'active'[^}]*tsType: 'boolean'/);
    assert.doesNotMatch(out, /declaredTsType/);
    assert.doesNotMatch(out, /ItemId|Instant|Flag/);
  });

  it('does not change the metadata of a schema that declares none', () => {
    const plain = defineSchema({ fcd_plain: { id: { type: 'serial', primaryKey: true }, n: { type: 'integer' } } });
    const col = schemaDefToMetadata(plain).tables.fcd_plain?.columns.find((c) => c.name === 'n');
    assert.ok(col);
    assert.equal('declaredTsType' in col, false);
    assert.equal(col.tsType, 'number | null');
  });
});

describe('a declared tsType on an embedded PowDB schema', () => {
  powdbGate.it('creates and reads integer, timestamp and boolean columns', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fix-cli-powdb-'));
    const meta = schemaDefToMetadata(def);
    const db: Db = await turbinePowDB({ embedded: dir }, meta, { warnOnUnlimited: false });
    try {
      for (const stmt of powqlSchemaDDL(meta)) await db.rawUnsafe(stmt);
      const seenAt = new Date(Date.UTC(2026, 2, 4, 5, 6, 7));
      const created = await db.fcdItems.create({ data: { ref: 7, seenAt, active: true, label: 'a' } });
      assert.equal(created.ref, 7);
      assert.equal(created.active, true);
      const read = await db.fcdItems.findFirst({ where: { ref: 7 } });
      assert.equal(read.ref, 7);
      assert.equal(typeof read.ref, 'number');
      assert.equal(read.active, true);
      assert.ok(read.seenAt instanceof Date, `seenAt is ${typeof read.seenAt}`);
      assert.equal(read.seenAt.getTime(), seenAt.getTime());
    } finally {
      await db.disconnect();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a declared tsType on a MySQL schema', () => {
  mysqlGate.it('still reads a boolean column as a boolean through a join', async () => {
    const { createPool } = await import('mysql2/promise');
    const url = new URL(MYSQL_URL);
    const base = {
      host: url.hostname,
      port: url.port ? Number(url.port) : 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
    const admin = createPool(base);
    await admin.query(`CREATE DATABASE IF NOT EXISTS \`${MYSQL_DATABASE}\``);
    await admin.end();
    const pool = createPool({ ...base, database: MYSQL_DATABASE });
    await pool.query('SET FOREIGN_KEY_CHECKS=0');
    for (const t of ['fcd_notes', 'fcd_items']) await pool.query(`DROP TABLE IF EXISTS \`${t}\``);
    await pool.query('SET FOREIGN_KEY_CHECKS=1');
    for (const stmt of schemaToSQL(def, { dialect: mysqlDialect })) await pool.query(stmt);
    await pool.end();

    const db: Db = await turbineMysql({ ...base, database: MYSQL_DATABASE }, schemaDefToMetadata(def), {
      warnOnUnlimited: false,
    });
    try {
      const item = await db.fcdItems.create({ data: { ref: 1, active: true } });
      await db.fcdNotes.create({ data: { itemId: item.id, done: true } });
      const rows = await db.fcdItems.findMany({
        where: { id: item.id },
        with: { fcdNotes: true },
        relationLoadStrategy: 'join',
      });
      const note = rows[0].fcdNotes[0];
      assert.equal(rows[0].active, true, `top-level boolean came back as ${JSON.stringify(rows[0].active)}`);
      assert.equal(note.done, true, `nested boolean came back as ${JSON.stringify(note.done)}`);
    } finally {
      await db.disconnect();
      const cleanup = createPool({ ...base, database: MYSQL_DATABASE });
      await cleanup.query('SET FOREIGN_KEY_CHECKS=0');
      for (const t of ['fcd_notes', 'fcd_items']) await cleanup.query(`DROP TABLE IF EXISTS \`${t}\``);
      await cleanup.query('SET FOREIGN_KEY_CHECKS=1');
      await cleanup.end();
    }
  });
});

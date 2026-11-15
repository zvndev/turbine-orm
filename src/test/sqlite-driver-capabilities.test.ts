/** The same native business operations run on both public SQLite bindings. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { type BetterSqlite3Database, turbineBetterSqlite3 } from '../better-sqlite3.js';
import { UnsupportedFeatureError } from '../errors.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { schemaToSQL } from '../schema-sql.js';
import { sqliteDialect, turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const require = createRequire(import.meta.url);
const native = (() => {
  try {
    return require('node:sqlite') as typeof import('node:sqlite');
  } catch {
    return undefined;
  }
})();
const peer = (() => {
  try {
    return require(process.env.TURBINE_SQLITE_BINDING_PEER ?? 'better-sqlite3') as new (
      path: string,
    ) => BetterSqlite3Database;
  } catch (error) {
    if (process.env.TURBINE_REQUIRE_SQLITE_BINDING === '1') throw error;
    return undefined;
  }
})();
const sqlite = skipGate(!native, 'SQLite capability checks require node:sqlite');
const definition = defineSchema(
  {
    parents: {
      id: { type: 'serial', primaryKey: true },
      label: { type: 'text', notNull: true },
      status: { type: 'enum', enumName: 'status', notNull: true },
    },
    children: {
      id: { type: 'serial', primaryKey: true },
      parentId: { type: 'integer', references: 'parents.id', notNull: true },
      payload: { type: 'json' },
      active: { type: 'boolean' },
    },
  },
  { enums: { status: ['open', 'closed'] } },
);
const schema = schemaDefToMetadata(definition);
const relation = Object.values(schema.tables.parents!.relations).find((r) => r.to === 'children')!.name;

for (const driver of ['builtin', 'better-sqlite3'] as const) {
  const test = driver === 'builtin' ? sqlite.it : it;
  async function fixture() {
    const raw = driver === 'builtin' ? new native!.DatabaseSync(':memory:') : new peer!(':memory:');
    raw.exec('PRAGMA foreign_keys=ON');
    for (const statement of schemaToSQL(definition, { dialect: sqliteDialect })) raw.exec(statement);
    const db =
      driver === 'builtin'
        ? turbineSqlite(raw as DatabaseSync, schema, { logger: {} })
        : await turbineBetterSqlite3(raw as BetterSqlite3Database, schema, { logger: {} });
    return {
      raw,
      db,
      close: async () => {
        await db.disconnect();
        raw.close();
      },
    };
  }
  describe(`${driver} native capabilities`, {
    skip: driver === 'better-sqlite3' && !peer && 'optional better-sqlite3 native peer is not installed',
  }, () => {
    test('nested writes and join, batched and flatten relations preserve JSON and booleans', async () => {
      const f = await fixture();
      try {
        await f.db.table('parents').create({
          data: {
            id: 1,
            label: 'parent',
            status: 'open',
            [relation]: { create: [{ id: 10, payload: { n: [true, null] }, active: true }] },
          },
        });
        const expected = [
          {
            id: 1,
            label: 'parent',
            status: 'open',
            [relation]: [{ id: 10, parentId: 1, payload: { n: [true, null] }, active: true }],
          },
        ];
        for (const relationLoadStrategy of ['join', 'batched', 'flatten'] as const) {
          assert.deepEqual(
            await f.db.table('parents').findMany({ with: { [relation]: true }, relationLoadStrategy }),
            expected,
          );
        }
        await assert.rejects(
          f.db.table('parents').create({
            data: {
              id: 2,
              label: 'rollback',
              status: 'closed',
              [relation]: { create: [{ id: 10, active: false }] },
            },
          }),
        );
        assert.equal(await f.db.table('parents').count(), 1);
        assert.equal(await f.db.table('children').count(), 1);
      } finally {
        await f.close();
      }
    });
    test('upsert, bulk conflict updates and TEXT CHECK enums retain their constraints', async () => {
      const f = await fixture();
      try {
        const table = f.db.table('parents');
        for (const label of ['created', 'updated']) {
          const row = await table.upsert({
            where: { id: 1 },
            create: { id: 1, label, status: 'open' },
            update: { label },
          });
          assert.equal(row.label, label);
        }
        const rows = await table.createMany({
          data: [
            { id: 1, label: 'bulk', status: 'closed' },
            { id: 2, label: 'second', status: 'open' },
          ],
          onConflict: { target: ['id'], update: ['label', 'status'] },
        });
        assert.equal(rows.length, 2);
        assert.equal((await table.findUnique({ where: { id: 1 } }))!.status, 'closed');
        await assert.rejects(
          f.db.rawUnsafe('INSERT INTO parents(id,label,status) VALUES($1,$2,$3)', 3, 'bad', 'invalid'),
        );
        assert.equal(await table.count(), 2);
      } finally {
        await f.close();
      }
    });
    test('nested savepoint rollback preserves the outer transaction and final rollback is atomic', async () => {
      const f = await fixture();
      try {
        await f.db.$transaction(async (tx) => {
          await tx.table('parents').create({ data: { id: 1, label: 'outer', status: 'open' } });
          await assert.rejects(
            tx.$transaction(async (nested) => {
              await nested.table('parents').create({ data: { id: 2, label: 'inner', status: 'closed' } });
              throw new Error('rollback savepoint');
            }),
            /rollback savepoint/,
          );
          assert.equal(await tx.table('parents').count(), 1);
        });
        await assert.rejects(
          f.db.$transaction(async (tx) => {
            await tx.table('parents').update({ where: { id: 1 }, data: { label: 'temporary' } });
            throw new Error('rollback outer');
          }),
          /rollback outer/,
        );
        assert.equal((await f.db.table('parents').findUnique({ where: { id: 1 } }))!.label, 'outer');
      } finally {
        await f.close();
      }
    });
    test('unsupported query shapes refuse with E017 on both bindings', async () => {
      const f = await fixture();
      try {
        const parent = f.db.table('parents');
        for (const args of [
          { distinct: ['label'] },
          { cursor: { id: 1 }, cursorPredicate: 'tuple' },
          { lock: 'update' },
          { forceCustomPlan: true },
          { where: { label: { search: 'word' } } },
          { where: { label: { in: ['word'], mode: 'insensitive' } } },
        ])
          await assert.rejects(async () => parent.findMany(args as never), UnsupportedFeatureError);
        for (const equals of [true, null, [], {}]) {
          await assert.rejects(
            f.db.table('children').findMany({ where: { payload: { path: ['v'], equals } } }),
            UnsupportedFeatureError,
          );
        }
        await assert.rejects(
          f.db.$transaction(async () => undefined, { readOnly: true }),
          UnsupportedFeatureError,
        );
      } finally {
        await f.close();
      }
    });
  });
}

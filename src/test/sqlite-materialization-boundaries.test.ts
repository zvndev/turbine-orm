/** Native evaluation, raw normalization and typed assignment remain separate. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';
import { it } from 'node:test';
import { type BetterSqlite3Database, turbineBetterSqlite3 } from '../better-sqlite3.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { turbineSqlite } from '../sqlite.js';

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
    ) => BetterSqlite3Database & { function(name: string, fn: (value: number) => number): unknown };
  } catch (error) {
    if (process.env.TURBINE_REQUIRE_SQLITE_BINDING === '1') throw error;
    return undefined;
  }
})();
const schema = schemaDefToMetadata(
  defineSchema({ items: { id: { type: 'integer', primaryKey: true }, stageValue: { type: 'integer' } } }),
);

for (const binding of ['node', 'better'] as const) {
  const available = binding === 'node' ? native : peer;
  const skip = !available && (binding === 'node' ? 'requires node:sqlite (Node >= 22.5)' : 'requires better-sqlite3');
  async function fixture() {
    const raw = binding === 'node' ? new native!.DatabaseSync(':memory:') : new peer!(':memory:');
    const db =
      binding === 'node'
        ? turbineSqlite(raw as DatabaseSync, schema, { logger: {} })
        : await turbineBetterSqlite3(raw as BetterSqlite3Database, schema, { logger: {} });
    return { raw, db, close: () => db.pool.end() };
  }

  it(`${binding}: completes native stepping before raw accessors and typed setters`, { skip }, async () => {
    const f = await fixture();
    const events: string[] = [];
    const sentinel = new Error('raw assignment boundary');
    let fail = false;
    try {
      f.raw.exec('CREATE TABLE source(id INTEGER PRIMARY KEY,v INTEGER); INSERT INTO source VALUES(1,10),(2,20)');
      f.raw.function('stage', (input: unknown) => {
        const value = Number(input);
        events.push(`native:${value}`);
        return value;
      });
      f.raw.exec('CREATE VIEW items AS SELECT id,stage(v) AS stage_value FROM source');
      Object.defineProperty(Object.prototype, 'stage_value', {
        configurable: true,
        set(value: number) {
          events.push(`raw:${value}`);
          if (fail && value === 20) throw sentinel;
          Object.defineProperty(this, 'stage_value', {
            enumerable: true,
            configurable: true,
            get() {
              events.push(`read:${value}`);
              return value + 100;
            },
          });
        },
      });
      Object.defineProperty(Object.prototype, 'stageValue', {
        configurable: true,
        set(value: number) {
          events.push(`final:${value}`);
          Object.defineProperty(this, 'stageValue', { value, enumerable: true, configurable: true });
        },
      });
      assert.deepEqual(await f.db.table('items').findMany({ orderBy: { id: 'asc' } }), [
        { id: 1, stageValue: 110 },
        { id: 2, stageValue: 120 },
      ]);
      assert.deepEqual(events, [
        'native:10',
        'native:20',
        'raw:10',
        'raw:20',
        'read:10',
        'final:110',
        'read:20',
        'final:120',
      ]);
      events.length = 0;
      fail = true;
      await assert.rejects(f.db.table('items').findMany({ orderBy: { id: 'asc' } }), (error) => error === sentinel);
      assert.deepEqual(events, ['native:10', 'native:20', 'raw:10', 'raw:20']);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'stage_value');
      Reflect.deleteProperty(Object.prototype, 'stageValue');
      await f.close();
    }
  });

  it(`${binding}: eager results do not inspect an unused native iterate getter`, { skip }, async () => {
    const f = await fixture();
    let hits = 0;
    const sentinel = new Error('unused iterator getter');
    const prepare = f.raw.prepare.bind(f.raw);
    f.raw.prepare = ((sql: string) => {
      const stmt = prepare(sql);
      Object.defineProperty(stmt, 'iterate', {
        configurable: true,
        get() {
          hits++;
          throw sentinel;
        },
      });
      return stmt;
    }) as typeof f.raw.prepare;
    try {
      f.raw.exec('CREATE TABLE items(id INTEGER PRIMARY KEY,stage_value INTEGER); INSERT INTO items VALUES(1,7),(2,8)');
      assert.deepEqual(await f.db.table('items').findMany({ orderBy: { id: 'asc' } }), [
        { id: 1, stageValue: 7 },
        { id: 2, stageValue: 8 },
      ]);
      assert.deepEqual(await f.db.rawUnsafe('SELECT id,stage_value FROM items ORDER BY id'), [
        { id: 1, stage_value: 7 },
        { id: 2, stage_value: 8 },
      ]);
      assert.equal(hits, 0);
    } finally {
      await f.close();
    }
  });

  it(`${binding}: retains exact integer policy when one SQL changes storage classes`, { skip }, async () => {
    const f = await fixture();
    try {
      f.raw.exec('CREATE TABLE mixed(v); INSERT INTO mixed VALUES(1)');
      const query = 'SELECT v FROM mixed';
      for (const [literal, expected] of [
        ['9007199254740993', '9007199254740993'],
        ['-9223372036854775808', '-9223372036854775808'],
        ["'text'", 'text'],
        ["x'00ff'", Uint8Array.of(0, 255)],
        ['NULL', null],
        ['9007199254740991', 9007199254740991],
      ] as const) {
        f.raw.exec(`UPDATE mixed SET v=${literal}`);
        assert.deepEqual(await f.db.rawUnsafe(query), [{ v: expected }]);
      }
    } finally {
      await f.close();
    }
  });
}

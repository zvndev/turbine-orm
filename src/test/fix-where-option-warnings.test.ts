/**
 * The unknown-option warning says a key "is ignored". For a key an operation
 * REFUSES by name (`limit` on updateMany, `optimisticLock` on upsert, `lock`
 * on a stream) that is false: the call throws a moment later with its own
 * message. So the warning skips the keys in REFUSED_OPTION_KEYS, and this file
 * holds every entry to its promise: each one throws, and none warns.
 *
 * Driven by the table itself, so a key added to it is covered with no edit
 * here.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import { TurbineError } from '../errors.js';
import { capabilitiesFromVersion, type PowdbPool } from '../powdb.js';
import { PowqlInterface } from '../powql.js';
import { REFUSED_OPTION_KEYS } from '../query/option-surface.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

// biome-ignore lint/suspicious/noExplicitAny: harness calls
type Any = any;

/**
 * A table name per check: the warning fires once per table, operation and key
 * per process, so a shared name would let one check's warning hide another's.
 */
const TABLE = 'fw_option_warnings';

function schema(table: string): SchemaMetadata {
  const t = mockTable(table, [
    { name: 'id', field: 'id', pgType: 'int4' },
    { name: 'name', field: 'name', pgType: 'text' },
    { name: 'version', field: 'version', pgType: 'int4' },
  ]);
  return { enums: {}, tables: { [table]: t } };
}

const VALUES: Record<string, unknown> = {
  limit: 1,
  take: 1,
  offset: 1,
  skip: 1,
  optimisticLock: { field: 'version', expected: 1 },
  lock: 'update',
};

/** Run `operation` with `extra` merged into otherwise valid args. */
async function run(qi: Any, operation: string, extra: Record<string, unknown>): Promise<void> {
  switch (operation) {
    case 'updateMany':
      await qi.updateMany({ where: { id: 1 }, data: { name: 'x' }, ...extra });
      return;
    case 'delete':
      await qi.delete({ where: { id: 1 }, ...extra });
      return;
    case 'deleteMany':
      await qi.deleteMany({ where: { id: 1 }, ...extra });
      return;
    case 'upsert':
      await qi.upsert({ where: { id: 1 }, create: { id: 1, name: 'x', version: 1 }, update: { name: 'y' }, ...extra });
      return;
    case 'findManyStream':
    case 'findManyStreamBatches':
      for await (const _ of qi[operation]({ ...extra })) break;
      return;
    default:
      throw new Error(`no args recipe for ${operation}; add one when adding the operation to REFUSED_OPTION_KEYS`);
  }
}

describe('refused option keys: refused, not warned about', () => {
  let warn: ReturnType<typeof mock.method>;
  const previous = process.env.NODE_ENV;
  before(() => {
    // The warning is dev-only; make sure this process counts as dev.
    delete process.env.NODE_ENV;
    warn = mock.method(console, 'warn', () => {});
  });
  after(() => {
    warn.mock.restore();
    if (previous !== undefined) process.env.NODE_ENV = previous;
  });

  const entries = Object.entries(REFUSED_OPTION_KEYS).flatMap(([op, keys]) =>
    [...keys].map((key) => [op, key] as const),
  );

  it('the table is not empty (a vacuous table would pass every check below)', () => {
    assert.ok(entries.length >= 10, `only ${entries.length} entries`);
  });

  for (const [operation, key] of entries) {
    it(`${operation}({ ${key} }) throws and does not warn`, async () => {
      assert.ok(key in VALUES, `no sample value for "${key}"; add one`);
      warn.mock.resetCalls();
      const table = `${TABLE}_${operation}_${key}`.toLowerCase();
      const qi = makeQuery(table, schema(table), { warnOnUnlimited: false });
      await assert.rejects(run(qi, operation, { [key]: VALUES[key] }), (err: unknown) => {
        assert.ok(err instanceof TurbineError, `${operation}.${key}: expected a TurbineError, got ${String(err)}`);
        assert.match(err.message, new RegExp(`\\b(${key}|limit|offset|lock)\\b`), 'the refusal names the key');
        return true;
      });
      const warned = warn.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.includes('unknown option'));
      assert.deepEqual(warned, [], `${operation}.${key} warned "ignored" before refusing`);
    });
  }

  it('control: a genuinely unknown key on the same operations still warns', async () => {
    warn.mock.resetCalls();
    const table = `${TABLE}_control`;
    const qi = makeQuery(table, schema(table), { warnOnUnlimited: false });
    await assert.rejects(run(qi, 'deleteMany', { include: { x: true }, limit: 1 }));
    const warned = warn.mock.calls.map((c) => String(c.arguments[0]));
    assert.ok(
      warned.some((m) => m.includes(`unknown option "include" in ${table}.deleteMany()`)),
      `expected an include warning, got ${JSON.stringify(warned)}`,
    );
  });

  it('PowDB: the bulk-write keys throw and do not warn', async () => {
    const pool = {
      capabilities: capabilitiesFromVersion('0.18.0'),
      retryStaleReads: false,
      readonly: false,
      query() {
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    } as unknown as PowdbPool;
    for (const operation of ['updateMany', 'deleteMany', 'upsert'] as const) {
      for (const key of REFUSED_OPTION_KEYS[operation] ?? []) {
        warn.mock.resetCalls();
        const table = `${TABLE}_powdb_${operation}_${key}`.toLowerCase();
        const qi = new PowqlInterface(pool, table, schema(table), [], { warnOnUnlimited: false });
        await assert.rejects(run(qi, operation, { [key]: VALUES[key] }), TurbineError, `${operation}.${key}`);
        const warned = warn.mock.calls.map((c) => String(c.arguments[0])).filter((m) => m.includes('unknown option'));
        assert.deepEqual(warned, [], `PowDB ${operation}.${key} warned "ignored" before refusing`);
      }
    }
  });
});

/**
 * PowDB refuses an operator object that names no comparison on a JSON column,
 * as the SQL engines do, instead of compiling it to a constant.
 *
 * `{ meta: { mode: 'insensitive' } }` on a json column holds only a modifier.
 * The SQL engines refuse it (E003). PowDB skipped the shared operand check for
 * JSON columns, so the filter compiled to a constant FALSE, and `NOT` turned
 * that into every row with a non-null value: a `deleteMany` carrying it
 * deleted them, and an `updateMany` rewrote them. The mass-mutation guard did
 * not stop it, because the compiled filter was not empty and the shape does
 * not fold to a constant on the SQL side (it is refused there before that).
 *
 * Every test runs the REAL in-process `@zvndev/powdb-embedded` engine and
 * asserts both the refusal and that no row was written. The message is
 * compared with the one the SQL builder raises for the same schema, so the
 * engines say the same thing.
 *
 * Run: npx tsx --test src/test/powdb-constant-filter.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe } from 'node:test';
import { ValidationError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import { QueryInterface } from '../query/index.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { skipGate } from './helpers.js';

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

// biome-ignore lint/suspicious/noExplicitAny: the cases drive hostile where shapes through an untyped accessor
type Db = any;

const SCHEMA = schemaDefToMetadata(
  defineSchema({
    docs: {
      id: { type: 'serial', primaryKey: true },
      title: { type: 'text', notNull: true },
      meta: { type: 'json' },
    },
  } as never),
);

// Three rows with a JSON value, one without. `NOT` over a constant false used
// to match the three.
const DOCS = [
  { title: 'alpha', meta: { t: 'Alpha' } },
  { title: 'beta', meta: { t: 'beta' } },
  { title: 'gamma', meta: { t: 'gamma' } },
  { title: 'empty', meta: null },
];

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function withDb<R>(fn: (db: Db) => Promise<R>): Promise<R> {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-powdb-constant-'));
  dirs.push(dir);
  const db = await turbinePowDB({ embedded: dir }, SCHEMA, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(SCHEMA)) await db.rawUnsafe(stmt);
    for (const d of DOCS) await db.table('docs').create({ data: d });
    return await fn(db);
  } finally {
    await db.disconnect();
  }
}

/** The rows as `[title, meta]`, in id order. */
async function snapshot(db: Db): Promise<unknown[]> {
  const rows = await db.table('docs').findMany({ orderBy: { id: 'asc' } });
  return rows.map((r: { title: string; meta: unknown }) => [r.title, r.meta]);
}

const BEFORE = DOCS.map((d) => [d.title, d.meta]);

/** The E003 the SQL builder raises for the same where on the same schema. */
function sqlRefusal(where: unknown): string {
  // biome-ignore lint/suspicious/noExplicitAny: build-only, no pool is touched
  const qi = new QueryInterface(null as any, 'docs', SCHEMA);
  try {
    qi.buildFindMany({ where } as never);
  } catch (err) {
    assert.ok(err instanceof ValidationError, `the SQL builder refuses with E003, got ${String(err)}`);
    return err.message;
  }
  assert.fail(`the SQL builder accepted ${JSON.stringify(where)}`);
}

/** Assert `run` is refused with exactly the SQL engines' message, and no row changed. */
async function assertRefusedLikeSql(db: Db, where: unknown, run: () => Promise<unknown>): Promise<void> {
  const expected = sqlRefusal(where);
  await assert.rejects(run, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.equal(err.message, expected);
    return true;
  });
  assert.deepEqual(await snapshot(db), BEFORE, 'no row was written');
}

const MODE_ONLY = [{ mode: 'insensitive' }, { mode: 'default' }];

describe('powdb: a JSON operator object that names no comparison is refused, not a constant', () => {
  it('deleteMany under NOT is refused and deletes nothing', async () => {
    await withDb(async (db) => {
      for (const meta of MODE_ONLY) {
        const where = { NOT: { meta } };
        await assertRefusedLikeSql(db, where, () => db.table('docs').deleteMany({ where }));
      }
    });
  });

  it('updateMany under NOT is refused and writes nothing', async () => {
    await withDb(async (db) => {
      for (const meta of MODE_ONLY) {
        const where = { NOT: { meta } };
        await assertRefusedLikeSql(db, where, () =>
          db.table('docs').updateMany({ where, data: { title: 'overwritten' } }),
        );
      }
    });
  });

  it('is refused wherever it sits: bare, beside a real condition, inside OR, AND and nested NOT', async () => {
    await withDb(async (db) => {
      const shapes = [
        { meta: { mode: 'insensitive' } },
        { title: 'alpha', NOT: { meta: { mode: 'insensitive' } } },
        { NOT: { OR: [{ title: 'beta' }, { meta: { mode: 'insensitive' } }] } },
        { NOT: { AND: [{ meta: { mode: 'insensitive' } }] } },
        { NOT: { NOT: { NOT: { meta: { mode: 'insensitive' } } } } },
      ];
      for (const where of shapes) {
        await assertRefusedLikeSql(db, where, () => db.table('docs').deleteMany({ where }));
        await assertRefusedLikeSql(db, where, () => db.table('docs').findMany({ where }));
      }
    });
  });

  it('refuses the other JSON operator objects the SQL engines refuse', async () => {
    await withDb(async (db) => {
      const shapes = [
        // A comparison with null matches no row on SQL; refused there, so a
        // NOT around it cannot become every row here.
        { NOT: { meta: { gt: null } } },
        { NOT: { meta: { lte: null } } },
        // An invalid mode is not silently read as case-sensitive.
        { NOT: { meta: { mode: 'insensitve', in: ['x'] } } },
        // A non-string operand to a string operator is not stringified.
        { NOT: { meta: { startsWith: 5 } } },
      ];
      for (const where of shapes) {
        await assertRefusedLikeSql(db, where, () => db.table('docs').deleteMany({ where }));
      }
    });
  });

  it('a JSON filter that does compare still works under NOT (the refusal is not over-broad)', async () => {
    await withDb(async (db) => {
      const where = { NOT: { meta: { path: ['t'], stringStartsWith: 'AL', mode: 'insensitive' } } };
      const rows = await db.table('docs').findMany({ where, orderBy: { id: 'asc' } });
      // The NULL document is neither TRUE nor FALSE, so NOT leaves it out, as on SQL.
      assert.deepEqual(
        rows.map((r: { title: string }) => r.title),
        ['beta', 'gamma'],
      );
      const { count } = await db.table('docs').deleteMany({ where });
      assert.equal(count, 2);
      assert.deepEqual(
        (await snapshot(db)).map((r) => (r as unknown[])[0]),
        ['alpha', 'empty'],
      );
    });
  });
});

/**
 * turbine-orm: a nested write nobody awaited must not commit half of itself on
 * PowDB, an engine with no savepoints (so the guard cannot lean on one).
 *
 * The callback returns the instant the parent INSERT's reply arrives, which is
 * when the nested write sits between its first statement and its second. The
 * transaction has to refuse and roll back; before it did, the parent row was
 * committed without its children.
 *
 * Embedded PowDB, no server. Skips where the addon has no prebuilt binary.
 *
 * Run: npx tsx --test src/test/fix-txerr-powdb-unawaited.test.ts
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'node:test';
import { ValidationError } from '../errors.js';
import { powqlSchemaDDL, turbinePowDB } from '../powdb.js';
import type { ColumnMetadata, RelationDef, SchemaMetadata, TableMetadata } from '../schema.js';
import { skipGate } from './helpers.js';

let embeddedAvailable = false;
try {
  const mod = (await import('@zvndev/powdb-embedded')) as { Database?: { open?: unknown } };
  embeddedAvailable = typeof mod?.Database?.open === 'function';
} catch {
  embeddedAvailable = false;
}
const { it } = skipGate(!embeddedAvailable, 'requires @zvndev/powdb-embedded (no prebuilt binary on this platform)');

function col(
  name: string,
  field: string,
  tsType: string,
  pgType: string,
  opts: Partial<ColumnMetadata> = {},
): ColumnMetadata {
  return {
    name,
    field,
    pgType,
    tsType,
    nullable: false,
    hasDefault: false,
    isArray: false,
    pgArrayType: 'text[]',
    ...opts,
  };
}

function table(name: string, columns: ColumnMetadata[], relations: Record<string, RelationDef> = {}): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    pgTypes: Object.fromEntries(columns.map((c) => [c.name, c.pgType])),
    allColumns: columns.map((c) => c.name),
    primaryKey: ['id'],
    uniqueColumns: [['id']],
    relations,
    indexes: [],
  } as unknown as TableMetadata;
}

const schema: SchemaMetadata = {
  enums: {},
  tables: {
    member: table(
      'member',
      [
        col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
        col('name', 'name', 'string', 'text'),
      ],
      {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'member',
          to: 'ppost',
          foreignKey: 'member_id',
          referenceKey: 'id',
        } as RelationDef,
      },
    ),
    ppost: table(
      'ppost',
      [
        col('id', 'id', 'number', 'int8', { isGenerated: true, hasDefault: true }),
        col('member_id', 'memberId', 'number', 'int8'),
        col('title', 'title', 'string', 'text'),
      ],
      {
        author: {
          type: 'belongsTo',
          name: 'author',
          from: 'ppost',
          to: 'member',
          foreignKey: 'member_id',
          referenceKey: 'id',
        } as RelationDef,
      },
    ),
  },
} as SchemaMetadata;

// biome-ignore lint/suspicious/noExplicitAny: TurbineClient table accessors are dynamically typed at this seam.
type DB = any;

async function withDb(fn: (db: DB) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'powdb-unawaited-'));
  const db: DB = await turbinePowDB({ embedded: dir, syncMode: 'normal' }, schema, { warnOnUnlimited: false });
  try {
    for (const stmt of powqlSchemaDDL(schema)) await db.rawUnsafe(stmt);
    await fn(db);
  } finally {
    await db.disconnect();
    rmSync(dir, { recursive: true, force: true });
  }
}

const nested = (name: string) => ({
  data: { name, posts: { create: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] } },
});

describe('PowDB: a nested write that is never awaited does not commit half of itself', () => {
  it('returning between the parent insert and the children: E003, nothing committed, every round', async () => {
    await withDb(async (db) => {
      // Fire `onParentInserted` when the parent INSERT's reply is about to be returned.
      let onParentInserted: (() => void) | undefined;
      const pool = db.pool;
      const connect = pool.connect.bind(pool);
      pool.connect = async () => {
        const client = await connect();
        const query = client.query.bind(client);
        client.query = async (...args: unknown[]) => {
          const first = args[0] as string | { text: string };
          const text = typeof first === 'string' ? first : first.text;
          const result = await query(...args);
          if (/^insert\s+member\b/i.test(text) && onParentInserted) {
            const fire = onParentInserted;
            onParentInserted = undefined;
            fire();
          }
          return result;
        };
        return client;
      };

      const rounds = 10;
      let fired = 0;
      for (let round = 0; round < rounds; round++) {
        const name = `half${round}`;
        let stray: Promise<unknown> | undefined;
        const gate = new Promise<void>((resolve) => {
          onParentInserted = () => {
            fired++;
            resolve();
          };
        });
        await assert.rejects(
          db.$transaction(async (tx: DB) => {
            stray = tx.table('member').create(nested(name));
            stray?.catch(() => {});
            await gate;
            return 'ok';
          }),
          (err: unknown) => {
            assert.ok(err instanceof ValidationError, `round ${round}: expected ValidationError, got ${String(err)}`);
            assert.equal(err.code, 'TURBINE_E003');
            assert.match(
              err.message,
              /callback returned while a query it started on the transaction was still running/,
            );
            return true;
          },
        );
        await stray?.catch(() => {});
        const members = await db.table('member').findMany({ where: { name } });
        const posts = await db.table('ppost').findMany({});
        assert.equal(members.length, 0, `round ${round}: the parent row was committed without its children`);
        assert.equal(posts.length, 0, `round ${round}: child rows were committed`);
      }
      assert.equal(fired, rounds, 'the callback returned inside the gap in every round');
    });
  });

  it('control: the same write, awaited, commits the parent and all three children', async () => {
    await withDb(async (db) => {
      await db.$transaction(async (tx: DB) => {
        await tx.table('member').create(nested('whole'));
      });
      const members = await db.table('member').findMany({ where: { name: 'whole' } });
      assert.equal(members.length, 1);
      const posts = await db.table('ppost').findMany({ where: { memberId: members[0].id } });
      assert.equal(posts.length, 3);
    });
  });
});

/**
 * A nested write exactly at the depth limit reads back whole.
 *
 * The write walk accepts rows down to depth 10 (MAX_DEPTH) and the read-back
 * `with` clause follows the written tree to the same depth. A row at the last
 * level may still carry a relation operation that writes nothing below it
 * (`connect`), and the read-back must stop at that row rather than ask for
 * one more level: the builder refuses a `with` tree eleven levels deep
 * (CircularRelationError), so asking for it would fail a write that was
 * accepted, after its rows were written.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import { CircularRelationError } from '../errors.js';
import { executeNestedCreate, type NestedWriteContext } from '../nested-write.js';
import type { SchemaMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { turbineSqlite } from '../sqlite.js';
import { makeQuery, skipGate } from './helpers.js';

const hasNodeSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const sqliteGate = skipGate(!hasNodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

/** `nodes(id, parent_id -> nodes.id, label)`, its relations named `children` and `parent`. */
const meta: SchemaMetadata = (() => {
  const base = schemaDefToMetadata(
    defineSchema({
      nodes: {
        id: { type: 'integer', primaryKey: true },
        parentId: { type: 'integer', references: 'nodes.id' },
        label: { type: 'text', notNull: true },
      },
    }),
  );
  const nodes = base.tables.nodes!;
  return {
    ...base,
    tables: {
      nodes: {
        ...nodes,
        relations: {
          children: { ...nodes.relations.nodes!, name: 'children' },
          parent: { ...nodes.relations.node!, name: 'parent' },
        },
      },
    },
  };
})();

/** The depth limit the write walk and the read-back share. */
const LIMIT = 10;

/**
 * A create chain whose deepest written rows sit at depth {@link LIMIT}, the
 * last of them connecting the existing node `connectId` as its child.
 */
function chain(connectId: number): Record<string, unknown> {
  let node: Record<string, unknown> = { label: `n${LIMIT}`, children: { connect: [{ id: connectId }] } };
  for (let depth = LIMIT - 1; depth >= 0; depth--) node = { label: `n${depth}`, children: { create: [node] } };
  return node;
}

/** How many `children` levels a read-back `with` clause asks for. */
function levels(withClause: unknown): number {
  let n = 0;
  let at = withClause as Record<string, unknown> | true | undefined;
  while (at && at !== true && 'children' in at) {
    n++;
    const next = at.children as { with?: Record<string, unknown> } | true;
    at = next === true ? undefined : next.with;
  }
  return n;
}

/** A nested-write context over in-memory tables, recording every read-back. */
function recordingCtx() {
  const reads: unknown[] = [];
  let id = 100;
  const table = () => ({
    async create(args: { data: Record<string, unknown> }) {
      return { id: id++, ...args.data };
    },
    async createMany(args: { data: Record<string, unknown>[] }) {
      return args.data.map((row) => ({ id: id++, ...row }));
    },
    async update(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      return { ...args.where, ...args.data };
    },
    async updateMany() {
      return { count: 1 };
    },
    async findMany() {
      return [];
    },
    async findUnique(args: { where: Record<string, unknown>; with?: unknown }) {
      reads.push(args.with);
      return { ...args.where };
    },
  });
  const ctx = { schema: meta, tx: { table } } as unknown as NestedWriteContext;
  return { ctx, reads };
}

describe('a nested write exactly at the depth limit reads back whole', () => {
  it('the read-back asks for every written level and no deeper, and the builder accepts it', async () => {
    const { ctx, reads } = recordingCtx();
    await executeNestedCreate(ctx, 'nodes', chain(1));
    // The root's read-back is the last one, after every level below it.
    const rootWith = reads.at(-1);
    assert.equal(
      levels(rootWith),
      LIMIT,
      `the read-back asks for ${levels(rootWith)} levels: ${JSON.stringify(rootWith)}`,
    );
    makeQuery('nodes', meta).buildFindUnique({ where: { id: 1 }, with: rootWith as never });
  });

  it('one level more than the limit is what the builder refuses (control)', () => {
    let deeper: unknown = true;
    for (let i = 0; i < LIMIT; i++) deeper = { with: { children: deeper } };
    assert.equal(levels({ children: deeper }), LIMIT + 1);
    assert.throws(
      () => makeQuery('nodes', meta).buildFindUnique({ where: { id: 1 }, with: { children: deeper } as never }),
      CircularRelationError,
    );
  });

  sqliteGate.it('on SQLite: the create succeeds and returns all ten levels below the root', async () => {
    const db = turbineSqlite(':memory:', meta);
    try {
      await db.raw`CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES nodes(id), label TEXT NOT NULL)`;
      await db.raw`INSERT INTO nodes (id, label) VALUES (1, 'existing')`;
      type Node = { label: string; children?: Node[] };
      const root = (await db.table('nodes').create({ data: chain(1) as never })) as unknown as Node;
      const labels: string[] = [];
      let at: Node | undefined = root;
      while (at) {
        labels.push(at.label);
        at = at.children?.[0];
      }
      assert.deepEqual(
        labels,
        Array.from({ length: LIMIT + 1 }, (_, depth) => `n${depth}`),
      );
      // The connected node is linked in the database; the read-back stops at the last written level.
      const linked = await db.table('nodes').findUnique({ where: { id: 1 } });
      assert.notEqual((linked as { parentId: number | null }).parentId, null);
    } finally {
      await db.disconnect();
    }
  });
});

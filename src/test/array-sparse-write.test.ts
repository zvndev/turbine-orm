/**
 * A sparse array is never written to an array column.
 *
 * A JS array with a hole (`new Array(1)`, `[['a'], new Array(1)]`) reads the
 * hole as `undefined`, but node-postgres binds it as NULL, so writing one
 * stored `{NULL}` while the same value as a `where` operand is refused with
 * E003. Write data now refuses it the same way, naming the field, before any
 * statement is sent: create, createMany, update / updateMany (a plain value
 * and `{ set }`), upsert `create` and `update`, the update template's
 * cache-hit param collect, and nested writes at any depth. A JSON column keeps
 * the baseline: the array is serialized as JSON does it (a hole is `null`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineClient } from '../client.js';
import { ValidationError } from '../errors.js';
import { assertNestedArrayWrites } from '../nested-write.js';
import type { PgCompatPool } from '../pg-types.js';
import type { SchemaMetadata } from '../schema.js';
import { makeQuery, mockTable } from './helpers.js';

function schema(): SchemaMetadata {
  return {
    enums: {},
    tables: {
      docs: mockTable(
        'docs',
        [
          { name: 'id', field: 'id', pgType: 'int4' },
          { name: 'tags', field: 'tags', pgType: '_text', unique: true },
          { name: 'grid', field: 'grid', pgType: '_int4' },
          { name: 'payload', field: 'payload', pgType: 'jsonb' },
          { name: 'note', field: 'note', pgType: 'text' },
        ],
        {
          holders: {
            type: 'hasMany',
            name: 'holders',
            from: 'docs',
            to: 'holders',
            foreignKey: 'doc_id',
            referenceKey: 'id',
          },
        },
      ),
      holders: mockTable(
        'holders',
        [
          { name: 'id', field: 'id', pgType: 'int4' },
          { name: 'doc_id', field: 'docId', pgType: 'int4' },
          { name: 'labels', field: 'labels', pgType: '_text' },
        ],
        {
          doc: {
            type: 'belongsTo',
            name: 'doc',
            from: 'holders',
            to: 'docs',
            foreignKey: 'doc_id',
            referenceKey: 'id',
          },
        },
      ),
    },
  };
}

const docs = () => makeQuery('docs', schema());

function sparseRefusal(field: string) {
  return (err: unknown) => {
    assert.ok(err instanceof ValidationError, String(err));
    assert.equal(err.code, 'TURBINE_E003');
    assert.ok(err.message.includes(`"${field}"`), err.message);
    assert.match(err.message, /sparse array/);
    return true;
  };
}

const SPARSE: [string, () => unknown[]][] = [
  ['a top-level hole', () => new Array(1)],
  ['a hole at depth', () => [['a'], new Array(1)]],
  ['a hole between values', () => Object.assign(new Array(3), { 0: 'a', 2: 'b' })],
];

describe('write data refuses a sparse array on an array column', () => {
  for (const [label, make] of SPARSE) {
    it(`${label}: create, createMany, update, updateMany and upsert`, () => {
      const refused = sparseRefusal('tags');
      assert.throws(() => docs().buildCreate({ data: { id: 1, tags: make() } } as never), refused);
      assert.throws(
        () =>
          docs().buildCreateMany({
            data: [
              { id: 1, tags: ['a'] },
              { id: 2, tags: make() },
            ],
          } as never),
        refused,
      );
      assert.throws(() => docs().buildUpdate({ where: { id: 1 }, data: { tags: make() } } as never), refused);
      assert.throws(() => docs().buildUpdate({ where: { id: 1 }, data: { tags: { set: make() } } } as never), refused);
      assert.throws(() => docs().buildUpdateMany({ where: { note: 'n' }, data: { tags: make() } } as never), refused);
      assert.throws(
        () => docs().buildUpsert({ where: { id: 1 }, create: { id: 1, tags: make() }, update: { note: 'u' } } as never),
        refused,
      );
      assert.throws(
        () => docs().buildUpsert({ where: { id: 1 }, create: { id: 1, note: 'c' }, update: { tags: make() } } as never),
        refused,
      );
    });
  }

  it('on another array column, named by its own field', () => {
    assert.throws(
      () => docs().buildCreate({ data: { id: 1, grid: [[1], new Array(2)] } } as never),
      sparseRefusal('grid'),
    );
  });

  it('a warm update template does not let the cache-hit collect bind it', () => {
    const q = docs();
    q.buildUpdate({ where: { id: 1 }, data: { tags: ['a'] } } as never);
    assert.throws(
      () => q.buildUpdate({ where: { id: 1 }, data: { tags: new Array(1) } } as never),
      sparseRefusal('tags'),
    );
  });

  it('a dense array, and an explicit null element, still bind as one value', () => {
    const { params } = docs().buildCreate({ data: { id: 1, tags: ['a', null], grid: [[1], [2]] } } as never);
    assert.deepEqual(params, [1, ['a', null], [[1], [2]]]);
  });
});

describe('a JSON column keeps the baseline serialization', () => {
  it('a hole is written as JSON null, on create and update', () => {
    const sparse = Object.assign(new Array(3), { 0: 1, 2: 3 });
    assert.deepEqual(docs().buildCreate({ data: { id: 1, payload: sparse } } as never).params, [1, '[1,null,3]']);
    assert.deepEqual(docs().buildUpdate({ where: { id: 1 }, data: { payload: new Array(1) } } as never).params, [
      '[null]',
      1,
    ]);
  });
});

describe('a nested write refuses it before any statement is sent', () => {
  function client() {
    const sent: string[] = [];
    const query = async (config: string | { text: string }) => {
      sent.push(typeof config === 'string' ? config : config.text);
      return { rows: [{ id: 1, doc_id: 1 }], rowCount: 1, fields: [] };
    };
    const pool = { query, connect: async () => ({ query, release: () => {} }), end: async () => {} };
    const db = new TurbineClient({ pool: pool as unknown as PgCompatPool }, schema());
    return { db, sent };
  }

  for (const [label, make] of SPARSE) {
    it(`${label}: in a child create, a child update, and a parent reached through belongsTo`, async () => {
      const cases: [string, (db: TurbineClient) => Promise<unknown>][] = [
        [
          'labels',
          (db) => db.table('docs').create({ data: { id: 1, holders: { create: [{ id: 1, labels: make() }] } } }),
        ],
        [
          'labels',
          (db) =>
            db.table('docs').update({
              where: { id: 1 },
              data: { holders: { updateMany: { where: { id: 1 }, data: { labels: { set: make() } } } } },
            }),
        ],
        ['tags', (db) => db.table('holders').create({ data: { id: 1, doc: { create: { id: 1, tags: make() } } } })],
        [
          'tags',
          (db) =>
            db.table('docs').upsert({
              where: { id: 1 },
              create: { id: 1, holders: { create: { id: 2, doc: { create: { id: 2, tags: make() } } } } },
              update: { note: 'u' },
            }),
        ],
      ];
      for (const [field, run] of cases) {
        const { db, sent } = client();
        await assert.rejects(() => run(db), sparseRefusal(field));
        assert.deepEqual(sent, []);
      }
    });
  }
});

/**
 * The nested pre-check reads a write the way the nested-write engine does: a
 * relation payload's rows sit under `create`, `connectOrCreate.create`,
 * `update.data` and `upsert.create` / `upsert.update`, and a `where` is a
 * selector. Walking objects generically instead took a payload's `data`
 * wrapper for a child column named `data`, stopped there, and let the
 * parent's own UPDATE run before the bind-time check refused the value.
 * Every grammar word is tried as a JSON column, as an array column, and as
 * a relation name, one and two relation levels down.
 */
describe('the nested pre-check follows the nested-write grammar', () => {
  const WORDS = ['data', 'where', 'create', 'update', 'set'] as const;
  type Variant = 'a JSON column' | 'an array column' | 'a relation';
  const VARIANTS: Variant[] = ['a JSON column', 'an array column', 'a relation'];

  function grammarSchema(word: string, variant: Variant): SchemaMetadata {
    const extra =
      variant === 'a relation'
        ? []
        : [{ name: word, field: word, pgType: variant === 'a JSON column' ? 'jsonb' : '_text' }];
    const kidRel = variant === 'a relation' ? word : 'kids';
    const grandRel = variant === 'a relation' ? word : 'grands';
    const columns = (fk: string) => [
      { name: 'id', field: 'id', pgType: 'int4' },
      { name: fk, field: fk, pgType: 'int4' },
      { name: 'note', field: 'note', pgType: 'text' },
      { name: 'tags', field: 'tags', pgType: '_text' },
      ...extra,
    ];
    const hasMany = (name: string, from: string, to: string, fk: string) => ({
      [name]: { type: 'hasMany' as const, name, from, to, foreignKey: fk, referenceKey: 'id' },
    });
    return {
      enums: {},
      tables: {
        p: mockTable(
          'p',
          [
            { name: 'id', field: 'id', pgType: 'int4' },
            { name: 'note', field: 'note', pgType: 'text' },
            { name: 'tags', field: 'tags', pgType: '_text' },
          ],
          hasMany(kidRel, 'p', 'k', 'p_id'),
        ),
        k: mockTable('k', columns('p_id'), hasMany(grandRel, 'k', 'g', 'k_id')),
        g: mockTable('g', columns('k_id')),
      },
    };
  }

  function recordingClient(s: SchemaMetadata) {
    const sent: string[] = [];
    const query = async (config: string | { text: string }) => {
      sent.push(typeof config === 'string' ? config : config.text);
      return { rows: [{ id: 1, p_id: 1, k_id: 1 }], rowCount: 1, fields: [] };
    };
    const pool = { query, connect: async () => ({ query, release: () => {} }), end: async () => {} };
    return { db: new TurbineClient({ pool: pool as unknown as PgCompatPool }, s), sent };
  }

  type Row = Record<string, unknown>;
  // Each operation wraps a row of the related table the way the engine reads it.
  const OPS: Record<string, (row: Row) => Row> = {
    create: (row) => ({ create: { id: 1, ...row } }),
    connectOrCreate: (row) => ({ connectOrCreate: { where: { id: 1 }, create: { id: 1, ...row } } }),
    update: (row) => ({ update: { where: { id: 1 }, data: row } }),
    upsertCreate: (row) => ({ upsert: { where: { id: 1 }, create: { id: 1, ...row }, update: { note: 'u' } } }),
    upsertUpdate: (row) => ({ upsert: { where: { id: 1 }, create: { id: 1 }, update: row } }),
  };
  // [outer operation, the one a row it writes uses one level further down]
  const CHAINS: [string, string][] = [
    ['create', 'create'],
    ['connectOrCreate', 'connectOrCreate'],
    ['update', 'update'],
    ['upsertCreate', 'create'],
    ['upsertUpdate', 'upsertUpdate'],
  ];
  const isUpdateRow = (op: string) => op === 'update' || op === 'upsertUpdate';

  for (const word of WORDS) {
    for (const variant of VARIANTS) {
      it(`${variant} named "${word}"`, async () => {
        const s = grammarSchema(word, variant);
        const kidRel = variant === 'a relation' ? word : 'kids';
        const grandRel = variant === 'a relation' ? word : 'grands';
        const field = variant === 'an array column' ? word : 'tags';
        const { db, sent } = recordingClient(s);
        for (const [hole, make] of SPARSE.slice(0, 2)) {
          // The row that carries the hole: an array column named like an
          // operation takes it (as `{ set }` in update data); otherwise the
          // hole goes to `tags`, next to a JSON column holding a hole of its
          // own, which stays JSON.
          const leaf = (op: string): Row => {
            const value = variant === 'an array column' && isUpdateRow(op) ? { set: make() } : make();
            return { [field]: value, ...(variant === 'a JSON column' ? { [word]: [1, make()] } : {}) };
          };
          for (const [outer, inner] of CHAINS) {
            for (const depth of [1, 2]) {
              const kidRow = depth === 1 ? leaf(outer) : { note: 'k', [grandRel]: OPS[inner]!(leaf(inner)) };
              const payload = { [kidRel]: OPS[outer]!(kidRow) };
              const label = `${hole}, ${outer} at depth ${depth}`;
              sent.length = 0;
              await assert.rejects(
                () =>
                  outer === 'create' || outer === 'connectOrCreate'
                    ? db.table('p').create({ data: { id: 1, note: 'p', ...payload } })
                    : db.table('p').update({ where: { id: 1 }, data: { note: 'p', ...payload } }),
                (err: unknown) => {
                  assert.ok(err instanceof ValidationError, `${label}: ${String(err)}`);
                  assert.ok(err.message.includes(`"${field}"`), `${label}: ${err.message}`);
                  assert.match(err.message, /sparse array/, label);
                  return true;
                },
              );
              assert.deepEqual(sent, [], `${label}: a statement was sent before the refusal`);
            }
          }
        }
      });
    }
  }

  it('a hole in a JSON column at any depth is not refused, and a where is not a row', () => {
    for (const word of WORDS) {
      const s = grammarSchema(word, 'a JSON column');
      const jsonOnly = { [word]: [['a'], new Array(1)] };
      for (const [outer, inner] of CHAINS) {
        const kidRow = { ...jsonOnly, grands: OPS[inner]!(jsonOnly) };
        assert.doesNotThrow(() => assertNestedArrayWrites(s, 'p', { note: 'p', kids: OPS[outer]!(kidRow) }), word);
      }
      // A selector is compiled (and its operands checked) by the where
      // compiler; the pre-check reads only the rows that are written.
      assert.doesNotThrow(() => assertNestedArrayWrites(s, 'p', { kids: { connect: { tags: new Array(1) } } }));
    }
  });
});

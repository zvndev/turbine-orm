/**
 * A nested `upsert` reads back the rows written below the row it created
 * or updated, like `create` and `connectOrCreate` do. The read-back
 * `with` clause follows every operation that can write a related row;
 * leaving `upsert` out returned the child without its grandchildren
 * while the database held them.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe } from 'node:test';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

const hasNodeSqlite = (() => {
  try {
    createRequire(process.cwd())('node:sqlite');
    return true;
  } catch {
    return false;
  }
})();

const sqliteGate = skipGate(!hasNodeSqlite, 'turbine-orm/sqlite requires node:sqlite (Node >= 22.5)');

const meta = schemaDefToMetadata(
  defineSchema({
    authors: {
      id: { type: 'integer', primaryKey: true },
      name: { type: 'text', notNull: true },
    },
    events: {
      id: { type: 'integer', primaryKey: true },
      authorId: { type: 'integer', notNull: true, references: 'authors.id' },
      title: { type: 'text' },
    },
    notes: {
      id: { type: 'integer', primaryKey: true },
      eventId: { type: 'integer', notNull: true, references: 'events.id' },
      body: { type: 'text', notNull: true },
    },
  }),
);

const DDL = [
  'CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
  'CREATE TABLE events (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES authors(id), title TEXT)',
  'CREATE TABLE notes (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), body TEXT NOT NULL)',
];

interface Event {
  title: string | null;
  notes?: { body: string }[];
}
interface Author {
  id: number;
  events: Event[];
}

async function open() {
  const db = await turbineSqlite(':memory:', meta);
  for (const statement of DDL) await db.rawUnsafe(statement);
  return db;
}

describe('nested upsert reads back below the row it wrote', () => {
  sqliteGate.it('the create branch returns its nested rows', async () => {
    const db = await open();
    try {
      const first = (await db.table('authors').create({ data: { name: 'upsert-create' } })) as unknown as Author;
      const made = (await db.table('authors').update({
        where: { id: first.id },
        data: {
          events: {
            upsert: {
              where: { id: 999 },
              create: { id: 999, title: 'created', notes: { create: [{ body: 'a' }, { body: 'b' }] } },
              update: { title: 'updated' },
            },
          },
        },
      })) as unknown as Author;
      assert.equal(made.events[0]?.title, 'created');
      assert.deepEqual((made.events[0]?.notes ?? []).map((n) => n.body).sort(), ['a', 'b']);
      assert.deepEqual(await db.rawUnsafe('SELECT body FROM notes ORDER BY body'), [{ body: 'a' }, { body: 'b' }]);
    } finally {
      await db.disconnect();
    }
  });

  sqliteGate.it('the update branch returns the rows it already has when its create names them', async () => {
    const db = await open();
    try {
      const first = (await db.table('authors').create({ data: { name: 'first' } })) as unknown as Author;
      await db.rawUnsafe(`INSERT INTO events (id, author_id, title) VALUES (7, ${first.id}, 'existing')`);
      await db.rawUnsafe(`INSERT INTO notes (event_id, body) VALUES (7, 'kept')`);
      const made = (await db.table('authors').update({
        where: { id: first.id },
        data: {
          events: {
            upsert: {
              where: { id: 7 },
              create: { id: 7, title: 'created', notes: { create: { body: 'new' } } },
              update: { title: 'renamed' },
            },
          },
        },
      })) as unknown as Author;
      assert.equal(made.events[0]?.title, 'renamed');
      assert.deepEqual(
        (made.events[0]?.notes ?? []).map((n) => n.body),
        ['kept'],
      );
    } finally {
      await db.disconnect();
    }
  });
});

/**
 * A nested write returns the whole tree it wrote, whatever the child's columns
 * are called.
 *
 * The read-back `with` clause is built from the data. It used to decide where
 * a nested operation's rows sat by looking at the row's own keys: any item
 * with a `data`, `create` or `update` key was taken for an `{ where, data }`
 * or `{ where, create, update }` wrapper. A created child row that has a
 * COLUMN with one of those names (a JSON `data` column is the common one) was
 * therefore read as a wrapper, its own relation writes were not seen, and the
 * returned child came back without the grandchildren that had just been
 * written. The rows were always written; only the returned tree was short.
 *
 * Two more ways the same clause came up short, with ordinary column names:
 * sibling rows that both wrote a relation kept only the LAST sibling's deeper
 * relations (so the result depended on the order of the rows), and a row
 * created through `connectOrCreate` was never followed below its own level.
 *
 * And one way the write accepted more than the read can return: a tree
 * deeper than the nesting limit was written when its last level had no
 * nested rows of its own, or when the depth came from `update` or
 * `connectOrCreate` rather than `create`, and the returned tree stopped at
 * the limit. Such a write is refused before any statement.
 *
 * Run: npx tsx --test src/test/nested-write-read-back-columns.test.ts
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe } from 'node:test';
import { CircularRelationError } from '../errors.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { turbineSqlite } from '../sqlite.js';
import { skipGate } from './helpers.js';

/** node:sqlite is a builtin only on Node >= 22.5; probe without a static import. */
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
      // Three columns named like the keys of a nested operation's wrapper.
      data: { type: 'jsonb' },
      create: { type: 'text' },
      update: { type: 'text' },
    },
    notes: {
      id: { type: 'integer', primaryKey: true },
      eventId: { type: 'integer', notNull: true, references: 'events.id' },
      body: { type: 'text', notNull: true },
    },
    marks: {
      id: { type: 'integer', primaryKey: true },
      noteId: { type: 'integer', notNull: true, references: 'notes.id' },
      who: { type: 'text', notNull: true },
    },
    // A table that references itself, to nest as deep as a test asks.
    nodes: {
      id: { type: 'integer', primaryKey: true },
      parentId: { type: 'integer', references: 'nodes.id' },
      label: { type: 'text' },
    },
  }),
);

const DDL = [
  'CREATE TABLE authors (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
  'CREATE TABLE events (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES authors(id), ' +
    'title TEXT, data TEXT, "create" TEXT, "update" TEXT)',
  'CREATE TABLE notes (id INTEGER PRIMARY KEY, event_id INTEGER NOT NULL REFERENCES events(id), body TEXT NOT NULL)',
  'CREATE TABLE marks (id INTEGER PRIMARY KEY, note_id INTEGER NOT NULL REFERENCES notes(id), who TEXT NOT NULL)',
  'CREATE TABLE nodes (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES nodes(id), label TEXT)',
];

interface Note {
  body: string;
  marks?: { who: string }[];
}
interface Event {
  id: number;
  title: string | null;
  data: unknown;
  create: string | null;
  update: string | null;
  notes?: Note[];
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

const bodies = (event: Event | undefined) => (event?.notes ?? []).map((n) => n.body).sort();

describe('a nested write reads back the rows under a child that has a column named like an operation key', () => {
  // The control: no such column is written, so the old key test never fired.
  sqliteGate.it('control: a child with ordinary columns returns its nested rows', async () => {
    const db = await open();
    try {
      const made = (await db.table('authors').create({
        data: {
          name: 'plain',
          events: { create: { title: 'plain', notes: { create: [{ body: 'a' }, { body: 'b' }] } } },
        },
      })) as unknown as Author;
      assert.deepEqual(bodies(made.events[0]), ['a', 'b']);
    } finally {
      await db.disconnect();
    }
  });

  for (const [column, value] of [
    ['data', { kind: 'signup', n: 1 }],
    ['create', 'c'],
    ['update', 'u'],
  ] as const) {
    sqliteGate.it(`create: a child row that sets its "${column}" column returns its nested rows`, async () => {
      const db = await open();
      try {
        const made = (await db.table('authors').create({
          data: {
            name: column,
            events: {
              create: { title: column, [column]: value, notes: { create: [{ body: 'a' }, { body: 'b' }] } },
            },
          },
        })) as unknown as Author;
        const event = made.events[0];
        assert.deepEqual(event?.[column], value, 'the column itself is written as a value');
        assert.deepEqual(bodies(event), ['a', 'b'], 'the rows written under the child are in the returned tree');
        // What the database holds, read independently of the returned tree.
        assert.deepEqual(await db.rawUnsafe('SELECT body FROM notes ORDER BY body'), [{ body: 'a' }, { body: 'b' }]);
      } finally {
        await db.disconnect();
      }
    });
  }

  sqliteGate.it('create: a list of child rows, only some of which set such a column', async () => {
    const db = await open();
    try {
      const made = (await db.table('authors').create({
        data: {
          name: 'mixed',
          events: {
            create: [
              { title: 'first', data: [1, 2], notes: { create: { body: 'x' } } },
              { title: 'second', notes: { create: [{ body: 'y' }, { body: 'z' }] } },
            ],
          },
        },
      })) as unknown as Author;
      const byTitle = new Map(made.events.map((e) => [e.title, e]));
      assert.deepEqual(bodies(byTitle.get('first')), ['x']);
      assert.deepEqual(bodies(byTitle.get('second')), ['y', 'z']);
    } finally {
      await db.disconnect();
    }
  });

  sqliteGate.it('update: a nested create under an existing parent returns its nested rows too', async () => {
    const db = await open();
    try {
      const author = (await db.table('authors').create({ data: { name: 'later' } })) as unknown as Author;
      const updated = (await db.table('authors').update({
        where: { id: author.id },
        data: {
          events: { create: { title: 'added', data: { late: true }, notes: { create: { body: 'n' } } } },
        },
      })) as unknown as Author;
      assert.deepEqual(bodies(updated.events[0]), ['n']);
    } finally {
      await db.disconnect();
    }
  });

  // The wrappers themselves still work as wrappers: an update's rows sit under
  // `data`, and a relation write inside it is followed.
  sqliteGate.it('update: `{ where, data }` is still read as a wrapper, with a "data" column inside it', async () => {
    const db = await open();
    try {
      const made = (await db.table('authors').create({
        data: { name: 'wrap', events: { create: { title: 'before' } } },
      })) as unknown as Author;
      const eventId = made.events[0]!.id;
      const updated = (await db.table('authors').update({
        where: { id: made.id },
        data: {
          events: {
            update: {
              where: { id: eventId },
              data: { title: 'after', data: { changed: true }, notes: { create: { body: 'w' } } },
            },
          },
        },
      })) as unknown as Author;
      const event = updated.events[0];
      assert.equal(event?.title, 'after');
      assert.deepEqual(event?.data, { changed: true });
      assert.deepEqual(bodies(event), ['w']);
    } finally {
      await db.disconnect();
    }
  });
});

describe('a nested write reads back what every sibling row wrote', () => {
  const whoUnder = (event: Event | undefined) =>
    (event?.notes ?? []).flatMap((n) => (n.marks ?? []).map((m) => `${n.body}:${m.who}`)).sort();

  // Both events write `notes` with `create`, and only one of them goes a level
  // deeper. Whichever comes last used to decide what the read-back asked for.
  const deep = { title: 'deep', notes: { create: { body: 'd', marks: { create: [{ who: 'x' }, { who: 'y' }] } } } };
  const shallow = { title: 'shallow', notes: { create: { body: 's' } } };

  for (const [order, events] of [
    ['deeper sibling first', [deep, shallow]],
    ['deeper sibling last', [shallow, deep]],
  ] as const) {
    sqliteGate.it(`create: siblings that diverge below the same relation, ${order}`, async () => {
      const db = await open();
      try {
        const made = (await db.table('authors').create({
          data: { name: order, events: { create: [...events] } },
        })) as unknown as Author;
        const byTitle = new Map(made.events.map((e) => [e.title, e]));
        assert.deepEqual(whoUnder(byTitle.get('deep')), ['d:x', 'd:y']);
        assert.deepEqual(bodies(byTitle.get('shallow')), ['s']);
        assert.deepEqual(whoUnder(byTitle.get('shallow')), []);
        assert.deepEqual(await db.rawUnsafe('SELECT who FROM marks ORDER BY who'), [{ who: 'x' }, { who: 'y' }]);
      } finally {
        await db.disconnect();
      }
    });
  }

  sqliteGate.it('create: two siblings that each go deeper under different notes', async () => {
    const db = await open();
    try {
      const made = (await db.table('authors').create({
        data: {
          name: 'both',
          events: {
            create: [
              { title: 'one', notes: { create: [{ body: 'a', marks: { create: { who: 'p' } } }, { body: 'b' }] } },
              { title: 'two', notes: { create: [{ body: 'c' }, { body: 'd', marks: { create: { who: 'q' } } }] } },
            ],
          },
        },
      })) as unknown as Author;
      const byTitle = new Map(made.events.map((e) => [e.title, e]));
      assert.deepEqual(whoUnder(byTitle.get('one')), ['a:p']);
      assert.deepEqual(whoUnder(byTitle.get('two')), ['d:q']);
    } finally {
      await db.disconnect();
    }
  });

  sqliteGate.it('connectOrCreate: the row it creates returns its nested rows', async () => {
    const db = await open();
    try {
      const made = (await db.table('authors').create({
        data: {
          name: 'coc',
          events: {
            connectOrCreate: {
              where: { id: 999 },
              create: { id: 999, title: 'created', notes: { create: [{ body: 'a' }, { body: 'b' }] } },
            },
          },
        },
      })) as unknown as Author;
      assert.equal(made.events[0]?.title, 'created');
      assert.deepEqual(bodies(made.events[0]), ['a', 'b']);
    } finally {
      await db.disconnect();
    }
  });

  // The other branch writes nothing below the row it finds. The levels its
  // `create` names are still read, so the existing row's own notes come back.
  sqliteGate.it('connectOrCreate: the row it finds returns the notes it already has', async () => {
    const db = await open();
    try {
      const first = (await db.table('authors').create({ data: { name: 'first' } })) as unknown as Author;
      await db.rawUnsafe(`INSERT INTO events (id, author_id, title) VALUES (7, ${first.id}, 'existing')`);
      await db.rawUnsafe(`INSERT INTO notes (event_id, body) VALUES (7, 'kept')`);
      const made = (await db.table('authors').update({
        where: { id: first.id },
        data: {
          events: {
            connectOrCreate: {
              where: { id: 7 },
              create: { id: 7, title: 'unused', notes: { create: { body: 'not written' } } },
            },
          },
        },
      })) as unknown as Author;
      assert.equal(made.events[0]?.title, 'existing');
      assert.deepEqual(bodies(made.events[0]), ['kept']);
      assert.deepEqual(await db.rawUnsafe('SELECT body FROM notes ORDER BY body'), [{ body: 'kept' }]);
    } finally {
      await db.disconnect();
    }
  });
});

describe('a nested write is accepted only as deep as its tree can be returned', () => {
  interface Node {
    id: number;
    label: string | null;
    nodes?: Node[];
  }

  /** A chain of `edges` nested creates under one root: `edges + 1` rows. */
  function chain(edges: number): Record<string, unknown> {
    let data: Record<string, unknown> = { label: `level ${edges}` };
    for (let level = edges - 1; level >= 0; level--) data = { label: `level ${level}`, nodes: { create: data } };
    return data;
  }

  const depthOf = (node: Node | undefined): number => (node?.nodes?.[0] ? 1 + depthOf(node.nodes[0]) : 0);

  sqliteGate.it('ten levels below the root are written and all of them come back', async () => {
    const db = await open();
    try {
      const made = (await db.table('nodes').create({ data: chain(10) })) as unknown as Node;
      assert.equal(depthOf(made), 10);
      assert.deepEqual(await db.rawUnsafe('SELECT count(*) AS n FROM nodes'), [{ n: 11 }]);
    } finally {
      await db.disconnect();
    }
  });

  sqliteGate.it('an eleventh level is refused with the depth error, and nothing is written', async () => {
    const db = await open();
    try {
      await assert.rejects(
        () => db.table('nodes').create({ data: chain(11) }),
        (err: unknown) => err instanceof CircularRelationError && err.code === 'TURBINE_E007',
      );
      assert.deepEqual(await db.rawUnsafe('SELECT count(*) AS n FROM nodes'), [{ n: 0 }]);
    } finally {
      await db.disconnect();
    }
  });

  // The depth of a tree is the same whichever operation each level uses. The
  // engine counted only `create` chains, so this shape used to be accepted.
  sqliteGate.it('depth through connectOrCreate counts like depth through create', async () => {
    const db = await open();
    try {
      let data: Record<string, unknown> = { id: 100, label: 'leaf' };
      for (let level = 10; level >= 0; level--) {
        data = {
          id: level + 1,
          label: `level ${level}`,
          nodes: { connectOrCreate: { where: { id: (data.id as number) ?? 0 }, create: data } },
        };
      }
      await assert.rejects(
        () => db.table('nodes').create({ data }),
        (err: unknown) => err instanceof CircularRelationError,
      );
      assert.deepEqual(await db.rawUnsafe('SELECT count(*) AS n FROM nodes'), [{ n: 0 }]);
    } finally {
      await db.disconnect();
    }
  });
});

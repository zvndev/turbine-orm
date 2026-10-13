/**
 * defineSchema refuses a schema that names something it does not contain, and
 * reads an ambiguous table the one way that is right.
 *
 * Each of these was accepted, and then went wrong somewhere else or nowhere:
 *
 *   - `default: 5` crashed the DDL generator with a TypeError,
 *   - `references: 'nope'` produced a table with no foreign key and no error,
 *   - a `references` or an index naming a table or column the schema does not
 *     have became SQL the database rejects at push time (or, with no database,
 *     a relation that silently did not exist),
 *   - `userId` and `user_id` in one table were the same column declared twice,
 *   - a table with columns called `name` and `columns` was taken for the legacy
 *     `table()` output and emitted as a different table.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TurbineErrorCode, ValidationError } from '../errors.js';
import { column, defineSchema, schemaDefToMetadata, schemaToSQL, table } from '../index.js';

// biome-ignore lint/suspicious/noExplicitAny: the schema is deliberately malformed
type Any = any;

const E003 = (re: RegExp) => (err: unknown) => {
  assert.ok(err instanceof ValidationError, `expected ValidationError, got ${String(err)}`);
  assert.equal(err.code, TurbineErrorCode.VALIDATION);
  assert.match(err.message, re);
  return true;
};

const id = { type: 'serial', primaryKey: true } as const;

describe('defineSchema, default values', () => {
  it('a finite number or a boolean is the literal it is', () => {
    const sql = schemaToSQL(
      defineSchema({
        items: {
          id,
          retries: { type: 'integer', default: 5 },
          offset: { type: 'integer', default: -3 },
          ratio: { type: 'real', default: 0.5 },
          active: { type: 'boolean', default: true },
          archived: { type: 'boolean', default: false },
          zero: { type: 'integer', default: 0 },
        },
      }),
    ).join('\n');
    assert.match(sql, /"retries" INTEGER DEFAULT 5/);
    assert.match(sql, /"offset" INTEGER DEFAULT -3/);
    assert.match(sql, /"ratio" REAL DEFAULT 0\.5/);
    assert.match(sql, /"active" BOOLEAN DEFAULT true/i);
    assert.match(sql, /"archived" BOOLEAN DEFAULT false/i);
    assert.match(sql, /"zero" INTEGER DEFAULT 0/);
  });

  it('a string is still raw SQL, and an absent default stays absent', () => {
    const def = defineSchema({
      items: {
        id,
        at: { type: 'timestamp', default: 'now()' },
        s: { type: 'text', default: "'x'" },
        n: { type: 'text' },
      },
    });
    assert.equal(def.tables.items!.columns.at!.defaultValue, 'now()');
    assert.equal(def.tables.items!.columns.s!.defaultValue, "'x'");
    assert.equal(def.tables.items!.columns.n!.defaultValue, null);
  });

  it('a default that is not text, a finite number or a boolean is E003 naming the column', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, {}, [], new Date(0), () => 1, Symbol('x')]) {
      assert.throws(
        () => defineSchema({ items: { id, n: { type: 'integer', default: bad as Any } } }),
        E003(/Invalid default for column "items\.n"/),
        String(bad),
      );
    }
  });

  it('the legacy builder takes the same values', () => {
    assert.equal(column.integer().default(7).build().defaultValue, '7');
    assert.equal(column.boolean().default(false).build().defaultValue, 'false');
    assert.throws(() => column.integer().default({} as Any), E003(/Invalid default for ColumnBuilder\.default\(\)/));
  });
});

describe('defineSchema, references', () => {
  it('a reference in table.column form still resolves, by accessor or by table name, field or column', () => {
    const def = defineSchema({
      authors: { id, displayName: { type: 'text' } },
      postTags: { id },
      posts: {
        id,
        a: { type: 'integer', references: 'authors.id' },
        b: { type: 'integer', references: { target: 'post_tags.id', onDelete: 'cascade' } },
        c: { type: 'integer', references: 'postTags.id' },
        d: { type: 'integer', references: 'authors.displayName' },
        e: { type: 'integer', references: 'authors.display_name' },
      },
    });
    assert.equal(def.tables.posts!.columns.b!.onDelete, 'cascade');
  });

  it('a reference to a table declared LATER, or to its own table, is fine', () => {
    assert.doesNotThrow(() =>
      defineSchema({
        posts: {
          id,
          parentId: { type: 'integer', references: 'posts.id' },
          authorId: { type: 'integer', references: 'authors.id' },
        },
        authors: { id },
      }),
    );
  });

  it('a reference that is not table.column is E003 (it used to drop the foreign key without a word)', () => {
    for (const bad of ['nope', '', 'authors.', '.id', 'a.b.c']) {
      assert.throws(
        () => defineSchema({ authors: { id }, posts: { id, userId: { type: 'integer', references: bad } } }),
        E003(/column "posts\.userId" has references ".*", which is not in "table\.column" form/),
        JSON.stringify(bad),
      );
    }
    assert.throws(
      () => defineSchema({ posts: { id, userId: { type: 'integer', references: 'auth.users.id' } } }),
      E003(/schema-qualified name/),
    );
  });

  it('a reference object without a text target is E003', () => {
    for (const references of [{ onDelete: 'cascade' }, { target: 5 }, 5, true]) {
      assert.throws(
        () => defineSchema({ posts: { id, userId: { type: 'integer', references: references as Any } } }),
        E003(/column "posts\.userId" has a "references" that is neither/),
        JSON.stringify(references),
      );
    }
  });

  it('a table outside this schema is left alone, since something else may own it', () => {
    const def = defineSchema({ posts: { id, externalId: { type: 'integer', references: 'external_things.id' } } });
    assert.equal(def.tables.posts!.columns.externalId!.referencesTarget, 'external_things.id');
    assert.match(schemaToSQL(def).join('\n'), /REFERENCES "external_things"\("id"\)/);
  });

  it('a column the target does not have is E003 with a suggestion', () => {
    assert.throws(
      () => defineSchema({ users: { id }, posts: { id, userId: { type: 'integer', references: 'users.idd' } } }),
      E003(/references "users\.idd", but table "users" has no column "idd"\. Did you mean "id"\?/),
    );
  });

  it('a field name in a reference becomes the column the DDL must name', () => {
    const def = defineSchema({
      authors: { displayName: { type: 'text', primaryKey: true } },
      posts: {
        id,
        a: { type: 'text', references: 'authors.displayName' },
        b: { type: 'text', references: 'authors.display_name' },
      },
    });
    assert.equal(def.tables.posts!.columns.a!.referencesTarget, 'authors.display_name');
    assert.equal(def.tables.posts!.columns.b!.referencesTarget, 'authors.display_name');
    const sql = schemaToSQL(def).join('\n');
    assert.doesNotMatch(sql, /displayName/, 'the camelCase field must never reach the DDL');
    assert.match(sql, /"a" TEXT REFERENCES "authors"\("display_name"\)/);
    const one = schemaDefToMetadata(
      defineSchema({
        authors: { displayName: { type: 'text', primaryKey: true } },
        posts: { id, a: { type: 'text', references: 'authors.displayName' } },
      }),
    );
    assert.equal(one.tables.posts!.relations.author!.referenceKey, 'display_name');
  });

  it('the legacy table() builder is checked too', () => {
    const users = table({ id: column.serial().primaryKey() });
    const posts = table({ id: column.serial().primaryKey(), userId: column.integer().references('users.idd') });
    assert.throws(() => defineSchema({ users, posts } as Any), E003(/column "posts\.userId" references "users\.idd"/));
    const typed = table({ id: column.serial().primaryKey(), userId: column.integer().references(5 as Any) });
    assert.throws(() => defineSchema({ users, typed } as Any), E003(/column "typed\.userId" has references 5/));
    const bare = table({ id: column.serial().primaryKey(), userId: column.integer().references('nope') });
    assert.throws(() => defineSchema({ users, bare } as Any), E003(/column "bare\.userId" has references "nope"/));
  });
});

describe('defineSchema, indexes', () => {
  it('an index on a column the table has is fine, by field or by column name', () => {
    assert.doesNotThrow(() =>
      defineSchema({
        posts: {
          id,
          authorId: { type: 'integer' },
          meta: { type: 'jsonb' },
          indexes: [
            { columns: ['authorId'] },
            { columns: ['author_id', 'id'], unique: true },
            { docField: 'meta', path: ['a'] },
          ],
        },
      }),
    );
  });

  it('an unknown column is E003 with a suggestion', () => {
    assert.throws(
      () => defineSchema({ posts: { id, authorId: { type: 'integer' }, indexes: [{ columns: ['authorid'] }] } }),
      E003(
        /index 0 of table "posts" names column "authorid", which the table does not have\. Did you mean "authorId"\?/,
      ),
    );
    assert.throws(
      () => defineSchema({ posts: { id, indexes: [{ columns: ['id'] }, { columns: ['id', 'zz'] }] } }),
      E003(/index 1 of table "posts" names column "zz"/),
    );
  });

  it('an unknown docField is E003', () => {
    assert.throws(
      () => defineSchema({ posts: { id, indexes: [{ docField: 'meta', path: ['a'] }] } }),
      E003(/index 0 of table "posts" names column "meta"/),
    );
  });

  it('an index that declares neither columns nor a docField is E003', () => {
    assert.throws(
      () => defineSchema({ posts: { id, indexes: [{ unique: true } as Any] } }),
      E003(/index 0 of table "posts" declares neither "columns"/),
    );
    assert.throws(
      () => defineSchema({ posts: { id, indexes: [{ columns: 'id' } as Any] } }),
      E003(/declares neither "columns"/),
    );
  });
});

describe('defineSchema, one column or table written two ways', () => {
  it('userId and user_id in one table are one column, so E003 names both', () => {
    assert.throws(
      () => defineSchema({ posts: { id, userId: { type: 'integer' }, user_id: { type: 'integer' } } }),
      E003(/table "posts" has columns "userId" and "user_id", which are the same column "user_id" in the database/),
    );
  });

  it('distinct columns that merely look alike are fine', () => {
    assert.doesNotThrow(() => defineSchema({ posts: { id, userId: { type: 'integer' }, userName: { type: 'text' } } }));
  });

  it('postTags and post_tags in one schema are one table, so E003 names both', () => {
    assert.throws(
      () => defineSchema({ postTags: { id }, post_tags: { id } }),
      E003(/tables "postTags" and "post_tags" are both the table "post_tags" in the database/),
    );
  });
});

describe('defineSchema, a table whose columns are called `name` and `columns`', () => {
  it('is a table of those columns, not the legacy table() output', () => {
    const def = defineSchema({
      posts: { id, name: { type: 'text' }, columns: { type: 'text' }, accessor: { type: 'text' } },
    });
    const t = def.tables.posts!;
    assert.deepEqual(Object.keys(t.columns).sort(), ['accessor', 'columns', 'id', 'name']);
    const sql = schemaToSQL(def).join('\n');
    assert.match(sql, /"name" TEXT/);
    assert.match(sql, /"columns" TEXT/);
    assert.match(sql, /"id" SERIAL PRIMARY KEY/);
  });

  it('an object under `name` is a column, even when `columns` holds nothing but objects', () => {
    // Without the string `name`, this shape is indistinguishable from a TableDef.
    assert.throws(
      () => defineSchema({ posts: { id, name: { type: 'text' }, columns: { a: { type: 'serial' } } } as Any }),
      E003(/unknown key "a" in column "posts\.columns"/),
    );
  });

  it('the legacy builder output is still read as a TableDef', () => {
    const def = defineSchema({ users: table({ id: column.serial().primaryKey(), email: column.text().notNull() }) });
    assert.equal(def.tables.users!.name, 'users');
    assert.equal(def.tables.users!.accessor, 'users');
    assert.deepEqual(Object.keys(def.tables.users!.columns), ['id', 'email']);
  });

  it('a hand-written TableDef is still a TableDef', () => {
    const hand = {
      name: 'ignored',
      accessor: 'ignored',
      columns: { id: column.serial().primaryKey().build() },
    };
    const def = defineSchema({ widgets: hand } as Any);
    assert.equal(def.tables.widgets!.name, 'widgets');
    assert.deepEqual(Object.keys(def.tables.widgets!.columns), ['id']);
  });

  it('a string where a column definition belongs is E003, not a table of nothing', () => {
    assert.throws(
      () => defineSchema({ posts: { id, name: 'text' } as Any }),
      E003(/column "posts\.name" must be an object such as \{ type: 'text' \}, received a string/),
    );
    assert.throws(
      () => defineSchema({ posts: { id, name: 'posts', columns: { type: 'text' } } as Any }),
      E003(/column "posts\.name" must be an object/),
    );
    assert.throws(
      () => defineSchema({ posts: { id, n: null } as Any }),
      E003(/column "posts\.n" must be an object.*null/),
    );
  });

  it('a column whose definition is undefined is absent', () => {
    const def = defineSchema({ posts: { id, gone: undefined } as Any });
    assert.deepEqual(Object.keys(def.tables.posts!.columns), ['id']);
  });

  it('a column type that is an Object.prototype member is an unknown type', () => {
    assert.throws(
      () => defineSchema({ posts: { id, x: { type: 'constructor' } } as Any }),
      E003(/Invalid column type "constructor"/),
    );
  });
});

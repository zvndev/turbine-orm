/**
 * turbine-orm, defineSchema refuses a key it does not know
 *
 * A schema is static code, and an unknown key is an option the author meant
 * and did not get: `defaultValue` for `default` emitted a column with no
 * DEFAULT, `uniq` for `unique` a non-unique index, `primarykey` for
 * `primaryKey` a "column" with no type. Each case below is refused twice:
 *
 * - at compile time, in a literal. The `@ts-expect-error` above each call is
 *   checked by `npm run typecheck` (tsconfig.test.json), and an unused one
 *   fails it, so each line proves the TYPE rejects the key;
 * - at runtime, for a schema from JSON or plain JS: the call throws E003
 *   naming the key and the key it most likely meant.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../errors.js';
import { column, defineSchema, type TableInput, table } from '../schema-builder.js';
import { schemaToSQL } from '../schema-sql.js';

/** Asserts an E003 that names `key` and, when given, suggests `suggestion`. */
function refuses(build: () => unknown, key: string, suggestion?: string): void {
  assert.throws(build, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected a ValidationError, got ${String(err)}`);
    assert.equal(err.code, 'TURBINE_E003');
    assert.match(err.message, new RegExp(`"${key}"`));
    if (suggestion) assert.match(err.message, new RegExp(`Did you mean "${suggestion}"\\?`));
    return true;
  });
}

const id = { type: 'serial', primaryKey: true } as const;

describe('defineSchema: an unknown key is refused, in the type and at runtime', () => {
  it('a column option, including the metadata spelling of a real one', () => {
    // @ts-expect-error `defaultValue` is ColumnConfig's name; the option is `default`
    refuses(
      () => defineSchema({ a: { id, role: { type: 'text', defaultValue: "'member'" } } }),
      'defaultValue',
      'default',
    );
    // @ts-expect-error a misspelled option
    refuses(() => defineSchema({ a: { id, email: { type: 'text', uniqe: true } } }), 'uniqe', 'unique');
  });

  it('a table option misspelled as an array-valued "column"', () => {
    // @ts-expect-error `primarykey` is not `primaryKey`
    refuses(() => defineSchema({ a: { id, primarykey: ['id'] } }), 'primarykey', 'primaryKey');
    // @ts-expect-error `index` is not `indexes`
    refuses(() => defineSchema({ a: { id, index: [{ columns: ['id'] }] } }), 'index', 'indexes');
  });

  it('an index option', () => {
    // @ts-expect-error `uniq` is not `unique`
    refuses(() => defineSchema({ a: { id, indexes: [{ columns: ['id'], uniq: true }] } }), 'uniq', 'unique');
  });

  it('a references option', () => {
    refuses(
      // @ts-expect-error `ondelete` is not `onDelete`
      () => defineSchema({ a: { id, b: { type: 'integer', references: { target: 'a.id', ondelete: 'cascade' } } } }),
      'ondelete',
      'onDelete',
    );
  });

  it('a check and a manyToMany option', () => {
    // @ts-expect-error `expr` is not `expression`
    refuses(() => defineSchema({ a: { id, checks: [{ expr: 'id > 0' }] } }), 'expr');
    refuses(
      () =>
        defineSchema({
          a: {
            id,
            // @ts-expect-error `sourcekey` is not `sourceKey`
            manyToMany: [{ name: 't', target: 'b', through: 'ab', sourceKey: 'aId', targetKey: 'bId', sourcekey: 'x' }],
          },
        }),
      'sourcekey',
      'sourceKey',
    );
  });

  it('a defineSchema option', () => {
    // @ts-expect-error `enum` is not `enums`
    refuses(() => defineSchema({ a: { id } }, { enum: { status: ['a'] } }), 'enum', 'enums');
  });

  it('the fluent builder refuses an unknown references option', () => {
    // @ts-expect-error `ondelete` is not `onDelete`
    refuses(() => column.integer().references('a.id', { ondelete: 'cascade' }), 'ondelete', 'onDelete');
  });

  it('a schema from JSON gets the same refusal (no literal type to catch it)', () => {
    const fromJson = JSON.parse(
      '{"a":{"id":{"type":"serial","primaryKey":true},"b":{"type":"text","defaultValue":"x"}}}',
    );
    refuses(() => defineSchema(fromJson as Record<string, TableInput>), 'defaultValue', 'default');
  });
});

describe('defineSchema: every known key is still accepted', () => {
  it('a schema using every option shape builds and emits its DDL', () => {
    const def = defineSchema(
      {
        users: {
          id: { type: 'serial', primaryKey: true },
          email: { type: 'varchar', maxLength: 255, notNull: true, unique: true, pii: true },
          status: { type: 'enum', enumName: 'user_status', default: "'active'", nullable: true },
          tags: { type: 'text', array: true, check: 'cardinality(tags) < 10' },
          embedding: { type: 'vector', dimensions: 3 },
          settings: { type: 'jsonb', tsType: '{ theme: string }' },
          updatedAt: { type: 'timestamptz', updatedAt: true },
          checks: [{ name: 'email_shape', expression: "email LIKE '%@%'" }],
          indexes: [
            { columns: ['status'], unique: false, name: 'idx_users_status' },
            { docField: 'settings', path: ['theme'] },
          ],
        },
        posts: {
          id: { type: 'serial', primaryKey: true },
          userId: { type: 'integer', references: { target: 'users.id', onDelete: 'cascade', onUpdate: 'cascade' } },
          editorId: { type: 'integer', references: 'users.id' },
          manyToMany: [
            {
              name: 'labels',
              target: 'labels',
              through: 'postLabels',
              sourceKey: 'postId',
              targetKey: 'labelId',
              references: 'id',
            },
          ],
        },
        labels: { id: { type: 'serial', primaryKey: true } },
        postLabels: {
          postId: { type: 'integer', references: 'posts.id' },
          labelId: { type: 'integer', references: 'labels.id' },
          primaryKey: ['postId', 'labelId'],
        },
        legacy: table({
          id: column.serial().primaryKey(),
          ownerId: column.integer().references('users.id', { onDelete: 'set null' }),
        }),
      },
      { enums: { user_status: ['active', 'banned'] } },
    );
    assert.equal(Object.keys(def.tables).length, 5);
    const ddl = schemaToSQL(def).join('\n');
    assert.match(ddl, /"status" "user_status" DEFAULT 'active'/);
    assert.match(ddl, /"email" VARCHAR\(255\) UNIQUE NOT NULL/);
    assert.match(ddl, /ON DELETE CASCADE ON UPDATE CASCADE/);
  });
});

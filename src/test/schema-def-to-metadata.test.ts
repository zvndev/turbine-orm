/**
 * schemaDefToMetadata() — defineSchema() → SchemaMetadata bridge.
 *
 * Verifies that a code-first SchemaDef converts to the exact SchemaMetadata
 * shape that introspection + `turbine generate` would produce for the same
 * schema — the shape non-SQL engines (turbinePowDB) and TurbineClient consume.
 * All build-only, no database.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { schemaHasIndexInfo } from '../index-advisor.js';
import type { SchemaMetadata, TableMetadata } from '../schema.js';
import { defineSchema } from '../schema-builder.js';
import { schemaDefToMetadata } from '../schema-metadata.js';
import { makeQuery } from './helpers.js';

// ---------------------------------------------------------------------------
// Realistic schema: generated PK, defaults, FKs (hasMany/belongsTo), explicit
// m2m through a junction, composite PK, enum, array, vector-free.
// ---------------------------------------------------------------------------

function realisticDef() {
  return defineSchema(
    {
      users: {
        id: { type: 'serial', primaryKey: true },
        email: { type: 'text', unique: true, notNull: true },
        role: { type: 'enum', enumName: 'user_role', default: "'member'" },
        nickname: { type: 'varchar', maxLength: 40 },
        tags: { type: 'text', array: true },
        createdAt: { type: 'timestamp', default: 'now()' },
      },
      posts: {
        id: { type: 'uuid', primaryKey: true, default: 'gen_random_uuid()' },
        authorId: {
          type: 'integer',
          notNull: true,
          references: { target: 'users.id', onDelete: 'cascade' },
        },
        title: { type: 'text', notNull: true },
        manyToMany: [
          { name: 'labels', target: 'labels', through: 'postLabels', sourceKey: 'postId', targetKey: 'labelId' },
        ],
      },
      labels: {
        id: { type: 'serial', primaryKey: true },
        name: { type: 'text', notNull: true, unique: true },
      },
      postLabels: {
        postId: { type: 'uuid', references: 'posts.id' },
        labelId: { type: 'integer', references: 'labels.id' },
        addedAt: { type: 'timestamptz', default: 'now()' },
        primaryKey: ['postId', 'labelId'],
      },
    },
    { enums: { user_role: ['member', 'admin'] } },
  );
}

describe('schemaDefToMetadata — full deep-equal against hand-written metadata', () => {
  it('converts a realistic schema to the exact generated-metadata shape', () => {
    const meta = schemaDefToMetadata(realisticDef());

    const expectedUsers: TableMetadata = {
      name: 'users',
      columns: [
        {
          name: 'id',
          field: 'id',
          dialectType: 'int4',
          pgType: 'int4',
          tsType: 'number',
          nullable: false,
          hasDefault: true,
          isArray: false,
          arrayType: 'integer[]',
          pgArrayType: 'integer[]',
          isGenerated: true,
        },
        {
          name: 'email',
          field: 'email',
          dialectType: 'text',
          pgType: 'text',
          tsType: 'string',
          nullable: false,
          hasDefault: false,
          isArray: false,
          arrayType: 'text[]',
          pgArrayType: 'text[]',
        },
        {
          name: 'role',
          field: 'role',
          dialectType: 'user_role',
          pgType: 'user_role',
          // Matches introspection: enum udt_names have no PG_TO_TS entry.
          tsType: 'unknown | null',
          nullable: true,
          hasDefault: true,
          isArray: false,
          arrayType: 'text[]',
          pgArrayType: 'text[]',
        },
        {
          name: 'nickname',
          field: 'nickname',
          dialectType: 'varchar',
          pgType: 'varchar',
          tsType: 'string | null',
          nullable: true,
          hasDefault: false,
          isArray: false,
          arrayType: 'text[]',
          pgArrayType: 'text[]',
          maxLength: 40,
        },
        {
          name: 'tags',
          field: 'tags',
          dialectType: '_text',
          pgType: '_text',
          tsType: 'string[] | null',
          nullable: true,
          hasDefault: false,
          isArray: true,
          arrayType: 'text[]',
          pgArrayType: 'text[]',
        },
        {
          name: 'created_at',
          field: 'createdAt',
          dialectType: 'timestamptz',
          pgType: 'timestamptz',
          tsType: 'Date | null',
          nullable: true,
          hasDefault: true,
          isArray: false,
          arrayType: 'timestamptz[]',
          pgArrayType: 'timestamptz[]',
        },
      ],
      columnMap: {
        id: 'id',
        email: 'email',
        role: 'role',
        nickname: 'nickname',
        tags: 'tags',
        createdAt: 'created_at',
      },
      reverseColumnMap: {
        id: 'id',
        email: 'email',
        role: 'role',
        nickname: 'nickname',
        tags: 'tags',
        created_at: 'createdAt',
      },
      dateColumns: new Set(['created_at']),
      dialectTypes: {
        id: 'int4',
        email: 'text',
        role: 'user_role',
        nickname: 'varchar',
        tags: '_text',
        created_at: 'timestamptz',
      },
      pgTypes: {
        id: 'int4',
        email: 'text',
        role: 'user_role',
        nickname: 'varchar',
        tags: '_text',
        created_at: 'timestamptz',
      },
      allColumns: ['id', 'email', 'role', 'nickname', 'tags', 'created_at'],
      primaryKey: ['id'],
      uniqueColumns: [['email']],
      relations: {
        posts: {
          type: 'hasMany',
          name: 'posts',
          from: 'users',
          to: 'posts',
          foreignKey: 'author_id',
          referenceKey: 'id',
          onDelete: 'cascade',
        },
      },
      indexes: [],
    };
    assert.deepStrictEqual(meta.tables.users, expectedUsers);

    const expectedPostLabels: TableMetadata = {
      name: 'post_labels',
      columns: [
        {
          name: 'post_id',
          field: 'postId',
          dialectType: 'uuid',
          pgType: 'uuid',
          tsType: 'string',
          nullable: false,
          hasDefault: false,
          isArray: false,
          arrayType: 'uuid[]',
          pgArrayType: 'uuid[]',
        },
        {
          name: 'label_id',
          field: 'labelId',
          dialectType: 'int4',
          pgType: 'int4',
          tsType: 'number',
          nullable: false,
          hasDefault: false,
          isArray: false,
          arrayType: 'integer[]',
          pgArrayType: 'integer[]',
        },
        {
          name: 'added_at',
          field: 'addedAt',
          dialectType: 'timestamptz',
          pgType: 'timestamptz',
          tsType: 'Date | null',
          nullable: true,
          hasDefault: true,
          isArray: false,
          arrayType: 'timestamptz[]',
          pgArrayType: 'timestamptz[]',
        },
      ],
      columnMap: { postId: 'post_id', labelId: 'label_id', addedAt: 'added_at' },
      reverseColumnMap: { post_id: 'postId', label_id: 'labelId', added_at: 'addedAt' },
      dateColumns: new Set(['added_at']),
      dialectTypes: { post_id: 'uuid', label_id: 'int4', added_at: 'timestamptz' },
      pgTypes: { post_id: 'uuid', label_id: 'int4', added_at: 'timestamptz' },
      allColumns: ['post_id', 'label_id', 'added_at'],
      primaryKey: ['post_id', 'label_id'],
      uniqueColumns: [],
      relations: {
        post: {
          type: 'belongsTo',
          name: 'post',
          from: 'post_labels',
          to: 'posts',
          foreignKey: 'post_id',
          referenceKey: 'id',
        },
        label: {
          type: 'belongsTo',
          name: 'label',
          from: 'post_labels',
          to: 'labels',
          foreignKey: 'label_id',
          referenceKey: 'id',
        },
      },
      indexes: [],
    };
    assert.deepStrictEqual(meta.tables.post_labels, expectedPostLabels);

    // posts: belongsTo users + explicit m2m to labels through the junction
    assert.deepStrictEqual(meta.tables.posts!.relations, {
      user: {
        type: 'belongsTo',
        name: 'user',
        from: 'posts',
        to: 'users',
        foreignKey: 'author_id',
        referenceKey: 'id',
        onDelete: 'cascade',
      },
      postLabels: {
        type: 'hasMany',
        name: 'postLabels',
        from: 'posts',
        to: 'post_labels',
        foreignKey: 'post_id',
        referenceKey: 'id',
      },
      labels: {
        type: 'manyToMany',
        name: 'labels',
        from: 'posts',
        to: 'labels',
        referenceKey: 'id',
        foreignKey: 'id',
        through: { table: 'post_labels', sourceKey: 'post_id', targetKey: 'label_id' },
      },
    });

    // labels: hasMany junction rows (the junction has a payload column, so
    // auto-m2m must NOT fire for labels → posts; only the explicit
    // declaration on posts exists).
    assert.deepStrictEqual(Object.keys(meta.tables.labels!.relations).sort(), ['postLabels']);
    assert.equal(meta.tables.labels!.primaryKey.length, 1);

    // enums propagate
    assert.deepStrictEqual(meta.enums, { user_role: ['member', 'admin'] });
  });

  it('keeps schemaHasIndexInfo() false so the index advisor stays silent', () => {
    const meta = schemaDefToMetadata(realisticDef());
    assert.equal(schemaHasIndexInfo(meta), false);
    for (const t of Object.values(meta.tables)) assert.deepStrictEqual(t.indexes, []);
  });

  it('is a pure function — input SchemaDef is not mutated', () => {
    const def = realisticDef();
    const snapshot = JSON.stringify(def);
    schemaDefToMetadata(def);
    assert.equal(JSON.stringify(def), snapshot);
  });
});

// ---------------------------------------------------------------------------
// FK disambiguation — two FKs to the same target (mirrors introspection)
// ---------------------------------------------------------------------------

describe('schemaDefToMetadata — relation naming', () => {
  it('disambiguates multiple FKs to the same target by FK column name', () => {
    const def = defineSchema({
      users: { id: { type: 'serial', primaryKey: true } },
      messages: {
        id: { type: 'serial', primaryKey: true },
        senderId: { type: 'integer', notNull: true, references: 'users.id' },
        recipientId: { type: 'integer', notNull: true, references: 'users.id' },
      },
    });
    const meta = schemaDefToMetadata(def);

    assert.deepStrictEqual(Object.keys(meta.tables.messages!.relations).sort(), ['recipient', 'sender']);
    assert.equal(meta.tables.messages!.relations.sender!.foreignKey, 'sender_id');
    assert.deepStrictEqual(Object.keys(meta.tables.users!.relations).sort(), [
      'messagesByRecipient',
      'messagesBySender',
    ]);
    assert.equal(meta.tables.users!.relations.messagesBySender!.type, 'hasMany');
    assert.equal(meta.tables.users!.relations.messagesBySender!.foreignKey, 'sender_id');
  });

  it('auto-detects a pure junction table as manyToMany (both directions)', () => {
    const def = defineSchema({
      students: { id: { type: 'serial', primaryKey: true } },
      courses: { id: { type: 'serial', primaryKey: true } },
      studentsCourses: {
        studentId: { type: 'integer', references: 'students.id' },
        courseId: { type: 'integer', references: 'courses.id' },
        primaryKey: ['studentId', 'courseId'],
      },
    });
    const meta = schemaDefToMetadata(def);

    const m2m = meta.tables.students!.relations.courses;
    assert.ok(m2m, 'students.courses m2m relation should exist');
    assert.equal(m2m.type, 'manyToMany');
    assert.deepStrictEqual(m2m.through, {
      table: 'students_courses',
      sourceKey: 'student_id',
      targetKey: 'course_id',
    });
    assert.equal(meta.tables.courses!.relations.students!.type, 'manyToMany');
  });

  it('accepts camelCase accessor names and field names in references targets', () => {
    const def = defineSchema({
      userProfiles: { id: { type: 'serial', primaryKey: true }, publicKey: { type: 'text', unique: true } },
      apiKeys: {
        id: { type: 'serial', primaryKey: true },
        // camelCase table accessor + camelCase field name
        profileKey: { type: 'text', notNull: true, references: 'userProfiles.publicKey' },
      },
    });
    const meta = schemaDefToMetadata(def);
    const rel = meta.tables.api_keys!.relations.userProfile!;
    assert.equal(rel.to, 'user_profiles');
    assert.equal(rel.foreignKey, 'profile_key');
    assert.equal(rel.referenceKey, 'public_key');
  });

  it('skips references to tables outside the SchemaDef instead of throwing', () => {
    const def = defineSchema({
      posts: {
        id: { type: 'serial', primaryKey: true },
        externalId: { type: 'integer', references: 'external_things.id' },
      },
    });
    const meta = schemaDefToMetadata(def);
    assert.deepStrictEqual(meta.tables.posts!.relations, {});
  });
});

// ---------------------------------------------------------------------------
// QueryInterface compatibility — the converted metadata must drive the real
// SQL builder, with-clause relations included (this is the PowDB use case:
// SchemaMetadata consumers that never saw a live database).
// ---------------------------------------------------------------------------

describe('schemaDefToMetadata — QueryInterface integration (build-only)', () => {
  const meta: SchemaMetadata = schemaDefToMetadata(realisticDef());

  it('builds a findMany with a hasMany with-clause over converted metadata', () => {
    const q = makeQuery('users', meta);
    const deferred = q.buildFindMany({ where: { email: 'a@b.co' }, with: { posts: true } });
    // Correlated subquery: posts.author_id = users.id
    assert.match(deferred.sql, /"author_id" = "users"\."id"/);
    assert.match(deferred.sql, /json_agg/);
    assert.deepStrictEqual(deferred.params, ['a@b.co']);
  });

  it('builds a belongsTo with-clause (posts → user)', () => {
    const q = makeQuery('posts', meta);
    const deferred = q.buildFindMany({ with: { user: true } });
    assert.match(deferred.sql, /"id" = "posts"\."author_id"/);
  });

  it('builds a manyToMany with-clause through the junction table', () => {
    const q = makeQuery('posts', meta);
    const deferred = q.buildFindMany({ with: { labels: true } });
    assert.match(deferred.sql, /"post_labels"/);
    assert.match(deferred.sql, /"label_id"/);
    assert.match(deferred.sql, /"post_id"/);
  });

  it('builds a nested with-clause (users → posts → labels)', () => {
    const q = makeQuery('users', meta);
    const deferred = q.buildFindMany({ with: { posts: { with: { labels: true } } } });
    assert.match(deferred.sql, /"post_labels"/);
    assert.match(deferred.sql, /"author_id" = "users"\."id"/);
  });

  it('camelCase where fields map through columnMap to snake_case columns', () => {
    const q = makeQuery('posts', meta);
    const deferred = q.buildFindMany({ where: { authorId: 7 } });
    assert.match(deferred.sql, /"author_id" = \$1/);
    assert.deepStrictEqual(deferred.params, [7]);
  });
});

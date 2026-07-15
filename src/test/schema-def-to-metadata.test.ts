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
import { ValidationError } from '../errors.js';
import { schemaHasIndexInfo } from '../index-advisor.js';
import { addAutoManyToManyRelations, buildRelationsFromForeignKeys, type ForeignKeyEntry } from '../introspect.js';
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

// ---------------------------------------------------------------------------
// N-4 — shared naming/collision resolution (parity with introspection)
// ---------------------------------------------------------------------------

/** Run fn while capturing console.warn calls; returns [result, warnings]. */
function captureWarnings<T>(fn: () => T): [T, string[]] {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    return [fn(), warnings];
  } finally {
    console.warn = original;
  }
}

describe('schemaDefToMetadata — collision guard parity with introspection (N-4)', () => {
  it('renames a belongsTo that would shadow a concrete scalar column (posts.user text + userId FK)', () => {
    // The verified repro: relation 'user' shadowed the scalar text column, so
    // `where: { user: { contains: 'bob' } }` threw E003 at runtime. The shared
    // resolver now Rel-suffixes it, keeping BOTH the scalar and the relation.
    const def = defineSchema({
      users: { id: { type: 'serial', primaryKey: true } },
      posts: {
        id: { type: 'serial', primaryKey: true },
        user: { type: 'text' },
        userId: { type: 'integer', notNull: true, references: 'users.id' },
      },
    });
    const [meta, warnings] = captureWarnings(() => schemaDefToMetadata(def));

    const posts = meta.tables.posts!;
    assert.equal(posts.relations.user, undefined);
    assert.equal(posts.relations.userRel!.type, 'belongsTo');
    assert.equal(posts.relations.userRel!.foreignKey, 'user_id');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /userRel/);

    // The scalar column stays targetable through the real SQL builder — the
    // reviewer's exact failing call now compiles into a LIKE filter.
    const q = makeQuery('posts', meta);
    const deferred = q.buildFindMany({ where: { user: { contains: 'bob' } } as never });
    assert.match(deferred.sql, /"user" LIKE \$1/);
    assert.deepStrictEqual(deferred.params, ['%bob%']);
    // And the relation still resolves as a with-clause.
    const withRel = q.buildFindMany({ with: { userRel: true } as never });
    assert.match(withRel.sql, /"id" = "posts"\."user_id"/);
  });

  it('keeps a legacy belongsTo that shadows ONLY a jsonb column (historical shadow, N-1b rule)', () => {
    const def = defineSchema({
      users: { id: { type: 'serial', primaryKey: true } },
      posts: {
        id: { type: 'serial', primaryKey: true },
        user: { type: 'jsonb' },
        userId: { type: 'integer', notNull: true, references: 'users.id' },
      },
    });
    const [meta, warnings] = captureWarnings(() => schemaDefToMetadata(def));
    assert.equal(meta.tables.posts!.relations.user!.type, 'belongsTo');
    assert.equal(meta.tables.posts!.relations.userRel, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /json\/jsonb/);
  });

  it('sibling clobber: two FKs to the same target deriving the same name BOTH survive with correct bindings', () => {
    // Old Pass 3 derived 'sponsor' for BOTH sponsorId (strip) and sponsor
    // (no suffix) — the second silently overwrote the first, and the survivor
    // bound whichever FK came last. Now both survive under distinct names,
    // each bound to its own FK column.
    const def = defineSchema({
      users: { id: { type: 'serial', primaryKey: true } },
      events: {
        id: { type: 'serial', primaryKey: true },
        sponsorId: { type: 'integer', references: 'users.id' },
        sponsor: { type: 'integer', references: 'users.id' },
      },
    });
    const [meta, warnings] = captureWarnings(() => schemaDefToMetadata(def));

    const rels = meta.tables.events!.relations;
    const belongsTos = Object.values(rels).filter((r) => r.type === 'belongsTo');
    assert.equal(belongsTos.length, 2, 'both belongsTo relations must survive');
    const names = belongsTos.map((r) => r.name);
    assert.equal(new Set(names).size, 2, 'names must be distinct');
    const byFk = new Map(belongsTos.map((r) => [r.foreignKey, r.name]));
    assert.ok(byFk.has('sponsor_id'), 'sponsorId FK survives');
    assert.ok(byFk.has('sponsor'), 'sponsor FK survives');
    assert.notEqual(byFk.get('sponsor_id'), byFk.get('sponsor'));
    // Both collided with scalar column fields → warnings for each rename.
    assert.ok(warnings.length >= 1);

    // Reverse side: two distinct hasMany names on users, one per FK.
    const userRels = Object.values(meta.tables.users!.relations).filter((r) => r.type === 'hasMany');
    assert.equal(userRels.length, 2);
    assert.equal(new Set(userRels.map((r) => r.name)).size, 2);
  });

  it('Pass-4 auto-m2m applies the shadow guard (concrete column → Rel suffix, not silent drop)', () => {
    const def = defineSchema({
      students: {
        id: { type: 'serial', primaryKey: true },
        courses: { type: 'text' }, // concrete scalar shadowing the m2m name
      },
      courses: { id: { type: 'serial', primaryKey: true } },
      studentsCourses: {
        studentId: { type: 'integer', references: 'students.id' },
        courseId: { type: 'integer', references: 'courses.id' },
        primaryKey: ['studentId', 'courseId'],
      },
    });
    const [meta, warnings] = captureWarnings(() => schemaDefToMetadata(def));
    const students = meta.tables.students!;
    assert.equal(students.relations.courses, undefined);
    assert.equal(students.relations.coursesRel!.type, 'manyToMany');
    assert.deepStrictEqual(students.relations.coursesRel!.through, {
      table: 'students_courses',
      sourceKey: 'student_id',
      targetKey: 'course_id',
    });
    assert.ok(warnings.some((w) => w.includes('coursesRel')));
    // The reverse direction is unaffected.
    assert.equal(meta.tables.courses!.relations.students!.type, 'manyToMany');
  });
});

describe('schemaDefToMetadata — relation-name parity with buildRelationsFromForeignKeys (N-4)', () => {
  it('derives IDENTICAL names to introspection-shaped FK entries for the divergent shapes', () => {
    // One logical schema exercising: (1) the posts.user/userId shadow shape,
    // (2) the the dogfood consumer two-FKs-to-one-target shape, (3) a pure junction m2m.
    const def = defineSchema({
      users: { id: { type: 'serial', primaryKey: true } },
      posts: {
        id: { type: 'serial', primaryKey: true },
        user: { type: 'text' },
        userId: { type: 'integer', notNull: true, references: 'users.id' },
      },
      modelInstances: {
        id: { type: 'serial', primaryKey: true },
        currentVersionId: { type: 'integer', references: 'modelInstanceVersions.id' },
        publishedVersionId: { type: 'integer', references: 'modelInstanceVersions.id' },
      },
      modelInstanceVersions: { id: { type: 'serial', primaryKey: true } },
      tags: { id: { type: 'serial', primaryKey: true } },
      postTags: {
        postId: { type: 'integer', references: 'posts.id' },
        tagId: { type: 'integer', references: 'tags.id' },
        primaryKey: ['postId', 'tagId'],
      },
    });

    // (a) the defineSchema path
    const [meta] = captureWarnings(() => schemaDefToMetadata(def));

    // (b) the introspection path, fed the FK entries a live catalog would
    // report for the SAME schema (snake_case columns, pg-default constraint
    // names) plus the same column-field seeds.
    const fks: ForeignKeyEntry[] = [
      {
        sourceTable: 'posts',
        sourceColumns: ['user_id'],
        targetTable: 'users',
        targetColumns: ['id'],
        constraintName: 'posts_user_id_fkey',
      },
      {
        sourceTable: 'model_instances',
        sourceColumns: ['current_version_id'],
        targetTable: 'model_instance_versions',
        targetColumns: ['id'],
        constraintName: 'model_instances_current_version_id_fkey',
      },
      {
        sourceTable: 'model_instances',
        sourceColumns: ['published_version_id'],
        targetTable: 'model_instance_versions',
        targetColumns: ['id'],
        constraintName: 'model_instances_published_version_id_fkey',
      },
      {
        sourceTable: 'post_tags',
        sourceColumns: ['post_id'],
        targetTable: 'posts',
        targetColumns: ['id'],
        constraintName: 'post_tags_post_id_fkey',
      },
      {
        sourceTable: 'post_tags',
        sourceColumns: ['tag_id'],
        targetTable: 'tags',
        targetColumns: ['id'],
        constraintName: 'post_tags_tag_id_fkey',
      },
    ];
    const columnFieldsByTable = new Map<string, Set<string>>([
      ['users', new Set(['id'])],
      ['posts', new Set(['id', 'user', 'userId'])],
      ['model_instances', new Set(['id', 'currentVersionId', 'publishedVersionId'])],
      ['model_instance_versions', new Set(['id'])],
      ['tags', new Set(['id'])],
      ['post_tags', new Set(['postId', 'tagId'])],
    ]);
    const [introspected] = captureWarnings(() => {
      const rels = buildRelationsFromForeignKeys(fks, columnFieldsByTable);
      addAutoManyToManyRelations(
        ['users', 'posts', 'model_instances', 'model_instance_versions', 'tags', 'post_tags'],
        fks,
        new Map([
          ['users', ['id']],
          ['posts', ['id']],
          ['model_instances', ['id']],
          ['model_instance_versions', ['id']],
          ['tags', ['id']],
          ['post_tags', ['post_id', 'tag_id']],
        ]),
        new Map([
          ['users', ['id']],
          ['posts', ['id', 'user', 'user_id']],
          ['model_instances', ['id', 'current_version_id', 'published_version_id']],
          ['model_instance_versions', ['id']],
          ['tags', ['id']],
          ['post_tags', ['post_id', 'tag_id']],
        ]),
        rels,
        columnFieldsByTable,
      );
      return rels;
    });

    for (const table of ['users', 'posts', 'model_instances', 'model_instance_versions', 'tags', 'post_tags']) {
      assert.deepStrictEqual(
        Object.keys(meta.tables[table]!.relations).sort(),
        Object.keys(introspected.get(table) ?? {}).sort(),
        `relation-name parity on "${table}"`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// F4a: defineSchema `indexes` surface → IndexMetadata carry-through
// ---------------------------------------------------------------------------

describe('schemaDefToMetadata: index declarations', () => {
  it('carries a doc-field expression index onto IndexMetadata with docPath', () => {
    const def = defineSchema({
      docs: {
        id: { type: 'serial', primaryKey: true },
        data: { type: 'jsonb', nullable: true },
        indexes: [{ docField: 'data', path: ['ns', 'value'] }],
      },
    });
    const meta = schemaDefToMetadata(def);
    const idx = meta.tables.docs!.indexes;
    assert.equal(idx.length, 1);
    assert.deepStrictEqual(idx[0]!.columns, ['data']);
    assert.deepStrictEqual(idx[0]!.docPath, ['ns', 'value']);
    assert.equal(idx[0]!.unique, false);
    // Auto-derived name: <table>_<col>_<segs joined by _>_idx.
    assert.equal(idx[0]!.name, 'docs_data_ns_value_idx');
  });

  it('carries a unique doc-field index and a camelCase → snake column name', () => {
    const def = defineSchema({
      docs: {
        id: { type: 'serial', primaryKey: true },
        payload: { type: 'jsonb', nullable: true },
        indexes: [{ docField: 'payload', path: ['externalId'], unique: true, name: 'my_ext_idx' }],
      },
    });
    const idx = schemaDefToMetadata(def).tables.docs!.indexes[0]!;
    assert.equal(idx.unique, true);
    assert.equal(idx.name, 'my_ext_idx');
    assert.deepStrictEqual(idx.columns, ['payload']);
    assert.deepStrictEqual(idx.docPath, ['externalId']);
  });

  it('carries a plain column index (no docPath), snake-casing field names', () => {
    const def = defineSchema({
      docs: {
        id: { type: 'serial', primaryKey: true },
        ownerId: { type: 'integer', notNull: true },
        indexes: [{ columns: ['ownerId'] }],
      },
    });
    const idx = schemaDefToMetadata(def).tables.docs!.indexes[0]!;
    assert.deepStrictEqual(idx.columns, ['owner_id']);
    assert.equal(idx.docPath, undefined);
    assert.equal(idx.name, 'docs_owner_id_idx');
  });

  it('a doc-only index set keeps schemaHasIndexInfo() false (advisor stays silent)', () => {
    const def = defineSchema({
      docs: {
        id: { type: 'serial', primaryKey: true },
        data: { type: 'jsonb', nullable: true },
        indexes: [{ docField: 'data', path: ['k'] }],
      },
    });
    const meta = schemaDefToMetadata(def);
    // The doc index is present in metadata...
    assert.equal(meta.tables.docs!.indexes.length, 1);
    // ...but does not flip schemaHasIndexInfo (doc-field indexes carry no
    // FK-coverage info → no blanket false positives).
    assert.equal(schemaHasIndexInfo(meta), false);
  });

  it('a DECLARED plain column index keeps schemaHasIndexInfo() false (SQL DDL never creates it)', () => {
    // A code-first `indexes: [{ columns }]` is NOT emitted by the SQL DDL
    // generators, so it does not reflect a real database index. Counting it
    // would arm blanket FK false positives (the FK auto-index the push path DID
    // create would be reported "missing"); a pure code-first schema therefore
    // stays "index-info unknown" exactly as it did before TableDef.indexes
    // existed. Marked via IndexMetadata.declared.
    const def = defineSchema({
      docs: {
        id: { type: 'serial', primaryKey: true },
        ownerId: { type: 'integer', notNull: true },
        indexes: [{ columns: ['ownerId'] }],
      },
    });
    const meta = schemaDefToMetadata(def);
    assert.equal(meta.tables.docs!.indexes[0]!.declared, true);
    assert.equal(schemaHasIndexInfo(meta), false);
  });

  it('a table with no `indexes` still gets []', () => {
    const def = defineSchema({ docs: { id: { type: 'serial', primaryKey: true } } });
    assert.deepStrictEqual(schemaDefToMetadata(def).tables.docs!.indexes, []);
  });

  it('rejects a negative / fractional / NaN doc-field array-index segment with a typed ValidationError', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const def = defineSchema({
        docs: {
          id: { type: 'serial', primaryKey: true },
          data: { type: 'jsonb', nullable: true },
          indexes: [{ docField: 'data', path: [bad] }],
        },
      });
      assert.throws(
        () => schemaDefToMetadata(def),
        (e: unknown) => e instanceof ValidationError && /must be a non-negative integer/.test((e as Error).message),
        `path segment ${bad} should be rejected`,
      );
    }
    // A valid non-negative integer index is accepted.
    const ok = defineSchema({
      docs: {
        id: { type: 'serial', primaryKey: true },
        data: { type: 'jsonb', nullable: true },
        indexes: [{ docField: 'data', path: ['tags', 0] }],
      },
    });
    assert.deepStrictEqual(schemaDefToMetadata(ok).tables.docs!.indexes[0]!.docPath, ['tags', 0]);
  });
});

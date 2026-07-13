/**
 * turbine-orm — Relation derivation from foreign keys (dogfood T-4)
 *
 * Unit tests for `buildRelationsFromForeignKeys()` / `relationNameFromColumn()`
 * — the pure naming core extracted from `introspect()` so the FK→relation
 * naming rules are testable without a database.
 *
 * Regression context (dogfood report): `model_instances` carries TWO
 * FK columns to `model_instance_versions` (`current_version_id`,
 * `published_version_id` — or Prisma-style quoted camelCase `currentVersionId`
 * / `publishedVersionId`). The old naming derived both belongsTo names from
 * the target table, so one clobbered the other, and camelCase `…Id` columns
 * were not suffix-stripped — the relation ended up with the SAME name as its
 * scalar FK column, shadowing it and generating types that failed
 * `tsc --strict` (TS2430/TS2322).
 *
 * Run: npx tsx --test src/test/introspect-relations.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  addAutoManyToManyRelations,
  buildRelationsFromForeignKeys,
  type ForeignKeyEntry,
  relationNameFromColumn,
} from '../introspect.js';

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

function fk(
  sourceTable: string,
  sourceColumns: string[],
  targetTable: string,
  targetColumns: string[],
  constraintName: string,
): ForeignKeyEntry {
  return { sourceTable, sourceColumns, targetTable, targetColumns, constraintName };
}

describe('relationNameFromColumn', () => {
  it('strips a snake_case _id suffix', () => {
    assert.equal(relationNameFromColumn('current_version_id'), 'currentVersion');
    assert.equal(relationNameFromColumn('user_id'), 'user');
  });

  it('strips a camelCase Id suffix (Prisma-style quoted columns)', () => {
    assert.equal(relationNameFromColumn('currentVersionId'), 'currentVersion');
    assert.equal(relationNameFromColumn('publishedVersionId'), 'publishedVersion');
  });

  it('leaves non-Id columns as-is (camelCased)', () => {
    assert.equal(relationNameFromColumn('current_version'), 'currentVersion');
    assert.equal(relationNameFromColumn('owner'), 'owner');
  });

  it('does not strip a bare "id" column into an empty name', () => {
    assert.equal(relationNameFromColumn('id'), 'id');
  });
});

describe('buildRelationsFromForeignKeys — single-FK back-compat naming', () => {
  it('keeps the historical target-table belongsTo / source-table hasMany names', () => {
    const [relations, warnings] = captureWarnings(() =>
      buildRelationsFromForeignKeys(
        [fk('posts', ['user_id'], 'users', ['id'], 'posts_user_id_fkey')],
        new Map([
          ['posts', new Set(['id', 'userId', 'title'])],
          ['users', new Set(['id', 'email'])],
        ]),
      ),
    );
    assert.deepEqual(warnings, []);

    const posts = relations.get('posts')!;
    assert.deepEqual(Object.keys(posts), ['user']);
    assert.equal(posts.user!.type, 'belongsTo');
    assert.equal(posts.user!.foreignKey, 'user_id');
    assert.equal(posts.user!.referenceKey, 'id');

    const users = relations.get('users')!;
    assert.deepEqual(Object.keys(users), ['posts']);
    assert.equal(users.posts!.type, 'hasMany');
  });
});

describe('buildRelationsFromForeignKeys — two FKs to the same target (T-4)', () => {
  it('derives each belongsTo name from its own column (snake_case _id)', () => {
    const [relations, warnings] = captureWarnings(() =>
      buildRelationsFromForeignKeys(
        [
          fk(
            'model_instances',
            ['current_version_id'],
            'model_instance_versions',
            ['id'],
            'model_instances_current_version_id_fkey',
          ),
          fk(
            'model_instances',
            ['published_version_id'],
            'model_instance_versions',
            ['id'],
            'model_instances_published_version_id_fkey',
          ),
        ],
        new Map([
          ['model_instances', new Set(['id', 'currentVersionId', 'publishedVersionId'])],
          ['model_instance_versions', new Set(['id', 'body'])],
        ]),
      ),
    );
    assert.deepEqual(warnings, []);

    const instances = relations.get('model_instances')!;
    assert.deepEqual(Object.keys(instances).sort(), ['currentVersion', 'publishedVersion']);
    assert.equal(instances.currentVersion!.type, 'belongsTo');
    assert.equal(instances.currentVersion!.foreignKey, 'current_version_id');
    assert.equal(instances.publishedVersion!.foreignKey, 'published_version_id');

    // Reverse hasMany side gets DISTINCT per-column names.
    const versions = relations.get('model_instance_versions')!;
    assert.deepEqual(Object.keys(versions).sort(), [
      'modelInstancesByCurrentVersion',
      'modelInstancesByPublishedVersion',
    ]);
    assert.equal(versions.modelInstancesByCurrentVersion!.type, 'hasMany');
    assert.equal(versions.modelInstancesByCurrentVersion!.foreignKey, 'current_version_id');
    assert.equal(versions.modelInstancesByPublishedVersion!.foreignKey, 'published_version_id');
  });

  it('strips camelCase Id suffixes so the relation never shadows the scalar FK field', () => {
    // Prisma-ported schemas use quoted camelCase column names — the exact
    // reported failure: relation "currentVersionId" === column field
    // "currentVersionId", shadowing the scalar entirely. The belongsTo side
    // legitimately changes (it was BROKEN — the legacy name collided with the
    // concrete-typed scalar), but the reverse hasMany side keeps the LEGACY
    // names (`modelInstancesByCurrentVersionId`): those were collision-free
    // and worked at runtime, so a regen must not rename them (N-1a).
    const [relations, warnings] = captureWarnings(() =>
      buildRelationsFromForeignKeys(
        [
          fk('model_instances', ['currentVersionId'], 'model_instance_versions', ['id'], 'mi_cv_fkey'),
          fk('model_instances', ['publishedVersionId'], 'model_instance_versions', ['id'], 'mi_pv_fkey'),
        ],
        new Map([
          ['model_instances', new Set(['id', 'currentVersionId', 'publishedVersionId'])],
          ['model_instance_versions', new Set(['id'])],
        ]),
      ),
    );
    assert.deepEqual(warnings, []);

    const instances = relations.get('model_instances')!;
    assert.deepEqual(Object.keys(instances).sort(), ['currentVersion', 'publishedVersion']);
    // The scalar fields stay targetable — no relation carries their names.
    assert.equal(instances.currentVersionId, undefined);
    assert.equal(instances.publishedVersionId, undefined);

    // Legacy-preserved: exactly what main generated for this shape.
    const versions = relations.get('model_instance_versions')!;
    assert.deepEqual(Object.keys(versions).sort(), [
      'modelInstancesByCurrentVersionId',
      'modelInstancesByPublishedVersionId',
    ]);
  });
});

describe('buildRelationsFromForeignKeys — collision fallback', () => {
  it('suffixes deterministically and warns when the derived name collides with a column field', () => {
    // `current_version_id` strips to `currentVersion`, but the table ALSO has
    // a scalar column whose field is `currentVersion` → deterministic Rel suffix.
    const [relations, warnings] = captureWarnings(() =>
      buildRelationsFromForeignKeys(
        [
          fk('model_instances', ['current_version_id'], 'model_instance_versions', ['id'], 'mi_cv_fkey'),
          fk('model_instances', ['published_version_id'], 'model_instance_versions', ['id'], 'mi_pv_fkey'),
        ],
        new Map([
          ['model_instances', new Set(['id', 'currentVersionId', 'publishedVersionId', 'currentVersion'])],
          ['model_instance_versions', new Set(['id'])],
        ]),
      ),
    );

    const instances = relations.get('model_instances')!;
    assert.deepEqual(Object.keys(instances).sort(), ['currentVersionRel', 'publishedVersion']);
    assert.equal(instances.currentVersionRel!.foreignKey, 'current_version_id');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /currentVersion/);
    assert.match(warnings[0]!, /currentVersionRel/);
  });

  it('suffixes and warns when a single-FK belongsTo name collides with a column field', () => {
    // profiles has a scalar column `user` AND an FK user_id → users.
    const [relations, warnings] = captureWarnings(() =>
      buildRelationsFromForeignKeys(
        [fk('profiles', ['user_id'], 'users', ['id'], 'profiles_user_id_fkey')],
        new Map([
          ['profiles', new Set(['id', 'userId', 'user'])],
          ['users', new Set(['id'])],
        ]),
      ),
    );
    const profiles = relations.get('profiles')!;
    assert.deepEqual(Object.keys(profiles), ['userRel']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /"user"/);
  });

  it('escalates to Rel2 when the Rel suffix is also taken', () => {
    const [relations, warnings] = captureWarnings(() =>
      buildRelationsFromForeignKeys(
        [fk('profiles', ['user_id'], 'users', ['id'], 'profiles_user_id_fkey')],
        new Map([
          ['profiles', new Set(['id', 'userId', 'user', 'userRel'])],
          ['users', new Set(['id'])],
        ]),
      ),
    );
    assert.deepEqual(Object.keys(relations.get('profiles')!), ['userRel2']);
    assert.equal(warnings.length, 1);
  });
});

describe('buildRelationsFromForeignKeys — composite FKs', () => {
  it('uses the constraint name for composite same-target FKs and keeps array keys', () => {
    const [relations, warnings] = captureWarnings(() =>
      buildRelationsFromForeignKeys(
        [
          fk('shipments', ['origin_region', 'origin_code'], 'locations', ['region', 'code'], 'fk_shipments_origin'),
          fk('shipments', ['dest_region', 'dest_code'], 'locations', ['region', 'code'], 'fk_shipments_dest'),
        ],
        new Map([
          ['shipments', new Set(['id', 'originRegion', 'originCode', 'destRegion', 'destCode'])],
          ['locations', new Set(['region', 'code'])],
        ]),
      ),
    );
    assert.deepEqual(warnings, []);

    const shipments = relations.get('shipments')!;
    assert.deepEqual(Object.keys(shipments).sort(), ['shipmentsDest', 'shipmentsOrigin']);
    assert.deepEqual(shipments.shipmentsOrigin!.foreignKey, ['origin_region', 'origin_code']);
    assert.deepEqual(shipments.shipmentsOrigin!.referenceKey, ['region', 'code']);

    const locations = relations.get('locations')!;
    assert.deepEqual(Object.keys(locations).sort(), ['shipmentsByShipmentsDest', 'shipmentsByShipmentsOrigin']);
  });
});

describe('buildRelationsFromForeignKeys — referential actions', () => {
  it('threads onDelete/onUpdate from the constraint map, omitting no-action', () => {
    const relations = buildRelationsFromForeignKeys(
      [fk('posts', ['user_id'], 'users', ['id'], 'posts_user_id_fkey')],
      new Map([
        ['posts', new Set(['id', 'userId'])],
        ['users', new Set(['id'])],
      ]),
      new Map([['posts_user_id_fkey', { onDelete: 'cascade' as const, onUpdate: 'no action' as const }]]),
    );
    const rel = relations.get('posts')!.user!;
    assert.equal(rel.onDelete, 'cascade');
    assert.equal(rel.onUpdate, undefined);
  });
});

// ---------------------------------------------------------------------------
// N-1 — legacy-first naming parity with main
//
// GOVERNING PRINCIPLE: never change a relation name that previously worked at
// runtime. Each case below states whether the expected names are
// LEGACY-PRESERVED (exactly what main generated — collision-free, worked) or
// LEGITIMATELY CHANGED (the legacy name collided with a concrete-typed scalar
// column, i.e. the shape was BROKEN on main and the rename is the fix).
// ---------------------------------------------------------------------------

describe('buildRelationsFromForeignKeys — main-parity table (N-1)', () => {
  interface NamingCase {
    name: string;
    fks: ForeignKeyEntry[];
    columnFields: Record<string, string[]>;
    unknownFields?: Record<string, string[]>;
    /** table → expected exact relation-name list (sorted) */
    expected: Record<string, string[]>;
    expectedWarnings: number;
  }

  const cases: NamingCase[] = [
    {
      // LEGACY-PRESERVED: the classic snake_case single-FK shape — identical
      // on main and here.
      name: 'plain snake_case single FK (posts.user_id → users)',
      fks: [fk('posts', ['user_id'], 'users', ['id'], 'posts_user_id_fkey')],
      columnFields: { posts: ['id', 'userId', 'title'], users: ['id', 'email'] },
      expected: { posts: ['user'], users: ['posts'] },
      expectedWarnings: 0,
    },
    {
      // LEGACY-PRESERVED: two snake_case FKs to the same target — main's
      // per-column derivation was already collision-free.
      name: 'two snake_case FKs to the same target',
      fks: [
        fk('model_instances', ['current_version_id'], 'model_instance_versions', ['id'], 'mi_cv_fkey'),
        fk('model_instances', ['published_version_id'], 'model_instance_versions', ['id'], 'mi_pv_fkey'),
      ],
      columnFields: {
        model_instances: ['id', 'currentVersionId', 'publishedVersionId'],
        model_instance_versions: ['id', 'body'],
      },
      expected: {
        model_instances: ['currentVersion', 'publishedVersion'],
        model_instance_versions: ['modelInstancesByCurrentVersion', 'modelInstancesByPublishedVersion'],
      },
      expectedWarnings: 0,
    },
    {
      // MIXED — the the dogfood consumer camelCase two-FK regression shape (N-1a):
      //   belongsTo LEGITIMATELY CHANGED: main derived 'authorId'/'editorId',
      //   which SHADOWED the concrete scalar FK fields (broken types) → the
      //   modern Id-stripped names apply.
      //   hasMany LEGACY-PRESERVED: main derived 'blogPostsByAuthorId'/
      //   'blogPostsByEditorId' — collision-free, worked at runtime; the
      //   branch had wrongly renamed them to 'blogPostsByAuthor'/'…Editor'.
      name: 'two camelCase-Id FKs (blogPosts.authorId/editorId → users)',
      fks: [
        fk('blogPosts', ['authorId'], 'users', ['id'], 'blogPosts_authorId_fkey'),
        fk('blogPosts', ['editorId'], 'users', ['id'], 'blogPosts_editorId_fkey'),
      ],
      columnFields: { blogPosts: ['id', 'authorId', 'editorId', 'title'], users: ['id', 'email'] },
      expected: {
        blogPosts: ['author', 'editor'],
        users: ['blogPostsByAuthorId', 'blogPostsByEditorId'],
      },
      expectedWarnings: 0,
    },
    {
      // LEGACY-PRESERVED: capitalized-snake FK columns. main derived
      // belongsTo 'Author'/'Editor' (free — the column FIELDS are
      // 'AuthorId'/'EditorId') and hasMany 'postsBy_Author'/'postsBy_Editor'
      // (snakeToCamel does not uppercase after '_A'). The branch had renamed
      // the hasMany side to 'postsByAuthor' — a regression.
      name: 'capitalized-snake FK columns (posts.Author_id/Editor_id → users)',
      fks: [
        fk('posts', ['Author_id'], 'users', ['id'], 'posts_Author_id_fkey'),
        fk('posts', ['Editor_id'], 'users', ['id'], 'posts_Editor_id_fkey'),
      ],
      columnFields: { posts: ['id', 'AuthorId', 'EditorId'], users: ['id'] },
      expected: {
        posts: ['Author', 'Editor'],
        users: ['postsBy_Author', 'postsBy_Editor'],
      },
      expectedWarnings: 0,
    },
    {
      // MIXED — uppercase `_ID` suffix:
      //   belongsTo LEGITIMATELY CHANGED: main's case-SENSITIVE strip left
      //   'author_ID' intact, which equals the scalar column field
      //   (snakeToCamel('author_ID') === 'author_ID') → shadow, broken on
      //   main → the modern case-insensitive strip yields 'author'/'editor'.
      //   hasMany LEGACY-PRESERVED: 'postsByAuthor_ID' was collision-free.
      name: 'uppercase _ID FK columns (posts.author_ID/editor_ID → users)',
      fks: [
        fk('posts', ['author_ID'], 'users', ['id'], 'posts_author_ID_fkey'),
        fk('posts', ['editor_ID'], 'users', ['id'], 'posts_editor_ID_fkey'),
      ],
      columnFields: { posts: ['id', 'author_ID', 'editor_ID'], users: ['id'] },
      expected: {
        posts: ['author', 'editor'],
        users: ['postsByAuthor_ID', 'postsByEditor_ID'],
      },
      expectedWarnings: 0,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const [relations, warnings] = captureWarnings(() =>
        buildRelationsFromForeignKeys(
          c.fks,
          new Map(Object.entries(c.columnFields).map(([t, f]) => [t, new Set(f)])),
          undefined,
          c.unknownFields ? new Map(Object.entries(c.unknownFields).map(([t, f]) => [t, new Set(f)])) : undefined,
        ),
      );
      for (const [table, names] of Object.entries(c.expected)) {
        assert.deepEqual(
          Object.keys(relations.get(table) ?? {}).sort(),
          [...names].sort(),
          `relation names on "${table}"`,
        );
      }
      assert.equal(warnings.length, c.expectedWarnings, `warnings: ${warnings.join(' | ')}`);
    });
  }

  it('keeps a legacy belongsTo that shadows ONLY an unknown-typed (jsonb) column, with a warning (N-1b)', () => {
    // posts has a jsonb column `user` (tsType 'unknown') AND user_id → users.
    // On main the relation 'user' shadowed the column but COMPILED (`unknown`
    // absorbs anything) and worked at runtime — regen must keep the name.
    const [relations, warnings] = captureWarnings(() =>
      buildRelationsFromForeignKeys(
        [fk('posts', ['user_id'], 'users', ['id'], 'posts_user_id_fkey')],
        new Map([
          ['posts', new Set(['id', 'user', 'userId'])],
          ['users', new Set(['id'])],
        ]),
        undefined,
        new Map([['posts', new Set(['user'])]]),
      ),
    );
    const posts = relations.get('posts')!;
    assert.deepEqual(Object.keys(posts), ['user']);
    assert.equal(posts.user!.type, 'belongsTo');
    assert.equal(posts.user!.foreignKey, 'user_id');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /json\/jsonb/);
    assert.match(warnings[0]!, /"user"/);
    // hasMany side unaffected.
    assert.deepEqual(Object.keys(relations.get('users')!), ['posts']);
  });

  it('still renames when the legacy name shadows a CONCRETE-typed column (broken on main)', () => {
    // Same shape but `user` is a concrete text column → the shadow generated
    // unsound types on main, so the deterministic Rel suffix applies.
    const [relations, warnings] = captureWarnings(() =>
      buildRelationsFromForeignKeys(
        [fk('posts', ['user_id'], 'users', ['id'], 'posts_user_id_fkey')],
        new Map([
          ['posts', new Set(['id', 'user', 'userId'])],
          ['users', new Set(['id'])],
        ]),
      ),
    );
    assert.deepEqual(Object.keys(relations.get('posts')!), ['userRel']);
    assert.equal(warnings.length, 1);
  });
});

// ---------------------------------------------------------------------------
// N-2 — auto-m2m collision handling (shared addAutoManyToManyRelations)
// ---------------------------------------------------------------------------

describe('addAutoManyToManyRelations — column-shadow handling (N-2)', () => {
  /** Junction fixture: post_tags(post_id, tag_id) linking posts ↔ tags. */
  function junctionSetup(extraPostFields: string[] = [], unknownPostFields: string[] = []) {
    const fks = [
      fk('post_tags', ['post_id'], 'posts', ['id'], 'pt_post_fkey'),
      fk('post_tags', ['tag_id'], 'tags', ['id'], 'pt_tag_fkey'),
    ];
    const columnFieldsByTable = new Map([
      ['posts', new Set(['id', 'title', ...extraPostFields])],
      ['tags', new Set(['id', 'label'])],
      ['post_tags', new Set(['postId', 'tagId'])],
    ]);
    const unknownTypedFieldsByTable = new Map([['posts', new Set(unknownPostFields)]]);
    const relationsByTable = buildRelationsFromForeignKeys(
      fks,
      columnFieldsByTable,
      undefined,
      unknownTypedFieldsByTable,
    );
    addAutoManyToManyRelations(
      ['posts', 'tags', 'post_tags'],
      fks,
      new Map([
        ['posts', ['id']],
        ['tags', ['id']],
        ['post_tags', ['post_id', 'tag_id']],
      ]),
      new Map([
        ['posts', ['id', 'title']],
        ['tags', ['id', 'label']],
        ['post_tags', ['post_id', 'tag_id']],
      ]),
      relationsByTable,
      columnFieldsByTable,
      unknownTypedFieldsByTable,
    );
    return relationsByTable;
  }

  it('adds both m2m directions for a pure junction (baseline)', () => {
    const [relations, warnings] = captureWarnings(() => junctionSetup());
    assert.deepEqual(warnings, []);
    assert.equal(relations.get('posts')!.tags!.type, 'manyToMany');
    assert.equal(relations.get('tags')!.posts!.type, 'manyToMany');
    assert.deepEqual(relations.get('posts')!.tags!.through, {
      table: 'post_tags',
      sourceKey: 'post_id',
      targetKey: 'tag_id',
    });
  });

  it('Rel-suffixes + warns when the m2m name shadows a CONCRETE-typed column (no silent drop)', () => {
    // posts has a scalar text[] column field `tags` → previously the branch
    // silently dropped the relation (with:{tags:true} → E005). Now it
    // survives under a deterministic suffix with a warning.
    const [relations, warnings] = captureWarnings(() => junctionSetup(['tags']));
    const posts = relations.get('posts')!;
    assert.equal(posts.tags, undefined);
    assert.equal(posts.tagsRel!.type, 'manyToMany');
    assert.deepEqual(posts.tagsRel!.through, { table: 'post_tags', sourceKey: 'post_id', targetKey: 'tag_id' });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /tagsRel/);
    // The other direction is unaffected.
    assert.equal(relations.get('tags')!.posts!.type, 'manyToMany');
  });

  it('keeps the legacy name + warns when the shadowed column is unknown-typed jsonb', () => {
    const [relations, warnings] = captureWarnings(() => junctionSetup(['tags'], ['tags']));
    const posts = relations.get('posts')!;
    assert.equal(posts.tags!.type, 'manyToMany');
    assert.equal(posts.tagsRel, undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /json\/jsonb/);
  });

  it('stays additive: an existing relation with the same name is never clobbered', () => {
    const relationsByTable = new Map<string, Record<string, import('../schema.js').RelationDef>>([
      [
        'posts',
        {
          tags: {
            type: 'hasMany',
            name: 'tags',
            from: 'posts',
            to: 'tags',
            foreignKey: 'post_id',
            referenceKey: 'id',
          },
        },
      ],
    ]);
    const fks = [
      fk('post_tags', ['post_id'], 'posts', ['id'], 'pt_post_fkey'),
      fk('post_tags', ['tag_id'], 'tags', ['id'], 'pt_tag_fkey'),
    ];
    const [, warnings] = captureWarnings(() =>
      addAutoManyToManyRelations(
        ['posts', 'tags', 'post_tags'],
        fks,
        new Map([['post_tags', ['post_id', 'tag_id']]]),
        new Map([['post_tags', ['post_id', 'tag_id']]]),
        relationsByTable,
      ),
    );
    assert.deepEqual(warnings, []);
    // The pre-existing hasMany won — untouched, no Rel-suffixed sibling.
    assert.equal(relationsByTable.get('posts')!.tags!.type, 'hasMany');
    assert.equal(relationsByTable.get('posts')!.tagsRel, undefined);
  });
});

/**
 * turbine-orm, `turbine mcp` relation-naming parity
 *
 * The MCP server introspects the database itself (it cannot assume generated
 * metadata exists), so its relation derivation MUST match `turbine generate`
 * exactly, otherwise the MCP schema tools describe relations that don't
 * exist on the generated client (and vice versa). mcp.ts previously carried a
 * stale local copy of a retired naming scheme; it now delegates to the shared
 * builder in introspect.ts. This suite pins the parity for the shapes where
 * the stale copy diverged: camelCase `…Id` FK columns and scalar shadows.
 *
 * Run: npx tsx --test src/test/mcp-relations.test.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRelations } from '../cli/mcp.js';
import { deriveCatalogRelations, type ForeignKeyEntry } from '../introspect.js';
import type { ColumnMetadata, IndexMetadata } from '../schema.js';

/** Run fn while suppressing console.warn (collision renames warn by design). */
function silenced<T>(fn: () => T): T {
  const original = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = original;
  }
}

function col(name: string, field: string, tsType = 'number', pgType = 'int8'): ColumnMetadata {
  return { name, field, tsType, pgType, nullable: false, hasDefault: false, isArray: false, pgArrayType: 'bigint[]' };
}

interface FkRow {
  /**
   * `pg_constraint.oid`, as `buildRelations` now groups by. Supplied by the
   * fixtures below because a constraint NAME is only unique per table, so the
   * name is not a grouping key at all (see the collision suite at the bottom).
   */
  constraint_oid: string;
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  constraint_name: string;
}

/** A plain (non-partial, non-expression) UNIQUE index, as pg_indexes reports it. */
function uniqueIndex(table: string, name: string, columns: string[]): IndexMetadata {
  return {
    name,
    columns,
    unique: true,
    definition: `CREATE UNIQUE INDEX ${name} ON public.${table} USING btree (${columns.join(', ')})`,
  };
}

// One fixture exercising every historically-divergent shape:
//   - blogPosts.authorId/editorId → users (camelCase two-FK: belongsTo must be
//     Id-stripped, hasMany must keep the legacy `blogPostsByAuthorId` names)
//   - posts.user (concrete text scalar) + posts.user_id → users (shadow → Rel)
//   - post_tags junction → auto-m2m posts.tags / tags.posts
//   - profiles.user_id UNIQUE → users.profile must be hasOne, NOT users.profiles
//     hasMany (this is the shape MCP got wrong by dropping `uniqueSetsByTable`)
//   - user_tags: a PK-LESS junction keyed only by a two-column UNIQUE index,
//     which is Prisma's implicit-m2m shape and needs `uniqueIndexColsByTable`
const TABLES = ['users', 'blogPosts', 'posts', 'tags', 'post_tags', 'profiles', 'user_tags'];

const COLUMNS = new Map<string, ColumnMetadata[]>([
  ['users', [col('id', 'id')]],
  [
    'blogPosts',
    [
      col('id', 'id'),
      col('authorId', 'authorId'),
      col('editorId', 'editorId'),
      col('title', 'title', 'string', 'text'),
    ],
  ],
  ['posts', [col('id', 'id'), col('user', 'user', 'string', 'text'), col('user_id', 'userId')]],
  ['tags', [col('id', 'id')]],
  ['post_tags', [col('post_id', 'postId'), col('tag_id', 'tagId')]],
  ['profiles', [col('id', 'id'), col('user_id', 'userId')]],
  ['user_tags', [col('user_id', 'userId'), col('tag_id', 'tagId')]],
]);

const PKS = new Map<string, string[]>([
  ['users', ['id']],
  ['blogPosts', ['id']],
  ['posts', ['id']],
  ['tags', ['id']],
  ['post_tags', ['post_id', 'tag_id']],
  ['profiles', ['id']],
  // user_tags deliberately has NO primary key (Prisma implicit-m2m junction).
]);

/** UNIQUE constraints per table: profiles.user_id is what makes the FK to-one. */
const UNIQUES = new Map<string, string[][]>([['profiles', [['user_id']]]]);

const INDEXES = new Map<string, IndexMetadata[]>([
  ['user_tags', [uniqueIndex('user_tags', 'user_tags_user_id_tag_id_key', ['user_id', 'tag_id'])]],
]);

const FK_ROWS: FkRow[] = [
  {
    constraint_oid: '16001',
    source_table: 'blogPosts',
    source_column: 'authorId',
    target_table: 'users',
    target_column: 'id',
    constraint_name: 'blogPosts_authorId_fkey',
  },
  {
    constraint_oid: '16002',
    source_table: 'blogPosts',
    source_column: 'editorId',
    target_table: 'users',
    target_column: 'id',
    constraint_name: 'blogPosts_editorId_fkey',
  },
  {
    constraint_oid: '16003',
    source_table: 'posts',
    source_column: 'user_id',
    target_table: 'users',
    target_column: 'id',
    constraint_name: 'posts_user_id_fkey',
  },
  {
    constraint_oid: '16004',
    source_table: 'post_tags',
    source_column: 'post_id',
    target_table: 'posts',
    target_column: 'id',
    constraint_name: 'post_tags_post_id_fkey',
  },
  {
    constraint_oid: '16005',
    source_table: 'post_tags',
    source_column: 'tag_id',
    target_table: 'tags',
    target_column: 'id',
    constraint_name: 'post_tags_tag_id_fkey',
  },
  {
    constraint_oid: '16006',
    source_table: 'profiles',
    source_column: 'user_id',
    target_table: 'users',
    target_column: 'id',
    constraint_name: 'profiles_user_id_fkey',
  },
  {
    constraint_oid: '16007',
    source_table: 'user_tags',
    source_column: 'user_id',
    target_table: 'users',
    target_column: 'id',
    constraint_name: 'user_tags_user_id_fkey',
  },
  {
    constraint_oid: '16008',
    source_table: 'user_tags',
    source_column: 'tag_id',
    target_table: 'tags',
    target_column: 'id',
    constraint_name: 'user_tags_tag_id_fkey',
  },
];

/**
 * Derive relations the way `turbine generate` does, by calling the SAME entry
 * point `introspectPostgresCatalog` calls.
 *
 * This used to re-implement the pipeline here, and it re-implemented MCP's
 * BROKEN version of it (the same four-argument `buildRelationsFromForeignKeys`
 * call, with `uniqueSetsByTable` omitted), so the suite compared MCP against MCP
 * and passed while the two surfaces genuinely disagreed. A parity test whose
 * reference side is a hand-copy of the thing under test can only ever confirm
 * the copy. Reference sides go through the shipped code path.
 */
function introspectDerived(): Map<string, Record<string, unknown>> {
  const fks: ForeignKeyEntry[] = FK_ROWS.map((r) => ({
    sourceTable: r.source_table,
    sourceColumns: [r.source_column],
    targetTable: r.target_table,
    targetColumns: [r.target_column],
    constraintName: r.constraint_name,
  }));
  return deriveCatalogRelations({
    tableNames: TABLES,
    foreignKeys: fks,
    pkByTable: PKS,
    columnsByTable: COLUMNS,
    uniqueByTable: UNIQUES,
    indexesByTable: INDEXES,
    enums: {},
  });
}

const mcpRelations = () => silenced(() => buildRelations(TABLES, COLUMNS, PKS, FK_ROWS, UNIQUES, INDEXES));

describe('turbine mcp, relation naming matches turbine generate', () => {
  it('derives deep-equal relation maps for the divergent fixture', () => {
    const mcpDerived = mcpRelations();
    const generateDerived = silenced(() => introspectDerived());

    assert.deepStrictEqual([...mcpDerived.keys()].sort(), [...generateDerived.keys()].sort());
    for (const table of generateDerived.keys()) {
      assert.deepStrictEqual(mcpDerived.get(table), generateDerived.get(table), `relation parity on "${table}"`);
    }
  });

  it('pins the exact expected names for the divergent shapes', () => {
    const rels = mcpRelations();

    // camelCase two-FK: Id-stripped belongsTo, LEGACY hasMany names.
    assert.deepStrictEqual(Object.keys(rels.get('blogPosts')!).sort(), ['author', 'editor']);

    // Scalar shadow → Rel suffix (never a silent shadow, never a drop).
    const posts = rels.get('posts')!;
    assert.equal(posts.user, undefined);
    assert.equal(posts.userRel!.type, 'belongsTo');
    // Auto-m2m through the junction survives on both sides.
    assert.equal(posts.tags!.type, 'manyToMany');
    assert.equal(rels.get('tags')!.posts!.type, 'manyToMany');
  });

  /**
   * The two shapes MCP actually got wrong, pinned as ABSOLUTE expectations
   * rather than as a comparison. The parity test above proves the two surfaces
   * agree; this one proves WHAT they agree on, so a future change that breaks
   * both identically still fails something.
   */
  it('emits a UNIQUE foreign key as hasOne on the parent, singular-named', () => {
    const users = mcpRelations().get('users')!;

    // With `uniqueSetsByTable` dropped this was `users.profiles` (hasMany), so
    // an MCP client that read the relation name out of the schema tool and used
    // it against the generated client got TURBINE_E005 Unknown relation.
    assert.equal(users.profiles, undefined, 'a UNIQUE FK must not produce the plural hasMany name');
    assert.equal(users.profile!.type, 'hasOne');
    assert.equal(users.profile!.to, 'profiles');
    assert.equal(users.profile!.foreignKey, 'user_id');
  });

  it('detects an auto-m2m through a PK-less junction keyed by a unique index', () => {
    const rels = mcpRelations();

    // With `uniqueIndexColsByTable` dropped, a junction with no primary key was
    // never recognized, so BOTH sides of every Prisma implicit m2m went missing.
    assert.equal(rels.get('users')!.tags!.type, 'manyToMany');
    assert.equal(rels.get('tags')!.users!.type, 'manyToMany');
    assert.deepStrictEqual(rels.get('users')!.tags!.through, {
      table: 'user_tags',
      sourceKey: 'user_id',
      targetKey: 'tag_id',
    });
  });

  it('keeps the legacy reverse names for the plain two-FK shape', () => {
    const users = mcpRelations().get('users')!;
    assert.deepStrictEqual(
      Object.keys(users).sort(),
      ['blogPostsByAuthorId', 'blogPostsByEditorId', 'posts', 'profile', 'tags', 'userTags'].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Constraint identity: the OID, never the name
// ---------------------------------------------------------------------------

/**
 * Postgres requires a constraint name to be unique per TABLE (`conrelid`,
 * `conname`), NOT per schema. Two tables in one schema may both carry a
 * `shared_fk`, and `buildRelations` used to group its rows by the bare
 * `constraint_name`: the two constraints collapsed into ONE entry, so one table
 * lost its relation entirely and the other pointed at whichever target happened
 * to arrive first in catalog order.
 *
 * FOREIGN KEYS ONLY, and that is not an accident: a PRIMARY KEY or UNIQUE
 * constraint is backed by an index, index names are unique per schema, and
 * Postgres refuses the second one outright (verified on PG 16). A foreign key
 * has no backing index, so the collision is legal and reachable.
 *
 * The same bug was fixed in `introspect.ts` in this sprint; `turbine mcp` reads
 * the catalog through its own query and had its own copy of it.
 */
describe('turbine mcp, foreign keys are identified by constraint OID', () => {
  const TWO_TABLES = ['users', 'accounts', 'orders'];
  const TWO_COLUMNS = new Map<string, ColumnMetadata[]>([
    ['users', [col('id', 'id')]],
    ['accounts', [col('id', 'id'), col('owner_id', 'ownerId')]],
    ['orders', [col('id', 'id'), col('owner_id', 'ownerId')]],
  ]);
  const TWO_PKS = new Map<string, string[]>([
    ['users', ['id']],
    ['accounts', ['id']],
    ['orders', ['id']],
  ]);

  it('keeps two same-named constraints on different tables apart', () => {
    const rows: FkRow[] = [
      {
        constraint_oid: '20001',
        source_table: 'accounts',
        source_column: 'owner_id',
        target_table: 'users',
        target_column: 'id',
        constraint_name: 'shared_fk',
      },
      {
        constraint_oid: '20002',
        source_table: 'orders',
        source_column: 'owner_id',
        target_table: 'users',
        target_column: 'id',
        constraint_name: 'shared_fk',
      },
    ];
    const rels = silenced(() => buildRelations(TWO_TABLES, TWO_COLUMNS, TWO_PKS, rows, new Map(), new Map()));

    // BOTH tables keep their belongsTo. Grouped by name the two constraints
    // merged into one entry owned by whichever row arrived first, so the other
    // table came back with NO relation at all.
    const accounts = rels.get('accounts')!;
    const orders = rels.get('orders')!;
    assert.equal(accounts.user!.type, 'belongsTo');
    assert.deepStrictEqual(accounts.user!.foreignKey, 'owner_id');
    assert.equal(accounts.user!.to, 'users');
    assert.equal(orders.user!.type, 'belongsTo');
    assert.deepStrictEqual(orders.user!.foreignKey, 'owner_id');
    assert.equal(orders.user!.to, 'users');

    // And users sees BOTH children, not one.
    assert.deepStrictEqual(Object.keys(rels.get('users')!).sort(), ['accounts', 'orders']);
  });

  /**
   * The composite half of the same class. The information_schema formulation
   * this replaced joined the constrained columns to the referenced columns on
   * the constraint name, which has no positional link, so a two-column FK came
   * back as FOUR rows and grouped into four AND-ed correlations with two pairs
   * crossed. Every read through such a relation returned nothing, silently.
   *
   * The catalog query pairs `conkey` to `confkey` by ordinal and orders by it,
   * so the grouped lists stay index-aligned. This asserts the pairing survives
   * the grouping.
   */
  it('keeps a composite foreign key paired in ordinal order', () => {
    const TABLES_C = ['regions', 'cities'];
    const COLUMNS_C = new Map<string, ColumnMetadata[]>([
      ['regions', [col('country', 'country', 'string', 'text'), col('code', 'code', 'string', 'text')]],
      [
        'cities',
        [
          col('id', 'id'),
          col('country', 'country', 'string', 'text'),
          col('region_code', 'regionCode', 'string', 'text'),
        ],
      ],
    ]);
    const PKS_C = new Map<string, string[]>([
      ['regions', ['country', 'code']],
      ['cities', ['id']],
    ]);
    const rows: FkRow[] = [
      {
        constraint_oid: '30001',
        source_table: 'cities',
        source_column: 'country',
        target_table: 'regions',
        target_column: 'country',
        constraint_name: 'cities_region_fkey',
      },
      {
        constraint_oid: '30001',
        source_table: 'cities',
        source_column: 'region_code',
        target_table: 'regions',
        target_column: 'code',
        constraint_name: 'cities_region_fkey',
      },
    ];
    const rels = silenced(() => buildRelations(TABLES_C, COLUMNS_C, PKS_C, rows, new Map(), new Map()));
    const rel = rels.get('cities')!.region!;
    assert.equal(rel.type, 'belongsTo');
    assert.deepStrictEqual(rel.foreignKey, ['country', 'region_code']);
    assert.deepStrictEqual(rel.referenceKey, ['country', 'code']);
  });
});

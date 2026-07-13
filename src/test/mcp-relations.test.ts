/**
 * turbine-orm — `turbine mcp` relation-naming parity (N-3)
 *
 * The MCP server introspects the database itself (it cannot assume generated
 * metadata exists), so its relation derivation MUST match `turbine generate`
 * exactly — otherwise the MCP schema tools describe relations that don't
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
import { addAutoManyToManyRelations, buildRelationsFromForeignKeys, type ForeignKeyEntry } from '../introspect.js';
import type { ColumnMetadata } from '../schema.js';

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
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  constraint_name: string;
}

// One fixture exercising every historically-divergent shape:
//   - blogPosts.authorId/editorId → users (camelCase two-FK: belongsTo must be
//     Id-stripped, hasMany must keep the legacy `blogPostsByAuthorId` names)
//   - posts.user (concrete text scalar) + posts.user_id → users (shadow → Rel)
//   - post_tags junction → auto-m2m posts.tags / tags.posts
const TABLES = ['users', 'blogPosts', 'posts', 'tags', 'post_tags'];

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
]);

const PKS = new Map<string, string[]>([
  ['users', ['id']],
  ['blogPosts', ['id']],
  ['posts', ['id']],
  ['tags', ['id']],
  ['post_tags', ['post_id', 'tag_id']],
]);

const FK_ROWS: FkRow[] = [
  {
    source_table: 'blogPosts',
    source_column: 'authorId',
    target_table: 'users',
    target_column: 'id',
    constraint_name: 'blogPosts_authorId_fkey',
  },
  {
    source_table: 'blogPosts',
    source_column: 'editorId',
    target_table: 'users',
    target_column: 'id',
    constraint_name: 'blogPosts_editorId_fkey',
  },
  {
    source_table: 'posts',
    source_column: 'user_id',
    target_table: 'users',
    target_column: 'id',
    constraint_name: 'posts_user_id_fkey',
  },
  {
    source_table: 'post_tags',
    source_column: 'post_id',
    target_table: 'posts',
    target_column: 'id',
    constraint_name: 'post_tags_post_id_fkey',
  },
  {
    source_table: 'post_tags',
    source_column: 'tag_id',
    target_table: 'tags',
    target_column: 'id',
    constraint_name: 'post_tags_tag_id_fkey',
  },
];

/** Derive relations the way `turbine generate` (introspect.ts) does. */
function introspectDerived(): Map<string, Record<string, unknown>> {
  const fks: ForeignKeyEntry[] = FK_ROWS.map((r) => ({
    sourceTable: r.source_table,
    sourceColumns: [r.source_column],
    targetTable: r.target_table,
    targetColumns: [r.target_column],
    constraintName: r.constraint_name,
  }));
  const columnFieldsByTable = new Map<string, Set<string>>();
  const unknownTypedFieldsByTable = new Map<string, Set<string>>();
  for (const [tbl, cols] of COLUMNS) {
    columnFieldsByTable.set(tbl, new Set(cols.map((c) => c.field)));
    unknownTypedFieldsByTable.set(tbl, new Set(cols.filter((c) => c.tsType === 'unknown').map((c) => c.field)));
  }
  const rels = buildRelationsFromForeignKeys(fks, columnFieldsByTable, undefined, unknownTypedFieldsByTable);
  addAutoManyToManyRelations(
    TABLES,
    fks,
    PKS,
    new Map(Array.from(COLUMNS, ([tbl, cols]) => [tbl, cols.map((c) => c.name)])),
    rels,
    columnFieldsByTable,
    unknownTypedFieldsByTable,
  );
  return rels;
}

describe('turbine mcp — relation naming matches turbine generate (N-3)', () => {
  it('derives deep-equal relation maps for the divergent fixture', () => {
    const mcpDerived = silenced(() => buildRelations(TABLES, COLUMNS, PKS, FK_ROWS));
    const generateDerived = silenced(() => introspectDerived());

    assert.deepStrictEqual([...mcpDerived.keys()].sort(), [...generateDerived.keys()].sort());
    for (const table of generateDerived.keys()) {
      assert.deepStrictEqual(mcpDerived.get(table), generateDerived.get(table), `relation parity on "${table}"`);
    }
  });

  it('pins the exact expected names for the divergent shapes', () => {
    const rels = silenced(() => buildRelations(TABLES, COLUMNS, PKS, FK_ROWS));

    // camelCase two-FK: Id-stripped belongsTo, LEGACY hasMany names.
    assert.deepStrictEqual(Object.keys(rels.get('blogPosts')!).sort(), ['author', 'editor']);
    assert.deepStrictEqual(
      Object.keys(rels.get('users')!).sort(),
      ['blogPostsByAuthorId', 'blogPostsByEditorId', 'posts'].sort(),
    );

    // Scalar shadow → Rel suffix (never a silent shadow, never a drop).
    const posts = rels.get('posts')!;
    assert.equal(posts.user, undefined);
    assert.equal(posts.userRel!.type, 'belongsTo');
    // Auto-m2m through the junction survives on both sides.
    assert.equal(posts.tags!.type, 'manyToMany');
    assert.equal(rels.get('tags')!.posts!.type, 'manyToMany');
  });
});

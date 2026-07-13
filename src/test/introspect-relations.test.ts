/**
 * turbine-orm — Relation derivation from foreign keys (dogfood T-4)
 *
 * Unit tests for `buildRelationsFromForeignKeys()` / `relationNameFromColumn()`
 * — the pure naming core extracted from `introspect()` so the FK→relation
 * naming rules are testable without a database.
 *
 * Regression context (Capa CMS dogfood report): `model_instances` carries TWO
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
import { buildRelationsFromForeignKeys, type ForeignKeyEntry, relationNameFromColumn } from '../introspect.js';

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
    // "currentVersionId", shadowing the scalar entirely.
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

    const versions = relations.get('model_instance_versions')!;
    assert.deepEqual(Object.keys(versions).sort(), [
      'modelInstancesByCurrentVersion',
      'modelInstancesByPublishedVersion',
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

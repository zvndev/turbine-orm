/**
 * The SQLite key comparison (sqliteKeyComparison) at its affinity edges:
 * the child's unique key justifies a to-one only when both sides compare
 * the way the join does. INTEGER and NUMERIC are different affinities
 * (a TEXT-stored '01' and 1 problem in reverse), TEXT never compares as
 * NUMERIC, and a column declared with no type has BLOB affinity.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sqliteKeyComparison } from '../catalog-metadata.js';
import type { ColumnMetadata } from '../schema.js';
import { mockTable } from './helpers.js';

function proof(childType: string, parentType: string, parentDdl = 'CREATE TABLE parents (id)'): boolean {
  const child = mockTable('children', [
    { name: 'id', field: 'id' },
    { name: 'parent_id', field: 'parentId', pgType: childType },
  ]).columns as ColumnMetadata[];
  const parent = mockTable('parents', [{ name: 'id', field: 'id', pgType: parentType }]).columns as ColumnMetadata[];
  const isToOne = sqliteKeyComparison(
    new Map([
      ['children', child],
      ['parents', parent],
    ]),
    new Map([['parents', parentDdl]]),
    new Map(),
  );
  return isToOne({
    sourceTable: 'children',
    sourceColumns: ['parent_id'],
    targetTable: 'parents',
    targetColumns: ['id'],
    constraintName: 'fk_children_parent',
  });
}

describe('sqliteKeyComparison affinity rules', () => {
  it('same affinity on both sides proves the to-one', () => {
    assert.equal(proof('INTEGER', 'INTEGER'), true);
    assert.equal(proof('TEXT', 'TEXT'), true);
  });

  it('INTEGER child against a NUMERIC parent is not a to-one', () => {
    assert.equal(proof('INTEGER', 'DECIMAL(10,2)'), false);
    assert.equal(proof('DECIMAL(10,2)', 'INTEGER'), false);
  });

  it('TEXT child against a NUMERIC parent is not a to-one', () => {
    assert.equal(proof('TEXT', 'DECIMAL(10,2)'), false);
    assert.equal(proof('VARCHAR(9)', 'INTEGER'), false);
  });

  it('a typeless column has BLOB affinity', () => {
    assert.equal(proof('', 'BLOB'), true);
    assert.equal(proof('', 'INTEGER'), false);
  });

  it('a COLLATE in the parent DDL refuses the to-one', () => {
    assert.equal(proof('TEXT', 'TEXT', 'CREATE TABLE parents (id TEXT COLLATE NOCASE)'), false);
  });
});

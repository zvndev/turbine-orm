/**
 * Composite foreign keys whose relation names read the CONSTRAINT name, as
 * SQLite DDL, and the relations PostgreSQL 18 derives from the same statements.
 * The libSQL and D1 introspection tests create these natively, so every SQLite
 * reader is held to one answer (node:sqlite and better-sqlite3 are covered by
 * relation-derivation-parity.test.ts).
 */
import assert from 'node:assert/strict';
import type { SchemaMetadata } from '../../schema.js';

export const CONSTRAINT_NAME_DDL = [
  'CREATE TABLE parents (a INTEGER NOT NULL, b INTEGER NOT NULL, c INTEGER, d INTEGER, PRIMARY KEY (a, b), UNIQUE (c, d))',
  // Two declared names over the same columns, told apart by the referenced key.
  'CREATE TABLE links (x INTEGER, y INTEGER, CONSTRAINT fk_one FOREIGN KEY (x, y) REFERENCES parents (a, b), CONSTRAINT fk_two FOREIGN KEY (x, y) REFERENCES parents (c, d))',
  // Unnamed: the first declared takes the default name, though SQLite lists it last.
  'CREATE TABLE pairs (x INTEGER, y INTEGER, FOREIGN KEY (x, y) REFERENCES parents (c, d), FOREIGN KEY (x, y) REFERENCES parents (a, b))',
  // An explicit name equal to the other key's default, which takes the counter and keeps its own action.
  'CREATE TABLE returns (tenant INTEGER, x INTEGER, y INTEGER, CONSTRAINT returns_tenant_y_fkey FOREIGN KEY (tenant, x) REFERENCES parents (a, b), FOREIGN KEY (tenant, y) REFERENCES parents (a, b) ON DELETE CASCADE)',
];

const XY = ['x', 'y'];
const AB = ['a', 'b'];
const CD = ['c', 'd'];

/** Relation name to [type, foreignKey, referenceKey, onDelete], per table. */
const EXPECTED = {
  links: { one: ['belongsTo', XY, AB, null], two: ['belongsTo', XY, CD, null] },
  pairs: { pairsXY: ['belongsTo', XY, CD, null], pairsXYFkey1: ['belongsTo', XY, AB, null] },
  returns: {
    returnsTenantY: ['belongsTo', ['tenant', 'x'], AB, null],
    returnsTenantYFkey1: ['belongsTo', ['tenant', 'y'], AB, 'cascade'],
  },
  parents: {
    linksByOne: ['hasMany', XY, AB, null],
    linksByTwo: ['hasMany', XY, CD, null],
    pairsByPairsXY: ['hasMany', XY, CD, null],
    pairsByPairsXYFkey1: ['hasMany', XY, AB, null],
    returnsByReturnsTenantY: ['hasMany', ['tenant', 'x'], AB, null],
    returnsByReturnsTenantYFkey1: ['hasMany', ['tenant', 'y'], AB, 'cascade'],
  },
};

export function assertConstraintNameRelations(schema: SchemaMetadata, engine: string): void {
  for (const [table, expected] of Object.entries(EXPECTED)) {
    const actual = Object.fromEntries(
      Object.entries(schema.tables[table]?.relations ?? {}).map(([name, r]) => [
        name,
        [r.type, r.foreignKey, r.referenceKey, r.onDelete ?? null],
      ]),
    );
    assert.deepEqual(actual, expected, `${engine}: relations of ${table}`);
  }
}

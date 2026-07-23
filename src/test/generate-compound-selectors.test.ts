/**
 * turbine-orm: generated compound-unique selector emission
 *
 * Two guarantees for the `*WhereUnique` compound-selector branches:
 *   1. a PARTIAL unique index is NOT a compound-unique source (it does not
 *      guarantee table-wide row uniqueness), so it never emits a selector;
 *   2. a synthetic selector name that is not a valid TS identifier (a
 *      junction-style quoted `"A"`/`"B"` column) is emitted as ONE quoted
 *      string-literal key, so the generated types.ts always parses, and it never
 *      contains a WHERE-clause fragment.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import ts from 'typescript';
import { generateTypes } from '../generate.js';
import type { ColumnMetadata, IndexMetadata, SchemaMetadata, TableMetadata } from '../schema.js';

function col(name: string, field: string, tsType = 'number', pgType = 'int8'): ColumnMetadata {
  return { name, field, pgType, tsType, nullable: false, hasDefault: false, isArray: false, pgArrayType: 'bigint[]' };
}

function table(name: string, columns: ColumnMetadata[], indexes: IndexMetadata[]): TableMetadata {
  const columnMap: Record<string, string> = {};
  const reverseColumnMap: Record<string, string> = {};
  const pgTypes: Record<string, string> = {};
  const allColumns: string[] = [];
  for (const c of columns) {
    columnMap[c.field] = c.name;
    reverseColumnMap[c.name] = c.field;
    pgTypes[c.name] = c.pgType;
    allColumns.push(c.name);
  }
  return {
    name,
    columns,
    columnMap,
    reverseColumnMap,
    dateColumns: new Set(),
    pgTypes,
    allColumns,
    primaryKey: [allColumns[0]!],
    uniqueColumns: [[allColumns[0]!]],
    relations: {},
    indexes,
  };
}

/** Assert a snippet is syntactically valid TypeScript via the compiler API. */
function assertParses(source: string): void {
  const sf = ts.createSourceFile('types.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = (sf as unknown as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  assert.equal(
    diags.length,
    0,
    `expected valid TS, got: ${diags.map((d) => d.messageText).join('; ')}\n---\n${source}`,
  );
}

describe('generateTypes: compound-unique selector emission', () => {
  it('excludes a PARTIAL unique index from compound-unique selectors', () => {
    const schema: SchemaMetadata = {
      enums: {},
      tables: {
        positions: table(
          'positions',
          [col('id', 'id'), col('pos_id', 'posId'), col('pos_item_id', 'posItemId')],
          [
            {
              name: 'positions_pos_id_pos_item_id_key',
              columns: ['pos_id', 'pos_item_id'],
              unique: true,
              definition:
                'CREATE UNIQUE INDEX positions_pos_id_pos_item_id_key ON positions USING btree (pos_id, pos_item_id) WHERE (pos_item_id IS NOT NULL)',
              partial: true,
            },
          ],
        ),
      },
    };
    const out = generateTypes(schema);
    assertParses(out);
    // The partial index must NOT surface as a compound selector.
    assert.doesNotMatch(out, /posId_posItemId/);
    // And absolutely no WHERE-clause fragment leaked anywhere.
    assert.doesNotMatch(out, /IS NOT NULL/);
  });

  it('emits a non-identifier junction selector name as ONE quoted string-literal key', () => {
    // A junction table whose UNIQUE index columns are the quoted uppercase
    // "A"/"B" (a metadata shape that must never generate broken types).
    const schema: SchemaMetadata = {
      enums: {},
      tables: {
        _UserOrgs: table(
          '_UserOrgs',
          [col('"A"', '"A"'), col('"B"', '"B"')],
          [
            {
              name: '_UserOrgs_AB_unique',
              columns: ['"A"', '"B"'],
              unique: true,
              definition: 'CREATE UNIQUE INDEX "_UserOrgs_AB_unique" ON "_UserOrgs" USING btree ("A", "B")',
            },
          ],
        ),
      },
    };
    const out = generateTypes(schema);
    assertParses(out);
    // The selector key is emitted quoted as a single string literal.
    assert.match(out, /'"A"_"B"':/);
    // The broken bare form must NOT appear.
    assert.doesNotMatch(out, /[^'"]"A"_"B":/);
  });
});

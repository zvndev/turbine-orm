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
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { generateMetadata, generateTypes } from '../generate.js';
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

/**
 * Assert a snippet is syntactically valid TypeScript, by running the `tsc`
 * BINARY over it rather than importing the compiler API.
 *
 * This used to be `ts.createSourceFile` from `import ts from 'typescript'`.
 * TypeScript 7 moved that API: the package's root export is now a version stub
 * (`"." -> "./lib/version.cjs"`) and the real compiler surface lives under
 * `typescript/unstable/*`. So the import resolved, `ts.createSourceFile` was
 * simply absent, and the file failed to typecheck. Importing the API therefore
 * pins the whole repo to TypeScript 6, and following it to an `unstable/`
 * subpath would pin it to a surface that is named for its instability.
 *
 * Driving the binary is version-stable, and it is what
 * generate-typecheck.test.ts already does for the generated client. Only
 * SYNTAX errors count here: this snippet is a fragment of a generated
 * `types.ts` and its imports are not resolvable in a temp directory, so
 * semantic diagnostics are expected and irrelevant. TypeScript's syntax errors
 * are exactly the TS1xxx range, which is the question being asked.
 */
function assertParses(source: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'turbine-parse-'));
  try {
    writeFileSync(join(dir, 'types.ts'), source);
    const tsc = resolve(dirname(fileURLToPath(import.meta.url)), '../../node_modules/.bin/tsc');
    // `cwd: dir` matters. Run from the repo root, tsc finds the repo's own
    // tsconfig.json, refuses the combination with `error TS5112: tsconfig.json
    // is present but will not be loaded if files are specified on commandline`,
    // and checks NOTHING. Every snippet then "parses", including a deliberately
    // broken one. The temp directory has no tsconfig, so the file is checked on
    // its own.
    const result = spawnSync(tsc, ['--noEmit', '--skipLibCheck', 'types.ts'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 120_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    // Precondition, because the failure above was silent and this check is only
    // worth having if it cannot pass vacuously: a TS5xxx/TS6xxx is a CLI or
    // configuration error, which means tsc never got as far as the source.
    assert.equal(result.error, undefined, `tsc did not run: ${result.error}`);
    const setupErrors = output.split('\n').filter((line) => /error TS[56]\d{3}:/.test(line));
    assert.deepEqual(setupErrors, [], `tsc failed before reading the source, so nothing was checked:\n${output}`);

    const syntaxErrors = output.split('\n').filter((line) => /error TS1\d{3}:/.test(line));
    assert.deepEqual(syntaxErrors, [], `expected valid TS, got:\n${syntaxErrors.join('\n')}\n---\n${source}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('generateTypes: compound-unique selector emission', () => {
  it('excludes a PARTIAL unique index from compound-unique selectors', () => {
    const schema: SchemaMetadata = {
      enums: {},
      tables: {
        ledger_entries: table(
          'ledger_entries',
          [col('id', 'id'), col('ledger_id', 'ledgerId'), col('line_id', 'lineId')],
          [
            {
              name: 'positions_pos_id_pos_item_id_key',
              columns: ['ledger_id', 'line_id'],
              unique: true,
              definition:
                'CREATE UNIQUE INDEX positions_pos_id_pos_item_id_key ON ledger_entries USING btree (ledger_id, line_id) WHERE (line_id IS NOT NULL)',
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

  it('round-trips the partial flag through generateMetadata (runtime agreement)', () => {
    // If the emitted metadata drops `partial`, the runtime compound-unique
    // derivation (which reads GENERATED metadata) re-arms the selector that
    // types.ts correctly excludes: type and runtime must agree.
    const schema: SchemaMetadata = {
      enums: {},
      tables: {
        ledger_lines: table(
          'ledger_lines',
          [col('id', 'id'), col('ledger_id', 'ledgerId'), col('line_id', 'lineId')],
          [
            {
              name: 'pos_items_partial_key',
              columns: ['ledger_id', 'line_id'],
              unique: true,
              partial: true,
              definition:
                'CREATE UNIQUE INDEX pos_items_partial_key ON public.ledger_lines USING btree (ledger_id, line_id) WHERE (line_id IS NOT NULL)',
            },
          ],
        ),
      },
    };
    const meta = generateMetadata(schema);
    assert.match(meta, /partial: true/);
    // A non-partial index must not gain the flag.
    const clean = generateMetadata({
      enums: {},
      tables: {
        ledger_lines: table(
          'ledger_lines',
          [col('id', 'id'), col('ledger_id', 'ledgerId'), col('line_id', 'lineId')],
          [
            {
              name: 'pos_items_key',
              columns: ['ledger_id', 'line_id'],
              unique: true,
              definition: 'CREATE UNIQUE INDEX pos_items_key ON public.ledger_lines USING btree (ledger_id, line_id)',
            },
          ],
        ),
      },
    });
    assert.doesNotMatch(clean, /partial/);
  });
});

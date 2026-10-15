#!/usr/bin/env tsx
/**
 * Writes site/lib/capabilities.generated.ts: every `EngineCapabilities` key
 * with each shipped engine's value, read from the engine's own dialect object.
 * The dialects page renders its capability table from that file, so the
 * published values cannot drift from the code.
 *
 * The one hand-written part is what each key decides (DECIDES below). A key
 * the dialects carry that DECIDES lacks, or one DECIDES names that no dialect
 * carries, stops the script by name.
 *
 *   npx tsx scripts/gen-capability-table.ts           write the file
 *   npx tsx scripts/gen-capability-table.ts --check   exit 1 if the file is stale
 *
 * `--check` runs in the unit suite (src/test/capability-table-sync.test.ts).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineCapabilities } from '../src/dialect.js';
import { postgresDialect } from '../src/dialect.js';
import { mssqlDialect } from '../src/mssql.js';
import { mysqlDialect } from '../src/mysql.js';
import { powdbDialect } from '../src/powdb.js';
import { sqliteDialect } from '../src/sqlite.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'lib', 'capabilities.generated.ts');

/** Column order on the page. */
const ENGINES = [
  { id: 'postgresql', label: 'PostgreSQL', dialect: postgresDialect },
  { id: 'sqlite', label: 'SQLite', dialect: sqliteDialect },
  { id: 'mysql', label: 'MySQL', dialect: mysqlDialect },
  { id: 'mssql', label: 'SQL Server', dialect: mssqlDialect },
  { id: 'powdb', label: 'PowDB', dialect: powdbDialect },
] as const;

/** What each key decides, in the order the page lists them. */
const DECIDES: Record<keyof EngineCapabilities, string> = {
  distinctOn: 'findMany `distinct` and groupBy `distinctOn`',
  positionalJson: 'Positional relation encoding (the default where true)',
  nullsOrderingClause: '`NULLS FIRST` / `NULLS LAST` placement',
  nullsSortHigh: 'NULL sorts after every value ascending',
  insensitiveInList: "`mode: 'insensitive'` on `in` / `notIn`",
  jsonDocumentEquality: "Whole-document JSON comparison: `'jsonb'`, `'exact'` or `'text'` (refused)",
  jsonExtractTyped: 'JSON path extraction returns typed values',
  jsonExactNumericCast: 'JSON path ranges cast to exact `numeric`',
  numericTextComparison: 'Numbers compared with text bind as text',
  enforcesForeignKeys: 'Foreign keys are always enforced',
  partitionLimitPushdown: 'Batched loader pushes per-parent `limit` into SQL',
  utcTimestampRewrite: '`utcTimestamps` rewrite of zone-less timestamps',
  paramTypeCasts: 'Update-expression parameters carry `::type` casts',
  namedEnumTypes: 'Enums are named types (`CREATE TYPE ... AS ENUM`)',
  structuredValueColumns: 'Columns that refuse an object or array',
  maxBindParameters: 'Parameters per statement',
  maxInsertRows: 'Rows per `INSERT ... VALUES`',
  chunkBindParameters: 'Parameters per `createMany` chunk',
  upsertConflictTarget: "Named conflict target, or `'any-unique-key'`",
  setClauseOrder: "`'left-to-right'` when a SET reads earlier assignments",
  reselectLocksRows: 'Reselect reads take `FOR UPDATE`',
  integerDivision: 'Truncating integer division operator',
  updateExpressions: '`expr` and `col()` in update data',
  bulkUpsertAppliesRepeatedKeys: 'Multi-row upsert merges collation-equal keys',
  skipDuplicatesCountsSkipped: '`skipDuplicates` counts skipped rows as affected',
  readOnlyTransactions: '`$transaction({ readOnly: true })`',
  connectionParameters: 'Server settings as connection parameters',
  backendCancel: 'Timed-out statements are cancelled on the server',
  idleTransactionTimeout: 'Server-side idle limit for a transaction',
  abortsTransactionOnError: 'A failed statement aborts the transaction',
  connectionDriver: "`'pg-compatible'`, `'engine-driver'` or `'none'`",
  preparesEveryStatement: 'Every statement is prepared under a server-wide cap',
  statementSyntax: 'Lexer for screening raw SQL (`null`: none)',
  inlineForeignKeys: 'Inline `REFERENCES` creates a foreign key',
  unboundedTextKeys: 'Unbounded text columns can be keys',
};

type Value = boolean | number | string | null;

function literal(value: Value): string {
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  return JSON.stringify(value);
}

export function renderCapabilityTable(): string {
  const keys = Object.keys(DECIDES) as Array<keyof EngineCapabilities>;
  for (const engine of ENGINES) {
    const carried = Object.keys(engine.dialect.capabilities);
    const missing = carried.filter((k) => !(k in DECIDES));
    const extra = keys.filter((k) => !carried.includes(k));
    if (missing.length > 0) throw new Error(`DECIDES has no entry for ${missing.join(', ')} (${engine.label})`);
    if (extra.length > 0) throw new Error(`${engine.label}'s capabilities have no ${extra.join(', ')}`);
  }

  const rows = keys.map((key) => {
    const values = ENGINES.map((e) => `${e.id}: ${literal(e.dialect.capabilities[key] as Value)}`).join(', ');
    return `  { key: '${key}', decides: ${JSON.stringify(DECIDES[key])}, values: { ${values} } },`;
  });

  return [
    '// Generated by scripts/gen-capability-table.ts from each engine dialect. Do not edit:',
    '// run `npm run gen:capabilities`. The unit suite fails while this file is stale.',
    '',
    'export const CAPABILITY_ENGINES = [',
    ...ENGINES.map((e) => `  { id: '${e.id}', label: '${e.label}' },`),
    '] as const;',
    '',
    `export type CapabilityEngine = (typeof CAPABILITY_ENGINES)[number]['id'];`,
    '',
    'export interface CapabilityRow {',
    '  key: string;',
    '  decides: string;',
    '  values: Record<CapabilityEngine, boolean | number | string | null>;',
    '}',
    '',
    'export const CAPABILITY_ROWS: readonly CapabilityRow[] = [',
    ...rows,
    '];',
    '',
  ].join('\n');
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const next = renderCapabilityTable();
  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT, 'utf-8');
    } catch {
      // missing counts as stale
    }
    if (current !== next) {
      console.error('site/lib/capabilities.generated.ts is stale. Run: npm run gen:capabilities');
      process.exit(1);
    }
    console.log('site/lib/capabilities.generated.ts is current.');
  } else {
    writeFileSync(OUT, next);
    console.log(`wrote ${OUT}`);
  }
}

/** Scoped structural MySQL diagnostics on one existing read-only tool snapshot. */
import { guardCheckout } from '../connection-guard.js';
import { ValidationError } from '../errors.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import type { ResolvedConfig } from './config.js';
import { createMysqlToolPool, introspectMysqlToolClient, mysqlToolIndexSummary } from './mysql-tools.js';

export type MysqlDoctorStatus = 'pass' | 'warn' | 'unknown' | 'fail';
export interface MysqlDoctorCheck {
  code: string;
  status: MysqlDoctorStatus;
  severity: 'info' | 'warning' | 'error';
  facts: Record<string, unknown>;
}
export interface MysqlDoctorReport {
  formatVersion: 1;
  engine: 'mysql';
  ok: boolean;
  checks: MysqlDoctorCheck[];
  limitations: string[];
}
type Filters = { include?: string[]; exclude?: string[]; legacyToManyUniques?: boolean };
/** Internal bridge supplied by the owned transport, never by CLI/MCP input. */
export interface MysqlDoctorSnapshot {
  client: PgCompatPoolClient;
  schema: string;
  query: PgCompatPoolClient['query'];
  assertVisibility(): Promise<void>;
}
export type MysqlDoctorCollector = (client: PgCompatPoolClient, options?: Filters) => Promise<MysqlDoctorReport>;
const CODES = [
  'MYSQL_RUNTIME',
  'MYSQL_VISIBILITY',
  'MYSQL_SCOPE',
  'MYSQL_ENGINES',
  'MYSQL_CONSTRAINTS',
  'MYSQL_FOREIGN_KEYS',
  'MYSQL_INDEXES',
  'MYSQL_MIGRATIONS',
] as const;
const MODES = new Set(
  'ALLOW_INVALID_DATES ANSI_QUOTES ERROR_FOR_DIVISION_BY_ZERO HIGH_NOT_PRECEDENCE IGNORE_SPACE NO_AUTO_VALUE_ON_ZERO NO_BACKSLASH_ESCAPES NO_DIR_IN_CREATE NO_ENGINE_SUBSTITUTION NO_UNSIGNED_SUBTRACTION NO_ZERO_DATE NO_ZERO_IN_DATE ONLY_FULL_GROUP_BY PAD_CHAR_TO_FULL_LENGTH PIPES_AS_CONCAT REAL_AS_FLOAT STRICT_ALL_TABLES STRICT_TRANS_TABLES TIME_TRUNCATE_FRACTIONAL'.split(
    ' ',
  ),
);
const LIMITATIONS = [
  'Catalog visibility requires proven database-wide grants. Roles and partial revokes may cause refusal.',
  'The owned transport requests a read-only repeatable-read consistent snapshot. Concurrent DDL and nontransactional tables are not snapshot-isolated.',
  'Only declared foreign keys and visible structural index facts are assessed. Opaque, prefix and invisible keys retain unknown coverage; no index necessity or performance is inferred.',
  'Migration counts and dirty-journal presence are observed only. Files, checksums, row validity, pending migrations and schema drift are not assessed.',
  'No data rows, SQL expressions, defaults, predicates, credentials, endpoints or grant text are reported. No repair SQL is generated.',
];

/** Does not open, release, commit or roll back the supplied snapshot. */
export async function collectMysqlDoctor(
  snapshot: MysqlDoctorSnapshot,
  options: Filters = {},
): Promise<MysqlDoctorReport> {
  const checks: MysqlDoctorCheck[] = CODES.map((code) => ({
    code,
    status: 'unknown',
    severity: 'warning',
    facts: { reason: 'not-assessed' },
  }));
  let current: (typeof CODES)[number] = 'MYSQL_RUNTIME';
  const set = (code: (typeof CODES)[number], status: MysqlDoctorStatus, facts: Record<string, unknown>) => {
    checks[CODES.indexOf(code)] = {
      code,
      status,
      severity: status === 'pass' ? 'info' : status === 'fail' ? 'error' : 'warning',
      facts,
    };
  };
  try {
    const runtime = (
      await snapshot.query<{ version: string; sql_mode: string; foreign_key_checks: number }>(
        'SELECT VERSION() AS version, @@session.sql_mode AS sql_mode, @@session.foreign_key_checks AS foreign_key_checks',
      )
    ).rows[0];
    const version = typeof runtime?.version === 'string' ? /^8\.\d+\.\d+(?=-|$)/.exec(runtime.version)?.[0] : undefined;
    if (!version || /mariadb/i.test(runtime?.version ?? '') || typeof runtime?.sql_mode !== 'string') {
      set(current, 'unknown', { reason: 'unrecognized-native-runtime' });
      return finish();
    }
    const modes = [...new Set(runtime.sql_mode.split(',').filter(Boolean))].sort();
    const foreignKeyChecks =
      runtime.foreign_key_checks === 1 || runtime.foreign_key_checks === 0 ? runtime.foreign_key_checks === 1 : null;
    set(current, foreignKeyChecks === true && modes.every((mode) => MODES.has(mode)) ? 'pass' : 'warn', {
      version,
      sqlModes: modes.filter((mode) => MODES.has(mode)),
      unrecognizedSqlModeCount: modes.filter((mode) => !MODES.has(mode)).length,
      foreignKeyChecks,
    });
    current = 'MYSQL_VISIBILITY';
    try {
      await snapshot.assertVisibility();
    } catch {
      set(current, 'unknown', { reason: 'catalog-visibility-unproved', assessment: 'refused' });
      return finish();
    }
    set(current, 'pass', { coverage: 'database-wide-grants-proved' });
    current = 'MYSQL_SCOPE';
    const metadata = await introspectMysqlToolClient(snapshot.client, {
      ...options,
      exclude: [...(options.exclude ?? []), '_turbine_migration_state'],
    });
    const tables = Object.values(metadata.tables).sort((a, b) => compare(a.name, b.name));
    const selected = new Set(tables.map((table) => table.name));
    const catalog = (
      await snapshot.query<{ TABLE_NAME: string; TABLE_TYPE: string; ENGINE: string | null }>(
        `SELECT TABLE_NAME, TABLE_TYPE, ENGINE FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = :p1 ORDER BY TABLE_NAME`,
        [snapshot.schema],
      )
    ).rows;
    set(current, 'pass', {
      selectedTables: tables.length,
      visibleCatalogObjects: catalog.length,
      excludedCatalogObjects: catalog.filter((row) => !selected.has(row.TABLE_NAME)).length,
      filtersApplied: Boolean(options.include?.length || options.exclude?.length),
      migrationScope: 'whole-selected-database',
    });
    current = 'MYSQL_ENGINES';
    const engines = tables.map((table) => {
      const row = catalog.find((entry) => entry.TABLE_NAME === table.name);
      const engine =
        typeof row?.ENGINE === 'string' &&
        /^(InnoDB|MyISAM|MEMORY|CSV|ARCHIVE|BLACKHOLE|MERGE|MRG_MYISAM|FEDERATED|NDB|NDBCLUSTER)$/i.test(row.ENGINE)
          ? row.ENGINE.toUpperCase()
          : null;
      return {
        table: table.name,
        engine,
        transactional:
          engine === 'INNODB'
            ? true
            : engine !== null &&
                ['MYISAM', 'MEMORY', 'CSV', 'ARCHIVE', 'BLACKHOLE', 'MERGE', 'MRG_MYISAM'].includes(engine)
              ? false
              : null,
      };
    });
    set(
      current,
      engines.some((row) => row.transactional === false)
        ? 'warn'
        : engines.some((row) => row.transactional === null)
          ? 'unknown'
          : 'pass',
      { tables: engines, assessment: 'InnoDB transactional suitability only; other engines are not certified' },
    );
    current = 'MYSQL_CONSTRAINTS';
    const constraints = (
      await snapshot.query<{ TABLE_NAME: string; CONSTRAINT_NAME: string; CONSTRAINT_TYPE: string; ENFORCED: string }>(
        `SELECT TABLE_NAME, CONSTRAINT_NAME, CONSTRAINT_TYPE, ENFORCED FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = :p1 ORDER BY TABLE_NAME, CONSTRAINT_NAME`,
        [snapshot.schema],
      )
    ).rows
      .filter((row) => selected.has(row.TABLE_NAME))
      .map((row) => ({
        table: row.TABLE_NAME,
        constraint: row.CONSTRAINT_NAME,
        type: ['PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY', 'CHECK'].includes(row.CONSTRAINT_TYPE)
          ? row.CONSTRAINT_TYPE
          : null,
        enforced: row.ENFORCED === 'YES' ? true : row.ENFORCED === 'NO' ? false : null,
      }));
    set(
      current,
      constraints.some((row) => row.enforced === false)
        ? 'warn'
        : constraints.some((row) => row.type === null || row.enforced === null)
          ? 'unknown'
          : 'pass',
      {
        constraints,
        assessment:
          'declarations and enforcement flags only; constraint expressions withheld and row integrity not scanned',
      },
    );
    current = 'MYSQL_FOREIGN_KEYS';
    const keys = (
      await snapshot.query<{
        TABLE_NAME: string;
        CONSTRAINT_NAME: string;
        COLUMN_NAME: string;
        ORDINAL_POSITION: number;
        REFERENCED_TABLE_NAME: string;
        REFERENCED_COLUMN_NAME: string;
        target_local: number;
      }>(
        `SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, ORDINAL_POSITION,
       REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME, (REFERENCED_TABLE_SCHEMA = TABLE_SCHEMA) AS target_local
       FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = :p1 AND REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION`,
        [snapshot.schema],
      )
    ).rows;
    const groups = new Map<string, typeof keys>();
    for (const key of keys) {
      if (!selected.has(key.TABLE_NAME)) continue;
      const id = JSON.stringify([key.TABLE_NAME, key.CONSTRAINT_NAME]);
      const group = groups.get(id) ?? [];
      group.push(key);
      groups.set(id, group);
    }
    const foreignKeys = [...groups.values()].map((group) => ({
      table: group[0]!.TABLE_NAME,
      constraint: group[0]!.CONSTRAINT_NAME,
      columns: group.map((key) => key.COLUMN_NAME),
      targetTable: group[0]!.REFERENCED_TABLE_NAME,
      targetColumns: group.map((key) => key.REFERENCED_COLUMN_NAME),
      targetScope: group.every((key) => key.target_local === 1) ? 'same-database' : 'external-database',
    }));
    set(current, foreignKeyChecks === true ? 'pass' : 'warn', {
      declared: foreignKeys,
      enforcement: foreignKeyChecks,
      assessment: 'declarations only; existing row integrity not scanned',
    });
    current = 'MYSQL_INDEXES';
    const primaryKeys = (
      await snapshot.query<{
        TABLE_NAME: string;
        COLUMN_NAME: string | null;
        SUB_PART: number | null;
        SEQ_IN_INDEX: number;
        INDEX_TYPE: string;
        IS_VISIBLE: string;
      }>(
        `SELECT TABLE_NAME, COLUMN_NAME, SUB_PART, SEQ_IN_INDEX, INDEX_TYPE, IS_VISIBLE
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = :p1 AND INDEX_NAME = 'PRIMARY'
       ORDER BY TABLE_NAME, SEQ_IN_INDEX`,
        [snapshot.schema],
      )
    ).rows;
    const indexes = tables.flatMap((table) =>
      table.indexes.map((index) => ({ table: table.name, ...mysqlToolIndexSummary(index) })),
    );
    function coverage(tableName: string, columns: string[]): string {
      const table = metadata.tables[tableName];
      if (!table || !selected.has(tableName)) return 'unknown-outside-scope';
      const primary = primaryKeys.filter((key) => key.TABLE_NAME === tableName);
      if (
        primary.length >= columns.length &&
        columns.every(
          (column, i) =>
            primary[i]?.COLUMN_NAME === column &&
            primary[i]?.SUB_PART === null &&
            primary[i]?.INDEX_TYPE === 'BTREE' &&
            primary[i]?.IS_VISIBLE === 'YES',
        )
      )
        return 'observed-primary-leading-columns';
      let opaque = primary.some(
        (key) =>
          key.SUB_PART !== null || key.COLUMN_NAME === null || key.INDEX_TYPE !== 'BTREE' || key.IS_VISIBLE !== 'YES',
      );
      for (const index of table.indexes) {
        const summary = mysqlToolIndexSummary(index);
        if (!summary) {
          opaque = true;
          continue;
        }
        const keys = summary.keys as { column: string | null; prefixLength: number | null }[];
        if (
          summary.type === 'BTREE' &&
          summary.visible === true &&
          keys.length >= columns.length &&
          columns.every((column, i) => keys[i]?.column === column && keys[i]?.prefixLength === null)
        )
          return 'observed-leading-columns';
        // Any opaque key is conservative unknown; it is never a missing index.
        if (
          summary.type !== 'BTREE' ||
          summary.visible !== true ||
          keys.some((key) => key.column === null || key.prefixLength !== null)
        )
          opaque = true;
      }
      return opaque ? 'unknown-opaque-keys' : 'not-observed';
    }
    const coverageFacts = foreignKeys.map((key) => ({
      ...key,
      sourceCoverage: coverage(key.table, key.columns),
      targetCoverage:
        key.targetScope === 'same-database' ? coverage(key.targetTable, key.targetColumns) : 'unknown-outside-scope',
    }));
    const verdicts = coverageFacts.flatMap((key) => [key.sourceCoverage, key.targetCoverage]);
    set(
      current,
      verdicts.includes('not-observed')
        ? 'warn'
        : verdicts.some((value) => value.startsWith('unknown'))
          ? 'unknown'
          : 'pass',
      {
        indexes,
        primaryKeys: primaryKeys
          .filter((key) => selected.has(key.TABLE_NAME))
          .map((key) => ({
            table: key.TABLE_NAME,
            column: key.COLUMN_NAME,
            prefixLength: key.SUB_PART,
            position: key.SEQ_IN_INDEX,
            type: key.INDEX_TYPE === 'BTREE' ? 'BTREE' : null,
            visible: key.IS_VISIBLE === 'YES' ? true : key.IS_VISIBLE === 'NO' ? false : null,
          })),
        foreignKeys: coverageFacts,
        assessment: 'ordered full-column BTREE prefixes only; no index SQL or performance recommendation',
      },
    );
    current = 'MYSQL_MIGRATIONS';
    const history = catalog.find((row) => row.TABLE_NAME === '_turbine_migrations');
    const journal = catalog.find((row) => row.TABLE_NAME === '_turbine_migration_state');
    const counts: Record<string, unknown> = {
      history: history ? 'present' : 'not-observed',
      journal: journal ? 'present' : 'not-observed',
      appliedCount: null,
      dirtyCount: null,
      integrity: 'not-assessed',
    };
    for (const [row, name, output] of [
      [history, '_turbine_migrations', 'appliedCount'],
      [journal, '_turbine_migration_state', 'dirtyCount'],
    ] as const) {
      if (!row) continue;
      if (row.TABLE_TYPE !== 'BASE TABLE' || row.ENGINE?.toUpperCase() !== 'INNODB') {
        set(current, 'unknown', { ...counts, reason: 'tracking-object-not-InnoDB-table' });
        return finish();
      }
      // Names are constants, schema is quoted independently of sql_mode.
      const count = (
        await snapshot.query<{ n: number | string }>(
          `SELECT COUNT(*) AS n FROM ${quote(snapshot.schema)}.${quote(name)}`,
        )
      ).rows[0]?.n;
      const value = Number(count);
      if (
        (typeof count !== 'number' && !(typeof count === 'string' && /^(0|[1-9]\d*)$/.test(count))) ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        throw new Error('Invalid count');
      counts[output] = value;
    }
    set(current, Number(counts.dirtyCount) > 0 ? 'fail' : history && journal ? 'pass' : 'unknown', counts);
  } catch {
    set(current, 'fail', { reason: 'collection-failed', detailsWithheld: true });
  }
  return finish();
  function finish(): MysqlDoctorReport {
    return {
      formatVersion: 1,
      engine: 'mysql',
      ok: checks.every((check) => check.status === 'pass'),
      checks,
      limitations: [...LIMITATIONS],
    };
  }
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
function quote(name: string): string {
  if (!name || Array.from(name).length > 64 || name.includes('\0'))
    throw new ValidationError('Invalid MySQL catalog identifier.');
  return `\`${name.replaceAll('`', '``')}\``;
}

export interface MysqlDoctorArgs {
  command: string;
  subcommand?: string;
  positional: string[];
  engine?: string;
  url?: string;
  schema?: string;
  json?: boolean;
  help?: boolean;
}
/** Reject legacy parser defaults and original tokens before creating any pool. */
export function assertMysqlDoctorArguments(args: MysqlDoctorArgs, argv?: readonly string[]): void {
  const allowed = new Set(['command', 'subcommand', 'positional', 'engine', 'url', 'schema', 'json', 'help']);
  if (
    Object.entries(args).some(([key, value]) => value !== undefined && !allowed.has(key)) ||
    args.subcommand !== undefined ||
    args.positional.length
  )
    throw new ValidationError(
      'MySQL doctor supports only --json, --engine, --url, --schema and --help; PostgreSQL repair, unused, audit, metrics and plan options are unsupported.',
    );
  if (!argv) return;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (['--engine', '--url', '-u', '--schema', '-s'].includes(token)) {
      const value = argv[++i];
      if (!value || value.startsWith('-'))
        throw new ValidationError('MySQL doctor requires explicit non-flag option operands.');
    } else if (!['--json', '--help', '-h'].includes(token))
      throw new ValidationError('Unsupported MySQL doctor argument.');
  }
}
export function showMysqlDoctorHelp(): void {
  console.log(
    'turbine doctor --engine mysql [--json] [--url mysql://host/database] [--schema database]\nRead-only scoped native MySQL 8.x structural checks. No repairs, files, query plans, unused-index or metrics analysis. Unknown checks do not mean clean.',
  );
}
/** Owns only the pool and snapshot opened here. The caller supplies the native transport bridge. */
export async function cmdMysqlDoctor(
  args: MysqlDoctorArgs,
  config: ResolvedConfig,
  collect: MysqlDoctorCollector,
): Promise<MysqlDoctorReport> {
  assertMysqlDoctorArguments(args);
  if (config.engine !== 'mysql' || config.adapter !== undefined)
    throw new ValidationError('MySQL doctor requires engine mysql without a PostgreSQL adapter.');
  const pool = createMysqlToolPool(config.url, config.schema, config);
  try {
    const client = await pool.connect();
    const checkout = guardCheckout(client);
    try {
      const report = await collect(client, config);
      console.log(args.json ? JSON.stringify(report, null, 2) : formatMysqlDoctor(report));
      return report;
    } finally {
      checkout.release();
    }
  } finally {
    await pool.end();
  }
}
export function formatMysqlDoctor(report: MysqlDoctorReport): string {
  return [
    `MySQL doctor: ${report.ok ? 'scoped checks passed' : 'attention or unknown checks'}`,
    ...report.checks.map(
      (check) => `${check.code}: ${check.status} (${check.severity}) ${JSON.stringify(check.facts)}`,
    ),
    ...report.limitations.map((limit) => `Limitation: ${limit}`),
  ].join('\n');
}

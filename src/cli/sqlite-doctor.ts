/** Scoped SQLite diagnostics. Reads catalog structure, never repairs a database. */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { type CheckoutGuard, guardCheckout } from '../connection-guard.js';
import { ValidationError } from '../errors.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import { sqliteDialect } from '../sqlite.js';
import { normalizeSqlitePath, type ResolvedConfig } from './config.js';
import type { CliArgs } from './index.js';
import {
  createSqliteToolPool,
  introspectSqliteToolClient,
  sqliteToolIndexSummary,
  sqliteToolRuntime,
} from './sqlite-tools.js';

export interface SqliteDoctorCheck {
  code:
    | 'SQLITE_RUNTIME'
    | 'SQLITE_READ_ONLY'
    | 'SQLITE_JOURNAL_MODE'
    | 'SQLITE_FOREIGN_KEYS'
    | 'SQLITE_CATALOG'
    | 'SQLITE_FK_CHILD_INDEX'
    | 'SQLITE_MIGRATION_TRACKING';
  severity: 'info' | 'warning' | 'error';
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  facts: Record<string, unknown>;
}

export interface SqliteDoctorReport {
  formatVersion: 1;
  engine: 'sqlite';
  ok: boolean;
  checks: SqliteDoctorCheck[];
  limitations: string[];
}

const quote = sqliteDialect.quoteIdentifier;
const HISTORY_LIMIT = 100;
const LIMITATIONS = [
  'Catalog and connection observations only; no integrity scan, user-row scan, repair or settings change.',
  'Child-index coverage describes complete prefixes of equality-constrained columns only, not query plans, collations, parent-key validity or data integrity.',
  'Connection foreign_keys is not evidence that historical rows satisfy foreign keys or that other connections enable enforcement.',
  'Migration history has no native dirty marker; dirty state, pending files and checksum correctness are unknown.',
  'Expression, default and predicate SQL, stored migration values and filesystem paths are withheld.',
  'Collection requires an active read-only SQLite tool checkout and a caller-owned snapshot; no timeout or cancellation is imposed on native catalog reads.',
];

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}
interface IndexRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}
interface IndexKey {
  seqno: number;
  cid: number;
  name: string | null;
  key: number;
  coll: string;
}

function report(checks: SqliteDoctorCheck[]): SqliteDoctorReport {
  return {
    formatVersion: 1,
    engine: 'sqlite',
    ok: checks.every((check) => check.status === 'pass'),
    checks,
    limitations: [...LIMITATIONS],
  };
}

function unknown(code: SqliteDoctorCheck['code'], facts: Record<string, unknown> = {}): SqliteDoctorCheck {
  // Native messages can contain schema SQL and literal values. Never echo them.
  return { code, severity: 'warning', status: 'unknown', facts: { reason: 'unreadable-or-incomplete', ...facts } };
}

/**
 * Collect within the caller's existing snapshot. Only registered SQLite tool
 * clients are accepted; arbitrary pg-compatible executors never receive SQL.
 * Does not release handles, alter settings or start/end a transaction.
 */
export async function collectSqliteDoctorReport(client: PgCompatPoolClient): Promise<SqliteDoctorReport> {
  const runtime = sqliteToolRuntime();
  const checks: SqliteDoctorCheck[] = [
    {
      code: 'SQLITE_RUNTIME',
      severity: runtime.available ? 'info' : 'error',
      status: runtime.available ? 'pass' : 'fail',
      facts: { node: process.versions.node, minimumNode: runtime.minimumNode, nativeAvailable: runtime.available },
    },
  ];
  if (!runtime.available) return report(checks);

  let metadata: ReturnType<typeof introspectSqliteToolClient>;
  try {
    // Also checks the tool adapter's native ownership registration before any
    // SQL is passed to the client's query interface.
    metadata = introspectSqliteToolClient(client, {});
  } catch {
    checks.push(unknown('SQLITE_CATALOG'));
    return report(checks);
  }
  checks.push({
    code: 'SQLITE_READ_ONLY',
    severity: 'info',
    status: 'pass',
    facts: { enforcement: 'database-open-read-only', handleOwner: 'caller', collectorReleasesHandle: false },
  });
  try {
    const version = (await client.query<{ version: string }>('SELECT sqlite_version() AS version')).rows[0]?.version;
    checks[0]!.facts.databaseVersion = typeof version === 'string' ? version : null;
    if (typeof version !== 'string') checks[0] = unknown('SQLITE_RUNTIME', checks[0]!.facts);
  } catch {
    checks[0] = unknown('SQLITE_RUNTIME', checks[0]!.facts);
  }
  for (const [code, sql, key] of [
    ['SQLITE_JOURNAL_MODE', 'PRAGMA main.journal_mode', 'journal_mode'],
    ['SQLITE_FOREIGN_KEYS', 'PRAGMA foreign_keys', 'foreign_keys'],
  ] as const) {
    try {
      const value = (await client.query(sql)).rows[0]?.[key];
      const valid = key === 'foreign_keys' ? value === 0 || value === 1 : typeof value === 'string';
      checks.push(
        !valid
          ? unknown(code)
          : {
              code,
              severity: key === 'foreign_keys' && value === 0 ? 'warning' : 'info',
              status: key === 'foreign_keys' && value === 0 ? 'warn' : 'pass',
              facts: { value, scope: key === 'foreign_keys' ? 'current-connection' : 'main-database', changed: false },
            },
      );
    } catch {
      checks.push(unknown(code));
    }
  }

  try {
    const tables = (await client.query<{ schema: string; name: string; type: string }>('PRAGMA main.table_list')).rows
      .filter((table) => table.schema === 'main' && !table.name.startsWith('sqlite_'))
      .sort((a, b) => compare(a.name, b.name));
    checks.push({
      code: 'SQLITE_CATALOG',
      severity: 'info',
      status: 'pass',
      facts: { tablesObserved: tables.filter((table) => table.type === 'table').length, scope: 'main' },
    });
    for (const table of tables) {
      if (table.name.toLowerCase() === '_turbine_migrations' || table.type === 'view') continue;
      if (table.type !== 'table' || !Object.hasOwn(metadata.tables, table.name)) {
        checks.push(unknown('SQLITE_FK_CHILD_INDEX', { table: table.name, reason: 'opaque-table' }));
        continue;
      }
      try {
        const foreignKeys = (await client.query<ForeignKeyRow>(`PRAGMA main.foreign_key_list(${quote(table.name)})`))
          .rows;
        const indexes = (await client.query<IndexRow>(`PRAGMA main.index_list(${quote(table.name)})`)).rows;
        const keys = new Map<string, IndexKey[]>();
        let incomplete = false;
        for (const index of indexes) {
          try {
            const rows = (await client.query<IndexKey>(`PRAGMA main.index_xinfo(${quote(index.name)})`)).rows;
            const ordered = rows.filter((key) => key.key === 1).sort((a, b) => a.seqno - b.seqno);
            if (!ordered.length || ordered.some((key, i) => key.seqno !== i)) incomplete = true;
            else keys.set(index.name, ordered);
          } catch {
            incomplete = true;
          }
          const native = metadata.tables[table.name]!.indexes.find((entry) => entry.name === index.name);
          if (!native || !sqliteToolIndexSummary(native)) incomplete = true;
        }
        // A rowid-alias primary key has no index_list entry. General metadata
        // marks it generated; verify native INTEGER/PK shape as well.
        const columns = (
          await client.query<{ name: string; type: string; pk: number; hidden: number }>(
            `PRAGMA main.table_xinfo(${quote(table.name)})`,
          )
        ).rows;
        const pk = columns.filter((column) => column.pk > 0);
        const rowidAlias =
          pk.length === 1 &&
          pk[0]!.type.toUpperCase() === 'INTEGER' &&
          !indexes.some((index) => index.origin === 'pk') &&
          metadata.tables[table.name]!.columns.some((column) => column.name === pk[0]!.name && column.isGenerated)
            ? pk[0]!.name
            : undefined;
        const groups = new Map<number, ForeignKeyRow[]>();
        for (const fk of foreignKeys) groups.set(fk.id, [...(groups.get(fk.id) ?? []), fk]);
        for (const [id, group] of [...groups].sort(([a], [b]) => a - b)) {
          group.sort((a, b) => a.seq - b.seq);
          const child = group.map((fk) => fk.from);
          const facts = { table: table.name, foreignKeyId: id, parentTable: group[0]!.table, columns: child };
          if (
            !columns.length ||
            new Set(child).size !== child.length ||
            group.some((fk, i) => fk.seq !== i || !columns.some((column) => column.name === fk.from))
          ) {
            checks.push(unknown('SQLITE_FK_CHILD_INDEX', facts));
            continue;
          }
          const covering = indexes
            .filter((index) => {
              const ordered = keys.get(index.name);
              const prefix = ordered?.slice(0, child.length).map((key) => key.name);
              // FK probes constrain every child column by equality. Their order
              // within the complete leading prefix does not change coverage.
              return index.partial === 0 && child.every((name) => prefix?.includes(name));
            })
            .map((index) => index.name)
            .sort(compare);
          const rowidCoverage = child.length === 1 && child[0] === rowidAlias;
          if (covering.length || rowidCoverage) {
            checks.push({
              code: 'SQLITE_FK_CHILD_INDEX',
              severity: 'info',
              status: 'pass',
              facts: { ...facts, coverage: 'structural-left-prefix', indexes: covering, rowidAlias: rowidCoverage },
            });
          } else if (
            incomplete ||
            indexes.some(
              (index) =>
                index.partial !== 0 ||
                keys
                  .get(index.name)
                  ?.some(
                    (key, i, all) => key.cid < 0 || all.slice(0, i).some((previous) => previous.name === key.name),
                  ),
            )
          ) {
            checks.push(unknown('SQLITE_FK_CHILD_INDEX', { ...facts, coverage: 'unknown' }));
          } else {
            checks.push({
              code: 'SQLITE_FK_CHILD_INDEX',
              severity: 'warning',
              status: 'warn',
              facts: {
                ...facts,
                coverage: 'no-structural-left-prefix',
              },
            });
          }
        }
      } catch {
        checks.push(unknown('SQLITE_FK_CHILD_INDEX', { table: table.name }));
      }
    }
  } catch {
    checks.push(unknown('SQLITE_CATALOG'));
  }
  checks.push(await migrationTracking(client));
  return report(checks);
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function migrationTracking(client: PgCompatPoolClient): Promise<SqliteDoctorCheck> {
  const code = 'SQLITE_MIGRATION_TRACKING';
  try {
    const entries = (
      await client.query<{ name: string; type: string }>(
        'SELECT name, type FROM main.sqlite_schema WHERE name = $1 COLLATE NOCASE',
        ['_turbine_migrations'],
      )
    ).rows;
    if (!entries.length) {
      return { code, severity: 'info', status: 'pass', facts: { visibility: 'absent', dirtyState: 'unknown' } };
    }
    const entry = entries[0]!;
    const kind = (await client.query<{ name: string; type: string }>('PRAGMA main.table_list')).rows.find(
      (table) => table.name === entry.name,
    );
    if (entry.type !== 'table' || kind?.type !== 'table') return unknown(code, { visibility: 'opaque' });
    const columns = (
      await client.query<{ name: string; type: string; pk: number; hidden: number; notnull: number }>(
        `PRAGMA main.table_xinfo(${quote(entry.name)})`,
      )
    ).rows;
    const canonical =
      columns.length === 4 &&
      columns.every((column) => {
        if (column.hidden !== 0) return false;
        return column.name === 'id'
          ? column.type.toUpperCase() === 'INTEGER' && column.pk === 1
          : ['name', 'checksum', 'applied_at'].includes(column.name) &&
              column.type.toUpperCase() === 'TEXT' &&
              column.notnull === 1 &&
              column.pk === 0;
      });
    if (!canonical) return unknown(code, { visibility: 'noncanonical', dirtyState: 'unknown' });
    // Match the migration reader's structural admission before inspecting rows.
    const indexes = (await client.query<IndexRow>(`PRAGMA main.index_list(${quote(entry.name)})`)).rows;
    let uniqueName = false;
    for (const index of indexes) {
      if (index.unique !== 1 || index.partial !== 0) continue;
      const keys = (await client.query<{ name: string | null }>(`PRAGMA main.index_info(${quote(index.name)})`)).rows;
      if (keys.length === 1 && keys[0]!.name === 'name') uniqueName = true;
    }
    const triggers = (
      await client.query(
        "SELECT 1 FROM main.sqlite_schema WHERE type = 'trigger' AND tbl_name = $1 COLLATE NOCASE LIMIT 1",
        [entry.name],
      )
    ).rows;
    if (!uniqueName || triggers.length) return unknown(code, { visibility: 'noncanonical', dirtyState: 'unknown' });
    const tables = (await client.query<{ name: string }>("SELECT name FROM main.sqlite_schema WHERE type = 'table'"))
      .rows;
    for (const table of tables) {
      const foreignKeys = (await client.query<ForeignKeyRow>(`PRAGMA main.foreign_key_list(${quote(table.name)})`))
        .rows;
      if (foreignKeys.some((fk) => fk.table.toLowerCase() === '_turbine_migrations'))
        return unknown(code, { visibility: 'noncanonical', dirtyState: 'unknown' });
    }
    // Bounded tracking-row inspection only. Never return names/checksums/times.
    const rows = (
      await client.query<{ valid: number }>(
        `SELECT (typeof(id) = 'integer' AND id > 0 AND typeof(name) = 'text' AND length(name) > 0 AND typeof(checksum) = 'text' AND typeof(applied_at) = 'text') AS valid FROM main.${quote(entry.name)} ORDER BY id LIMIT ${HISTORY_LIMIT + 1}`,
      )
    ).rows;
    const truncated = rows.length > HISTORY_LIMIT;
    const invalid = rows.slice(0, HISTORY_LIMIT).filter((row) => row.valid !== 1).length;
    return {
      code,
      severity: invalid ? 'warning' : truncated ? 'warning' : 'info',
      status: invalid ? 'warn' : truncated ? 'unknown' : 'pass',
      facts: {
        visibility: 'readable',
        rowsInspected: Math.min(rows.length, HISTORY_LIMIT),
        historyComplete: !truncated,
        invalidStorageRows: invalid,
        dirtyState: 'unknown',
        checksumsVerified: false,
      },
    };
  } catch {
    return unknown(code, { dirtyState: 'unknown' });
  }
}

/** Preflight before any SQLite open, including an MCP snapshot checkout. */
export function assertSqliteDoctorFile(url: string): void {
  if (!sqliteToolRuntime().available) throw new ValidationError(sqliteToolRuntime().reason!);
  // SQLite may create WAL/SHM files even for a readOnly database open. Require
  // existing sidecars for a WAL-format file; never create them just to diagnose.
  const path = normalizeSqlitePath(url);
  try {
    const fd = openSync(path, 'r');
    try {
      const header = Buffer.alloc(20);
      readSync(fd, header, 0, header.length, 0);
      if ((header[18] === 2 || header[19] === 2) && (!existsSync(`${path}-wal`) || !existsSync(`${path}-shm`))) {
        throw new ValidationError(
          'SQLite doctor requires existing WAL and SHM files for a WAL database; no sidecars were created. Use an owned read-only snapshot.',
        );
      }
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError('SQLite doctor requires an accessible existing database file.', { cause: error });
  }
}

/** Own a single existing file checkout and a stable read snapshot. */
export async function runSqliteDoctor(options: { url: string; schema?: string }): Promise<SqliteDoctorReport> {
  if (options.schema !== undefined && options.schema !== 'main') {
    throw new ValidationError('SQLite doctor requires schema "main".');
  }
  assertSqliteDoctorFile(options.url);
  const pool = createSqliteToolPool(options.url, options.schema ?? 'main');
  let client: PgCompatPoolClient | undefined;
  let checkout: CheckoutGuard | undefined;
  let result: SqliteDoctorReport | undefined;
  const errors: unknown[] = [];
  try {
    client = await pool.connect();
    checkout = guardCheckout(client);
    await client.query('BEGIN');
    result = await collectSqliteDoctorReport(client);
    await client.query('COMMIT');
  } catch (error) {
    errors.push(error);
  }
  try {
    client?.release();
  } catch (error) {
    errors.push(error);
  }
  checkout?.detach();
  try {
    await pool.end();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw Object.assign(new AggregateError(errors, 'SQLite doctor failed; owned cleanup was attempted.'), {
      report: result,
    });
  }
  return result!;
}

/** Reject PostgreSQL-only options before the lazy SQLite transport opens. */
export function assertSqliteDoctorArguments(
  args: Pick<CliArgs, 'command' | 'subcommand' | 'positional'> & Record<string, unknown>,
  argv: readonly string[] = [],
): void {
  const supported = new Set(['command', 'positional', 'engine', 'url', 'schema', 'json', 'verbose', 'help']);
  for (const key of Object.keys(args)) {
    if (!supported.has(key)) throw new ValidationError(`SQLite doctor does not support option "${key}".`);
  }
  if (args.subcommand !== undefined || args.positional.length) {
    throw new ValidationError('SQLite doctor takes no positional arguments.');
  }
  const flags = new Set(['--engine', '--url', '-u', '--schema', '-s', '--json', '--verbose', '-v', '--help', '-h']);
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!;
    if (!flags.has(flag)) throw new ValidationError(`SQLite doctor does not support argument "${flag}".`);
    if (['--engine', '--url', '-u', '--schema', '-s'].includes(flag)) {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith('-')) throw new ValidationError(`SQLite doctor ${flag} requires a value.`);
    }
  }
}

/** CLI presentation adapter; the PostgreSQL command keeps its own output. */
export async function cmdSqliteDoctor(
  args: CliArgs,
  config: ResolvedConfig,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  assertSqliteDoctorArguments(args as CliArgs & Record<string, unknown>, argv);
  if (
    config.engine !== 'sqlite' ||
    config.schema !== 'main' ||
    config.adapter ||
    config.include.length ||
    config.exclude.length
  ) {
    throw new ValidationError(
      'SQLite doctor requires engine "sqlite", schema "main", no adapter and no table filters.',
    );
  }
  const result = await runSqliteDoctor(config);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log('SQLite doctor (read-only catalog observations)');
    for (const check of result.checks) console.log(`${check.status} ${check.code} ${JSON.stringify(check.facts)}`);
    for (const limitation of result.limitations) console.log(`Limitation: ${limitation}`);
  }
}

/** Engine-specific help does not open a file or require a native runtime. */
export function showSqliteDoctorHelp(): void {
  console.log('turbine doctor --engine sqlite --url ./app.sqlite [--json]');
  console.log('Read-only runtime, connection, catalog, child-index and migration tracking observations.');
  console.log('Unknown results are explicit; no integrity scan, automatic repair, SQL input or settings change.');
  console.log('Requires an existing stable file set; WAL databases need existing WAL and SHM sidecars.');
}

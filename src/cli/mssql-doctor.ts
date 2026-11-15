/** Advisory structural diagnostics from an owned SQL Server catalog handle. */
import { type CheckoutGuard, guardCheckout } from '../connection-guard.js';
import { ValidationError } from '../errors.js';
import { mssqlDialect } from '../mssql.js';
import type { PgCompatPoolClient } from '../pg-types.js';
import type { SchemaMetadata } from '../schema.js';
import type { ResolvedConfig } from './config.js';
import type { CliArgs } from './index.js';
import * as catalog from './mssql-tools.js';

export interface MssqlDoctorCheck {
  code: string;
  status: 'pass' | 'warn' | 'fail' | 'unknown';
  severity: 'info' | 'warning' | 'error';
  message: string;
  observed?: unknown;
}
export interface MssqlDoctorReport {
  formatVersion: 1;
  engine: 'mssql';
  /** All scoped checks passed. Collection success alone does not imply ok. */
  ok: boolean;
  checks: MssqlDoctorCheck[];
  limitations: string[];
}

/** Optional transport sidecar; populated only from the existing fixed reads. */
export interface MssqlDoctorCatalog {
  namespace: string | null;
  primaryKeys: Record<
    string,
    { disabled: boolean | null; hypothetical: boolean | null; orderedKeysKnown: boolean; method: string | null }
  >;
}

type CatalogOptions = { include?: string[]; exclude?: string[]; legacyToManyUniques?: boolean };
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const ident = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  ![...value].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const quote = mssqlDialect.quoteIdentifier;
const prefix = (keys: readonly string[], columns: readonly string[]) =>
  columns.length > 0 && keys.length >= columns.length && columns.every((column, i) => keys[i] === column);

/** Never begins/ends a transaction or releases the caller's connection. */
export async function collectMssqlDoctorReport(
  client: PgCompatPoolClient,
  options: CatalogOptions = {},
): Promise<MssqlDoctorReport> {
  // This is also the ownership/concurrency guard. Caller-provided metadata is never accepted.
  const metadata = await catalog.introspectMssqlToolClient(client, options);
  // Older catalog transports lack namespace/activity provenance. They remain usable,
  // but cannot establish qualified relationships or primary-key index coverage.
  const sidecar = (
    catalog as typeof catalog & {
      mssqlToolDoctorCatalog?: (metadata: SchemaMetadata) => MssqlDoctorCatalog | undefined;
    }
  ).mssqlToolDoctorCatalog?.(metadata);
  const namespace = ident(sidecar?.namespace) ? sidecar.namespace : null;
  const tables = Object.values(metadata.tables).sort((a, b) => compare(a.name, b.name));
  const checks: MssqlDoctorCheck[] = [
    {
      code: 'MSSQL_CATALOG_SCOPE',
      status: 'unknown',
      severity: 'warning',
      message:
        'Visible catalog facts only; metadata permissions, omitted objects and cross-namespace relationships are unverified.',
      observed: {
        namespace: namespace === null ? null : quote(namespace),
        visibleTables: tables.length,
        complete: false,
      },
    },
    {
      code: 'MSSQL_CATALOG_CONSISTENCY',
      status: 'unknown',
      severity: 'warning',
      message:
        'Fixed catalog reads have no native read-only transaction or consistent snapshot guarantee; concurrent DDL can change observations.',
    },
    {
      code: 'MSSQL_RUNTIME_VERSION',
      status: 'unknown',
      severity: 'info',
      message: 'Server version discovery is unsupported by this catalog adapter.',
    },
    {
      code: 'MSSQL_MIGRATION_STATE',
      status: 'unknown',
      severity: 'info',
      message: 'Migration history, dirty state and filesystem checksums are unsupported by this catalog adapter.',
    },
  ];
  const target = (table: string) => ({ namespace: namespace === null ? null : quote(namespace), table: quote(table) });
  for (const table of tables) {
    if (!ident(table.name) || table.columns.some((c) => !ident(c.name))) {
      throw new ValidationError('SQL Server doctor encountered an unsupported catalog identifier.');
    }
    const columns = table.columns.slice().sort((a, b) => compare(a.name, b.name));
    checks.push({
      code: 'MSSQL_WRITE_RESTRICTIONS',
      status: columns.length ? 'pass' : 'unknown',
      severity: 'info',
      message:
        'Observed generated columns reject explicit writes; identity inserts normally require omission and identity updates are restricted. Unlisted restrictions remain unverified.',
      observed: {
        ...target(table.name),
        columns: columns
          .filter((c) => c.isGenerated || c.isGeneratedStored)
          .map((c) => ({
            column: quote(c.name),
            identity: c.isGenerated === true,
            generatedReadOnly: c.isGeneratedStored === true,
          })),
      },
    });
    const primary = table.primaryKey.filter(ident);
    const pkFlags = sidecar?.primaryKeys[table.name];
    const primaryUsable =
      primary.length === table.primaryKey.length &&
      primary.length > 0 &&
      primary.every((name) => columns.some((c) => c.name === name && !c.isGeneratedStored)) &&
      pkFlags?.orderedKeysKnown === true &&
      (pkFlags.method === 'CLUSTERED' || pkFlags.method === 'NONCLUSTERED') &&
      pkFlags.disabled === false &&
      pkFlags.hypothetical === false;
    const indexes = table.indexes
      .slice()
      .sort((a, b) => compare(a.name, b.name))
      .map((index) => {
        if (!ident(index.name) || index.columns.some((name) => !ident(name))) {
          throw new ValidationError('SQL Server doctor encountered an unsupported index identifier.');
        }
        const summary = catalog.mssqlToolIndexSummary(index);
        const usable =
          summary?.orderedKeysKnown === true &&
          summary.partial === false &&
          summary.disabled === false &&
          summary.hypothetical === false &&
          summary.computed === false &&
          (summary.method === 'CLUSTERED' || summary.method === 'NONCLUSTERED') &&
          index.columns.length > 0 &&
          index.columns.every((name) => columns.some((c) => c.name === name && !c.isGeneratedStored));
        return {
          name: quote(index.name),
          columns: index.columns.map(quote),
          unique: typeof summary?.nativeUnique === 'boolean' ? summary.nativeUnique : null,
          partial: typeof summary?.partial === 'boolean' ? summary.partial : null,
          disabled: typeof summary?.disabled === 'boolean' ? summary.disabled : null,
          hypothetical: typeof summary?.hypothetical === 'boolean' ? summary.hypothetical : null,
          computed: typeof summary?.computed === 'boolean' ? summary.computed : null,
          method: summary?.method === 'CLUSTERED' || summary?.method === 'NONCLUSTERED' ? summary.method : null,
          eligibleForForeignKeyCoverage: usable,
          keys: index.columns,
        };
      });
    checks.push({
      code: 'MSSQL_VISIBLE_KEYS',
      status: 'unknown',
      severity: 'info',
      message:
        'Visible primary and unique/index properties are structural observations; completeness, constraint trust and enforcement are unverified.',
      observed: {
        ...target(table.name),
        primaryKey: primary.map(quote),
        primaryIndexEligible: primaryUsable,
        indexes: indexes.map(({ keys: _keys, ...index }) => index),
      },
    });
    // Derivation is owned by the existing introspector; reverse/many-to-many
    // accessors are not independent constraints and must not duplicate findings.
    const relationships = Object.values(table.relations)
      .filter((r) => r.type === 'belongsTo')
      .sort((a, b) =>
        compare(
          JSON.stringify([a.to, a.foreignKey, a.referenceKey]),
          JSON.stringify([b.to, b.foreignKey, b.referenceKey]),
        ),
      );
    for (const relation of relationships) {
      const child = typeof relation.foreignKey === 'string' ? [relation.foreignKey] : relation.foreignKey;
      const parent = typeof relation.referenceKey === 'string' ? [relation.referenceKey] : relation.referenceKey;
      const referenced = Object.hasOwn(metadata.tables, relation.to) ? metadata.tables[relation.to] : undefined;
      const known =
        namespace !== null &&
        ident(relation.to) &&
        child.length > 0 &&
        child.length === parent.length &&
        child.every((name) => ident(name) && columns.some((c) => c.name === name)) &&
        parent.every((name) => ident(name) && referenced?.columns.some((c) => c.name === name));
      const covering = known
        ? indexes.filter((index) => index.eligibleForForeignKeyCoverage && prefix(index.keys, child)).map((i) => i.name)
        : [];
      const primaryCovers = known && primaryUsable && prefix(primary, child);
      checks.push({
        code: 'MSSQL_FK_CHILD_INDEX',
        status: primaryCovers || covering.length > 0 ? 'pass' : 'unknown',
        severity: primaryCovers || covering.length > 0 ? 'info' : 'warning',
        message:
          primaryCovers || covering.length > 0
            ? 'An observed active unfiltered rowstore index has the complete ordered child-key left prefix. This is advisory structure, not a performance or FK enforcement guarantee.'
            : 'Full child-key index coverage is unproved. Uncertain, filtered, computed, disabled and hypothetical indexes cannot prove it; catalog absence cannot establish a missing index.',
        observed: {
          ...target(table.name),
          columns: child.filter(ident).map(quote),
          referenced: ident(relation.to) ? { ...target(relation.to), columns: parent.filter(ident).map(quote) } : null,
          primaryCovers,
          coveringIndexes: covering,
        },
      });
    }
  }
  return {
    formatVersion: 1,
    engine: 'mssql',
    ok: checks.every((check) => check.status === 'pass'),
    checks,
    limitations: [
      'Collection success is distinct from every check being known and passed.',
      'Catalog visibility and database permissions are unverified; empty catalogs never establish a clean schema.',
      'Reads are fixed catalog queries only, without a native read-only transaction or consistent snapshot.',
      'Only visible same-namespace base-table relationships survive existing introspection filters; cross-namespace and hidden objects remain unknown.',
      'Index advice covers ordered column structure only, without workload, plan, collation applicability or performance guarantees.',
      'Server version, migration state, FK trust/enforcement and native SQL Server certification remain unknown.',
    ],
  };
}

export function assertMssqlDoctorArguments(args: CliArgs, rawArgs?: readonly string[]): void {
  const allowed = new Set(['command', 'positional', 'engine', 'url', 'schema', 'json', 'help', 'include', 'exclude']);
  if (args.subcommand || args.positional.length)
    throw new ValidationError('SQL Server doctor takes no positional arguments.');
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) throw new ValidationError(`SQL Server doctor does not support option "${key}".`);
  }
  if (rawArgs) {
    for (let i = 1; i < rawArgs.length; i++) {
      const token = rawArgs[i]!;
      if (['--engine', '--url', '-u', '--schema', '-s', '--include', '--exclude'].includes(token)) {
        const value = rawArgs[++i];
        if (!value?.trim() || value.startsWith('-'))
          throw new ValidationError('SQL Server doctor option requires a value.');
      } else if (!['--json', '--help', '-h'].includes(token)) {
        throw new ValidationError(
          'SQL Server doctor accepts only engine, URL, schema, include/exclude, JSON and help options.',
        );
      }
    }
  }
}

/** Owns a new pool and one checkout; always awaits both cleanup paths. */
export async function runMssqlDoctor(
  options: { url: string; schema?: string } & CatalogOptions,
): Promise<MssqlDoctorReport> {
  const pool = catalog.createMssqlToolPool(options.url, options.schema ?? 'dbo');
  let client: PgCompatPoolClient | undefined;
  let checkout: CheckoutGuard | undefined;
  try {
    client = await pool.connect();
    checkout = guardCheckout(client);
    return await collectMssqlDoctorReport(client, options);
  } finally {
    try {
      if (client) await catalog.releaseMssqlToolClient(client);
    } finally {
      checkout?.detach();
      await pool.end();
    }
  }
}

export function showMssqlDoctorHelp(): void {
  console.log('turbine doctor --engine mssql [--json] [--schema dbo] [--include tables] [--exclude tables]');
  console.log(
    'Advisory fixed catalog reads only. No native read-only transaction, consistent snapshot, repair or plan execution.',
  );
}

export async function cmdMssqlDoctor(
  args: CliArgs,
  config: ResolvedConfig,
  rawArgs?: readonly string[],
): Promise<void> {
  assertMssqlDoctorArguments(args, rawArgs);
  if (config.engine !== 'mssql' || config.adapter !== undefined)
    throw new ValidationError('SQL Server doctor requires engine mssql without a PostgreSQL adapter.');
  const report = await runMssqlDoctor(config);
  if (args.json) console.log(JSON.stringify(report));
  else {
    console.log('SQL Server catalog doctor: collection completed; assessment incomplete.');
    for (const check of report.checks)
      console.log(
        `${check.status.toUpperCase()} ${check.code}: ${check.message}${check.observed ? ` ${JSON.stringify(check.observed)}` : ''}`,
      );
    for (const limitation of report.limitations) console.log(`LIMITATION: ${limitation}`);
  }
}

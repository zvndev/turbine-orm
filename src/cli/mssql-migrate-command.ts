/** SQL Server migration command adapter. Engine selection remains in the shared dispatcher. */
import { readFileSync } from 'node:fs';
import { MigrationError, ValidationError } from '../errors.js';
import { printableCatalogName as shown } from '../introspect.js';
import type { ResolvedConfig } from './config.js';
import type { CliArgs } from './index.js';
import {
  createMigration,
  listIgnoredSqlFiles,
  type MigrationFile,
  statusGateProblems,
  summarizeMigrationStatus,
} from './migrate.js';
import * as native from './mssql-migrate.js';
import { parseMssqlMigrationContent, scanMssqlMigrationDestructive } from './mssql-migrate-sql.js';
import { banner, info, label, success, table, warn } from './ui.js';

type Runner = Pick<
  typeof native,
  | 'inspectMssqlMigrationDeploy'
  | 'planMssqlMigrationRollback'
  | 'migrateMssqlStatus'
  | 'migrateMssqlUp'
  | 'migrateMssqlDeploy'
  | 'migrateMssqlDown'
>;

export function showMssqlMigrationHelp(): void {
  banner();
  info('SQL Server SQL-first migrations (--engine mssql, --schema dbo):');
  info('migrate create <name> | up [--step N] | deploy [--wait[=seconds]] | down [--step N] | status [--exit-code]');
  info('up/down/deploy accept --dry-run. up/down require confirmation or --allow-destructive for destructive SQL.');
  info('deploy permits supported destructive SQL without prompting. Each selected run commits atomically.');
  info('--wait takes 1..2147483 whole seconds; omit it for no lock wait. Bare --wait means 300 seconds.');
  info('Use explicit schema.object names in UP/DOWN SQL. GO on its own line separates native batches.');
  info('Drift overrides, no-transaction, sqlcmd, procedural/dynamic SQL and code-first recipes are unsupported.');
}

function validate(args: CliArgs, config: ResolvedConfig, sub: string, argv: readonly string[]): void {
  if (String(config.engine) !== 'mssql')
    throw new ValidationError('SQL Server migration commands require engine "mssql".');
  if (
    config.adapter !== undefined ||
    args.auto ||
    args.fromDiff ||
    args.recipe ||
    args.allowPending ||
    args.allowPooler ||
    args.withSchema ||
    config.schemaFileConfigured ||
    args.force ||
    args.allowDrift
  ) {
    throw new ValidationError(
      'SQL Server migrations refuse adapters, schema diff/recipes/schemaFile, --force, --allow-drift, --allow-pending and --allow-pooler. Use explicit UP/DOWN SQL.',
    );
  }
  const supported = new Set([
    'command',
    'subcommand',
    'positional',
    'engine',
    'url',
    'schema',
    'step',
    'dryRun',
    'exitCode',
    'wait',
    'allowDestructive',
    'verbose',
    'help',
  ]);
  for (const key of Object.keys(args)) {
    if (!supported.has(key)) throw new ValidationError(`SQL Server migrate does not support option "${key}".`);
  }
  // Preserve the shared parser but refuse missing operands, including flags
  // swallowed by an earlier duplicate that the parsed object no longer shows.
  const valueFlags = new Set(['--url', '-u', '--schema', '-s']);
  for (let i = 1; i < argv.length; i++) {
    if (!valueFlags.has(argv[i]!)) continue;
    const value = argv[i + 1];
    if (!value?.trim() || value.startsWith('-')) {
      throw new ValidationError(`SQL Server migrate ${argv[i]} requires a value.`);
    }
    i++;
  }
  for (const key of ['url', 'schema'] as const) {
    if (Object.hasOwn(args, key) && (!args[key]?.trim() || args[key]!.startsWith('-'))) {
      throw new ValidationError(`SQL Server migrate option "${key}" requires a value.`);
    }
  }
  if (args.allowDestructive && !['up', 'down', 'deploy'].includes(sub))
    throw new ValidationError('--allow-destructive only applies to migrate up/down/deploy.');
  if (args.exitCode && !['status', 'list'].includes(sub))
    throw new ValidationError('--exit-code only applies to migrate status.');
  if (args.wait !== undefined && sub !== 'deploy') throw new ValidationError('--wait only applies to migrate deploy.');
  if (args.wait !== undefined && (!Number.isInteger(args.wait) || args.wait < 1 || args.wait * 1000 > 2147483647)) {
    throw new ValidationError(
      'SQL Server migration --wait must be whole seconds between 1 and 2147483; omit it for no wait.',
    );
  }
  if (args.step !== undefined && (!['up', 'down'].includes(sub) || !Number.isSafeInteger(args.step) || args.step < 1)) {
    throw new ValidationError('--step must be a positive safe integer for SQL Server migrate up/down.');
  }
  if (args.dryRun && !['up', 'down', 'deploy'].includes(sub))
    throw new ValidationError('--dry-run only applies to migrate up/down/deploy.');
}

function inventory(files: MigrationFile[], direction: 'up' | 'down'): void {
  native.assertMssqlMigrationFiles(files, direction);
  for (const file of files) {
    const sql = parseMssqlMigrationContent(readFileSync(file.path, 'utf8'), file.filename)[direction];
    label('Migration', shown(file.filename));
    if (scanMssqlMigrationDestructive(sql).length) warn('DESTRUCTIVE SQL Server migration.');
    console.log(sql);
  }
}

/** A separate factory permits observable command tests without replacing shared CLI configuration. */
export function createMssqlMigrationCommand(runner: Runner = native) {
  return async function cmdMssqlMigrate(
    args: CliArgs,
    config: ResolvedConfig,
    confirmDestructive: (report: string) => Promise<boolean>,
    argv: readonly string[] = process.argv.slice(2),
  ): Promise<void> {
    const sub = args.subcommand;
    if (!sub || sub === 'help') {
      showMssqlMigrationHelp();
      return;
    }
    if (!['create', 'up', 'deploy', 'down', 'status', 'list'].includes(sub))
      throw new ValidationError(`Unknown migrate subcommand: ${sub}`);
    validate(args, config, sub, argv);
    banner();
    if (sub === 'create') {
      const name = args.positional[0];
      if (!name || args.positional.length !== 1) throw new ValidationError('Usage: turbine migrate create <name>');
      const file = createMigration(config.migrationsDir, name);
      success(`Created ${shown(file.path)}`);
      info('Edit its UP/DOWN SQL Server SQL; qualify user objects with their schema.');
      return;
    }
    if (args.positional.length) throw new ValidationError(`Unexpected arguments for migrate ${sub}.`);
    if (!config.url)
      throw new ValidationError('SQL Server migrations require --url, config.url or MSSQL DATABASE_URL.');
    label('SQL Server schema', shown(config.schema));
    label('Migrations', shown(config.migrationsDir));
    const ignored = listIgnoredSqlFiles(config.migrationsDir);
    for (const name of ignored) warn(`Not a migration (expected YYYYMMDDHHMMSS_name.sql): ${shown(name)}`);
    const options = { schema: config.schema };
    if (sub === 'status' || sub === 'list') {
      const statuses = await runner.migrateMssqlStatus(config.url, config.migrationsDir, options);
      console.log(
        table(
          ['Status', 'Migration', 'Applied at'],
          statuses.map((s) => [
            s.missingFile ? 'Missing file' : s.checksumValid === false ? 'Drifted' : s.applied ? 'Applied' : 'Pending',
            shown(s.file.filename),
            s.appliedAt?.toISOString() ?? '-',
          ]),
        ),
      );
      const problems = statusGateProblems(summarizeMigrationStatus(statuses), ignored.map(shown));
      if (problems.length) warn(`Migration history is not clean: ${problems.join(', ')}`);
      if (args.exitCode && problems.length) process.exitCode = 2;
      return;
    }
    if (args.dryRun) {
      const plan = await runner.inspectMssqlMigrationDeploy(config.url, config.migrationsDir, options);
      if (plan.mismatches.length)
        throw new MigrationError(
          `SQL Server migration checksum drift or missing files: ${plan.mismatches.map((m) => shown(m.name)).join(', ')}.`,
        );
      const rollback =
        sub === 'down'
          ? await runner.planMssqlMigrationRollback(config.url, config.migrationsDir, { ...options, step: args.step })
          : undefined;
      if (rollback?.missing.length)
        throw new MigrationError(`Missing rollback files: ${rollback.missing.map(shown).join(', ')}.`);
      const files = rollback?.files ?? (sub === 'up' ? plan.pending.slice(0, args.step) : plan.pending);
      inventory(files, sub === 'down' ? 'down' : 'up');
      for (const order of plan.outOfOrder)
        warn(`Out of order: ${shown(order.applied)} predates ${shown(order.newestPrior)}.`);
      info(`Dry run: ${files.length} migration(s); no database or history changes made.`);
      info('SQL validity, database triggers and transaction state are checked during execution.');
      return;
    }
    if (sub === 'deploy') warn('Deploy permits supported destructive SQL Server migrations without prompting.');
    const execute = (allowDestructive: boolean) =>
      sub === 'down'
        ? runner.migrateMssqlDown(config.url, config.migrationsDir, { ...options, step: args.step, allowDestructive })
        : sub === 'deploy'
          ? runner.migrateMssqlDeploy(config.url, config.migrationsDir, {
              ...options,
              lockWaitMs: args.wait === undefined ? undefined : args.wait * 1000,
            })
          : runner.migrateMssqlUp(config.url, config.migrationsDir, { ...options, step: args.step, allowDestructive });
    let result: Awaited<ReturnType<typeof execute>>;
    try {
      result = await execute(args.allowDestructive === true);
    } catch (error) {
      if (
        !(error instanceof MigrationError) ||
        !error.message.includes('DESTRUCTIVE') ||
        sub === 'deploy' ||
        args.allowDestructive
      )
        throw error;
      if (!(await confirmDestructive(error.message)))
        throw new MigrationError('Aborted; no SQL Server migrations or history changes were committed.');
      result = await execute(true);
    }
    if (result.errors.length)
      throw new MigrationError('SQL Server migration runner returned errors; no success can be reported.');
    const files = 'applied' in result ? result.applied : result.rolledBack;
    success(`${files.length} migration(s) ${sub === 'down' ? 'rolled back' : 'applied'}`);
    for (const file of files) info(shown(file.filename));
    if ('outOfOrder' in result)
      for (const order of result.outOfOrder)
        warn(`Applied ${shown(order.applied)} out of order, before ${shown(order.newestPrior)}.`);
  };
}
export const cmdMssqlMigrate = createMssqlMigrationCommand();

/** SQLite command integration; the PostgreSQL CLI keeps its existing runner and output. */
import { readFileSync } from 'node:fs';
import { MigrationError, ValidationError } from '../errors.js';
import { printableCatalogName as shown } from '../introspect.js';
import type { ResolvedConfig } from './config.js';
import type { CliArgs } from './index.js';
import {
  createMigration,
  formatChecksumMismatchError,
  listIgnoredSqlFiles,
  type MigrationFile,
  parseMigrationContent,
  statusGateProblems,
  summarizeMigrationStatus,
} from './migrate.js';
import {
  assertSqliteMigrationFiles,
  inspectSqliteMigrationDeploy,
  migrateSqliteDeploy,
  migrateSqliteDown,
  migrateSqliteStatus,
  migrateSqliteUp,
  planSqliteMigrationRollback,
  scanSqliteMigrationDestructive,
} from './sqlite-migrate.js';
import { banner, info, label, success, table, warn } from './ui.js';

export function showSqliteHelp(): void {
  banner();
  info('SQLite SQL-first workflow (--engine sqlite, --url <persistent filename or file: URL>):');
  info('init -> migrate up -> generate (pull is an alias for generate)');
  info('Existing databases: init or pull; status shows the catalog.');
  info('migrate create <name> creates a file to edit with -- UP and -- DOWN SQL.');
  info('migrate up [--step N], deploy [--wait[=seconds]], down [--step N], status [--exit-code]');
  info(
    'up/down/deploy support --dry-run and --allow-drift. up/down require --allow-destructive for destructive SQL without interactive confirmation.',
  );
  info('deploy is noninteractive and permits destructive SQL. A selected batch commits atomically.');
  info('Native migration writes require Node >=24.10; migration status needs Node 22.x >=22.16 or >=24.');
  info(
    'Code-first schema diff: turbine push --schema-file <file> --dry-run; apply: turbine push --schema-file <file>.',
  );
  info('Recipes, views and PostgreSQL adapters are not supported.');
  info('Explicit seed modules: turbine seed --engine sqlite --help (never run automatically by init).');
}

function validateFlags(args: CliArgs, config: ResolvedConfig, sub: string): void {
  if (
    args.auto ||
    args.fromDiff ||
    args.recipe ||
    args.allowPending ||
    args.allowPooler ||
    config.schemaFileConfigured
  ) {
    throw new ValidationError(
      'SQLite migrations do not support schema diff, recipes, schemaFile, --allow-pending or --allow-pooler. Create and edit explicit UP/DOWN SQL.',
    );
  }
  if (args.exitCode && sub !== 'status' && sub !== 'list') {
    throw new ValidationError('--exit-code only applies to migrate status.');
  }
  if (args.wait !== undefined && sub !== 'deploy') {
    throw new ValidationError('--wait only applies to migrate deploy.');
  }
  if (args.step !== undefined && sub !== 'up' && sub !== 'down') {
    throw new ValidationError(
      '--step only applies to SQLite migrate up/down; deploy always applies the entire pending batch.',
    );
  }
  if (args.dryRun && !['up', 'down', 'deploy'].includes(sub)) {
    throw new ValidationError('--dry-run only applies to SQLite migrate up/down/deploy.');
  }
  if (args.force) {
    throw new ValidationError(
      'SQLite migrations use --allow-drift to explicitly rebaseline modified files; --force is not supported.',
    );
  }
}

function inventory(files: MigrationFile[], section: 'up' | 'down', printSql = false): void {
  assertSqliteMigrationFiles(files, section);
  for (const file of files) {
    const sql = parseMigrationContent(readFileSync(file.path, 'utf8'), file.path)[section];
    label('Migration', shown(file.filename));
    const destructive = scanSqliteMigrationDestructive(sql);
    if (destructive.length) {
      warn(`DESTRUCTIVE SQL: ${destructive.map((hit) => hit.kind).join(', ')}`);
    }
    if (printSql) console.log(sql);
  }
}

export async function cmdSqliteMigrate(
  args: CliArgs,
  config: ResolvedConfig,
  confirmDestructive: (report: string) => Promise<boolean>,
): Promise<void> {
  const sub = args.subcommand;
  if (!sub || sub === 'help') {
    showSqliteHelp();
    return;
  }
  if (!['create', 'up', 'deploy', 'down', 'status', 'list'].includes(sub)) {
    throw new ValidationError(`Unknown migrate subcommand: ${sub}`);
  }
  validateFlags(args, config, sub);
  banner();
  if (sub === 'create') {
    const name = args.positional[0];
    if (!name || args.positional.length !== 1) throw new ValidationError('Usage: turbine migrate create <name>');
    const file = createMigration(config.migrationsDir, name);
    success(`Created ${shown(file.path)}`);
    info('Edit its UP/DOWN SQLite SQL, then run turbine migrate up.');
    return;
  }
  if (args.positional.length) throw new ValidationError(`Unexpected arguments for migrate ${sub}.`);
  if (!config.url) throw new ValidationError('SQLite migrations need --url <filename>, config.url, or DATABASE_URL.');
  label('SQLite database', shown(config.url));
  label('Migrations', shown(config.migrationsDir));
  const ignored = listIgnoredSqlFiles(config.migrationsDir);
  for (const name of ignored) warn(`Not a migration (expected YYYYMMDDHHMMSS_name.sql): ${shown(name)}`);
  const options = { schema: config.schema, allowDrift: args.allowDrift };

  if (sub === 'status' || sub === 'list') {
    const statuses = await migrateSqliteStatus(config.url, config.migrationsDir, options);
    const health = summarizeMigrationStatus(statuses);
    info(`${statuses.filter((s) => s.applied).length} applied, ${statuses.filter((s) => !s.applied).length} pending`);
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
    const problems = statusGateProblems(health, ignored.map(shown));
    if (problems.length) warn(`Migration history is not clean: ${problems.join(', ')}`);
    if (args.exitCode && problems.length) process.exitCode = 2;
    return;
  }

  if (args.allowDrift)
    warn('--allow-drift rebaselines modified files; their previous SQL is not re-run. Missing files still block.');
  if (sub === 'deploy') warn('Deploy permits destructive SQLite SQL without prompting.');

  if (args.dryRun) {
    let files: MigrationFile[];
    const direction = sub === 'down' ? 'down' : 'up';
    if (sub === 'down') {
      const plan = await planSqliteMigrationRollback(config.url, config.migrationsDir, { ...options, step: args.step });
      if (plan.stoppedAt)
        throw new MigrationError(
          `${plan.stoppedAt.name}: ${plan.stoppedAt.error}; the entire rollback batch would be refused.`,
        );
      files = plan.toRollback;
    } else {
      const plan = await inspectSqliteMigrationDeploy(config.url, config.migrationsDir, options);
      const blocking = plan.mismatches.filter((m) => m.type === 'missing' || !args.allowDrift);
      if (blocking.length) throw new MigrationError(formatChecksumMismatchError(blocking));
      files = sub === 'up' ? plan.pending.slice(0, args.step) : plan.pending;
      for (const order of plan.outOfOrder)
        warn(`Out of order: ${shown(order.applied)} predates ${shown(order.newestPrior)}.`);
    }
    inventory(files, direction, true);
    info(`Dry run: ${files.length} migration(s); no database or history changes made.`);
    info(
      'SQL is displayed, not executed. Native authorization, SQL validity and foreign key checks run during execution.',
    );
    return;
  }

  // The native runner re-reads files/history after acquiring its lock. A preview
  // cannot authorize writes or turn a stale pending list into an execution plan.
  const execute = (allowDestructive: boolean) =>
    sub === 'down'
      ? migrateSqliteDown(config.url, config.migrationsDir, { ...options, step: args.step, allowDestructive })
      : sub === 'deploy'
        ? migrateSqliteDeploy(config.url, config.migrationsDir, {
            ...options,
            lockWaitMs: args.wait === undefined ? undefined : args.wait * 1000,
            onLockWait: () => warn(`Another writer holds the SQLite lock; waiting up to ${args.wait}s.`),
          })
        : migrateSqliteUp(config.url, config.migrationsDir, { ...options, step: args.step, allowDestructive });
  let result: Awaited<ReturnType<typeof execute>>;
  try {
    result = await execute(args.allowDestructive === true);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('DESTRUCTIVE') ||
      sub === 'deploy' ||
      args.allowDestructive
    )
      throw error;
    if (!(await confirmDestructive(error.message)))
      throw new MigrationError('Aborted; no SQLite migrations or history changes were committed.');
    result = await execute(true);
  }
  if (result.errors.length) {
    throw new MigrationError(
      `SQLite migration batch rolled back: ${result.errors.map((e) => `${shown(e.file.filename)}: ${e.error}`).join('\n')}`,
    );
  }
  const files = 'applied' in result ? result.applied : result.rolledBack;
  success(`${files.length} migration(s) ${sub === 'down' ? 'rolled back' : 'applied'}`);
  for (const file of files) info(shown(file.filename));
  for (const baseline of result.rebaselined)
    warn(`Re-baselined ${shown(baseline.name)}: ${baseline.from} -> ${baseline.to}`);
  if ('outOfOrder' in result) {
    for (const order of result.outOfOrder)
      warn(`Applied ${shown(order.applied)} out of order, before ${shown(order.newestPrior)}.`);
  }
}

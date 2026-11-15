/** MySQL SQL-first CLI adapter. Native DDL effects are never represented as transactional. */
import { readFileSync } from 'node:fs';
import { MigrationError, ValidationError } from '../errors.js';
import { printableCatalogName as shown } from '../introspect.js';
import type { SchemaDef } from '../schema-builder.js';
import { mysqlDatabaseFromUrl, type ResolvedConfig } from './config.js';
import type { CliArgs } from './index.js';
import {
  createMigration,
  formatChecksumMismatchError,
  listIgnoredSqlFiles,
  parseMigrationContent,
  statusGateProblems,
  summarizeMigrationStatus,
} from './migrate.js';
import {
  inspectMysqlMigrationDeploy,
  migrateMysqlDeploy,
  migrateMysqlDown,
  migrateMysqlStatus,
  migrateMysqlUp,
  planMysqlMigrationRollback,
  recoverMysqlMigration,
} from './mysql-migrate.js';
import { createMysqlSchemaMigration } from './mysql-schema.js';
import { assertMysqlSchemaConfig } from './mysql-schema-command.js';
import { banner, info, label, redactUrl, success, table, warn } from './ui.js';

export function showMysqlMigrateHelp(): void {
  info(`MySQL SQL-first migrations (optional mysql2 peer, direct MySQL 8.0.17+):
  turbine migrate create <name> --engine mysql [--from-diff --schema-file path]
  turbine migrate up --engine mysql [--step N] [--allow-destructive] [--allow-drift]
  turbine migrate deploy --engine mysql [--wait[=seconds]]
  turbine migrate down --engine mysql [--step N] [--allow-destructive] [--allow-drift]
  turbine migrate status --engine mysql [--exit-code] (list is an alias)
  turbine migrate recover <name> <checksum> <applied|rolled-back> --engine mysql --acknowledge-partial-ddl

Config/.env/--url select the database; default migrations: ./turbine/migrations.
Files use YYYYMMDDHHMMSS_name.sql with -- UP / -- DOWN sections.
up/down/deploy accept --dry-run: read-only inspection, not an execution guarantee.
Deploy permits destructive SQL without prompting, applies all pending files and always refuses drift.
MySQL DDL implicitly commits; failures can leave partial effects and block all ordinary writes.
Recovery requires manual reconciliation and exact dirty name/checksum/outcome; it never replays SQL.
Status --exit-code returns 2 for dirty, pending, drift, missing or ignored files; errors return 1.
create --from-diff compares a conservative SchemaDef subset and writes SQL for review, without applying it.
No --force, --auto, recipes, adapters, --allow-pending or --allow-pooler.
A configured schemaFile is used only by create --from-diff; ordinary SQL execution does not import it.`);
}

/** Check original tokens too: the shared legacy parser can swallow a safety flag as an operand. */
export function assertMysqlMigrationArguments(args: CliArgs, argv?: readonly string[]): void {
  const keys = new Set([
    'command',
    'engine',
    'subcommand',
    'positional',
    'url',
    'schema',
    'step',
    'dryRun',
    'force',
    'help',
    'auto',
    'fromDiff',
    'recipe',
    'allowDrift',
    'allowDestructive',
    'allowPending',
    'allowPooler',
    'exitCode',
    'wait',
    'schemaFile',
    'acknowledgePartialDdl',
  ]);
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && !keys.has(key)) throw new ValidationError(`Unsupported MySQL migration option: ${key}.`);
  }
  if (!argv) return;
  const operands = new Set(['--engine', '--url', '-u', '--schema', '-s', '--step', '-n', '--recipe', '--schema-file']);
  const flags = new Set([
    '--dry-run',
    '--force',
    '-f',
    '--help',
    '-h',
    '--auto',
    '--from-diff',
    '--allow-drift',
    '--allow-destructive',
    '--allow-pending',
    '--allow-pooler',
    '--exit-code',
    '--acknowledge-partial-ddl',
  ]);
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (operands.has(token)) {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith('-'))
        throw new ValidationError(`MySQL ${token} requires an explicit non-flag operand.`);
    } else if (token === '--wait') {
      const value = argv[i + 1];
      if (value && /^\d+$/.test(value)) i++;
    } else if (token.startsWith('--wait=')) {
      if (!/^\d+$/.test(token.slice(7))) throw new ValidationError('Invalid MySQL --wait operand.');
    } else if (token.startsWith('-') && !flags.has(token)) {
      throw new ValidationError(`Unsupported MySQL migration flag: ${shown(token)}.`);
    }
  }
}

function validate(args: CliArgs, config: ResolvedConfig, sub: string): void {
  assertMysqlMigrationArguments(args);
  if (config.engine !== 'mysql' || config.adapter !== undefined)
    throw new ValidationError('MySQL migrations require engine "mysql" and no PostgreSQL adapter.');
  if (typeof config.migrationsDir !== 'string' || !config.migrationsDir.trim() || config.migrationsDir.includes('\0'))
    throw new ValidationError('MySQL migrationsDir must be a nonempty path.');
  if (
    args.auto ||
    args.recipe ||
    args.allowPending ||
    args.allowPooler ||
    (args.fromDiff && sub !== 'create') ||
    (args.schemaFile !== undefined && !(sub === 'create' && args.fromDiff))
  )
    throw new ValidationError(
      'MySQL migrations require explicit SQL files; --from-diff and --schema-file only apply to create, and --auto, recipes, --allow-pending and --allow-pooler are unsupported.',
    );
  if (sub === 'create' && args.fromDiff) assertMysqlSchemaConfig(config);
  if (args.force) throw new ValidationError('MySQL migrations refuse --force; create a new migration.');
  if (args.exitCode && !['status', 'list'].includes(sub))
    throw new ValidationError('--exit-code only applies to MySQL migrate status/list.');
  if (args.step !== undefined && (!['up', 'down'].includes(sub) || !Number.isSafeInteger(args.step) || args.step < 1))
    throw new ValidationError('--step requires a positive integer and only applies to MySQL migrate up/down.');
  if (
    args.wait !== undefined &&
    (sub !== 'deploy' || !Number.isSafeInteger(args.wait) || args.wait < 1 || args.wait * 1000 > 2147483647)
  )
    throw new ValidationError('--wait requires 1..2147483 seconds and only applies to MySQL migrate deploy.');
  if (args.dryRun && !['up', 'down', 'deploy'].includes(sub))
    throw new ValidationError('--dry-run only applies to MySQL migrate up/down/deploy.');
  if (args.allowDrift && !['up', 'down'].includes(sub))
    throw new ValidationError('--allow-drift only applies to MySQL migrate up/down; deploy always refuses drift.');
  if (args.allowDestructive && !['up', 'down'].includes(sub))
    throw new ValidationError('--allow-destructive only applies to MySQL migrate up/down; deploy supplies consent.');
  if (args.acknowledgePartialDdl && sub !== 'recover')
    throw new ValidationError('--acknowledge-partial-ddl only applies to MySQL migrate recover.');
  if (sub === 'create') {
    if (args.positional.length !== 1) throw new ValidationError('Usage: turbine migrate create <name> --engine mysql');
  } else if (sub === 'recover') {
    const [name, checksum, outcome] = args.positional;
    if (
      args.positional.length !== 3 ||
      !name ||
      !/^[a-f0-9]{64}$/.test(checksum ?? '') ||
      !['applied', 'rolled-back'].includes(outcome ?? '') ||
      args.acknowledgePartialDdl !== true
    )
      throw new ValidationError(
        'Usage: turbine migrate recover <exact-name> <sha256> <applied|rolled-back> --engine mysql --acknowledge-partial-ddl. Manually reconcile schema/data first.',
      );
  } else if (args.positional.length) throw new ValidationError(`Unexpected arguments for MySQL migrate ${sub}.`);
  if (config.url) {
    const database = mysqlDatabaseFromUrl(config.url);
    if (config.schema !== database) throw new ValidationError('MySQL migration schema must match the URL database.');
  } else if (sub !== 'create') {
    throw new ValidationError(
      'MySQL migrations need --url, config.url, or DATABASE_URL selecting an existing database.',
    );
  }
}

export async function cmdMysqlMigrate(
  args: CliArgs,
  config: ResolvedConfig,
  loadSchema?: (path: string) => Promise<SchemaDef>,
): Promise<void> {
  const sub = args.subcommand;
  if (!sub || sub === 'help') {
    showMysqlMigrateHelp();
    return;
  }
  if (!['create', 'up', 'deploy', 'down', 'status', 'list', 'recover'].includes(sub))
    throw new ValidationError(`Unknown MySQL migrate subcommand: ${shown(sub)}`);
  validate(args, config, sub);
  banner();
  if (sub === 'create') {
    if (args.fromDiff) {
      if (!loadSchema)
        throw new ValidationError('MySQL create --from-diff requires the CLI schema loader integration.');
      const schema = await loadSchema(config.schemaFile);
      const result = await createMysqlSchemaMigration(config.url, config.migrationsDir, args.positional[0]!, schema);
      if (!result.file) success('No supported schema changes; no migration file created.');
      else {
        success(`Created ${shown(result.file.path)}`);
        warn('Review UP and destructive DOWN. MySQL DDL implicitly commits; every ALTER requires --allow-destructive.');
      }
      return;
    }
    const file = createMigration(config.migrationsDir, args.positional[0]!);
    success(`Created ${shown(file.path)}`);
    info('Edit its UP/DOWN MySQL SQL, then run turbine migrate up --engine mysql.');
    return;
  }
  label('MySQL database', redactUrl(config.url));
  label('Migrations', shown(config.migrationsDir));
  const options = { schema: config.schema };
  const ignored = listIgnoredSqlFiles(config.migrationsDir);
  for (const file of ignored) warn(`Not a migration (expected YYYYMMDDHHMMSS_name.sql): ${shown(file)}`);
  if (sub === 'status' || sub === 'list') {
    const statuses = await migrateMysqlStatus(config.url, config.migrationsDir, options);
    console.log(
      table(
        ['Status', 'Migration', 'Applied at'],
        statuses.map((s) => [
          s.dirty
            ? 'Dirty'
            : s.missingFile
              ? 'Missing file'
              : s.checksumValid === false
                ? 'Drifted'
                : s.applied
                  ? 'Applied'
                  : 'Pending',
          shown(s.file.filename),
          s.appliedAt?.toISOString() ?? '-',
        ]),
      ),
    );
    const problems = statusGateProblems(summarizeMigrationStatus(statuses), ignored.map(shown));
    for (const status of statuses) {
      if (!status.dirty) continue;
      const dirty = status.dirty;
      problems.push(`dirty: ${shown(dirty.name)}`);
      warn(
        `Dirty ${shown(dirty.name)}: checksum ${dirty.checksum}, ${dirty.direction}, ${dirty.completedStatements}/${dirty.totalStatements} confirmed statement responses.`,
      );
      warn(
        'Counts are lower bounds; later SQL may have effects. Autocommitted DDL is not rolled back. Reconcile manually before recover.',
      );
    }
    info(`${statuses.filter((s) => s.applied).length} applied, ${statuses.filter((s) => !s.applied).length} pending`);
    if (problems.length) warn(`Migration history is not clean: ${problems.join(', ')}`);
    if (args.exitCode && problems.length) process.exitCode = 2;
    return;
  }
  if (sub === 'recover') {
    await recoverMysqlMigration(config.url, config.migrationsDir, {
      ...options,
      name: args.positional[0]!,
      checksum: args.positional[1]!,
      outcome: args.positional[2] as 'applied' | 'rolled-back',
      acknowledgePartialDdl: true,
    });
    success('Recorded manually reconciled MySQL migration outcome; no migration SQL was executed.');
    return;
  }
  if (args.allowDrift)
    warn('--allow-drift records modified checksums without replaying applied UP SQL; missing files still block.');
  if (args.dryRun) {
    const plan = await inspectMysqlMigrationDeploy(config.url, config.migrationsDir, options);
    if (plan.dirty)
      throw new MigrationError(
        `MySQL migration ${shown(plan.dirty.name)} is dirty; reconcile and recover before continuing. Autocommitted DDL is not rolled back.`,
      );
    const blocking = plan.mismatches.filter((m) => m.type === 'missing' || !args.allowDrift);
    if (blocking.length) throw new MigrationError(formatChecksumMismatchError(blocking));
    const files =
      sub === 'down'
        ? await planMysqlMigrationRollback(config.url, config.migrationsDir, { ...options, step: args.step })
        : sub === 'up'
          ? plan.pending.slice(0, args.step)
          : plan.pending;
    for (const file of files) {
      label('Migration', shown(file.filename));
      console.log(parseMigrationContent(readFileSync(file.path, 'utf8'), file.path)[sub === 'down' ? 'down' : 'up']);
    }
    for (const order of plan.outOfOrder)
      warn(`Out of order: ${shown(order.applied)} predates ${shown(order.newestPrior)}.`);
    info(`Dry run: ${files.length} migration(s); no database or history changes made.`);
    warn(
      'SQL is displayed, not executed or certified. Native SQL mode/policy, executable SQL, authorization, destructive consent and concurrent state are checked again at execution; this inspection does not guarantee success.',
    );
    return;
  }
  warn('MySQL DDL implicitly commits. Partial effects may remain on failure; no transactional rollback is promised.');
  if (sub === 'deploy') warn('Deploy permits destructive MySQL SQL without prompting.');
  const writeOptions = {
    ...options,
    step: args.step,
    allowDrift: args.allowDrift,
    allowDestructive: args.allowDestructive,
  };
  const result =
    sub === 'down'
      ? await migrateMysqlDown(config.url, config.migrationsDir, writeOptions)
      : sub === 'deploy'
        ? await migrateMysqlDeploy(config.url, config.migrationsDir, {
            ...options,
            lockWaitMs: args.wait === undefined ? undefined : args.wait * 1000,
            onLockWait: () => warn(`Another runner holds the MySQL migration lock; waiting up to ${args.wait}s.`),
          })
        : await migrateMysqlUp(config.url, config.migrationsDir, writeOptions);
  const files = 'applied' in result ? result.applied : result.rolledBack;
  for (const file of files) info(`${sub === 'down' ? 'DOWN completed' : 'Applied'}: ${shown(file.filename)}`);
  for (const baseline of result.rebaselined)
    warn(`Re-baselined ${shown(baseline.name)}: ${baseline.from} -> ${baseline.to}`);
  if ('outOfOrder' in result)
    for (const order of result.outOfOrder)
      warn(`Applied ${shown(order.applied)} out of order, before ${shown(order.newestPrior)}.`);
  if (result.errors.length)
    throw new MigrationError(result.errors.map((e) => `${shown(e.file.filename)}: ${e.error}`).join('\n'));
  success(`${files.length} migration(s) ${sub === 'down' ? 'DOWN completed' : 'applied'}`);
}

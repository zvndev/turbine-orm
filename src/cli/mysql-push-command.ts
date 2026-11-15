/** MySQL push argument boundary and CLI presentation; shared dispatch supplies the loader. */
import { ValidationError } from '../errors.js';
import { printableCatalogName as shown } from '../introspect.js';
import type { SchemaDef } from '../schema-builder.js';
import type { ResolvedConfig } from './config.js';
import type { CliArgs } from './index.js';
import { pushMysqlSchema } from './mysql-push.js';
import { assertMysqlSchemaConfig } from './mysql-schema-command.js';
import { info, label, success, warn } from './ui.js';

/** Validate original operands before a swallowed --dry-run can become an apply. */
export function assertMysqlPushArguments(args: CliArgs, argv: readonly string[]): void {
  const keys = new Set([
    'command',
    'positional',
    'engine',
    'url',
    'schema',
    'schemaFile',
    'dryRun',
    'yes',
    'allowDestructive',
    'exitCode',
    'help',
  ]);
  for (const [key, value] of Object.entries(args))
    if (value !== undefined && !keys.has(key)) throw new ValidationError(`Unsupported MySQL push option: ${key}.`);
  if (args.command !== 'push' || args.positional.length)
    throw new ValidationError('Usage: turbine push --engine mysql (--dry-run | --yes) [--allow-destructive].');
  if (args.engine !== undefined && args.engine !== 'mysql')
    throw new ValidationError('MySQL push requires engine mysql.');
  const operands = new Set(['--engine', '--url', '-u', '--schema', '-s', '--schema-file']);
  const flags = new Set(['--dry-run', '--yes', '-y', '--allow-destructive', '--exit-code', '--help', '-h']);
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (operands.has(token)) {
      const operand = argv[++i];
      if (!operand?.trim() || operand.startsWith('-'))
        throw new ValidationError(`MySQL push ${token} requires an explicit non-flag operand.`);
    } else if (token.startsWith('-') && !flags.has(token))
      throw new ValidationError(`Unsupported MySQL push flag: ${shown(token)}.`);
    else if (!token.startsWith('-')) throw new ValidationError('Unexpected MySQL push operand.');
  }
  if (args.help) return;
  if ((args.dryRun === true) === (args.yes === true))
    throw new ValidationError('MySQL push requires exactly one of --dry-run or --yes (explicit apply).');
  if (args.yes && args.engine !== 'mysql')
    throw new ValidationError('MySQL push --yes requires explicit --engine mysql.');
  if (args.exitCode && !args.dryRun) throw new ValidationError('MySQL push --exit-code requires --dry-run.');
}

export function showMysqlPushHelp(): void {
  info(`MySQL conservative schema push:
  turbine push --engine mysql --dry-run [--exit-code] [--schema-file path]
  turbine push --engine mysql --yes [--allow-destructive] [--schema-file path]
Requires clean history and a complete supported schema. Preview writes nothing.
Apply preserves one ordinary SQL migration and uses the native partial-DDL journal.
Every ALTER requires separate --allow-destructive consent. DDL is not atomic.
Stop external schema changes; the cooperative runner lock is not a DDL lock.
Failures preserve files and dirty state; inspect and manually reconcile before migrate recover.`);
}

export async function cmdMysqlPush(
  args: CliArgs,
  config: ResolvedConfig,
  loadSchema: (path: string) => Promise<SchemaDef>,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  assertMysqlPushArguments(args, argv);
  if (args.help) return showMysqlPushHelp();
  if (config.engine !== 'mysql') throw new ValidationError('MySQL push requires engine mysql.');
  assertMysqlSchemaConfig(config);
  const result = await pushMysqlSchema(config.url, config.migrationsDir, await loadSchema(config.schemaFile), {
    dryRun: args.dryRun,
    apply: args.yes,
    allowDestructive: args.allowDestructive,
  });
  label('MySQL database', shown(result.plan.database));
  label('Catalog fingerprint', result.plan.fingerprint);
  if (!result.plan.steps.length) return success('No supported schema changes; no migration file created.');
  if (args.dryRun) {
    console.log(result.plan.up);
    info('Dry run: no files, history or schema changes made.');
    if (result.plan.requiresAlterConsent) info('Apply requires --yes and --allow-destructive for every ALTER.');
    if (args.exitCode) process.exitCode = 2;
  } else success(`Applied journaled migration ${shown(result.file!.filename)}.`);
  warn('Catalog checks are advisory, not a DDL lock. MySQL DDL implicitly commits; partial effects may remain.');
}

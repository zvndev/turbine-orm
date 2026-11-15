/** SQLite push and read-only schema diff presentation. */
import { ValidationError } from '../errors.js';
import type { SchemaDef } from '../schema-builder.js';
import { normalizeSqlitePath, type ResolvedConfig } from './config.js';
import type { CliArgs } from './index.js';
import { planSqliteSchema, pushSqliteSchema } from './sqlite-schema.js';
import { info, label, success } from './ui.js';

export async function cmdSqliteSchema(
  args: CliArgs,
  config: ResolvedConfig,
  loadSchema: (path: string) => Promise<SchemaDef>,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const supported = new Set([
    'command',
    'positional',
    'engine',
    'url',
    'schema',
    'schemaFile',
    'dryRun',
    'exitCode',
    'force',
    'allowDestructive',
    'verbose',
    'help',
  ]);
  for (const key of Object.keys(args)) {
    if (!supported.has(key)) throw new ValidationError(`SQLite push does not support option "${key}".`);
  }
  if (args.positional.length) throw new ValidationError('SQLite push takes no positional arguments.');
  // The shared PostgreSQL parser keeps its existing behavior. A value flag can
  // consume --dry-run, and repeated flags can overwrite that evidence in args.
  // Inspect raw operands as well as parsed keys before importing schema code.
  const valueFlags = new Set(['--url', '-u', '--schema', '-s', '--schema-file']);
  for (let i = 1; i < argv.length; i++) {
    if (!valueFlags.has(argv[i]!)) continue;
    const value = argv[i + 1];
    if (!value?.trim() || value.startsWith('-')) {
      throw new ValidationError(`SQLite push ${argv[i]} requires a value. Prefix relative paths with ./ if needed.`);
    }
    i++;
  }
  for (const key of ['url', 'schema', 'schemaFile'] as const) {
    if (Object.hasOwn(args, key) && (!args[key]?.trim() || args[key]!.startsWith('-'))) {
      throw new ValidationError(`SQLite push option "${key}" requires a value.`);
    }
  }
  if (config.schema !== 'main' || config.adapter || config.include.length || config.exclude.length) {
    throw new ValidationError(
      'SQLite schema push requires schema "main", no PostgreSQL adapter and no include/exclude filters.',
    );
  }
  if (args.force || args.allowDestructive)
    throw new ValidationError(
      'SQLite schema push preserves data; --force and --allow-destructive cannot bypass its refusals.',
    );
  if (args.exitCode && !args.dryRun) throw new ValidationError('SQLite push --exit-code requires --dry-run.');
  const filename = normalizeSqlitePath(config.url);
  const schema = await loadSchema(config.schemaFile);
  const plan = planSqliteSchema(schema, filename);
  label('SQLite database', filename);
  label('Schema file', config.schemaFile);
  for (const change of plan.changes) info(`${change.kind}: ${change.table}`);
  for (const object of plan.preserved) info(`Preserved: ${object}`);
  for (const step of plan.steps) {
    console.log(step.sql);
    if (step.params) console.log(`  Bindings: ${JSON.stringify(step.params)}`);
  }
  if (args.dryRun) {
    info('Dry run, no changes applied.');
    if (args.exitCode && plan.steps.length) process.exitCode = 2;
    return;
  }
  if (!plan.steps.length) {
    success('No supported schema changes to apply.');
    return;
  }
  const applied = pushSqliteSchema(schema, filename, { expectedPlan: plan });
  success(`Applied ${applied.steps.length} SQLite schema statements in one transaction.`);
  info('Schema push does not create or rebaseline SQL migration history.');
}

/** CLI presentation for a read-only MySQL diff. Shared dispatch is injected by the CLI. */
import { ValidationError } from '../errors.js';
import type { SchemaDef } from '../schema-builder.js';
import { mysqlDatabaseFromUrl, type ResolvedConfig, resolveCliEngine, validateCliEngineUrl } from './config.js';
import type { CliArgs } from './index.js';
import { inspectMysqlSchema, planMysqlSchema } from './mysql-schema.js';
import { modelMysqlSchema } from './mysql-schema-ddl.js';
import { info, label, success } from './ui.js';

export function assertMysqlSchemaConfig(config: ResolvedConfig): void {
  if (config.adapter || config.include.length || config.exclude.length)
    throw new ValidationError(
      'MySQL schema comparison requires engine mysql, no adapter and the complete schema without include/exclude filters.',
    );
  validateCliEngineUrl(resolveCliEngine(config.engine), config.url);
  if (!config.url || mysqlDatabaseFromUrl(config.url) !== config.schema)
    throw new ValidationError('MySQL schema comparison needs a URL selecting the configured database.');
  if (!config.schemaFile?.trim() || config.schemaFile.includes('\0'))
    throw new ValidationError('MySQL schema comparison requires a schema file path.');
}

export async function cmdMysqlSchema(
  args: CliArgs,
  config: ResolvedConfig,
  loadSchema: (path: string) => Promise<SchemaDef>,
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const keys = new Set(['command', 'positional', 'engine', 'url', 'schema', 'schemaFile', 'exitCode', 'help']);
  for (const [key, value] of Object.entries(args))
    if (value !== undefined && !keys.has(key)) throw new ValidationError(`Unsupported MySQL diff option: ${key}.`);
  if (args.command !== 'diff' || args.positional.length)
    throw new ValidationError('Usage: turbine diff --engine mysql [--schema-file path] [--exit-code].');
  const operands = new Set(['--engine', '--url', '-u', '--schema', '-s', '--schema-file']);
  const flags = new Set(['--exit-code', '--help', '-h']);
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (operands.has(token)) {
      const value = argv[++i];
      if (!value?.trim() || value.startsWith('-'))
        throw new ValidationError(`MySQL diff ${token} requires an explicit operand.`);
    } else if (token.startsWith('-') && !flags.has(token))
      throw new ValidationError(`Unsupported MySQL diff flag: ${token}.`);
  }
  assertMysqlSchemaConfig(config);
  const schema = await loadSchema(config.schemaFile);
  modelMysqlSchema(schema);
  const plan = planMysqlSchema(schema, await inspectMysqlSchema(config.url));
  label('MySQL database', plan.database);
  label('Catalog fingerprint', plan.fingerprint);
  if (!plan.steps.length) success('No supported schema changes.');
  else {
    for (const step of plan.steps) {
      info(`${step.kind}: ${step.table}`);
      console.log(step.sql);
    }
    info(
      'Read-only comparison. Create a reviewed SQL migration with migrate create <name> --from-diff --engine mysql.',
    );
    if (plan.requiresAlterConsent)
      info('The native runner requires --allow-destructive for every ALTER, including additions.');
    if (args.exitCode) process.exitCode = 2;
  }
}

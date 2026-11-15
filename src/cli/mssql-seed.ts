/** Trusted local SQL Server callback modules, using an injected native importer. */
import { existsSync, statSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ValidationError } from '../errors.js';
import { type MssqlSeedFunction, runMssqlSeed } from '../mssql-seed.js';
import { type ResolvedConfig, resolveSeedFile, unwrapModuleDefault } from './config.js';
import type { CliArgs } from './index.js';
import { needsTsLoader, registerTsLoader } from './loader.js';
import { introspectMssqlProject } from './mssql-project.js';
import { banner, info, label, success } from './ui.js';

export function showMssqlSeedHelp(): void {
  banner();
  info('turbine seed --engine mssql [--url mssql://host/database] [--schema dbo] [--verbose]');
  info('Run the trusted JS/TS default callback selected by config seedFile (legacy seed) or discovery.');
  info('Export default defineMssqlSeed(async (tx) => { ... }) from turbine-orm/mssql/seed.');
  info('TypeScript requires project-local tsx. Await every table operation and nested $transaction.');
  info('Native unqualified table resolution must match the configured schema. No session schema is changed.');
  info('Callback failure rolls back transactional DML; imports, external connections and module effects are excluded.');
  info('No implicit init seed, SQL files, dry-run, preview, positional arguments or PostgreSQL-only flags.');
}

/** Call before loading config, too: the generic parser consumes missing operands. */
export function assertMssqlSeedArguments(args: CliArgs, rawArgs?: readonly string[]): void {
  const supported = new Set(['command', 'positional', 'engine', 'url', 'schema', 'verbose', 'help']);
  for (const key of Object.keys(args)) {
    if (!supported.has(key)) throw new ValidationError(`SQL Server seed does not support option "${key}".`);
  }
  if (args.positional.length)
    throw new ValidationError('SQL Server seed takes no positional arguments. Set seedFile in config.');
  for (const key of ['url', 'schema'] as const) {
    if (Object.hasOwn(args, key) && !args[key]?.trim()) {
      throw new ValidationError(`SQL Server seed --${key} requires a value.`);
    }
  }
  if (rawArgs) {
    for (let i = 1; i < rawArgs.length; i++) {
      const token = rawArgs[i]!;
      if (['--url', '-u', '--schema', '-s', '--engine'].includes(token)) {
        const value = rawArgs[++i];
        if (!value?.trim() || value.startsWith('-'))
          throw new ValidationError(`SQL Server seed ${token} requires a value.`);
      } else if (!['--verbose', '-v', '--help', '-h'].includes(token)) {
        throw new ValidationError('SQL Server seed takes only --engine, --url, --schema, --verbose and --help.');
      }
    }
  }
}

/** The full CLI injects its native JS/TS importer in both ESM and CJS builds. */
export async function cmdMssqlSeed(
  args: CliArgs,
  config: ResolvedConfig,
  importModule: (specifier: string) => Promise<unknown>,
): Promise<void> {
  assertMssqlSeedArguments(args);
  const seedFile = resolveSeedFile(config);
  if (!seedFile || !existsSync(seedFile) || !statSync(seedFile).isFile()) {
    throw new ValidationError('SQL Server seed file not found. Set seedFile in config or create seed.ts or seed.js.');
  }
  if (!/\.(?:[cm]?ts|[cm]?js)$/i.test(seedFile)) {
    throw new ValidationError(
      `Unsupported SQL Server seed extension "${extname(seedFile)}". Use a trusted JS/TS default callback; SQL files are not supported.`,
    );
  }
  const schema = await introspectMssqlProject(config);
  if (needsTsLoader(seedFile)) {
    const status = await registerTsLoader();
    if (status !== 'registered' && status !== 'already') {
      throw new ValidationError(
        `Cannot load TypeScript SQL Server seed (${status}). Install tsx in this project or use .js/.mjs/.cjs.`,
      );
    }
  }
  banner();
  label('Seed file', relative(process.cwd(), seedFile) || seedFile);
  const fn: unknown = unwrapModuleDefault(await importModule(pathToFileURL(seedFile).href));
  if (typeof fn !== 'function')
    throw new ValidationError('SQL Server seed module must export a callable default callback receiving tx.');
  await runMssqlSeed(config.url, schema, fn as MssqlSeedFunction, { schema: config.schema });
  success('Seed completed');
}

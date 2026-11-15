/** Trusted local MySQL seed modules; no PostgreSQL fallback or SQL-file runner. */
import { existsSync, statSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ValidationError } from '../errors.js';
import { type MysqlSeedFunction, runMysqlSeed } from '../mysql-seed.js';
import { type ResolvedConfig, resolveSeedFile, unwrapModuleDefault } from './config.js';
import type { CliArgs } from './index.js';
import { getTsLoaderError, needsTsLoader, registerTsLoader } from './loader.js';
import { introspectMysqlProject } from './mysql-project.js';
import importSeedModule from './mysql-seed-loader.cjs';
import { banner, info, label, success } from './ui.js';

export function showMysqlSeedHelp(): void {
  banner();
  info('turbine seed --engine mysql [--url <mysql://.../database>] [--verbose]');
  info('Run the trusted default callback selected by config seedFile (legacy seed) or default discovery.');
  info('Export default defineMysqlSeed(async (tx) => { ... }) from turbine-orm/mysql/seed.');
  info('Supports .ts/.mts/.cts (project-local tsx required), .js/.mjs/.cjs; optional mysql2 peer required.');
  info('Awaited table() reads/DML run in one transaction; nested $transaction callbacks use savepoints.');
  info('Requires InnoDB base tables, no triggers, full catalog visibility and no concurrent schema changes.');
  info('MySQL DDL implicitly commits: raw SQL, DDL and driver/connection access are refused.');
  info('Imports, captured connections and external side effects are outside the DML rollback guarantee.');
  info('No SQL files, dry-run, preview, positional arguments, --schema or PostgreSQL-only flags. Init never seeds.');
}

/** Validate original tokens too, since the shared parser can swallow a flag as a value. */
export function assertMysqlSeedArguments(args: CliArgs, argv?: readonly string[]): void {
  const supported = new Set(['command', 'positional', 'engine', 'url', 'verbose', 'help']);
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && !supported.has(key)) {
      throw new ValidationError(`MySQL seed does not support option "${key}". Use seed --engine mysql --help.`);
    }
  }
  if (args.positional.length)
    throw new ValidationError('MySQL seed takes no positional arguments. Set seedFile in config.');
  if (Object.hasOwn(args, 'url') && !args.url?.trim()) {
    throw new ValidationError('MySQL seed --url requires a MySQL database URL.');
  }
  if (!argv) return;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (['--engine', '--url', '-u'].includes(token)) {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new ValidationError(`MySQL seed ${token} requires a value.`);
    } else if (!['--verbose', '-v', '--help', '-h'].includes(token)) {
      throw new ValidationError(`Unsupported MySQL seed argument: ${token}.`);
    }
  }
}

export async function cmdMysqlSeed(args: CliArgs, config: ResolvedConfig): Promise<void> {
  assertMysqlSeedArguments(args);
  const seedFile = resolveSeedFile(config);
  if (!seedFile || !existsSync(seedFile) || !statSync(seedFile).isFile()) {
    throw new ValidationError('MySQL seed file not found. Set seedFile in config or create seed.ts or seed.js.');
  }
  if (!/\.(?:[cm]?ts|[cm]?js)$/i.test(seedFile)) {
    throw new ValidationError(
      `Unsupported MySQL seed extension "${extname(seedFile)}". Use a trusted JS/TS module exporting a callback; SQL seed files are not supported.`,
    );
  }
  // Validate config/engine and native peer before importing executable seed code.
  const schema = await introspectMysqlProject(config);
  if (needsTsLoader(seedFile)) {
    const status = await registerTsLoader();
    if (status !== 'registered' && status !== 'already') {
      throw new ValidationError(
        `Cannot load TypeScript MySQL seed (${status}). Install tsx in this project or use .js/.mjs/.cjs. ${getTsLoaderError() ?? ''}`,
      );
    }
  }
  banner();
  label('Seed file', relative(process.cwd(), seedFile) || seedFile);
  const fn: unknown = unwrapModuleDefault(await importSeedModule(pathToFileURL(seedFile).href));
  if (typeof fn !== 'function')
    throw new ValidationError('MySQL seed module must export a callable default callback receiving tx.');
  await runMysqlSeed(config.url, schema, fn as MysqlSeedFunction);
  success('Seed completed');
}

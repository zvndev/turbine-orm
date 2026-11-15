/** Trusted local SQLite seed modules; no PostgreSQL seed or connection fallback. */
import { existsSync, statSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ValidationError } from '../errors.js';
import { runSqliteSeed, type SqliteSeedFunction } from '../sqlite-seed.js';
import { normalizeSqlitePath, type ResolvedConfig, resolveSeedFile, unwrapModuleDefault } from './config.js';
import type { CliArgs } from './index.js';
import { getTsLoaderError, needsTsLoader, registerTsLoader } from './loader.js';
import { introspectSqliteProject } from './sqlite-project.js';
import { banner, info, label, success } from './ui.js';

export function showSqliteSeedHelp(): void {
  banner();
  info('turbine seed --engine sqlite [--url <filename or file: URL>] [--verbose]');
  info('Run the trusted local module selected by config seedFile (legacy seed) or default discovery.');
  info('Export default defineSqliteSeed(async (tx) => { ... }) from turbine-orm/sqlite/seed.');
  info('Supports .ts/.mts/.cts (project-local tsx required), .js/.mjs/.cjs; Node >=22.12.');
  info('The database must already exist. Awaited callback tx operations commit together or roll back on failure.');
  info('Imports, other connections and arbitrary module side effects are outside that transaction.');
  info('No dry-run, preview, SQL files, positional arguments, --schema or PostgreSQL-only flags.');
}

export async function cmdSqliteSeed(args: CliArgs, config: ResolvedConfig): Promise<void> {
  const supported = new Set(['command', 'positional', 'engine', 'url', 'verbose', 'help']);
  for (const key of Object.keys(args)) {
    if (!supported.has(key)) {
      throw new ValidationError(`SQLite seed does not support option "${key}". Use seed --engine sqlite --help.`);
    }
  }
  if (args.positional.length)
    throw new ValidationError('SQLite seed takes no positional arguments. Set seedFile in config.');
  if (Object.hasOwn(args, 'url') && !args.url?.trim()) {
    throw new ValidationError('SQLite seed --url requires a persistent filename or file: URL.');
  }
  const seedFile = resolveSeedFile(config);
  if (!seedFile || !existsSync(seedFile) || !statSync(seedFile).isFile()) {
    throw new ValidationError('SQLite seed file not found. Set seedFile in config or create seed.ts or seed.js.');
  }
  if (!/\.(?:[cm]?ts|[cm]?js)$/i.test(seedFile)) {
    throw new ValidationError(
      `Unsupported SQLite seed extension "${extname(seedFile)}". Use a trusted JS/TS module exporting a callback; SQL seed files are not supported.`,
    );
  }
  // Validate engine/config/path/runtime and inspect without creating a missing
  // database, before importing any executable user seed code.
  const schema = await introspectSqliteProject(config);
  if (needsTsLoader(seedFile)) {
    const status = await registerTsLoader();
    if (status !== 'registered' && status !== 'already') {
      throw new ValidationError(
        `Cannot load TypeScript SQLite seed (${status}). Install tsx in this project or use .js/.mjs/.cjs. ${getTsLoaderError() ?? ''}`,
      );
    }
  }
  banner();
  label('Seed file', relative(process.cwd(), seedFile) || seedFile);
  const fn: unknown = unwrapModuleDefault(await import(pathToFileURL(seedFile).href));
  if (typeof fn !== 'function') {
    throw new ValidationError('SQLite seed module must export a callable default callback receiving tx.');
  }
  await runSqliteSeed(normalizeSqlitePath(config.url), schema, fn as SqliteSeedFunction);
  success('Seed completed');
}

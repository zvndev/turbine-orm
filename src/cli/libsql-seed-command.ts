/** Trusted local libSQL seed command. The CLI project lane supplies resolution. */
import { existsSync, statSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ValidationError } from '../errors.js';
import { localUrl } from '../libsql/pool.js';
import { type LibsqlSeedFunction, runLibsqlSeed } from '../libsql-seed.js';
import type { SchemaMetadata } from '../schema.js';
import { resolveSeedFile, unwrapModuleDefault } from './config.js';
import { getTsLoaderError, needsTsLoader, registerTsLoader } from './loader.js';
import importSeedModule from './mysql-seed-loader.cjs';
import { banner, info, label, success } from './ui.js';

/** Structural so this command does not require changes to shared engine unions. */
export interface LibsqlSeedArguments {
  command: string;
  positional: string[];
  engine?: string;
  url?: string;
  verbose?: boolean;
  help?: boolean;
}
export interface LibsqlSeedConfig {
  engine?: string;
  url: string;
  seedFile?: string;
  seed?: string;
}
/**
 * Must validate engine/options/runtime, refuse missing/non-file databases and
 * introspect the existing main catalog without DDL before returning. Return the
 * same normalized local URL used for introspection. No import of user seed code.
 */
export type ResolveLibsqlSeedProject = () => Promise<{ url: string; schema: SchemaMetadata }>;

export function showLibsqlSeedHelp(): void {
  banner();
  info('turbine seed --engine libsql [--url <local file: URL>] [--verbose]');
  info('Run the trusted default callback selected by seedFile (legacy seed) or default discovery.');
  info('Export default defineLibsqlSeed(async (tx) => { ... }) from turbine-orm/libsql/seed.');
  info('Supports .ts/.mts/.cts (project-local tsx required), .js/.mjs/.cjs; optional @libsql/client required.');
  info('The local database must exist. Await every query; nested callbacks use native savepoints.');
  info('SQLite-like transaction semantics; imports, other connections and external effects do not roll back.');
  info('No SQL files, preview/dry-run, positional arguments, remote/sync URLs, migrations or rebuild.');
}

/** Call with original argv too, before the shared parser can discard flags. */
export function assertLibsqlSeedArguments(args: LibsqlSeedArguments, argv?: readonly string[]): void {
  if (!['seed', 's'].includes(args.command)) throw new ValidationError('libSQL seed requires the seed command.');
  const supported = new Set(['command', 'positional', 'engine', 'url', 'verbose', 'help']);
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && !supported.has(key)) {
      throw new ValidationError(`libSQL seed does not support option "${key}". Use seed --engine libsql --help.`);
    }
  }
  if (args.engine !== undefined && args.engine !== 'libsql')
    throw new ValidationError('libSQL seed requires engine libsql.');
  if (args.positional.length) throw new ValidationError('libSQL seed takes no positional arguments. Set seedFile.');
  if (Object.hasOwn(args, 'url')) localUrl(args.url ?? '');
  if (!argv) return;
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]!;
    if (['--engine', '--url', '-u'].includes(token)) {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new ValidationError(`libSQL seed ${token} requires a value.`);
      if (token === '--engine' && value !== 'libsql') throw new ValidationError('libSQL seed requires engine libsql.');
      if (token !== '--engine') localUrl(value);
    } else if (!['--verbose', '-v', '--help', '-h'].includes(token)) {
      throw new ValidationError(`Unsupported libSQL seed argument: ${token}.`);
    }
  }
}

export async function cmdLibsqlSeed(
  args: LibsqlSeedArguments,
  config: LibsqlSeedConfig,
  resolveProject: ResolveLibsqlSeedProject,
): Promise<void> {
  assertLibsqlSeedArguments(args);
  if (config.engine !== 'libsql') throw new ValidationError('libSQL seed requires engine libsql.');
  localUrl(config.url);
  const seedFile = resolveSeedFile(config);
  if (!seedFile || !existsSync(seedFile) || !statSync(seedFile).isFile()) {
    throw new ValidationError('libSQL seed file not found. Set seedFile or create seed.ts or seed.js.');
  }
  if (!/\.(?:[cm]?ts|[cm]?js)$/i.test(seedFile)) {
    throw new ValidationError(
      `Unsupported libSQL seed extension "${extname(seedFile)}". Use a trusted JS/TS callback module; SQL seed files are not supported.`,
    );
  }
  const project = await resolveProject();
  if (localUrl(project.url) !== config.url) {
    throw new ValidationError('libSQL seed project URL must match the resolved config URL.');
  }
  if (needsTsLoader(seedFile)) {
    const status = await registerTsLoader();
    if (status !== 'registered' && status !== 'already') {
      throw new ValidationError(
        `Cannot load TypeScript libSQL seed (${status}). Install tsx in this project or use .js/.mjs/.cjs. ${getTsLoaderError() ?? ''}`,
      );
    }
  }
  banner();
  label('Seed file', relative(process.cwd(), seedFile) || seedFile);
  const fn: unknown = unwrapModuleDefault(await importSeedModule(pathToFileURL(seedFile).href));
  if (typeof fn !== 'function')
    throw new ValidationError('libSQL seed module must export a callable default callback.');
  await runLibsqlSeed(project.url, project.schema, fn as LibsqlSeedFunction);
  success('Seed completed');
}

/** Local native libSQL projects. No migration, schema lifecycle or remote transport. */
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ConnectionError, ValidationError } from '../errors.js';
import { resolveColumnTypeOverrides, resolveImportExtension } from '../generate.js';
import { generateLibsqlFiles } from '../libsql/generate.js';
import { introspectLibsql, type LibsqlIntrospectOptions } from '../libsql/introspect.js';
import type { LibsqlLocalClient } from '../libsql/pool.js';
import importOptionalPeer from '../optional-peer-import.cjs';
import type { SchemaMetadata } from '../schema.js';
import { findConfigFile, type ResolvedConfig } from './config.js';
import { assertLibsqlProjectConfigOptions, libsqlProjectUrl } from './libsql-project-config.js';
import { isSymlinkRefusal, openNoFollow } from './no-follow.js';
import { banner, info, label, success } from './ui.js';

export { libsqlProjectUrl } from './libsql-project-config.js';

/** Project engines supported by the local libSQL workflow. */
export type LibsqlProjectConfig = Omit<ResolvedConfig, 'engine'> & { engine?: string };
export interface LibsqlProjectArgs {
  allowEmpty?: boolean;
  includeViews?: boolean;
  zod?: boolean;
  noTimestamp?: boolean;
  skipGenerate?: boolean;
  skipSchema?: boolean;
  skipSeed?: boolean;
  skipPush?: boolean;
  withSchema?: boolean;
  force?: boolean;
  yes?: boolean;
  verbose?: boolean;
}

const commands = new Set(['init', 'pull', 'generate', 'gen', 'g', 'status', 'info']);
export function assertLibsqlProjectCommand(command: string): void {
  if (!commands.has(command))
    throw new ValidationError(
      `Command "${command}" is unsupported for local libSQL. Use init, pull, generate, catalog status, migrate status or bounded additive migrate deploy.`,
    );
}

/** Closed raw-flag admission also catches known PG flags which would otherwise be ignored. */
export function assertLibsqlProjectArguments(command: string, raw: readonly string[]): void {
  assertLibsqlProjectCommand(command);
  const values = new Set(['--engine', '--url', '-u', '--out', '-o', '--schema']);
  const flags = new Set(['--help', '-h', '--verbose', '-v']);
  if (['generate', 'gen', 'g', 'pull', 'init'].includes(command)) {
    for (const flag of ['--include', '--exclude', '--import-ext']) values.add(flag);
    for (const flag of ['--allow-empty', '--no-timestamp', '--keep-column-names', '--legacy-to-many-uniques'])
      flags.add(flag);
  }
  if (command === 'init') {
    for (const flag of ['--yes', '-y', '--force', '--skip-generate', '--skip-schema', '--skip-seed', '--skip-push'])
      flags.add(flag);
  }
  for (let i = 1; i < raw.length; i++) {
    const token = raw[i]!;
    if (values.has(token)) {
      const value = raw[++i];
      if (!value || value.startsWith('-')) throw new ValidationError(`Missing value for ${token}.`);
    } else if (!flags.has(token)) throw new ValidationError(`Unsupported local libSQL argument: ${token}.`);
  }
}

/** Minimal seed-lane contract: validated persistent URL/path and unchanged introspection options. */
export function resolveLibsqlProjectContext(config: LibsqlProjectConfig, args: LibsqlProjectArgs = {}) {
  if (config.engine !== 'libsql') throw new ValidationError('Local libSQL project commands require engine "libsql".');
  if (config.adapter !== undefined || config.schema !== 'main')
    throw new ValidationError('Local libSQL projects require schema "main" and no PostgreSQL adapter.');
  assertLibsqlProjectConfigOptions(config);
  if (args.includeViews || args.withSchema || config.schemaFileConfigured || args.zod)
    throw new ValidationError('Local libSQL projects do not support views, schema lifecycle or Zod generation.');
  const target = libsqlProjectUrl(config.url);
  const introspectOptions: LibsqlIntrospectOptions = {
    schema: 'main',
    include: config.include,
    exclude: config.exclude,
    relationNames: config.relationNames,
    keepColumnNames: config.keepColumnNames,
    legacyToManyUniques: config.legacyToManyUniques,
  };
  return { ...target, introspectOptions };
}

const notADatabaseFile = () =>
  new ValidationError('The local libSQL database must be an existing regular file. Run turbine init first.');

/**
 * Whether a database file is at `path`: false when nothing is there, refused
 * when something other than a regular file is. One lstat answers both, so the
 * two answers cannot describe different files.
 */
function existingDatabaseFile(path: string): boolean {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch {
    return false;
  }
  if (!stat.isFile()) throw notADatabaseFile();
  return true;
}

function requireFile(path: string): void {
  if (!existingDatabaseFile(path)) throw notADatabaseFile();
}

/** Refuse a `.gitignore` that is not a regular file before init creates anything. */
function assertGitignoreIsRegular(): void {
  try {
    const stat = lstatSync('.gitignore');
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ValidationError('.gitignore must be a regular file.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Create `.gitignore` holding `ignores`, or append the lines it lacks. An
 * existing file is opened once without following a symlink and is read and
 * appended through that descriptor, so a name replaced after the create was
 * refused is never written through, and a file that appeared in that window
 * gets the lines instead of being skipped.
 */
function addIgnores(ignores: string, created: string[]): void {
  try {
    writeFileSync('.gitignore', ignores, { flag: 'wx' });
    created.push('.gitignore');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const irregular = () => new ValidationError('.gitignore must be a regular file.');
  let fd: number;
  try {
    fd = openNoFollow('.gitignore', constants.O_RDWR | constants.O_APPEND);
  } catch (error) {
    if (isSymlinkRefusal(error) || (error as NodeJS.ErrnoException).code === 'EISDIR') throw irregular();
    throw error;
  }
  try {
    if (!fstatSync(fd).isFile()) throw irregular();
    const previous = readFileSync(fd, 'utf8');
    const missing = ignores.split('\n').filter((line) => line && !previous.split(/\r?\n/).includes(line));
    if (missing.length) appendFileSync(fd, `${previous.endsWith('\n') ? '' : '\n'}${missing.join('\n')}\n`);
  } finally {
    closeSync(fd);
  }
}

export async function introspectLibsqlProject(config: LibsqlProjectConfig, args: LibsqlProjectArgs = {}) {
  const context = resolveLibsqlProjectContext(config, args);
  requireFile(context.databasePath);
  return introspectLibsql(context.url, context.introspectOptions);
}

/** Resolve missing leaves through the nearest existing ancestor, including database directory aliases. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(path) === path) throw error;
    return join(canonicalPath(dirname(path)), basename(path));
  }
}

/** Resolve output and reject all database/output aliases before a native client can open. */
function outputDirectory(out: string, databasePath: string): string {
  const path = resolve(out);
  const rel = relative(process.cwd(), path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new ValidationError('libSQL generated output must be within the project root.');
  let cursor = process.cwd();
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      if (!lstatSync(cursor).isDirectory() || lstatSync(cursor).isSymbolicLink())
        throw new ValidationError('libSQL output ancestors must be regular directories, without symlinks.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const database = canonicalPath(databasePath);
  const identities = new Set<string>();
  try {
    const stat = lstatSync(database, { bigint: true });
    identities.add(`${stat.dev}:${stat.ino}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  for (const name of ['index.ts', 'types.ts', 'metadata.ts']) {
    const destination = join(path, name);
    const canonical = canonicalPath(destination);
    if (
      canonical === database ||
      canonical.startsWith(`${database}${sep}`) ||
      database.startsWith(`${canonical}${sep}`)
    )
      throw new ValidationError('libSQL generated output must not collide with the database path.');
    try {
      const stat = lstatSync(destination, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink())
        throw new ValidationError('libSQL generated files must be regular files, without symlinks.');
      const identity = `${stat.dev}:${stat.ino}`;
      if (identities.has(identity))
        throw new ValidationError('libSQL generated files must not alias the database or each other.');
      identities.add(identity);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return path;
}

export async function generateLibsqlProject(config: LibsqlProjectConfig, args: LibsqlProjectArgs = {}) {
  const context = resolveLibsqlProjectContext(config, args);
  const outDir = outputDirectory(config.out, context.databasePath);
  requireFile(context.databasePath);
  const { schema, files } = await renderLibsqlProject(config, args, context.url);
  writeGeneratedFiles(outDir, files);
  return { schema, outDir, files: Object.keys(files) };
}

async function renderLibsqlProject(config: LibsqlProjectConfig, args: LibsqlProjectArgs, url: string) {
  const { introspectOptions } = resolveLibsqlProjectContext(config, args);
  const schema = await introspectLibsql(url, introspectOptions);
  if (!Object.keys(schema.tables).length && !args.allowEmpty)
    throw new ValidationError('Local libSQL introspection matched 0 tables. Check filters or pass --allow-empty.');
  let columnTypes = config.columnTypes;
  if (columnTypes && (config.include.length || config.exclude.length)) {
    const catalog = await introspectLibsql(url, {
      ...introspectOptions,
      include: [],
      exclude: [],
      relationNames: undefined,
    });
    resolveColumnTypeOverrides(catalog, columnTypes);
    columnTypes = Object.fromEntries(
      Object.entries(columnTypes).filter(([key]) => Object.hasOwn(schema.tables, key.slice(0, key.lastIndexOf('.')))),
    );
  }
  const { ext: importExt, mode: importMode } = resolveImportExtension(config.out, config.importExtension);
  // Render every file before making output directories or replacing existing output.
  const files = generateLibsqlFiles(schema, { noTimestamp: args.noTimestamp, importExt, importMode, columnTypes });
  return { schema, files };
}

function writeGeneratedFiles(outDir: string, files: Record<string, string>): void {
  mkdirSync(outDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(outDir, name), contents);
}

export function libsqlConfigTemplate(config: LibsqlProjectConfig): string {
  return `import type { TurbineCliConfig } from 'turbine-orm/cli';

// Local native libSQL only. --url and DATABASE_URL override this persistent file.
const config: TurbineCliConfig = {
  engine: 'libsql',
  url: ${JSON.stringify(config.url)},
  out: ${JSON.stringify(config.out)},
};
export default config;
`;
}

async function nativeClientFactory() {
  try {
    const peer = (await importOptionalPeer('@libsql/client/node')) as {
      createClient: (options: { url: string; intMode: 'bigint'; concurrency: number }) => LibsqlLocalClient;
    };
    // Load and execute the native engine before any persistent project effect.
    const probe = peer.createClient({ url: ':memory:', intMode: 'bigint', concurrency: 1 });
    try {
      if ((await probe.execute({ sql: 'SELECT 9007199254740993' })).rows[0]?.[0] !== 9007199254740993n)
        throw new Error('Native bigint mode unavailable');
    } finally {
      probe.close();
    }
    return peer.createClient;
  } catch (cause) {
    throw new ConnectionError(
      'Local libSQL requires optional @libsql/client/node and its native engine. Install @libsql/client.',
      { cause },
    );
  }
}

export async function initLibsqlProject(config: LibsqlProjectConfig, args: LibsqlProjectArgs = {}) {
  const context = resolveLibsqlProjectContext(config, args);
  const outDir = outputDirectory(config.out, context.databasePath);
  assertGitignoreIsRegular();
  const existingDatabase = existingDatabaseFile(context.databasePath);
  const occupied = ['index.ts', 'types.ts', 'metadata.ts', 'zod.ts'].some((name) => existsSync(join(outDir, name)));
  // An empty native in-memory catalog validates new-project generation without creating a file or directory.
  const planned =
    !args.skipGenerate && !occupied
      ? await renderLibsqlProject(config, { ...args, allowEmpty: true }, existingDatabase ? context.url : ':memory:')
      : undefined;
  const rel = relative(process.cwd(), context.databasePath);
  const portableUrl =
    !rel.startsWith('..') && !isAbsolute(rel)
      ? `file:./${encodeURI(rel).replaceAll('#', '%23').replaceAll('?', '%3F')}`
      : context.url;
  const configText = libsqlConfigTemplate({ ...config, url: portableUrl });
  const exampleText = `import { turbine } from ${JSON.stringify(`./${relative(process.cwd(), outDir).split(sep).join('/')}/index.js`)};

async function main() {
  const db = await turbine(${JSON.stringify(portableUrl)});
  try { console.log('Local libSQL client ready'); }
  finally { await db.disconnect(); }
}
void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
`;
  const createClient = await nativeClientFactory();
  const created: string[] = [];
  if (!existingDatabase) {
    mkdirSync(dirname(context.databasePath), { recursive: true });
    try {
      writeFileSync(context.databasePath, '', { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      requireFile(context.databasePath);
      // A concurrent creator may have supplied a different catalog. Refuse before scaffolding or output writes.
      throw new ValidationError('The local libSQL database appeared during init. Retry initialization.');
    }
    let client: LibsqlLocalClient | undefined;
    try {
      client = createClient({ url: context.url, intMode: 'bigint', concurrency: 1 });
      await client.execute({ sql: 'PRAGMA user_version = 0' });
    } catch (error) {
      client?.close();
      client = undefined;
      unlinkSync(context.databasePath);
      throw error;
    } finally {
      client?.close();
    }
    created.push(context.databasePath);
  }
  const create = (path: string, contents: string) => {
    try {
      writeFileSync(path, contents, { flag: 'wx' });
      created.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  };
  if (!findConfigFile()) create('turbine.config.ts', configText);
  create('libsql-example.ts', exampleText);
  // Append ignores additively. Never create .env or write credentials.
  addIgnores('.env\n*.sqlite\n*.sqlite-shm\n*.sqlite-wal\n', created);
  if (planned) writeGeneratedFiles(outDir, planned.files);
  const generated = planned ? { schema: planned.schema, outDir, files: Object.keys(planned.files) } : undefined;
  return { databasePath: context.databasePath, existingDatabase, created, generated };
}

export async function cmdLibsqlInit(args: LibsqlProjectArgs, config: LibsqlProjectConfig): Promise<void> {
  banner();
  const result = await initLibsqlProject(config, args);
  label('Local libSQL database', result.databasePath);
  for (const path of result.created) success(`Created ${JSON.stringify(path)}`);
  info('Existing files preserved. Run npx tsx libsql-example.ts. No schema or migrations were applied.');
}

export async function cmdLibsqlGenerate(args: LibsqlProjectArgs, config: LibsqlProjectConfig): Promise<void> {
  banner();
  const result = await generateLibsqlProject(config, args);
  success(`Generated ${result.files.join(', ')} in ${JSON.stringify(result.outDir)}`);
}

export async function cmdLibsqlStatus(args: LibsqlProjectArgs, config: LibsqlProjectConfig): Promise<void> {
  banner();
  const schema: SchemaMetadata = await introspectLibsqlProject(config, args);
  label('Local libSQL catalog tables (filtered)', String(Object.keys(schema.tables).length));
  for (const table of Object.values(schema.tables))
    label(
      JSON.stringify(table.name),
      `${table.columns.length} columns, ${Object.keys(table.relations).length} relations`,
    );
  info('Catalog observations only. Use migrate status for separate read-only migration inspection.');
}

export function showLibsqlProjectHelp(): void {
  console.log('Local libSQL: init | pull | generate | status. Use --engine libsql --url file:./turbine/dev.sqlite.');
  console.log('Install optional @libsql/client and tsx. Persistent local files only; no remote/auth/sync/replicas.');
  console.log(
    'Status observes the catalog only. migrate status inspects history; migrate deploy applies bounded additive SQL. Push, schema, doctor and tools are unsupported.',
  );
}

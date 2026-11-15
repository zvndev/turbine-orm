/** SQL-first MySQL project commands backed by the optional native introspector. */
import {
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ValidationError } from '../errors.js';
import { generate } from '../generate.js';
import { applyRelationRenames, assertSafeCatalogSchema, printableCatalogName as shown } from '../introspect.js';
import { introspectMysql } from '../mysql.js';
import type { SchemaMetadata } from '../schema.js';
import { findConfigFile, mysqlDatabaseFromUrl, type ResolvedConfig, resolveCliEngine } from './config.js';
import { banner, info, label, redactUrl, success } from './ui.js';

export interface MysqlProjectArgs {
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

function checkConfig(config: ResolvedConfig, args: MysqlProjectArgs): void {
  if (resolveCliEngine(config.engine) !== 'mysql') {
    throw new ValidationError('MySQL project commands require engine "mysql".');
  }
  let database: string;
  try {
    database = mysqlDatabaseFromUrl(config.url);
  } catch (error) {
    throw new ValidationError((error as Error).message);
  }
  if (config.schema !== database) throw new ValidationError('MySQL CLI schema must match the database in its URL.');
  if (config.adapter !== undefined) throw new ValidationError('PostgreSQL adapters cannot be used with MySQL.');
  for (const key of ['include', 'exclude'] as const) {
    if (!Array.isArray(config[key]) || !config[key].every((value) => typeof value === 'string' && value.length > 0)) {
      throw new ValidationError(`MySQL config ${key} must be an array of nonempty table names.`);
    }
  }
  for (const key of ['out', 'migrationsDir'] as const) {
    if (typeof config[key] !== 'string' || !config[key].trim() || config[key].includes('\0')) {
      throw new ValidationError(`MySQL config ${key} must be a nonempty path.`);
    }
  }
  if (!['auto', 'js', 'ts', 'none'].includes(config.importExtension)) {
    throw new ValidationError('MySQL config importExtension must be auto, js, ts, or none.');
  }
  if (typeof config.keepColumnNames !== 'boolean' || typeof config.legacyToManyUniques !== 'boolean') {
    throw new ValidationError('MySQL config keepColumnNames and legacyToManyUniques must be booleans.');
  }
  if (
    config.columnTypes !== undefined &&
    (!config.columnTypes ||
      typeof config.columnTypes !== 'object' ||
      Array.isArray(config.columnTypes) ||
      !Object.values(config.columnTypes).every((value) => typeof value === 'string' && value.trim()))
  ) {
    throw new ValidationError(
      'MySQL config columnTypes must map database columns to nonempty TypeScript type strings.',
    );
  }
  if (
    config.relationNames !== undefined &&
    (!config.relationNames ||
      typeof config.relationNames !== 'object' ||
      Array.isArray(config.relationNames) ||
      !Object.values(config.relationNames).every(
        (names) =>
          names &&
          typeof names === 'object' &&
          !Array.isArray(names) &&
          Object.values(names).every((name) => typeof name === 'string' && name.length > 0),
      ))
  ) {
    throw new ValidationError('MySQL config relationNames must map tables to relation rename maps.');
  }
  if (args.includeViews) throw new ValidationError('MySQL CLI introspection does not support --include-views yet.');
  if (args.withSchema || config.schemaFileConfigured) {
    throw new ValidationError('MySQL CLI projects use SQL migrations, not schemaFile or --with-schema.');
  }
}

/** Refuse every unsupported command before reaching PostgreSQL handlers. */
export function assertMysqlProjectCommand(command: string): void {
  if (['init', 'generate', 'gen', 'g', 'pull', 'status', 'info', 'migrate', 'migration', 'm'].includes(command)) return;
  throw new ValidationError(
    `Command "${command}" is not supported for MySQL. Supported commands: init, pull, generate, status, migrate.`,
  );
}

/** Read the native MySQL catalog and release its short-lived pool on all paths. */
export async function introspectMysqlProject(
  config: ResolvedConfig,
  args: MysqlProjectArgs = {},
): Promise<SchemaMetadata> {
  checkConfig(config, args);
  const metadata = await introspectMysql({
    connectionString: config.url,
    schema: config.schema,
    include: config.include,
    legacyToManyUniques: config.legacyToManyUniques,
    // The native migration runner journals partial DDL separately from history.
    exclude: config.include.includes('_turbine_migration_state')
      ? config.exclude
      : [...config.exclude, '_turbine_migration_state'],
  });
  const schema = config.relationNames ? applyRelationRenames(metadata, config.relationNames) : metadata;
  assertSafeCatalogSchema(schema);
  return schema;
}

/** Generate only after native introspection and validation succeed. */
export async function generateMysqlProject(config: ResolvedConfig, args: MysqlProjectArgs = {}) {
  const schema = await introspectMysqlProject(config, args);
  if (Object.keys(schema.tables).length === 0 && !args.allowEmpty) {
    throw new ValidationError(
      'MySQL introspection matched 0 tables; refusing an empty client. Apply SQL, check include/exclude, or pass --allow-empty.',
    );
  }
  let columnTypes = config.columnTypes;
  if (columnTypes && (config.include.length || config.exclude.length)) {
    // Validate excluded overrides against the full catalog so genuine typos still fail.
    const catalog = await introspectMysqlProject(
      { ...config, include: [], exclude: [], relationNames: undefined },
      args,
    );
    columnTypes = Object.fromEntries(
      Object.entries(columnTypes).filter(([key]) => {
        const table = key.slice(0, key.lastIndexOf('.'));
        const column = key.slice(key.lastIndexOf('.') + 1);
        return Object.hasOwn(schema.tables, table) || !catalog.tables[table]?.columns.some((c) => c.name === column);
      }),
    );
  }
  const result = generate({
    target: 'mysql',
    schema,
    exactNativeIntegers: config.exactNativeIntegers,
    outDir: config.out,
    connectionString: config.url,
    importExtension: config.importExtension,
    keepColumnNames: config.keepColumnNames,
    columnTypes,
    noTimestamp: args.noTimestamp,
    zod: args.zod,
  });
  return { schema, ...result };
}

/** Credentials always stay in the environment, never the tracked config. */
export function mysqlConfigTemplate(config: ResolvedConfig): string {
  return `import type { TurbineCliConfig } from 'turbine-orm/cli';

const config: TurbineCliConfig = {
  engine: 'mysql',
  url: process.env.DATABASE_URL,
  out: ${JSON.stringify(config.out)},
  migrationsDir: ${JSON.stringify(config.migrationsDir)},
  legacyToManyUniques: ${JSON.stringify(config.legacyToManyUniques)},
};

// Apply schema changes with native MySQL SQL tooling, then turbine generate.
export default config;
`;
}

function createFile(path: string, contents: string, created: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
    created.push(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

/**
 * Make `.gitignore` ignore `/.env`. Created only when nothing is at the name;
 * otherwise read and appended through one descriptor, so the file read is the
 * file appended to, and a `.gitignore` that appeared after a separate look is
 * given the rule instead of being skipped before `.env` is written.
 * @internal exported for tests.
 */
export function ignoreEnvFile(created: string[]): void {
  const rule = '# Local database credentials\n/.env\n';
  try {
    writeFileSync('.gitignore', rule, { encoding: 'utf8', flag: 'wx' });
    created.push('.gitignore');
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  let fd: number;
  try {
    fd = openSync('.gitignore', constants.O_RDWR | constants.O_APPEND);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    throw new ValidationError(
      '.gitignore cannot be read or created (a dangling symlink?). Remove it and run the command again.',
    );
  }
  try {
    if (!/(?:^|\n)\/\.env\s*$/.test(readFileSync(fd, 'utf8').trimEnd())) appendFileSync(fd, `\n${rule}`);
  } finally {
    closeSync(fd);
  }
}

const STARTER_SQL = `-- UP
CREATE TABLE users (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  display_name VARCHAR(255)
) COLLATE utf8mb4_0900_bin;

-- DOWN
DROP TABLE users;
`;

export interface MysqlInitResult {
  created: string[];
  generated?: { outDir: string; files: string[] };
}

/** Additive scaffolding. Never creates a database or applies SQL, even with --force. */
export async function initMysqlProject(config: ResolvedConfig, args: MysqlProjectArgs = {}): Promise<MysqlInitResult> {
  // Probe before writing anything; inspect the complete catalog before choosing a starter.
  const catalog = await introspectMysqlProject({ ...config, include: [], exclude: [], relationNames: undefined }, args);
  const created: string[] = [];
  if (!findConfigFile()) createFile('turbine.config.ts', mysqlConfigTemplate(config), created);
  // Establish the ignore rule before writing a URL that might contain a password.
  ignoreEnvFile(created);
  createFile('.env', `DATABASE_URL=${JSON.stringify(config.url)}\n`, created);
  createFile('.env.example', 'DATABASE_URL=mysql://user:password@localhost:3306/app\n', created);
  mkdirSync(config.migrationsDir, { recursive: true });
  if (
    !Object.keys(catalog.tables).length &&
    !args.skipSchema &&
    !readdirSync(config.migrationsDir).some((file) => file.endsWith('.sql'))
  ) {
    const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    createFile(join(config.migrationsDir, `${timestamp}_create_users.sql`), STARTER_SQL, created);
  }
  const occupied = ['index.ts', 'types.ts', 'metadata.ts', 'zod.ts'].some((file) =>
    existsSync(resolve(config.out, file)),
  );
  const generated =
    Object.keys(catalog.tables).length && !args.skipGenerate && !occupied
      ? await generateMysqlProject(config, args)
      : undefined;
  return { created, ...(generated ? { generated } : {}) };
}

export async function cmdMysqlInit(args: MysqlProjectArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const result = await initMysqlProject(config, args);
  label('MySQL database', redactUrl(config.url));
  for (const path of result.created) success(`Created ${shown(path)}`);
  if (result.generated) success(`Generated ${result.generated.files.join(', ')} in ${shown(result.generated.outDir)}`);
  info('Existing files are preserved, including with --force. Check DATABASE_URL in your environment or .env.');
  info('Init never applies SQL. Apply schema changes with native MySQL tooling, then run turbine generate.');
}

export async function cmdMysqlGenerate(args: MysqlProjectArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const result = await generateMysqlProject(config, args);
  label('MySQL database', redactUrl(config.url));
  success(`Found ${Object.keys(result.schema.tables).length} tables`);
  success(`Generated ${result.files.join(', ')} in ${shown(result.outDir)}`);
}

export async function cmdMysqlStatus(args: MysqlProjectArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const schema = await introspectMysqlProject(config, args);
  label('MySQL database', redactUrl(config.url));
  label('Tables', String(Object.keys(schema.tables).length));
  for (const table of Object.values(schema.tables)) {
    label(shown(table.name), `${table.columns.length} columns, ${Object.keys(table.relations).length} relations`);
  }
}

export function showMysqlHelp(): void {
  console.log(`MySQL SQL-first project commands (mysql2 optional peer required):
  turbine init --engine mysql --url mysql://user:password@host:3306/database
  turbine pull --engine mysql
  turbine generate --engine mysql [--include users] [--exclude audit] [--allow-empty]
  turbine status --engine mysql
  turbine push --engine mysql --dry-run [--exit-code]
  turbine push --engine mysql --yes [--allow-destructive]
  turbine seed --engine mysql

Config: engine: 'mysql', url: process.env.DATABASE_URL; database comes from the URL.
Generation: --out, --import-ext, --keep-column-names, --no-timestamp, --zod.
Init preserves files and never applies SQL. Use turbine migrate --engine mysql --help for native SQL migrations.
MySQL diff --schema-file path [--exit-code] compares a conservative SchemaDef subset without writes.
Use migrate create <name> --from-diff --schema-file path to scaffold reviewed native SQL.
Seeds are explicit trusted DML callbacks; use turbine seed --engine mysql --help for rollback limits.
Journaled push preserves a SQL migration before execution; use turbine push --engine mysql --help.
Views and automatic seeding are unavailable.`);
}

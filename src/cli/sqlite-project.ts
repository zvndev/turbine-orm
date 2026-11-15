/** SQLite project commands. Schemas are maintained by explicit UP/DOWN SQL migrations. */
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { DatabaseSync as NativeDatabase } from 'node:sqlite';
import { ValidationError } from '../errors.js';
import { generate } from '../generate.js';
import { applyRelationRenames, assertSafeCatalogSchema, printableCatalogName as shown } from '../introspect.js';
import type { SchemaMetadata } from '../schema.js';
import { introspectSqliteDatabase } from '../sqlite.js';
import { findConfigFile, normalizeSqlitePath, type ResolvedConfig, resolveCliEngine } from './config.js';
import { banner, info, label, newline, success } from './ui.js';

export interface SqliteProjectArgs {
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

function databaseConstructor(): typeof NativeDatabase {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major! < 22 || (major === 22 && minor! < 12)) {
    throw new ValidationError('SQLite CLI commands require node:sqlite with readOnly support (Node >= 22.12).');
  }
  try {
    const Database = createRequire(join(process.cwd(), 'package.json'))('node:sqlite').DatabaseSync;
    if (typeof Database !== 'function') throw new Error('DatabaseSync unavailable');
    return Database;
  } catch {
    throw new ValidationError('SQLite CLI commands require node:sqlite with readOnly support (Node >= 22.12).');
  }
}

function checkConfig(config: ResolvedConfig, args: SqliteProjectArgs): void {
  if (resolveCliEngine(config.engine) !== 'sqlite') {
    throw new ValidationError('SQLite project commands require engine "sqlite".');
  }
  if (config.adapter !== undefined) throw new ValidationError('PostgreSQL adapters cannot be used with SQLite.');
  if (config.schema !== 'main') throw new ValidationError('SQLite project commands use schema "main".');
  if (args.withSchema || config.schemaFileConfigured) {
    throw new ValidationError(
      'SQLite CLI projects use SQL migrations, not schemaFile or --with-schema. Run turbine migrate create <name>, edit its UP/DOWN SQL, then migrate up and generate.',
    );
  }
}

/** Unsupported commands must be refused before reaching PostgreSQL handlers. */
export function assertSqliteProjectCommand(command: string): void {
  if (
    [
      'init',
      'generate',
      'gen',
      'g',
      'pull',
      'status',
      'info',
      'push',
      'seed',
      's',
      'migrate',
      'migration',
      'm',
      'mcp',
      'capabilities',
      'schema',
      'compile',
      'explain-error',
    ].includes(command)
  )
    return;
  throw new ValidationError(
    `Command "${command}" is not supported for SQLite. Use SQL migrations: turbine migrate create <name>, edit its UP/DOWN SQL, turbine migrate up, then turbine generate.`,
  );
}

/** Introspect an existing database without creating a missing file or retaining a handle. */
export async function introspectSqliteProject(
  config: ResolvedConfig,
  args: SqliteProjectArgs = {},
): Promise<SchemaMetadata> {
  checkConfig(config, args);
  const path = normalizeSqlitePath(config.url);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new ValidationError(`SQLite database file does not exist: ${path}. Run turbine init --engine sqlite first.`);
  }
  const Database = databaseConstructor();
  const db = new Database(path, { readOnly: true });
  try {
    db.exec('BEGIN');
    const metadata = introspectSqliteDatabase(db, {
      includeViews: args.includeViews,
      include: config.include,
      exclude: config.exclude,
      legacyToManyUniques: config.legacyToManyUniques,
    });
    const schema = config.relationNames ? applyRelationRenames(metadata, config.relationNames) : metadata;
    assertSafeCatalogSchema(schema);
    return schema;
  } finally {
    db.close();
  }
}

/** Reuse the schema-specific SQLite factory and every supported generation option. */
export async function generateSqliteProject(config: ResolvedConfig, args: SqliteProjectArgs = {}) {
  const schema = await introspectSqliteProject(config, args);
  if (Object.keys(schema.tables).length === 0 && !args.allowEmpty) {
    throw new ValidationError(
      'SQLite introspection matched 0 tables; refusing an empty client. Apply a SQL migration, check include/exclude, or pass --allow-empty.',
    );
  }
  let columnTypes = config.columnTypes;
  if (columnTypes && (config.include.length || config.exclude.length)) {
    // Validate keys against the complete catalog before omitting overrides for
    // filtered-out tables. Typos must still reach the generator's diagnostics.
    const catalog = await introspectSqliteProject(
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
    target: 'sqlite',
    schema,
    exactNativeIntegers: config.exactNativeIntegers,
    outDir: config.out,
    connectionString: normalizeSqlitePath(config.url),
    importExtension: config.importExtension,
    keepColumnNames: config.keepColumnNames,
    columnTypes,
    noTimestamp: args.noTimestamp,
    zod: args.zod,
  });
  return { schema, ...result };
}

/** Separate template keeps the default PostgreSQL configTemplate byte-identical. */
export function sqliteConfigTemplate(config: ResolvedConfig): string {
  return `import type { TurbineCliConfig } from 'turbine-orm/cli';

// DATABASE_URL (when set) and --url override this persistent local database.
const config: TurbineCliConfig = {
  engine: 'sqlite',
  url: ${JSON.stringify(config.url)},
  out: ${JSON.stringify(config.out)},
  migrationsDir: ${JSON.stringify(config.migrationsDir)},
};

// Schema changes: turbine migrate create <name>, edit UP/DOWN SQL,
// turbine migrate up, then turbine generate. Code-first alternative:
// turbine push --schema-file <file> --dry-run, then the same command without --dry-run.
export default config;
`;
}

const STARTER_SQL = `-- UP
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT
);

-- DOWN
DROP TABLE users;
`;

/** Create files exclusively; even --force init never replaces a user's files. */
function createFile(path: string, contents: string, created: string[]): void {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, contents, { encoding: 'utf8', flag: 'wx' });
    created.push(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
}

export interface SqliteInitResult {
  databasePath: string;
  created: string[];
  existingDatabase: boolean;
  generated?: { outDir: string; files: string[] };
}

/** Additive scaffolding for a persistent SQL-first project. Never applies SQL. */
export async function initSqliteProject(
  config: ResolvedConfig,
  args: SqliteProjectArgs = {},
): Promise<SqliteInitResult> {
  checkConfig(config, args);
  const databasePath = normalizeSqlitePath(config.url || './turbine/dev.sqlite');
  let existingDatabase = existsSync(databasePath);
  // Resolve the driver before making any project files on unsupported Node versions.
  const Database = databaseConstructor();
  mkdirSync(dirname(databasePath), { recursive: true });
  const created: string[] = [];
  if (!existingDatabase) {
    try {
      // Reserve a new path exclusively so a concurrent creator is never opened
      // for writing merely because the earlier existence check saw no file.
      writeFileSync(databasePath, '', { flag: 'wx' });
      created.push(databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      existingDatabase = true;
    }
  }
  const db = new Database(databasePath, { readOnly: existingDatabase });
  let tableCount: number;
  try {
    // Set a persistent database header for a new database without creating a user table.
    if (!existingDatabase) db.exec('PRAGMA user_version = 0');
    tableCount = Number(
      db
        .prepare(
          "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> '_turbine_migrations'",
        )
        .get()!.n,
    );
  } finally {
    db.close();
  }
  // Keep local project paths portable when resolution supplied an absolute path.
  const localPath = relative(process.cwd(), databasePath);
  const projectPath =
    localPath && !localPath.startsWith('..') && !isAbsolute(localPath) ? `./${localPath}` : databasePath;
  const effective = { ...config, url: projectPath };
  if (!findConfigFile()) createFile('turbine.config.ts', sqliteConfigTemplate(effective), created);
  mkdirSync(config.migrationsDir, { recursive: true });
  if (
    tableCount === 0 &&
    !args.skipSchema &&
    !readdirSync(config.migrationsDir).some((file) => file.endsWith('.sql'))
  ) {
    const timestamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
    createFile(join(config.migrationsDir, `${timestamp}_create_users.sql`), STARTER_SQL, created);
  }

  let generated: SqliteInitResult['generated'];
  const generatedNames = ['index.ts', 'types.ts', 'metadata.ts', 'zod.ts'];
  const outputOccupied = generatedNames.some((name) => existsSync(resolve(config.out, name)));
  if (tableCount > 0 && !args.skipGenerate && !outputOccupied) {
    generated = await generateSqliteProject({ ...effective, url: databasePath }, args);
  }
  return { databasePath, created, existingDatabase, ...(generated ? { generated } : {}) };
}

export async function cmdSqliteInit(args: SqliteProjectArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const result = await initSqliteProject(config, args);
  label('SQLite database', result.databasePath);
  for (const path of result.created) success(`Created ${shown(path)}`);
  if (result.created.length === 0) info('Existing project files preserved.');
  if (result.generated) success(`Generated ${result.generated.files.join(', ')} in ${shown(result.generated.outDir)}`);
  newline();
  info(
    'Schema changes use SQL migrations, or code-first turbine push --schema-file <file> (preview with --dry-run). Automatic seeding is not supported.',
  );
  info(
    'Run turbine migrate up, then turbine generate. To add changes: turbine migrate create <name>, edit UP/DOWN SQL.',
  );
  info('Existing config, migration and generated files are preserved by init, including with --force.');
}

export async function cmdSqliteGenerate(args: SqliteProjectArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const result = await generateSqliteProject(config, args);
  label('SQLite database', normalizeSqlitePath(config.url));
  success(`Found ${Object.keys(result.schema.tables).length} tables`);
  success(`Generated ${result.files.join(', ')} in ${shown(result.outDir)}`);
}

export async function cmdSqliteStatus(args: SqliteProjectArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const schema = await introspectSqliteProject(config, args);
  label('SQLite database', normalizeSqlitePath(config.url));
  label('Tables', String(Object.keys(schema.tables).length));
  for (const table of Object.values(schema.tables)) {
    label(shown(table.name), `${table.columns.length} columns, ${Object.keys(table.relations).length} relations`);
  }
  info('For migration history, run turbine migrate status.');
}

/** SQL Server database-first project lifecycle. Migration execution has its own command adapter. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ValidationError } from '../errors.js';
import { generate } from '../generate.js';
import { applyRelationRenames, assertSafeCatalogSchema, printableCatalogName as shown } from '../introspect.js';
import { introspectMssql } from '../mssql.js';
import type { SchemaMetadata } from '../schema.js';
import {
  findConfigFile,
  looksLikeSchemaFilePath,
  type ResolvedConfig,
  resolveCliEngine,
  validateCliEngineUrl,
} from './config.js';
import { banner, info, label, success } from './ui.js';

export interface MssqlProjectArgs {
  allowEmpty?: boolean;
  includeViews?: boolean;
  zod?: boolean;
  noTimestamp?: boolean;
  skipGenerate?: boolean;
  withSchema?: boolean;
}

function checkConfig(config: ResolvedConfig, args: MssqlProjectArgs): void {
  if (resolveCliEngine(config.engine) !== 'mssql') {
    throw new ValidationError('SQL Server project commands require engine "mssql".');
  }
  validateCliEngineUrl('mssql', config.url);
  if (config.adapter !== undefined) throw new ValidationError('PostgreSQL adapters cannot be used with MSSQL.');
  for (const key of ['include', 'exclude'] as const) {
    if (!Array.isArray(config[key]) || !config[key].every((value) => typeof value === 'string' && value.length > 0)) {
      throw new ValidationError(`MSSQL config ${key} must be an array of nonempty table names.`);
    }
  }
  if (!config.schema || config.schema.includes('\0') || looksLikeSchemaFilePath(config.schema)) {
    throw new ValidationError('MSSQL schema must be a SQL Server namespace (default dbo), not a schema file.');
  }
  if (args.withSchema || config.schemaFileConfigured) {
    throw new ValidationError('MSSQL CLI projects are database-first; schemaFile and --with-schema are not supported.');
  }
  if (args.includeViews) {
    throw new ValidationError('MSSQL CLI introspection does not support includeViews.');
  }
}

/** Refuse unsupported commands before PostgreSQL handlers or drivers can run. */
export function assertMssqlProjectCommand(command: string): void {
  if (
    ['init', 'generate', 'gen', 'g', 'pull', 'status', 'info', 'seed', 's', 'migrate', 'migration', 'm'].includes(
      command,
    )
  )
    return;
  throw new ValidationError(
    `Command "${command}" is not supported for MSSQL. SQL Server CLI supports init, pull/generate, status, callback seed and SQL-first migrate; code-first push/diff and PostgreSQL tools are not implemented.`,
  );
}

/** Existing native catalog reader owns the short-lived connection and cleanup. */
export async function introspectMssqlProject(
  config: ResolvedConfig,
  args: MssqlProjectArgs = {},
): Promise<SchemaMetadata> {
  checkConfig(config, args);
  if (!config.url)
    throw new ValidationError('MSSQL requires a database URL. Set DATABASE_URL or pass --url mssql://host/database.');
  const metadata = await introspectMssql({
    connectionString: config.url,
    schema: config.schema,
    include: config.include,
    exclude: config.exclude,
    legacyToManyUniques: config.legacyToManyUniques,
  });
  const schema = config.relationNames ? applyRelationRenames(metadata, config.relationNames) : metadata;
  assertSafeCatalogSchema(schema);
  return schema;
}

export async function generateMssqlProject(config: ResolvedConfig, args: MssqlProjectArgs = {}) {
  const schema = await introspectMssqlProject(config, args);
  if (Object.keys(schema.tables).length === 0 && !args.allowEmpty) {
    throw new ValidationError(
      'MSSQL introspection matched 0 tables; check schema/include/exclude or pass --allow-empty.',
    );
  }
  let columnTypes = config.columnTypes;
  if (columnTypes && (config.include.length || config.exclude.length)) {
    // A valid override for an omitted table is irrelevant; a typo must still fail.
    const catalog = await introspectMssqlProject(
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
  return {
    schema,
    ...generate({
      target: 'mssql',
      schema,
      exactNativeIntegers: config.exactNativeIntegers,
      outDir: config.out,
      connectionString: config.url,
      importExtension: config.importExtension,
      keepColumnNames: config.keepColumnNames,
      columnTypes,
      noTimestamp: args.noTimestamp,
      zod: args.zod,
    }),
  };
}

/** Credentials stay in the environment; all project settings survive initialization. */
export function mssqlConfigTemplate(config: ResolvedConfig): string {
  const settings = {
    engine: 'mssql',
    schema: config.schema,
    out: config.out,
    include: config.include,
    exclude: config.exclude,
    importExtension: config.importExtension,
    keepColumnNames: config.keepColumnNames,
    legacyToManyUniques: config.legacyToManyUniques,
    relationNames: config.relationNames,
    columnTypes: config.columnTypes,
  };
  return `import type { TurbineCliConfig } from 'turbine-orm/cli';

// Install the optional driver: npm i mssql. Set DATABASE_URL in your environment.
const config: TurbineCliConfig = {
  ...${JSON.stringify(settings, null, 2)},
  url: process.env.DATABASE_URL,
};

export default config;
`;
}

/** Add config exclusively and optionally generate from an existing database. Never writes SQL. */
export async function initMssqlProject(config: ResolvedConfig, args: MssqlProjectArgs = {}) {
  checkConfig(config, args);
  const created: string[] = [];
  if (!findConfigFile()) {
    const path = resolve('turbine.config.ts');
    mkdirSync(dirname(path), { recursive: true });
    try {
      writeFileSync(path, mssqlConfigTemplate(config), { encoding: 'utf8', flag: 'wx' });
      created.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const occupied = ['index.ts', 'metadata.ts', 'types.ts', 'zod.ts'].some((file) =>
    existsSync(resolve(config.out, file)),
  );
  const generated =
    config.url && !args.skipGenerate && !occupied ? await generateMssqlProject(config, args) : undefined;
  return { created, generated };
}

export async function cmdMssqlInit(args: MssqlProjectArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const result = await initMssqlProject(config, args);
  for (const path of result.created) success(`Created ${shown(path)}`);
  if (result.generated) success(`Generated ${result.generated.files.join(', ')} in ${shown(result.generated.outDir)}`);
  info('Install mssql and set DATABASE_URL; run turbine pull to generate from an existing SQL Server database.');
  info(
    'Init preserves existing config and generated files. SQL-first migrate is separate; code-first push/diff is not supported.',
  );
}

export async function cmdMssqlGenerate(args: MssqlProjectArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const result = await generateMssqlProject(config, args);
  label('SQL Server schema', shown(config.schema));
  success(`Found ${Object.keys(result.schema.tables).length} tables`);
  success(`Generated ${result.files.join(', ')} in ${shown(result.outDir)}`);
}

export async function cmdMssqlStatus(args: MssqlProjectArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const schema = await introspectMssqlProject(config, args);
  label('SQL Server schema', shown(config.schema));
  label('Tables', String(Object.keys(schema.tables).length));
  for (const table of Object.values(schema.tables)) label(shown(table.name), `${table.columns.length} columns`);
}

export function showMssqlHelp(): void {
  console.log('SQL Server: turbine init|pull|generate|status --engine mssql --schema dbo --url mssql://host/database');
  console.log('Install optional mssql driver. Generated turbine(target, options) is asynchronous.');
  console.log(
    'SQL-first migrations: turbine migrate create|up|deploy|down|status --engine mssql. Callback seeds: turbine seed --engine mssql. No push/diff or code-first schema.',
  );
  console.log('Native URL connections use encrypt: false, trustServerCertificate: true; query parameters are refused.');
}

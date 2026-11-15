/** Code-first generation; no native catalog or migration runner is implied. */
import { ValidationError } from '../errors.js';
import { type GenerateFileOptions, generateIndex, generateMetadata, generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';

/** Generate the established SQLite types/metadata with an async local libSQL factory. */
export function generateLibsqlFiles(
  schema: SchemaMetadata,
  options: Omit<GenerateFileOptions, 'target' | 'exactNativeIntegers'> = {},
): Record<'index.ts' | 'types.ts' | 'metadata.ts', string> {
  // Runtime metadata keeps its real storage/schema types. Only declarations
  // change to the values the libSQL adapter actually returns.
  const typesSchema: SchemaMetadata = {
    ...schema,
    tables: Object.fromEntries(
      Object.entries(schema.tables).map(([name, table]) => [
        name,
        {
          ...table,
          columns: table.columns.map((column) => {
            if (column.declaredTsType !== undefined) return column;
            const type = column.dialectType ?? column.pgType;
            const mapped = /^(?:bytea|blob)$/i.test(type)
              ? 'Uint8Array'
              : /^(?:numeric|decimal|money)/i.test(type)
                ? 'number | string'
                : undefined;
            return mapped === undefined ? column : { ...column, tsType: column.nullable ? `${mapped} | null` : mapped };
          }),
        },
      ]),
    ),
  };
  const sqliteOptions: GenerateFileOptions = { ...options, target: 'sqlite', exactNativeIntegers: true };
  const source = generateIndex(schema, sqliteOptions);
  const start = source.indexOf('/** Bind this schema synchronously;');
  const finish = source.indexOf("export * from './types", start);
  if (start < 0 || finish <= start || !source.includes("from 'turbine-orm/sqlite'")) {
    throw new ValidationError('The SQLite generation contract changed; libSQL generation requires an explicit update.');
  }
  const factory = `/** Bind this schema asynchronously to local libSQL. */
export async function turbine(
  target: Parameters<typeof turbineLibsql>[0],
  options?: TypedTurbineLibsqlOptions,
): Promise<TurbineClient> {
  return await turbineLibsql(target, SCHEMA, options as TurbineLibsqlOptions | undefined) as TurbineClient;
}

`;
  const index = `${source.slice(0, start)}${factory}${source.slice(finish)}`
    .replaceAll("'turbine-orm/sqlite'", "'turbine-orm/libsql'")
    .replaceAll('turbineSqlite', 'turbineLibsql')
    .replaceAll('TurbineSqliteOptions', 'TurbineLibsqlOptions');
  return {
    'index.ts': index,
    'types.ts': generateTypes(typesSchema, sqliteOptions),
    'metadata.ts': generateMetadata(schema, sqliteOptions),
  };
}

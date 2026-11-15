/** Optional, code-first D1 generation. This module runs at generation time in Node. */
import { ValidationError } from '../errors.js';
import { type GenerateFileOptions, generateIndex, generateMetadata, generateTypes } from '../generate.js';
import type { SchemaMetadata } from '../schema.js';

export type GenerateD1Options = Omit<GenerateFileOptions, 'target' | 'exactNativeIntegers'> & {
  /** Keep database column names instead of camelCase fields. */
  keepColumnNames?: boolean;
};

const nativeImports = `import { turbineSqlite } from 'turbine-orm/sqlite';
import type { TurbineSqliteOptions } from 'turbine-orm/sqlite';
import type { TurbineClient as BaseTurbineClient, TransactionClient as BaseTransactionClient, QueryInterface, TransactionOptions, DeferredQuery, PipelineResults, WhereClause } from 'turbine-orm';`;

function changedContract(): never {
  throw new ValidationError('The SQLite generation contract changed; D1 generation requires an explicit update.');
}

/** Retain established declarations verbatim, admitting only the complete known factory contract. */
function d1Index(source: string): string {
  const imports = source.indexOf(nativeImports);
  const optionsStart = source.indexOf('export type TypedTurbineSqliteOptions = {');
  const accessorsStart = source.indexOf('export interface TypedTransactionClient extends BaseTransactionClient {\n');
  const accessorsEnd = source.indexOf('  $transaction<R>(fn: (tx: TypedTransactionClient) => Promise<R>): Promise<R>;');
  const exportsStart = source.indexOf("export * from './types", accessorsEnd);
  if (
    imports < 0 ||
    optionsStart <= imports ||
    accessorsStart <= optionsStart ||
    accessorsEnd < accessorsStart ||
    exportsStart <= accessorsEnd
  )
    changedContract();
  const accessors = source
    .slice(
      accessorsStart + 'export interface TypedTransactionClient extends BaseTransactionClient {\n'.length,
      accessorsEnd,
    )
    .replace(/\n$/, '');
  const expected = `export type TypedTurbineSqliteOptions = {
  [K in Exclude<keyof TurbineSqliteOptions, 'globalFilters'>]?: TurbineSqliteOptions[K] | undefined;
} & { globalFilters?: TurbineGlobalFilters | undefined };

export interface TypedTransactionClient extends BaseTransactionClient {
${accessors}
  $transaction<R>(fn: (tx: TypedTransactionClient) => Promise<R>): Promise<R>;
}

export interface TurbineClient extends BaseTurbineClient {
${accessors}
  $transaction<R>(
    fn: (tx: TypedTransactionClient) => Promise<R>,
    options?: TransactionOptions,
  ): Promise<R>;
  $transaction<T extends readonly DeferredQuery<unknown>[]>(
    queries: readonly [...T],
    options?: TransactionOptions,
  ): Promise<PipelineResults<T>>;
  $withSession<R>(
    context: { [key in string]: string | number | boolean },
    fn: (tx: TypedTransactionClient) => Promise<R>,
  ): Promise<R>;
}

/** Bind this schema synchronously; disconnect closes only Turbine-owned handles. */
export function turbine(
  target: string | import('node:sqlite').DatabaseSync,
  options?: TypedTurbineSqliteOptions,
): TurbineClient {
  return turbineSqlite(target, SCHEMA, options as TurbineSqliteOptions | undefined) as TurbineClient;
}

`;
  if (source.slice(optionsStart, exportsStart) !== expected || source.indexOf(nativeImports, imports + 1) !== -1)
    changedContract();
  const d1Imports = `import { turbineD1 } from 'turbine-orm/d1';
import type { D1ClientBase, D1DatabaseBinding, TurbineD1Options } from 'turbine-orm/d1';
import type { QueryInterface as BaseQueryInterface, DefaultInputTypes, TableInputTypes, CreateManyArgs, CreateManyResult, FieldResult, DeferredQuery, WhereClause } from 'turbine-orm';`;
  const declarations = `export type TypedTurbineD1Options = {
  [K in Exclude<keyof TurbineD1Options, 'globalFilters'>]?: TurbineD1Options[K] | undefined;
} & { globalFilters?: TurbineGlobalFilters | undefined };

/** D1 has no native cursor. Bulk conflict reconciliation requires an unsupported session. */
export type QueryInterface<T extends object, R extends object = {}, M extends TableInputTypes = DefaultInputTypes<T, R>> =
  Omit<BaseQueryInterface<T, R, M>, 'findManyStream' | 'findManyStreamBatches' | 'createMany' | 'buildCreateMany'> & {
    createMany<S extends { [key in string]: boolean } | undefined = undefined, O extends { [key in string]: boolean } | undefined = undefined, C extends boolean | undefined = undefined>(
      args: Omit<CreateManyArgs<T, M['createMany'], S, O, C>, 'onConflict'> & { onConflict?: never },
    ): Promise<CreateManyResult<FieldResult<T, S, O>, C>>;
    buildCreateMany<S extends { [key in string]: boolean } | undefined = undefined, O extends { [key in string]: boolean } | undefined = undefined, C extends boolean | undefined = undefined>(
      args: Omit<CreateManyArgs<T, M['createMany'], S, O, C>, 'onConflict'> & { onConflict?: never },
    ): DeferredQuery<CreateManyResult<FieldResult<T, S, O>, C>>;
  };

/** Only the supplied-binding facade and schema-specific accessors are promised. */
export interface TurbineClient extends Omit<D1ClientBase,
  '$transaction' | 'transaction' | 'pipeline' | '$withSession' | '$connection' | '$listen' | '$notify' | 'table'> {
${accessors}
  table<T extends object = { [key in string]: unknown }>(name: string): QueryInterface<T>;
}

/** Synchronous binding; no URL, native handle, network acquisition or caller-binding close. */
export function turbine(binding: D1DatabaseBinding, options?: TypedTurbineD1Options): TurbineClient {
  return turbineD1(binding, SCHEMA, options as TurbineD1Options | undefined) as unknown as TurbineClient;
}

`;
  return (
    source.slice(0, imports) +
    d1Imports +
    source.slice(imports + nativeImports.length, optionsStart) +
    declarations +
    source.slice(exportsStart)
  );
}

/** Emit the established types/metadata and an actual synchronous turbineD1 factory. */
export function generateD1Files(
  schema: SchemaMetadata,
  options: GenerateD1Options = {},
): Record<'index.ts' | 'types.ts' | 'metadata.ts', string> {
  if ('target' in options || 'exactNativeIntegers' in options) {
    throw new ValidationError('D1 generation fixes its target and number-valued integer policy.');
  }
  const runtimeSchema = options.keepColumnNames
    ? {
        ...schema,
        tables: Object.fromEntries(
          Object.entries(schema.tables).map(([name, table]) => [
            name,
            {
              ...table,
              columns: table.columns.map((column) => ({ ...column, field: column.name })),
              // Assignment to a plain object's __proto__ key is not an own entry.
              columnMap: Object.fromEntries(table.columns.map((column) => [column.name, column.name])),
              reverseColumnMap: Object.fromEntries(table.columns.map((column) => [column.name, column.name])),
            },
          ]),
        ),
      }
    : schema;
  // D1 reads numeric INTEGER values, never libSQL's string-valued large integers.
  // Metadata remains untouched: the adapter's real decoders determine returned values.
  // Declarations use SQLite's native type spelling. This also keeps the shared
  // emitter's PostgreSQL int8 write widening out of D1. No column-name keyed
  // synthetic overrides are needed, so quoted names containing dots still work.
  const typesSchema: SchemaMetadata = {
    ...runtimeSchema,
    tables: Object.fromEntries(
      Object.entries(runtimeSchema.tables).map(([name, table]) => [
        name,
        {
          ...table,
          columns: table.columns.map((column) => {
            const type = column.dialectType ?? column.pgType;
            if (column.isArray || Object.hasOwn(runtimeSchema.enums, type)) return column;
            const mapped = /BLOB|BYTEA/i.test(type)
              ? 'Uint8Array'
              : /INT|SERIAL/i.test(type)
                ? 'number'
                : /^(?:numeric|decimal|money)/i.test(type)
                  ? 'number | string'
                  : undefined;
            if (mapped === undefined && column.declaredTsType === undefined) return column;
            return {
              ...column,
              dialectType: type.toUpperCase(),
              ...(mapped !== undefined && column.declaredTsType === undefined
                ? { tsType: column.nullable ? `${mapped} | null` : mapped }
                : {}),
            };
          }),
        },
      ]),
    ),
  };
  const sqliteOptions: GenerateFileOptions = { ...options, target: 'sqlite', exactNativeIntegers: false };
  return {
    'index.ts': d1Index(generateIndex(runtimeSchema, sqliteOptions)),
    'types.ts': generateTypes(typesSchema, sqliteOptions),
    'metadata.ts': generateMetadata(runtimeSchema, sqliteOptions),
  };
}

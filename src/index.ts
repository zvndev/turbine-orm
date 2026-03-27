/**
 * turbine-orm
 *
 * Turbine TypeScript SDK — type-safe Postgres queries with nested relations
 * and pipeline batching. Feels like Prisma, runs at raw-SQL speed.
 *
 * @example
 * ```ts
 * // 1. Generate types from your database:
 * //    npx turbine generate
 *
 * // 2. Import the generated client:
 * import { turbine } from './generated/turbine';
 *
 * const db = turbine({ connectionString: process.env.DATABASE_URL });
 *
 * // Type-safe queries with auto-complete
 * const user = await db.users.findUnique({ where: { id: 1 } });
 *
 * // Nested relations in a single query (json_agg, no N+1)
 * const userWithPosts = await db.users.findUnique({
 *   where: { id: 1 },
 *   with: { posts: { with: { comments: true } } },
 * });
 *
 * // Pipeline: multiple queries in one round-trip
 * const [user, count] = await db.pipeline(
 *   db.users.buildFindUnique({ where: { id: 1 } }),
 *   db.posts.buildCount({ where: { orgId: 1 } }),
 * );
 *
 * await db.disconnect();
 * ```
 */

// Client
export {
  TurbineClient,
  TransactionClient,
  type TurbineConfig,
  type TransactionOptions,
  type Middleware,
  type MiddlewareParams,
  type MiddlewareNext,
} from './client.js';

// Query builder
export {
  QueryInterface,
  type DeferredQuery,
  type FindUniqueArgs,
  type FindManyArgs,
  type CreateArgs,
  type CreateManyArgs,
  type UpdateArgs,
  type UpdateManyArgs,
  type DeleteArgs,
  type DeleteManyArgs,
  type UpsertArgs,
  type CountArgs,
  type GroupByArgs,
  type AggregateArgs,
  type AggregateResult,
  type RelationFilter,
  type JsonFilter,
  type ArrayFilter,
  type WithClause,
  type WithOptions,
  type OrderDirection,
} from './query.js';

// Pipeline
export { executePipeline, type PipelineResults } from './pipeline.js';

// Schema metadata types
export type {
  SchemaMetadata,
  TableMetadata,
  ColumnMetadata,
  RelationDef,
  IndexMetadata,
} from './schema.js';

// Schema utilities
export {
  snakeToCamel,
  camelToSnake,
  snakeToPascal,
  singularize,
  pgTypeToTs,
  isDateType,
  pgArrayType,
} from './schema.js';

// Introspection
export { introspect, type IntrospectOptions } from './introspect.js';

// Code generation
export { generate, type GenerateOptions } from './generate.js';

// Schema builder — define schemas in TypeScript
export {
  defineSchema,
  // Legacy compat (deprecated — use object format with defineSchema)
  table,
  column,
  ColumnBuilder,
  type ColumnDef,
  type ColumnTypeName,
  type ColumnConfig,
  type ColumnType,
  type TableDef,
  type SchemaDef,
} from './schema-builder.js';

// Schema SQL — generate DDL, diff, and push
export {
  schemaToSQL,
  schemaToSQLString,
  schemaDiff,
  schemaPush,
  type DiffResult,
  type AlterDef,
  type AlterColumnDef,
  type PushResult,
} from './schema-sql.js';

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
  type Middleware,
  type MiddlewareNext,
  type MiddlewareParams,
  TransactionClient,
  type TransactionOptions,
  TurbineClient,
  type TurbineConfig,
} from './client.js';
// Error types
export {
  CircularRelationError,
  ConnectionError,
  MigrationError,
  NotFoundError,
  RelationError,
  TimeoutError,
  TurbineError,
  TurbineErrorCode,
  ValidationError,
} from './errors.js';
// Code generation
export { type GenerateOptions, generate } from './generate.js';
// Introspection
export { type IntrospectOptions, introspect } from './introspect.js';
// Pipeline
export { executePipeline, type PipelineResults } from './pipeline.js';
// Query builder
export {
  type AggregateArgs,
  type AggregateResult,
  type ArrayFilter,
  type CountArgs,
  type CreateArgs,
  type CreateManyArgs,
  type DeferredQuery,
  type DeleteArgs,
  type DeleteManyArgs,
  type FindManyArgs,
  type FindUniqueArgs,
  type GroupByArgs,
  type JsonFilter,
  type OrderDirection,
  QueryInterface,
  type RelationFilter,
  type UpdateArgs,
  type UpdateManyArgs,
  type UpsertArgs,
  type WithClause,
  type WithOptions,
} from './query.js';
// Schema metadata types
export type {
  ColumnMetadata,
  IndexMetadata,
  RelationDef,
  SchemaMetadata,
  TableMetadata,
} from './schema.js';
// Schema utilities
export {
  camelToSnake,
  isDateType,
  pgArrayType,
  pgTypeToTs,
  singularize,
  snakeToCamel,
  snakeToPascal,
} from './schema.js';

// Schema builder — define schemas in TypeScript
export {
  ColumnBuilder,
  type ColumnConfig,
  type ColumnDef,
  type ColumnType,
  type ColumnTypeName,
  column,
  defineSchema,
  type SchemaDef,
  type TableDef,
  // Legacy compat (deprecated — use object format with defineSchema)
  table,
} from './schema-builder.js';

// Schema SQL — generate DDL, diff, and push
export {
  type AlterColumnDef,
  type AlterDef,
  type DiffResult,
  type PushResult,
  schemaDiff,
  schemaPush,
  schemaToSQL,
  schemaToSQLString,
} from './schema-sql.js';

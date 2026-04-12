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
  type PgCompatPool,
  type PgCompatPoolClient,
  type PgCompatQueryResult,
  TransactionClient,
  type TransactionOptions,
  TurbineClient,
  type TurbineConfig,
} from './client.js';
// Error types
export {
  CheckConstraintError,
  CircularRelationError,
  ConnectionError,
  DeadlockError,
  type ErrorMessageMode,
  ForeignKeyError,
  getErrorMessageMode,
  MigrationError,
  NotFoundError,
  NotNullViolationError,
  PipelineError,
  type PipelineResultSlot,
  RelationError,
  SerializationFailureError,
  setErrorMessageMode,
  TimeoutError,
  TurbineError,
  TurbineErrorCode,
  UniqueConstraintError,
  ValidationError,
  wrapPgError,
} from './errors.js';
// Code generation
export { type GenerateOptions, generate } from './generate.js';
// Introspection
export { type IntrospectOptions, introspect } from './introspect.js';
// Pipeline
export { executePipeline, type PipelineOptions, type PipelineResults, pipelineSupported } from './pipeline.js';
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
  type FindManyStreamArgs,
  type FindUniqueArgs,
  type GroupByArgs,
  type JsonFilter,
  type OrderDirection,
  QueryInterface,
  type RelationDescriptor,
  type RelationFilter,
  type TypedWithClause,
  type UpdateArgs,
  type UpdateInput,
  type UpdateManyArgs,
  type UpdateOperatorInput,
  type UpsertArgs,
  type WithClause,
  type WithOptions,
  type WithResult,
} from './query/index.js';
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
// Serverless / edge factory
export { type TurbineHttpOptions, turbineHttp } from './serverless.js';

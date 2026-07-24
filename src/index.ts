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

// Database adapters
export type { DatabaseAdapter, IntrospectionOverrides } from './adapters/index.js';
export { alloydb, cockroachdb, postgresql, timescale, yugabytedb } from './adapters/index.js';
// Client
export {
  type Middleware,
  type MiddlewareNext,
  type MiddlewareParams,
  type PgCompatPool,
  type PgCompatPoolClient,
  type PgCompatQueryResult,
  type RetryOptions,
  TransactionClient,
  type TransactionOptions,
  TurbineClient,
  type TurbineConfig,
  type TurbineDriver,
  withRetry,
} from './client.js';
// Dialect contract
export type {
  BuiltStatement,
  BulkInsertStatementInput,
  ColumnDefinitionInput,
  ColumnTypeInput,
  CreateIndexStatementInput,
  CreateTableStatementInput,
  Dialect,
  DialectIntrospector,
  DialectMigrator,
  DialectName,
  InsertStatementInput,
  IntrospectOptions as DialectIntrospectOptions,
  ResultStrategy,
  StreamableConnection,
  UpsertStatementInput,
} from './dialect.js';
export { postgresDialect } from './dialect.js';
// Error types
export {
  CheckConstraintError,
  CircularRelationError,
  ConnectionError,
  DeadlockError,
  type ErrorMessageMode,
  ExclusionConstraintError,
  ForeignKeyError,
  getErrorMessageMode,
  MigrationError,
  NotFoundError,
  NotNullViolationError,
  OptimisticLockError,
  PipelineError,
  type PipelineResultSlot,
  ReadOnlyError,
  RelationError,
  SerializationFailureError,
  setErrorMessageMode,
  TimeoutError,
  TurbineError,
  TurbineErrorCode,
  UniqueConstraintError,
  UnsupportedFeatureError,
  ValidationError,
  wrapPgError,
} from './errors.js';
// Code generation
export { type GenerateOptions, generate } from './generate.js';
// Introspection
export { type IntrospectOptions, introspect } from './introspect.js';
// Nested writes
export {
  executeNestedCreate,
  executeNestedUpdate,
  hasRelationFields,
  type NestedWriteContext,
} from './nested-write.js';
// Observability
export {
  HttpJsonSink,
  type HttpJsonSinkOptions,
  type MetricsFlushBatch,
  type MetricsFlushRow,
  type ObserveConfig,
  type ObserveHandle,
  type ObserveSink,
  PgMetricsSink,
  type PgMetricsSinkOptions,
} from './observe.js';
// Pipeline
export { executePipeline, type PipelineOptions, type PipelineResults, pipelineSupported } from './pipeline.js';
// Query builder
export {
  type AggregateArgs,
  type AggregateResult,
  type ArrayFilter,
  type ColumnRef,
  type ConnectOrCreateOp,
  type CountArgs,
  type CreateArgs,
  type CreateDataInput,
  type CreateManyArgs,
  type DeferredQuery,
  type DeleteArgs,
  type DeleteManyArgs,
  type FieldResult,
  type FindManyArgs,
  type FindManyStreamArgs,
  type FindUniqueArgs,
  type GlobalFilters,
  type GroupByAggregateSpec,
  type GroupByArgs,
  type GroupByDistinctOn,
  type GroupByResult,
  type HavingClause,
  type JsonFilter,
  type JsonPathAggregateTarget,
  type JsonPathGroupKey,
  type JsonPathOrderBy,
  type MiddlewareFn,
  type NestedCreateOp,
  type NestedUpdateOp,
  type NestedUpdateOpItem,
  type NestedUpsertOpItem,
  type OmitResult,
  type OrderByClause,
  type OrderByObject,
  type OrderDirection,
  type QueryEvent,
  type QueryEventListener,
  QueryInterface,
  type QueryResult,
  type RelationDescriptor,
  type RelationFilter,
  type RelationLoadStrategy,
  type RelationPickBy,
  type RelationPickOrderBy,
  type SelectResult,
  type SkipGlobalFilters,
  type TextSearchFilter,
  type TypedWithClause,
  type UpdateArgs,
  type UpdateDataInput,
  type UpdateInput,
  type UpdateManyArgs,
  type UpdateOperatorInput,
  type UpsertArgs,
  type VectorDistanceFilter,
  type VectorFilter,
  type VectorMetric,
  type VectorOrderBy,
  type VectorOrderByDistance,
  type WhereClause,
  type WhereOperator,
  type WhereValue,
  type WithClause,
  type WithOptions,
  type WithOrderByObject,
  type WithResult,
} from './query/index.js';
// Realtime — LISTEN/NOTIFY pub/sub
export { type ActiveSubscription, type NotificationHandler, type Subscription, validateChannel } from './realtime.js';
// Schema metadata types
export type {
  CheckMetadata,
  ColumnMetadata,
  IndexMetadata,
  PrismaCompatMap,
  PrismaModelMap,
  PrismaRelationMap,
  ReferentialAction,
  RelationDef,
  SchemaMetadata,
  TableMetadata,
} from './schema.js';
// Schema utilities
export {
  camelToSnake,
  isDateType,
  normalizeKeyColumns,
  pgArrayType,
  pgTypeToTs,
  singularize,
  snakeToCamel,
  snakeToPascal,
  withDbFieldNames,
} from './schema.js';
// Schema builder — define schemas in TypeScript
export {
  applyManyToManyRelations,
  type CheckDef,
  ColumnBuilder,
  type ColumnConfig,
  type ColumnDef,
  type ColumnIndexDef,
  type ColumnType,
  type ColumnTypeName,
  column,
  type DefineSchemaOptions,
  type DocFieldIndexDef,
  defineSchema,
  isDocFieldIndexDef,
  type ManyToManyDef,
  type ReferenceDef,
  type SchemaDef,
  type SchemaIndexDef,
  type TableDef,
  // Legacy compat (deprecated — use object format with defineSchema)
  table,
} from './schema-builder.js';
// Schema metadata bridge — defineSchema() → SchemaMetadata without a live DB
export { schemaDefToMetadata } from './schema-metadata.js';
// Schema SQL — generate DDL, diff, and push
export {
  type AlterColumnDef,
  type AlterDef,
  DestructivePushRefusal,
  type DiffResult,
  type PushResult,
  type SchemaSqlOptions,
  schemaDiff,
  schemaPush,
  schemaToSQL,
  schemaToSQLString,
} from './schema-sql.js';
// Seed helper
export { type DefinedSeed, defineSeed, type SeedFunction } from './seed.js';
// Serverless / edge factory
export { type TurbineHttpOptions, turbineHttp } from './serverless.js';
// Typed raw SQL — Turbine's TypedSQL escape hatch
export { buildTypedSql, TypedSqlQuery } from './typed-sql.js';

/**
 * turbine-orm — Query builder barrel
 *
 * Re-exports every public symbol from the query submodules so that
 * `import { … } from './query/index.js'` is a drop-in replacement for the
 * former monolithic `import { … } from './query.js'`.
 */

// ---------------------------------------------------------------------------
// Types (all type-only exports)
// ---------------------------------------------------------------------------

export type {
  AggregateArgs,
  AggregateResult,
  ArrayFilter,
  ConnectOrCreateOp,
  CountArgs,
  CreateArgs,
  CreateDataInput,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  FieldResult,
  FindManyArgs,
  FindManyStreamArgs,
  FindUniqueArgs,
  GroupByArgs,
  HavingClause,
  JsonFilter,
  NestedCreateOp,
  NestedUpdateOp,
  NestedUpdateOpItem,
  NestedUpsertOpItem,
  OmitResult,
  OrderByClause,
  OrderDirection,
  QueryResult,
  RelationDescriptor,
  RelationFilter,
  RelationLoadStrategy,
  SelectResult,
  TextSearchFilter,
  TypedWithClause,
  UpdateArgs,
  UpdateDataInput,
  UpdateInput,
  UpdateManyArgs,
  UpdateOperatorInput,
  UpsertArgs,
  VectorDistanceFilter,
  VectorFilter,
  VectorMetric,
  VectorOrderBy,
  VectorOrderByDistance,
  WhereClause,
  WhereOperator,
  WhereValue,
  WithClause,
  WithOptions,
  WithResult,
} from './types.js';

// ---------------------------------------------------------------------------
// Utilities (runtime values + types)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Dialect contract
export type {
  BuiltStatement,
  BulkInsertStatementInput,
  ColumnDefinitionInput,
  ColumnTypeInput,
  CreateIndexStatementInput,
  CreateTableStatementInput,
  Dialect,
  InsertStatementInput,
  UpsertStatementInput,
} from '../dialect.js';
export { postgresDialect } from '../dialect.js';
export type { SqlCacheEntry } from './utils.js';
export {
  buildCorrelation,
  escapeLike,
  escSingleQuote,
  fnv1a64Hex,
  LRUCache,
  OPERATOR_KEYS,
  quoteIdent,
  sqlToPreparedName,
} from './utils.js';

// Builder (runtime values + types)
// ---------------------------------------------------------------------------

export type {
  DeferredQuery,
  MiddlewareFn,
  QueryEvent,
  QueryEventListener,
  QueryInterfaceOptions,
  ReselectExecutor,
} from './builder.js';
export { QueryInterface } from './builder.js';

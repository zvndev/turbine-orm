/**
 * turbine-orm, Query builder barrel
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
  ColumnRef,
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
  GlobalFilters,
  GroupByAggregateSpec,
  GroupByArgs,
  GroupByDistinctOn,
  GroupByResult,
  HavingClause,
  JsonFilter,
  JsonPathAggregateTarget,
  JsonPathGroupKey,
  JsonPathOrderBy,
  NestedCreateOp,
  NestedUpdateOp,
  NestedUpdateOpItem,
  NestedUpsertOpItem,
  OmitResult,
  OrderByClause,
  OrderByObject,
  OrderDirection,
  QueryResult,
  RelationDescriptor,
  RelationFilter,
  RelationLoadStrategy,
  RelationPickBy,
  RelationPickOrderBy,
  ResolvedSkipGlobalFilters,
  SelectResult,
  SkipGlobalFilters,
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
  WithOrderByObject,
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
export type { OptionKind, OptionTable } from './option-surface.js';
export {
  AGGREGATE_OPTIONS,
  ALL_OPTION_TABLES,
  applyNativeOptions,
  COUNT_OPTIONS,
  CREATE_MANY_OPTIONS,
  CREATE_OPTIONS,
  DELETE_MANY_OPTIONS,
  DELETE_OPTIONS,
  FIND_MANY_OPTIONS,
  FIND_MANY_STREAM_OPTIONS,
  FIND_UNIQUE_OPTIONS,
  GROUP_BY_OPTIONS,
  optionKeysOfKind,
  UPDATE_MANY_OPTIONS,
  UPDATE_OPTIONS,
  UPSERT_OPTIONS,
} from './option-surface.js';
export type { PrivilegeOption, Unsafe } from './types.js';
// The privilege sentinel: a runtime value, not a type (see types.ts).
export { assertOrderDirection, resolveSkipGlobalFilters, resolveUnsafeFlag, UNSAFE } from './types.js';
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
  TemporalInfinityReading,
} from './builder.js';
export {
  AUTO_ASSUMED_ROUND_TRIP_MS,
  AUTO_COUNT_BATCH_MIN_PARENT_ROWS,
  AUTO_JOIN_PENALTY_MS_PER_ROW,
  AUTO_TO_ONE_JOIN_MAX_ROWS,
  AUTO_TO_ONE_JOIN_ROWS_MAX,
  AUTO_TO_ONE_JOIN_ROWS_MIN,
  QueryInterface,
} from './builder.js';

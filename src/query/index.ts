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
  CountArgs,
  CreateArgs,
  CreateManyArgs,
  DeleteArgs,
  DeleteManyArgs,
  FindManyArgs,
  FindManyStreamArgs,
  FindUniqueArgs,
  GroupByArgs,
  JsonFilter,
  OrderDirection,
  RelationDescriptor,
  RelationFilter,
  TypedWithClause,
  UpdateArgs,
  UpdateInput,
  UpdateManyArgs,
  UpdateOperatorInput,
  UpsertArgs,
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

export type { SqlCacheEntry } from './utils.js';
export {
  escapeLike,
  escSingleQuote,
  fnv1a64Hex,
  LRUCache,
  OPERATOR_KEYS,
  quoteIdent,
  sqlToPreparedName,
} from './utils.js';

// ---------------------------------------------------------------------------
// Builder (runtime values + types)
// ---------------------------------------------------------------------------

export type { DeferredQuery, MiddlewareFn, QueryInterfaceOptions } from './builder.js';
export { QueryInterface } from './builder.js';

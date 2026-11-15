/** Optional stateless binding for the query function returned by Neon neon(). */
export {
  NEON_HTTP_CAPABILITIES,
  type NeonHttpBatchOptions,
  type NeonHttpOptions,
  type NeonHttpQueryOptions,
  type NeonHttpSql,
  TurbineNeonHttp,
  turbineNeonHttp,
} from './neon-http/client.js';
export type { DeferredQuery } from './query/deferred.js';
export type { TableClient } from './query/table-client.js';
export type { SchemaMetadata } from './schema.js';

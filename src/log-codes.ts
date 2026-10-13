/**
 * turbine-orm, every `code` a Turbine log line can carry.
 *
 * A log line's TEXT is not a stable contract; its `code` is. This list is the
 * whole set. Library code imports it as a TYPE only (see `TurbineLogCode` in
 * logger.ts), so an emitter cannot use a code that is not here and the list
 * itself never reaches a bundle. The tests import the runtime array: one test
 * per code, and a source scan that fails on a code nothing emits.
 */
export const LOG_CODES = [
  // client.ts, construction (always on)
  'unknown-config-key',
  'plan-cache-mode-ignored',
  'prepared-statements-on-pooler',
  'connection-option-ignored',
  // client.ts, runtime errors
  'pool-error',
  'query-listener-error',
  'pool-listener-error',
  'replica-close-error',
  // client.ts, `logging: true` lifecycle lines
  'external-pool',
  'pool-created',
  'replicas-configured',
  'pipeline',
  'raw-sql',
  'transaction-committed',
  'transaction-rolled-back',
  'listen',
  'notify',
  'connection-verified',
  'disconnect-skipped',
  'pool-disconnected',
  // typed-sql.ts
  'typed-sql',
  // realtime.ts
  'listen-reconnecting',
  'listen-lost',
  // query/utils.ts, a pg type parser replaced (client construction, always on)
  'parser-overwrite',
  // query/builder.ts, query/utils.ts, query/option-surface.ts: per-query advice
  'untyped-columns',
  'unordered-page',
  'auto-strategy',
  'deep-with',
  'flatten-blocked',
  'redundant-sort-term',
  'unknown-query-option',
  // query/builder.ts, always on
  'unlimited-find-many',
  'temporal-infinity',
  'cache-mismatch',
  // query/relations.ts, per-query advice
  'relation-payload-json',
  'flatten-fallback',
  'unindexed-relation',
  // prisma-compat.ts
  'prisma-compat-unknown-option',
  'prisma-compat-native-spelling',
  'prisma-map-stale',
  'prisma-compat-junction-collision',
  // powdb.ts, powdb-introspect.ts
  'powdb-link-collision',
  'powdb-link-drift',
  'powdb-introspect-no-primary-key',
  // introspect.ts, generate.ts
  'introspect-cross-schema-fk',
  'introspect-relation-renamed',
  'introspect-relation-shadows-json',
  'generate-relation-shadows-column',
] as const;

/** A stable, machine-readable log line id. */
export type TurbineLogCode = (typeof LOG_CODES)[number];

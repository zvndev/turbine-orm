/**
 * Shared client-config seam for the non-Postgres engine factories
 * (`turbine-orm/sqlite`, `turbine-orm/mysql`, `turbine-orm/mssql`).
 *
 * Each factory builds its own driver pool and then hands a {@link TurbineConfig}
 * to `TurbineClient`. Historically each one listed the config keys it forwarded
 * by hand, which made the forwarded set an ALLOWLIST: every option added to
 * `TurbineConfig` afterwards silently became unreachable on three engines until
 * someone remembered to edit three literals (that is exactly how `errorMessages`
 * and later `logQueryParams` ended up Postgres-only).
 *
 * {@link EngineClientConfig} inverts the default. Every `TurbineConfig` field is
 * forwarded EXCEPT the ones listed below, so a new client option is engine-wide
 * the day it lands and only a deliberate `Omit` entry can take it away again.
 * Each engine's options interface extends this type and its factory spreads the
 * config through verbatim.
 */

import type { TurbineConfig } from './client.js';

/**
 * `TurbineConfig` keys an engine factory does NOT forward. Every exclusion is
 * deliberate; nothing else about `TurbineConfig` is engine-specific.
 *
 *   - `pool`, `dialect`, `preparedStatements`: owned by the factory. It binds
 *     the driver pool and its dialect, and pins prepared statements off (these
 *     drivers cache plans themselves). Letting a caller set them would unbind
 *     the engine from its own SQL.
 *   - `connectionString`, `host`, `port`, `database`, `user`, `password`, `ssl`,
 *     `poolSize`, `idleTimeoutMs`, `connectionTimeoutMs`, `max`,
 *     `idleTimeoutMillis`, `connectionTimeoutMillis`: pg connection and
 *     pool-tuning fields, ignored by `TurbineClient` whenever `pool` is set (it
 *     always is here). Each engine takes its connection target as its first
 *     argument instead, in that driver's own vocabulary.
 *   - `replicas`: entries are Postgres connection strings or pg-compatible
 *     pools, which `TurbineClient` opens as `pg.Pool`s. There is no engine
 *     equivalent to route reads to.
 *
 * Everything else is forwarded, including options that are Postgres-only by
 * CAPABILITY rather than by plumbing (`jsonEncoding: 'positional'`). Those throw
 * a typed `UnsupportedFeatureError` (E017) when used, which is a better answer
 * than an option the type system says does not exist.
 */
type EngineOwnedConfigKey =
  | 'pool'
  | 'dialect'
  | 'preparedStatements'
  | 'connectionString'
  | 'host'
  | 'port'
  | 'database'
  | 'user'
  | 'password'
  | 'ssl'
  | 'poolSize'
  | 'idleTimeoutMs'
  | 'connectionTimeoutMs'
  | 'max'
  | 'idleTimeoutMillis'
  | 'connectionTimeoutMillis'
  | 'replicas';

/**
 * The client-level options every engine factory accepts and forwards to
 * `TurbineClient` unchanged: all of {@link TurbineConfig} minus the connection
 * and dialect plumbing the factory owns (see {@link EngineOwnedConfigKey}).
 */
export type EngineClientConfig = Omit<TurbineConfig, EngineOwnedConfigKey>;

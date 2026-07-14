/**
 * turbine-orm CLI — Configuration file support
 *
 * Loads turbine.config.ts (or .js/.mjs) via dynamic import.
 * Falls back to CLI args and environment variables.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface TurbineCliConfig {
  /** Postgres connection string */
  url?: string;
  /** Output directory for generated files (default: ./generated/turbine) */
  out?: string;
  /** Postgres schema to introspect (default: public) */
  schema?: string;
  /** Tables to include (empty = all) */
  include?: string[];
  /** Tables to exclude */
  exclude?: string[];
  /** Directory for migration files (default: ./turbine/migrations) */
  migrationsDir?: string;
  /** Path to seed file. Defaults are resolved from seed.ts, seed.js, then seed.sql. */
  seed?: string;
  /** Path to seed file. Deprecated alias for `seed`. */
  seedFile?: string;
  /** Schema builder file path (for push command) */
  schemaFile?: string;
  /**
   * Database adapter for PostgreSQL-compatible databases that need
   * dialect-specific behavior (e.g. CockroachDB, YugabyteDB).
   *
   * @example
   * ```ts
   * import { cockroachdb } from 'turbine-orm/adapters';
   * export default { url: process.env.DATABASE_URL, adapter: cockroachdb };
   * ```
   */
  adapter?: import('../adapters/index.js').DatabaseAdapter;
}

/**
 * Alias for {@link TurbineCliConfig}. Some docs and examples import the config
 * type as `TurbineConfig`; both names refer to the same shape.
 */
export type TurbineConfig = TurbineCliConfig;

/**
 * Heuristic: does a configured `schema` value actually look like a schema FILE
 * path rather than a Postgres schema name? `schema` is the Postgres namespace
 * to introspect (default `public`); the schema-builder file goes in `schemaFile`.
 * A value containing a path separator or a JS/TS extension is almost certainly a
 * mis-set `schemaFile` — introspecting `WHERE table_schema = './turbine/schema.ts'`
 * silently matches zero tables. Used by `turbine generate` to fail loudly.
 */
export function looksLikeSchemaFilePath(schema: string): boolean {
  if (!schema) return false;
  return schema.includes('/') || schema.includes('\\') || /\.(ts|mts|cts|js|mjs|cjs|json)$/i.test(schema);
}

// ---------------------------------------------------------------------------
// Config file names, in priority order
// ---------------------------------------------------------------------------

const CONFIG_FILES = ['turbine.config.ts', 'turbine.config.mts', 'turbine.config.js', 'turbine.config.mjs'] as const;
const DEFAULT_SEED_CANDIDATES = ['seed.ts', 'seed.js', 'seed.sql'] as const;

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

/** A config-file load attempt that failed, kept so the CLI can surface it. */
export interface ConfigLoadError {
  /** The config file whose import threw (e.g. `turbine.config.ts`). */
  filename: string;
  /** The underlying error thrown by the dynamic import. */
  error: unknown;
}

/** Result of {@link loadConfigResult}: the resolved config plus any load failure. */
export interface ConfigLoadResult {
  config: TurbineCliConfig;
  /**
   * Set when a config file existed but failed to import. The config is still
   * returned as `{}` so resolution falls through to env vars and CLI flags, but
   * the CLI should surface this rather than let it masquerade as a missing URL.
   */
  loadError?: ConfigLoadError;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `value` is a pure ESM/CJS-interop wrapper: an object whose only
 * meaningful export is `default` (the `__esModule` marker is ignored). No
 * Turbine config field is named `default`, so a real config never matches.
 */
function isPureDefaultWrapper(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).filter((k) => k !== '__esModule');
  return keys.length === 1 && keys[0] === 'default';
}

/**
 * Unwrap the module object returned by `import(configFile)` down to the actual
 * config value.
 *
 * With `"type": "commonjs"` in the consumer's package.json (the `npm init -y`
 * default) plus the tsx loader, importing `turbine.config.ts` yields a
 * CJS-interop DOUBLE-wrapped default: `mod.default` is itself `{ default: config }`.
 * A naive `mod.default ?? mod` then reads every field as `undefined`, so every
 * command fails with a misleading "No database URL provided".
 *
 * This prefers `default` when present (the historical behavior) and then keeps
 * descending through any additional pure `{ default: … }` wrappers, so both the
 * correct single-default shape and the double-wrapped shape resolve to the same
 * config. A genuine config object (which has real fields, never a lone
 * `default`) is returned untouched.
 */
export function unwrapModuleDefault(mod: unknown): unknown {
  // Step 1: prefer `default` at the top level (mirrors `mod.default ?? mod`).
  let value: unknown = isPlainObject(mod) && mod.default != null ? mod.default : mod;

  // Step 2: peel off any further pure interop wrappers, bounded to avoid a
  // pathological self-referential object spinning forever.
  for (let depth = 0; depth < 10 && isPlainObject(value) && isPureDefaultWrapper(value); depth++) {
    value = value.default;
  }

  return value;
}

/**
 * {@link unwrapModuleDefault} specialized for config files: a non-object export
 * collapses to `{}` so downstream resolution falls through to env vars/flags.
 */
export function unwrapConfigModule(mod: unknown): TurbineCliConfig {
  const value = unwrapModuleDefault(mod);
  return isPlainObject(value) ? (value as TurbineCliConfig) : {};
}

/**
 * Attempt to load a turbine config file from the given directory, returning the
 * resolved config together with any load failure so the caller can surface it.
 *
 * Candidates are tried in {@link CONFIG_FILES} priority order. The first one
 * that imports successfully wins. If a candidate exists but throws (syntax
 * error, ESM/CJS interop failure, etc.) we remember the first such error and
 * keep trying lower-priority candidates; if none load, the remembered error is
 * returned in `loadError` while `config` stays `{}` so env/flag resolution can
 * still proceed.
 */
export async function loadConfigResult(cwd?: string): Promise<ConfigLoadResult> {
  const dir = cwd ?? process.cwd();
  let loadError: ConfigLoadError | undefined;

  for (const filename of CONFIG_FILES) {
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) continue;

    try {
      const absPath = resolve(filePath);
      const fileUrl = pathToFileURL(absPath).href;

      // For .ts files, we rely on the tsx loader being registered by the CLI
      // before this runs. Dynamic import handles .js/.mjs natively.
      const mod = await import(fileUrl);
      return { config: unwrapConfigModule(mod) };
    } catch (err) {
      // Remember the first real load failure but keep trying lower-priority
      // candidates (e.g. a working .js next to a broken .ts).
      if (!loadError) loadError = { filename, error: err };
    }
  }

  return loadError ? { config: {}, loadError } : { config: {} };
}

/**
 * Attempt to load a turbine config file from the current directory.
 * Returns the config if found, or an empty object. Load failures are swallowed
 * here; callers that need to surface them should use {@link loadConfigResult}.
 */
export async function loadConfig(cwd?: string): Promise<TurbineCliConfig> {
  return (await loadConfigResult(cwd)).config;
}

/**
 * Find the config file path (for display purposes).
 * Returns null if no config file is found.
 */
export function findConfigFile(cwd?: string): string | null {
  const dir = cwd ?? process.cwd();
  for (const filename of CONFIG_FILES) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Merge config with CLI args (CLI args take precedence)
// ---------------------------------------------------------------------------

export interface ResolvedConfig {
  url: string;
  out: string;
  schema: string;
  include: string[];
  exclude: string[];
  migrationsDir: string;
  seedFile?: string;
  schemaFile: string;
}

export interface CliOverrides {
  url?: string;
  out?: string;
  schema?: string;
  include?: string[];
  exclude?: string[];
}

/**
 * Merge config file values with CLI overrides and env vars.
 * Priority: CLI flags > env vars > config file > defaults.
 */
export function resolveConfig(fileConfig: TurbineCliConfig, overrides: CliOverrides): ResolvedConfig {
  return {
    url: overrides.url ?? process.env.DATABASE_URL ?? fileConfig.url ?? '',
    out: overrides.out ?? fileConfig.out ?? './generated/turbine',
    schema: overrides.schema ?? fileConfig.schema ?? 'public',
    include: overrides.include ?? fileConfig.include ?? [],
    exclude: overrides.exclude ?? fileConfig.exclude ?? [],
    migrationsDir: fileConfig.migrationsDir ?? './turbine/migrations',
    seedFile: fileConfig.seed ?? fileConfig.seedFile,
    schemaFile: fileConfig.schemaFile ?? './turbine/schema.ts',
  };
}

/**
 * Resolve the seed file path. An explicit config value wins even if the file
 * does not exist yet; otherwise the root-level defaults are tried in order.
 */
export function resolveSeedFile(
  config: Pick<TurbineCliConfig, 'seed' | 'seedFile'>,
  cwd = process.cwd(),
): string | null {
  const explicit = config.seed ?? config.seedFile;
  if (explicit) return resolve(cwd, explicit);

  for (const candidate of DEFAULT_SEED_CANDIDATES) {
    const filePath = resolve(cwd, candidate);
    if (existsSync(filePath)) return filePath;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Config file template (for `turbine init`)
// ---------------------------------------------------------------------------

export function configTemplate(connectionString?: string): string {
  const _url = connectionString ?? 'process.env.DATABASE_URL';
  const urlLine = connectionString ? `  url: '${connectionString}',` : `  url: process.env.DATABASE_URL,`;

  return `import type { TurbineCliConfig } from 'turbine-orm/cli';

/**
 * Turbine configuration
 * @see https://turbineorm.dev
 */
const config: TurbineCliConfig = {
  /** Postgres connection string */
${urlLine}

  /** Output directory for generated types + client */
  out: './generated/turbine',

  /** Postgres schema to introspect (default: public) */
  schema: 'public',

  /** Tables to exclude from generation */
  // exclude: ['_migrations', '_sessions'],

  /** Directory for SQL migration files */
  migrationsDir: './turbine/migrations',

  /** Path to seed file (defaults: ./seed.ts, ./seed.js, ./seed.sql) */
  seed: './seed.ts',

  /** Path to schema builder file (for turbine push) */
  schemaFile: './turbine/schema.ts',
};

export default config;
`;
}

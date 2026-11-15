/**
 * turbine-orm CLI, Configuration file support
 *
 * Loads turbine.config.ts (or .js/.mjs) via dynamic import.
 * Falls back to CLI args and environment variables.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertD1Config, type D1LocalConfig } from './d1-config.js';
import { PASSWORD_QUERY_PARAM_PATTERN } from './ui.js';

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export type { D1SeedPlan, D1SeedValue } from './d1-config.js';

export type CliEngine = 'postgresql' | 'sqlite' | 'mysql' | 'mssql' | 'libsql' | 'd1';

export interface TurbineCliConfig {
  /** Explicit persistent local Miniflare D1 binding. */
  d1?: D1LocalConfig;
  /** CLI database engine (default: postgresql). */
  engine?: CliEngine;
  /** Engine connection URL, or persistent SQLite filename / file URL. */
  url?: string;
  /** Output directory for generated files (default: ./generated/turbine) */
  out?: string;
  /** Namespace to introspect (PostgreSQL: public; MySQL: URL database; MSSQL: dbo; SQLite: main). */
  schema?: string;
  /** Tables to include (empty = all) */
  include?: string[];
  /** Tables to exclude */
  exclude?: string[];
  /**
   * Rename derived relations, as `{ table: { derivedName: desiredName } }`.
   *
   * Relation names are composed by introspection (a database does not name its
   * relationships), so two foreign keys to the same table produce names nobody
   * would predict, and a port from another ORM that named them differently has
   * to hand-edit every call site. A typo here is an error, not a silent no-op.
   */
  relationNames?: Record<string, Record<string, string>>;
  /**
   * TypeScript type overrides for generated row and input types, as
   * `{ '<table>.<column>': '<type>' }` with database names. The main use is a
   * `json` / `jsonb` column, which otherwise generates as `unknown`:
   * `{ 'users.settings': '{ theme: string; beta?: boolean }' }`. The type text
   * is emitted verbatim. A key naming no table or column is an error, not a
   * silent no-op. A code-first column's `tsType` feeds the same map.
   */
  columnTypes?: Record<string, string>;
  /**
   * Extension for the generated `index.ts` sibling imports:
   * `'js'` (`./types.js`), `'ts'` (`./types.ts`, for Node's native type
   * stripping), `'none'` (`./types`), or `'auto'` (default: tsconfig-detected,
   * falling back to `'js'`; never picks `'ts'`).
   */
  importExtension?: 'js' | 'ts' | 'none' | 'auto';
  /**
   * Keep raw database column names as generated field names (snake_case)
   * instead of camelCase. Opt-in; default `false`.
   */
  keepColumnNames?: boolean;
  /** Opt-in native integer generation; sqlite/mysql/mssql only. */
  exactNativeIntegers?: boolean;
  /**
   * Opt OUT of the unique-FK → one-to-one (`hasOne`) introspection flip,
   * emitting the pre-0.41 `hasMany` shape for unique-covered child relations.
   * Default `false` (detection on).
   */
  legacyToManyUniques?: boolean;
  /** Directory for migration files (default: ./turbine/migrations) */
  migrationsDir?: string;
  /**
   * Path to the seed file (canonical key). With no value, discovery falls back
   * to seed.ts, seed.js, seed.sql, then the same three under `turbine/`.
   */
  seedFile?: string;
  /**
   * Path to the seed file. Back-compat alias for {@link TurbineCliConfig.seedFile}:
   * older `turbine init` runs scaffolded this spelling. `seedFile` wins when both
   * are set.
   */
  seed?: string;
  /**
   * The `defineSchema()` file (default `./turbine/schema.ts`): what `push` applies,
   * and where `generate` reads the `pii` / `updatedAt` / `maxLength` tags the
   * database cannot store.
   */
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
 * mis-set `schemaFile`, introspecting `WHERE table_schema = './turbine/schema.ts'`
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
/**
 * Config-less fallback locations for the seed file, in priority order.
 *
 * Root-level candidates stay FIRST so no project that already relies on
 * `./seed.ts` changes behavior. The `turbine/` candidates are appended so a
 * project that drops the `seedFile` key can still auto-discover the file
 * `turbine init` scaffolds (see {@link DEFAULT_INIT_SEED_FILE}).
 */
const DEFAULT_SEED_CANDIDATES = [
  'seed.ts',
  'seed.js',
  'seed.sql',
  'turbine/seed.ts',
  'turbine/seed.js',
  'turbine/seed.sql',
] as const;

/**
 * Where `turbine init` scaffolds the seed file, and the `seedFile` value it
 * writes into the generated config. Kept next to the schema file so a new
 * project's Turbine files live in one directory.
 */
export const DEFAULT_INIT_SEED_FILE = './turbine/seed.ts';

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
  const keys = Object.keys(value);
  return keys.includes('default') && keys.every((key) => key === 'default' || key === '__esModule');
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
 * error, ESM/CJS interop failure, etc.), retain the first such error and
 * keep trying lower-priority candidates; if none load, the remembered error is
 * returned in `loadError` while `config` stays `{}` so env/flag resolution can
 * still proceed.
 */
export async function loadConfigResult(
  cwd?: string,
  importModule?: (url: string) => Promise<unknown>,
): Promise<ConfigLoadResult> {
  const dir = cwd ?? process.cwd();
  let loadError: ConfigLoadError | undefined;

  for (const filename of CONFIG_FILES) {
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) continue;

    try {
      const fileUrl = pathToFileURL(filePath).href;

      // For .ts files, the CLI must register the tsx loader before importing.
      // before this runs. Dynamic import handles .js/.mjs natively.
      const mod = await (importModule ? importModule(fileUrl) : import(fileUrl));
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
  d1?: D1LocalConfig;
  /** Optional for compatibility with older typed fixtures; resolution always sets it. */
  engine?: CliEngine;
  url: string;
  out: string;
  schema: string;
  include: string[];
  exclude: string[];
  migrationsDir: string;
  seedFile?: string;
  schemaFile: string;
  /**
   * True when `--schema-file` or the config `schemaFile` key named the file, as
   * opposed to the `./turbine/schema.ts` default. A named file that is missing is
   * an error; a missing default just means a database-first project.
   */
  schemaFileConfigured?: boolean;
  /** Resolved generator import-extension mode. */
  importExtension: 'js' | 'ts' | 'none' | 'auto';
  /** Resolved keep-column-names generator flag. */
  keepColumnNames: boolean;
  /** Opt-in native integer declarations. */
  exactNativeIntegers?: boolean;
  /** Resolved opt-out of the unique-FK → hasOne introspection flip. */
  legacyToManyUniques: boolean;
  /** Resolved derived-relation rename map, or undefined when none is declared. */
  relationNames?: Record<string, Record<string, string>>;
  /** Column type overrides for the generator, or undefined when none is declared. */
  columnTypes?: Record<string, string>;
  /**
   * The config file's `adapter`, passed to `migrate up` / `deploy` / `down` so a
   * CockroachDB or YugabyteDB project takes the migration lock its engine supports.
   */
  adapter?: import('../adapters/index.js').DatabaseAdapter;
}

export interface CliOverrides {
  engine?: CliEngine;
  url?: string;
  out?: string;
  schema?: string;
  /** `--schema-file <path>`: the defineSchema() file, overriding config `schemaFile`. */
  schemaFile?: string;
  include?: string[];
  exclude?: string[];
  importExtension?: 'js' | 'ts' | 'none' | 'auto';
  keepColumnNames?: boolean;
  /** Opt-in native integer generation; sqlite/mysql/mssql only. */
  exactNativeIntegers?: boolean;
  legacyToManyUniques?: boolean;
}

/**
 * The first candidate that is a non-blank string. An empty or whitespace-only
 * value counts as unset, because an exported-but-empty variable (`DATABASE_URL=`
 * in a shell profile or a `.env` template) is how "not configured" is usually
 * spelled, and `??` would let it beat a real value further down the chain.
 */
export function firstNonEmpty(...candidates: Array<string | undefined>): string | undefined {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/** Validate config arguments with TypeError; the command boundary adds its E003 diagnostic. */
export function resolveCliEngine(engine: unknown): CliEngine {
  if (engine === undefined) return 'postgresql';
  if (['postgresql', 'sqlite', 'mysql', 'mssql', 'libsql', 'd1'].includes(engine as string)) return engine as CliEngine;
  throw new TypeError('Unknown CLI engine.');
}

/** Validate the endpoint fields consumed by the native network introspectors. */
function networkDatabaseFromUrl(url: string, protocol: string, label: string): string {
  try {
    if (typeof url !== 'string' || /[\s\0?#]/.test(url)) throw new Error();
    const parsed = new URL(url);
    const database = decodeURIComponent(parsed.pathname.slice(1));
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
    if (parsed.protocol !== `${protocol}:` || !parsed.hostname || !database || /[/\\\0]/.test(database)) {
      throw new Error();
    }
    return database;
  } catch {
    throw new TypeError(
      `${label} CLI requires ${protocol}://host/database with valid URL escaping and no query parameters or fragments. Use a native pool for advanced connection options.`,
    );
  }
}

/** Resolve the MySQL database without opening a connection or exposing credentials. */
export function mysqlDatabaseFromUrl(url: string): string {
  return networkDatabaseFromUrl(url, 'mysql', 'MySQL');
}

/** Resolve a local, persistent SQLite target without opening or creating it. */
export function normalizeSqlitePath(url: string, cwd = process.cwd()): string {
  if (typeof url !== 'string' || !url.trim() || url.includes('\0')) {
    throw new TypeError('SQLite requires a nonempty persistent database path.');
  }
  let path = url.trim();
  if (
    /^postgres(?:ql)?:/i.test(path) ||
    /(?:^|\s)(?:host|hostaddr|dbname|user|password|port|service|sslmode|connect_timeout)\s*=/i.test(path)
  ) {
    throw new TypeError('A PostgreSQL connection string cannot be used with engine "sqlite".');
  }
  const uri = /^(file|sqlite):/i.exec(path);
  if (uri) {
    const value = path.slice(uri[0].length);
    if (/[?#]/.test(value)) {
      throw new TypeError('SQLite CLI file URLs cannot contain query parameters or fragments.');
    }
    try {
      if (value.startsWith('//')) {
        // Both spellings use file URL rules, including rejection of remote hosts.
        const parsed = new URL(`file:${value}`);
        if (parsed.hostname && parsed.hostname !== 'localhost') throw new Error('remote host');
        path = fileURLToPath(parsed);
      } else {
        path = decodeURIComponent(value);
      }
    } catch {
      throw new TypeError('Invalid SQLite file URL. Use a local filename or file:///absolute/path.');
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(path)) {
    throw new TypeError('SQLite requires a local database path, not a network connection URL.');
  }
  if (path.includes('\0')) throw new TypeError('SQLite database paths cannot contain NUL characters.');
  if (!path.trim() || path === ':memory:' || /(?:^|[/\\]):memory:(?:$|[/\\])/i.test(path)) {
    throw new TypeError('SQLite CLI commands require a persistent file; :memory: cannot survive between commands.');
  }
  return resolve(cwd, path);
}

/** Refuse SQLite targets on the default PG path before a driver sees them. */
export function validateCliEngineUrl(engine: CliEngine, url: string): void {
  // The libSQL route validates and normalizes with its real effect-free helper.
  // This config-only entry deliberately avoids importing the native graph.
  if (engine === 'd1' && url) throw new TypeError('Remove url and DATABASE_URL for local D1.');
  if (!url || engine === 'libsql') return;
  if (engine === 'mysql') {
    mysqlDatabaseFromUrl(url);
  } else if (engine === 'mssql') {
    networkDatabaseFromUrl(url, 'mssql', 'MSSQL');
  } else if (/^mssql:/i.test(url.trim())) {
    throw new TypeError('A SQL Server connection URL requires engine "mssql" (or --engine mssql).');
  } else if (engine === 'sqlite') {
    normalizeSqlitePath(url);
  } else if (/^mysql:/i.test(url.trim())) {
    throw new TypeError('A MySQL URL requires engine "mysql" (or --engine mysql).');
  } else if (/^(?:postgres(?:ql)?:|\s*[a-z_]+\s*=)/i.test(url.trim())) {
    // Database names may themselves end in .db; preserve libpq strings too.
    return;
  } else if (/^\/\S+\s+\S+$/.test(url.trim())) {
    // pg accepts "<Unix socket directory> <database>" as a connection string.
    return;
  } else if (/^(?:file:|sqlite:|:memory:|\.{0,2}[/\\]|[a-z]:[/\\])|\.(?:db|sqlite3?)(?:[?#].*)?$/i.test(url.trim())) {
    throw new TypeError('A SQLite database path requires engine "sqlite" (or --engine sqlite).');
  }
}

/**
 * Merge config file values with CLI overrides and env vars.
 * Priority: CLI flags > env vars > config file > defaults.
 */
export function resolveConfig(fileConfig: TurbineCliConfig, overrides: CliOverrides): ResolvedConfig {
  const option = <K extends keyof CliOverrides>(key: K) => overrides[key] ?? fileConfig[key];
  for (const value of [fileConfig.exactNativeIntegers, overrides.exactNativeIntegers]) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new TypeError('exactNativeIntegers must be a boolean.');
    }
  }
  // Validate both supplied values, even when a flag would override a bad file value.
  if (fileConfig.engine !== undefined) resolveCliEngine(fileConfig.engine);
  const engine = resolveCliEngine(overrides.engine !== undefined ? overrides.engine : fileConfig.engine);
  if (engine === 'd1') assertD1Config(fileConfig);
  const url = firstNonEmpty(overrides.url, process.env.DATABASE_URL, fileConfig.url) ?? '';
  validateCliEngineUrl(engine, url);
  if (engine !== 'postgresql' && fileConfig.adapter !== undefined) {
    throw new TypeError(`PostgreSQL adapters cannot be used with engine "${engine}".`);
  }
  if (
    engine === 'mysql' &&
    option('schema') !== undefined &&
    option('schema') !== (url ? mysqlDatabaseFromUrl(url) : '')
  ) {
    throw new TypeError('MySQL CLI schema must match the database in its URL.');
  }
  if (engine === 'sqlite' && (option('schema') ?? 'main') !== 'main') {
    throw new TypeError('SQLite CLI introspection uses schema "main"; PostgreSQL namespaces are not supported.');
  }
  return {
    engine,
    d1: fileConfig.d1,
    url: engine === 'sqlite' && url ? normalizeSqlitePath(url) : url,
    out: option('out') ?? './generated/turbine',
    schema:
      option('schema') ??
      (engine === 'postgresql'
        ? 'public'
        : engine === 'mssql'
          ? 'dbo'
          : engine === 'mysql'
            ? url
              ? mysqlDatabaseFromUrl(url)
              : ''
            : 'main'),
    include: option('include') ?? [],
    relationNames: fileConfig.relationNames,
    columnTypes: fileConfig.columnTypes,
    exclude: option('exclude') ?? [],
    migrationsDir: fileConfig.migrationsDir ?? './turbine/migrations',
    // `seedFile` is canonical (what the docs and `turbine init` use); `seed` is a
    // back-compat alias kept working for configs scaffolded before 0.50.
    seedFile: fileConfig.seedFile ?? fileConfig.seed,
    schemaFile: option('schemaFile') ?? './turbine/schema.ts',
    schemaFileConfigured: option('schemaFile') !== undefined,
    importExtension: option('importExtension') ?? 'auto',
    keepColumnNames: option('keepColumnNames') ?? false,
    exactNativeIntegers: option('exactNativeIntegers') ?? false,
    legacyToManyUniques: option('legacyToManyUniques') ?? false,
    adapter: fileConfig.adapter,
  };
}

/**
 * Resolve the seed file path. An explicit config value wins even if the file
 * does not exist yet; otherwise {@link DEFAULT_SEED_CANDIDATES} is tried in
 * order (root-level first, then the `turbine/` location `init` scaffolds).
 */
export function resolveSeedFile(
  config: Pick<TurbineCliConfig, 'seed' | 'seedFile'>,
  cwd = process.cwd(),
): string | null {
  // Canonical `seedFile` first, then the back-compat `seed` alias (see resolveConfig).
  const explicit = config.seedFile ?? config.seed;
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

/**
 * Does this connection string carry a password?
 *
 * `turbine init --url` used to inline whatever it was given straight into
 * `turbine.config.ts`, a file projects commit, so the documented one-liner
 * (`turbine init --url postgres://user:PASSWORD@host/db`) committed a live
 * database password. Everything that decides between "inline the string" and
 * "read `process.env.DATABASE_URL`" asks this function, so there is exactly one
 * definition of "this value is a secret".
 *
 * Three spellings carry a password, and libpq (and `pg-connection-string`,
 * which is what `pg` actually parses with) accepts all three:
 *
 *  1. URL userinfo: `postgres://user:pass@host/db`.
 *  2. URL query parameter: `postgres://user@host/db?password=pass`, and its
 *     siblings such as `?sslpassword=`. This one was missed, on the reasoning
 *     that a successful `new URL` ruled out the keyword form below, which is
 *     true and irrelevant: the secret was in the query string.
 *  3. libpq keyword form: `host=... password=...` (also `sslpassword=`), which
 *     is not a URL at all.
 *
 * The query-parameter test reuses `PASSWORD_QUERY_PARAM_PATTERN`, the very
 * regex `redactUrl` redacts with, so a spelling the terminal output hides can
 * never be a spelling this function calls safe to commit. `pg-connection-string`
 * itself would be the ideal oracle, but it is only a TRANSITIVE dependency (of
 * `pg`), and importing an undeclared package would break on any strict,
 * non-hoisting installer. Detection stays self-contained.
 *
 * @internal exported for tests.
 */
export function connectionStringHasPassword(connectionString: string): boolean {
  const value = connectionString.trim();
  if (!value) return false;

  try {
    const parsed = new URL(value);
    // An empty password ("postgres://user@host/db", "?password=") is not a
    // secret. decodeURIComponent is deliberately NOT applied: presence is
    // sufficient, and a percent-encoded value is still a non-empty one.
    if (parsed.password !== '') return true;
    for (const match of value.matchAll(new RegExp(PASSWORD_QUERY_PARAM_PATTERN, 'gi'))) {
      if (match[2] !== '') return true;
    }
    // A string libpq parses as a URI is never re-parsed as the keyword form, so
    // the check below genuinely cannot apply here.
    return false;
  } catch {
    // Not a URL: fall through to the libpq keyword form.
  }

  // A keyword whose name ends in `password` (`password`, `sslpassword`) with a
  // non-empty value, at the start of the string or after whitespace.
  return /(^|\s)[^\s=]*password\s*=\s*\S/i.test(value);
}

/**
 * The `turbine.config.ts` scaffold.
 *
 * A password-bearing `connectionString` is NEVER inlined: the emitted config
 * reads `process.env.DATABASE_URL` instead, and `turbine init` scaffolds the
 * `.env` that holds the real value. The refusal lives here rather than at the
 * call site so no future caller can reintroduce the leak by passing the raw
 * `--url` through.
 *
 * `schema` is the RESOLVED Postgres schema (`--schema` or the default), written
 * as the config's `schema` value. `init --schema app` probes `app` and then
 * used to write `schema: 'public'` regardless, so the next documented step,
 * `push`, diffed the starter schema against the wrong namespace and proposed
 * dropping every column it found there.
 */
export function configTemplate(connectionString?: string, schema = 'public'): string {
  const inlineUrl = connectionString && !connectionStringHasPassword(connectionString) ? connectionString : undefined;
  // Same delimiter rule as the URL below: a schema name is an arbitrary
  // identifier, and a quote in it must not end the TS string early.
  const schemaLiteral = schema.replace(/[\\']/g, '\\$&');
  // Single quotes are the string delimiter in the emitted TS, so a connection
  // string containing one would otherwise produce a config file that does not
  // parse (a password-free URL can still carry a quote in a query parameter).
  const urlLine = inlineUrl ? `  url: '${inlineUrl.replace(/[\\']/g, '\\$&')}',` : `  url: process.env.DATABASE_URL,`;

  return `import type { TurbineCliConfig } from 'turbine-orm/cli';

const config: TurbineCliConfig = {
${urlLine}
  out: './generated/turbine',
  schema: '${schemaLiteral}',
  migrationsDir: './turbine/migrations',
  seedFile: '${DEFAULT_INIT_SEED_FILE}',
  schemaFile: './turbine/schema.ts',
};

export default config;
`;
}

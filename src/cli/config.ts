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
  /** Path to seed file (default: ./turbine/seed.ts) */
  seedFile?: string;
  /** Schema builder file path (for push command) */
  schemaFile?: string;
}

// ---------------------------------------------------------------------------
// Config file names, in priority order
// ---------------------------------------------------------------------------

const CONFIG_FILES = ['turbine.config.ts', 'turbine.config.mts', 'turbine.config.js', 'turbine.config.mjs'] as const;

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

/**
 * Attempt to load a turbine config file from the current directory.
 * Returns the config if found, or an empty object.
 */
export async function loadConfig(cwd?: string): Promise<TurbineCliConfig> {
  const dir = cwd ?? process.cwd();

  for (const filename of CONFIG_FILES) {
    const filePath = join(dir, filename);
    if (!existsSync(filePath)) continue;

    try {
      const absPath = resolve(filePath);
      const fileUrl = pathToFileURL(absPath).href;

      // For .ts files, we need to rely on Node's --experimental-strip-types
      // or the tsx loader. Dynamic import handles .js/.mjs natively.
      const mod = await import(fileUrl);
      const config: TurbineCliConfig = mod.default ?? mod;

      return config;
    } catch (err) {
      // If importing a .ts file fails, try the next one
      if (filename.endsWith('.ts') || filename.endsWith('.mts')) {
        continue;
      }
      throw new Error(`Failed to load config from ${filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {};
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
  seedFile: string;
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
    seedFile: fileConfig.seedFile ?? './turbine/seed.ts',
    schemaFile: fileConfig.schemaFile ?? './turbine/schema.ts',
  };
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

  /** Path to seed file */
  seedFile: './turbine/seed.ts',

  /** Path to schema builder file (for turbine push) */
  schemaFile: './turbine/schema.ts',
};

export default config;
`;
}

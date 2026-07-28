#!/usr/bin/env node
/**
 * turbine-orm CLI
 *
 * Commands:
 *   turbine init                 , Initialize a Turbine project
 *   turbine generate | pull      , Introspect database and generate TypeScript types
 *   turbine migrate-from-prisma   - Parse a schema.prisma and emit a Prisma->Turbine name map + report
 *   turbine push                  - Apply schema-builder definitions to database (destructive ops gated)
 *   turbine migrate create <name> - Create a new SQL migration file (--auto | --from-diff | --recipe <name>)
 *   turbine migrate up           , Apply pending migrations
 *   turbine migrate deploy       , Apply pending migrations without prompts
 *   turbine migrate down         , Rollback last migration
 *   turbine migrate status       , Show migration status
 *   turbine seed                 , Run seed file
 *   turbine status               , Show schema summary
 *   turbine doctor                - Index + cached-plan triage (--fix, --json, --no-concurrently, --unused, --audit, --no-plan-divergence)
 *   turbine studio                : Launch local read-only web UI (--demo for a seeded sample DB)
 *   turbine mcp                  , Start read-only MCP server over JSON-RPC stdio
 *   turbine observe              , Launch metrics dashboard (requires TURBINE_OBSERVE_URL)
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx turbine generate
 *   npx turbine init --url postgres://...
 *   npx turbine migrate create add_users_table
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate, generatePrismaMap } from '../generate.js';
import {
  buildCreateIndexSql,
  buildDropIndexSql,
  collectDoctorProbeIndexNames,
  collectRelationProbeColumns,
  findMissingRelationIndexes,
  type MissingRelationIndex,
} from '../index-advisor.js';
import {
  auditDoctorIndexes,
  collectStatsSnapshot,
  collectTableHeat,
  type DoctorIndexAudit,
  findInvalidIndexes,
  findRedundantIndexes,
  findUnusedIndexes,
  formatBytes,
  type IndexTier,
  isSnapshotUsable,
  type ProbedColumn,
  type RedundantIndex,
  type ScoredMissingIndex,
  STATS_THRESHOLDS,
  type StatsSnapshot,
  scoreMissingIndex,
  type TableHeatResult,
  type UnusedIndex,
} from '../index-stats.js';
import { introspect } from '../introspect.js';
import {
  collectDivergenceCandidateColumns,
  collectDivergenceOrderColumns,
  findPlanDivergence,
  PLAN_DIVERGENCE_THRESHOLDS,
  type PlanDivergenceFinding,
  type PlanDivergenceReport,
} from '../plan-divergence.js';
import { applyFlipVerdicts, emptyFlipProbeResult, needsFlipProbe, probePlanFlips } from '../plan-flip-probe.js';
import { type SchemaMetadata, snakeToCamel } from '../schema.js';
import type { SchemaDef } from '../schema-builder.js';
import { DestructivePushRefusal, schemaDiff, schemaPush } from '../schema-sql.js';
import type { CliOverrides, ConfigLoadError, ResolvedConfig, TurbineCliConfig } from './config.js';
import {
  configTemplate,
  DEFAULT_INIT_SEED_FILE,
  findConfigFile,
  loadConfigResult,
  looksLikeSchemaFilePath,
  resolveConfig,
  resolveSeedFile,
  unwrapModuleDefault,
} from './config.js';
import { DESTRUCTIVE_KIND_LABEL } from './destructive.js';
import { canResolveTsx, getTsLoaderError, needsTsLoader, registerTsLoader } from './loader.js';
import { runMcpServer } from './mcp.js';
import {
  buildDiffMigrationBody,
  collectUpDestructive,
  createMigration,
  type DestructiveOffender,
  formatChecksumMismatchError,
  inspectMigrationDeploy,
  listMigrationFiles,
  MIGRATION_RECIPES,
  type MigrationFile,
  migrateDeploy,
  migrateDown,
  migrateStatus,
  migrateUp,
  type OutOfOrderApply,
} from './migrate.js';
import { startObserve } from './observe.js';
import { formatPrismaReport, summaryLines } from './prisma-report.js';
import { DEFAULT_EXCLUDED_TABLES, resolvePrismaSchema } from './prisma-resolve.js';
import {
  PrismaParseError,
  type PrismaSchemaAst,
  parsePrismaSchema,
  type ResolvedPrismaDatasourceUrl,
  resolvePrismaDatasourceUrl,
} from './prisma-schema.js';
import { startStudio } from './studio.js';
import {
  banner,
  blue,
  bold,
  box,
  cyan,
  dim,
  divider,
  elapsed,
  error,
  table as formatTable,
  gray,
  green,
  header,
  info,
  label,
  magenta,
  newline,
  red,
  redactUrl,
  Spinner,
  success,
  symbols,
  warn,
  yellow,
} from './ui.js';

// ---------------------------------------------------------------------------
// Argument parsing (zero deps, just process.argv)
// ---------------------------------------------------------------------------

export interface CliArgs {
  command: string;
  subcommand?: string;
  positional: string[];
  url?: string;
  out?: string;
  schema?: string;
  include?: string[];
  exclude?: string[];
  step?: number;
  dryRun?: boolean;
  force?: boolean;
  verbose?: boolean;
  help?: boolean;
  auto?: boolean;
  /** `migrate create --from-diff`: scaffold UP/DOWN from the schema diff, destructive statements flagged. */
  fromDiff?: boolean;
  allowDrift?: boolean;
  allowEmpty?: boolean;
  allowDestructive?: boolean;
  /** `migrate create --recipe <name>` scaffold selector. */
  recipe?: string;
  fix?: boolean;
  /** `doctor --json`: emit a stable, versioned machine-readable report. */
  json?: boolean;
  /** `doctor --fix --no-concurrently`: emit plain CREATE INDEX instead of the CONCURRENTLY + no-transaction form. */
  noConcurrently?: boolean;
  /** `doctor --unused`: report-only never-scanned / redundant / invalid indexes with DROP suggestions. */
  unused?: boolean;
  /** `doctor --audit`: unused report scoped to doctor's own previously-suggested index names. */
  audit?: boolean;
  /** `doctor --min-scans <n>`: idx_scan below this counts as never-scanned (default 1 = idx_scan 0). */
  minScans?: number;
  /** `doctor --metrics-url <url>`: read _turbine_metrics for the table-heat boost from a separate DB. */
  metricsUrl?: string;
  /** `doctor --no-plan-divergence`: skip the cached-plan divergence section (and its pg_stats read). */
  noPlanDivergence?: boolean;
  // init flags
  /** `init --yes`/`-y`: accept every step's default non-interactively. */
  yes?: boolean;
  /** `init --skip-schema`: don't scaffold the schema file. */
  skipSchema?: boolean;
  /** `init --skip-seed`: don't scaffold the seed file or offer to run it. */
  skipSeed?: boolean;
  /** `init --skip-push`: don't offer to push the schema to the database. */
  skipPush?: boolean;
  /** `init --skip-generate`: don't offer to generate the typed client. */
  skipGenerate?: boolean;
  // generate flags
  zod?: boolean;
  includeViews?: boolean;
  /** Omit the `Generated at:` header line for reproducible (diff-stable) output. */
  noTimestamp?: boolean;
  /** `generate --import-ext <js|none|auto>`: sibling-import extension mode (F3). */
  importExtension?: 'js' | 'none' | 'auto';
  /** `generate --keep-column-names`: keep raw DB column names as field names (F4). */
  keepColumnNames?: boolean;
  /** `generate --legacy-to-many-uniques`: opt out of the unique-FK → hasOne flip (F2). */
  legacyToManyUniques?: boolean;
  // studio / observe flags
  port?: number;
  host?: string;
  noOpen?: boolean;
  /** Opt-in to bind Studio/Observe on a non-loopback host. */
  allowRemote?: boolean;
  /** Opt-in to Studio single-row write mode (`studio --write`). */
  write?: boolean;
  /** Reveal PII-tagged column values in Studio instead of redacting (`--show-pii`). */
  showPii?: boolean;
  /** Launch Studio with a seeded in-memory sample database (`studio --demo`). */
  demo?: boolean;
  // migrate-from-prisma flags
  /** `migrate-from-prisma --allow-partial`: exit 0 even when some items are UNRESOLVED. */
  allowPartial?: boolean;
  /** `migrate-from-prisma --no-db`: parse-only, skip database resolution. */
  noDb?: boolean;
}

export function parseArgs(argv = process.argv.slice(2)): CliArgs {
  const args = argv;
  const result: CliArgs = {
    command: args[0] ?? 'help',
    positional: [],
  };

  let i = 1;

  // Check for subcommand (e.g. "migrate create")
  if (i < args.length && args[i] && !args[i]!.startsWith('-')) {
    result.subcommand = args[i];
    i++;
  }

  for (; i < args.length; i++) {
    const arg = args[i]!;
    const next = args[i + 1];

    switch (arg) {
      case '--url':
      case '-u':
        result.url = next;
        i++;
        break;
      case '--out':
      case '-o':
        result.out = next;
        i++;
        break;
      case '--schema':
      case '-s':
        result.schema = next;
        i++;
        break;
      case '--include':
        result.include = next?.split(',');
        i++;
        break;
      case '--exclude':
        result.exclude = next?.split(',');
        i++;
        break;
      case '--step':
      case '-n':
        result.step = next ? parseInt(next, 10) : undefined;
        i++;
        break;
      case '--dry-run':
        result.dryRun = true;
        break;
      case '--auto':
        result.auto = true;
        break;
      case '--from-diff':
        result.fromDiff = true;
        break;
      case '--yes':
      case '-y':
        result.yes = true;
        break;
      case '--skip-schema':
        result.skipSchema = true;
        break;
      case '--skip-seed':
        result.skipSeed = true;
        break;
      case '--skip-push':
        result.skipPush = true;
        break;
      case '--skip-generate':
        result.skipGenerate = true;
        break;
      case '--allow-drift':
        result.allowDrift = true;
        break;
      case '--allow-empty':
        result.allowEmpty = true;
        break;
      case '--fix':
        result.fix = true;
        break;
      case '--json':
        result.json = true;
        break;
      case '--no-concurrently':
        result.noConcurrently = true;
        break;
      case '--unused':
        result.unused = true;
        break;
      case '--audit':
        result.audit = true;
        break;
      case '--min-scans':
        result.minScans = next ? Number.parseInt(next, 10) : undefined;
        i++;
        break;
      case '--metrics-url':
        result.metricsUrl = next;
        i++;
        break;
      case '--no-plan-divergence':
        result.noPlanDivergence = true;
        break;
      case '--zod':
        result.zod = true;
        break;
      case '--include-views':
        result.includeViews = true;
        break;
      case '--no-timestamp':
        result.noTimestamp = true;
        break;
      case '--import-ext':
      case '--import-extension':
        if (next !== 'js' && next !== 'none' && next !== 'auto') {
          console.error(`--import-ext requires one of: js, none, auto (got ${next ?? '(nothing)'})`);
          process.exit(1);
        }
        result.importExtension = next;
        i++;
        break;
      case '--keep-column-names':
        result.keepColumnNames = true;
        break;
      case '--legacy-to-many-uniques':
        result.legacyToManyUniques = true;
        break;
      case '--allow-destructive':
        result.allowDestructive = true;
        break;
      case '--recipe':
        if (next === undefined || next.startsWith('-')) {
          console.error('--recipe requires a name (e.g. --recipe backfill)');
          process.exit(1);
        }
        result.recipe = next;
        i++;
        break;
      case '--force':
      case '-f':
        result.force = true;
        break;
      case '--verbose':
      case '-v':
        result.verbose = true;
        break;
      case '--help':
      case '-h':
        result.help = true;
        break;
      case '--port':
        result.port = next ? Number.parseInt(next, 10) : undefined;
        i++;
        break;
      case '--host':
        result.host = next;
        i++;
        break;
      case '--no-open':
        result.noOpen = true;
        break;
      case '--allow-remote':
        result.allowRemote = true;
        break;
      case '--write':
        result.write = true;
        break;
      case '--show-pii':
        result.showPii = true;
        break;
      case '--demo':
        result.demo = true;
        break;
      case '--allow-partial':
        result.allowPartial = true;
        break;
      case '--no-db':
        result.noDb = true;
        break;
      default:
        if (!arg.startsWith('-')) {
          result.positional.push(arg);
        }
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// TypeScript loader, user-facing error helper
// ---------------------------------------------------------------------------

/**
 * Print a friendly error explaining how to install tsx, then exit.
 * Called when we know we need to load a `.ts` file but the loader isn't available.
 */
function failMissingTsLoader(filePath: string, reason: 'missing' | 'unsupported' | 'failed'): never {
  newline();
  error(`Cannot load TypeScript file: ${filePath}`);
  newline();
  if (reason === 'unsupported') {
    console.log(`  ${dim('Your Node.js version does not support')} ${cyan('module.register()')}.`);
    console.log(
      `  ${dim('Upgrade to Node.js')} ${cyan('20.6+')} ${dim('or use a')} ${cyan('.js')} ${dim('/')} ${cyan('.mjs')} ${dim('config file.')}`,
    );
  } else if (reason === 'failed') {
    // tsx IS installed but registering its loader threw. Report the real
    // cause, telling the user to install tsx here would be a misdiagnosis.
    console.log(`  ${dim('tsx is installed, but registering its TypeScript loader failed:')}`);
    newline();
    console.log(`    ${getTsLoaderError() ?? '(unknown error)'}`);
    newline();
    console.log(
      `  ${dim('Try upgrading tsx:')} ${cyan('npm install --save-dev tsx@latest')}${dim(', or rename your file to')} ${cyan('.mjs')}.`,
    );
  } else {
    console.log(`  ${dim('Loading .ts config / schema files requires')} ${cyan('tsx')} ${dim('to be installed.')}`);
    newline();
    console.log(`  ${dim('Install it as a dev dependency:')}`);
    console.log(`    ${cyan('npm install --save-dev tsx')}`);
    console.log(`    ${dim('or')}`);
    console.log(`    ${cyan('pnpm add -D tsx')}`);
    console.log(`    ${dim('or')}`);
    console.log(`    ${cyan('yarn add -D tsx')}`);
    newline();
    console.log(`  ${dim('Alternatively, rename your file to')} ${cyan('.js')} ${dim('or')} ${cyan('.mjs')}.`);
  }
  newline();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config bootstrap
// ---------------------------------------------------------------------------

/**
 * Does this invocation need a `turbine.config.*` file?
 *
 * Everything does, with one deliberate exception: `turbine studio --demo` boots
 * a seeded in-memory database, needs no `DATABASE_URL` and no config file, and
 * is the very next command the quickstart suggests after `turbine init`.
 * Resolving the config anyway means a freshly scaffolded directory (a
 * `turbine.config.ts` with `tsx` not installed yet) dies with "Cannot load
 * TypeScript file" before demo mode ever starts.
 *
 * @internal exported for tests.
 */
export function usesProjectConfig(args: Pick<CliArgs, 'command' | 'demo'>): boolean {
  return !(args.command === 'studio' && args.demo === true);
}

/**
 * Outcome of {@link bootstrapCliConfig}.
 *
 * @internal exported for tests.
 */
export interface CliConfigBootstrap {
  /** Merged config: CLI flags > env vars > config file > defaults. */
  config: ResolvedConfig;
  /** The raw config-file contents (`{}` when none was loaded). */
  fileConfig: TurbineCliConfig;
  /** Set when a config file existed but failed to import. */
  loadError?: ConfigLoadError;
  /** True when config resolution was deliberately skipped (see {@link usesProjectConfig}). */
  skipped: boolean;
}

/**
 * Resolve the effective CLI config: register the tsx loader when the config file
 * is TypeScript, import it, then merge it with env vars and CLI flags. Exits with
 * the actionable "Cannot load TypeScript file" error when a `.ts` config cannot
 * be loaded. Config-free invocations short-circuit without touching the disk.
 *
 * @internal exported for tests.
 */
export async function bootstrapCliConfig(
  args: Pick<CliArgs, 'command' | 'demo'>,
  overrides: CliOverrides,
): Promise<CliConfigBootstrap> {
  if (!usesProjectConfig(args)) {
    return { config: resolveConfig({}, overrides), fileConfig: {}, skipped: true };
  }

  // If the user has a TypeScript config file, register the tsx ESM loader
  // before we attempt to import it. Otherwise Node throws
  // ERR_UNKNOWN_FILE_EXTENSION for `.ts`.
  const configPath = findConfigFile();
  if (needsTsLoader(configPath)) {
    const status = await registerTsLoader();
    if (status === 'missing' || status === 'unsupported' || status === 'failed') {
      failMissingTsLoader(configPath ?? 'turbine.config.ts', status);
    }
  }

  const { config: fileConfig, loadError } = await loadConfigResult();
  return { config: resolveConfig(fileConfig, overrides), fileConfig, loadError, skipped: false };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface RequireUrlOptions {
  /**
   * Environment variable names a `schema.prisma` datasource declares via
   * `env(...)` that were unset. Listed as an extra way to supply the URL, so
   * the user sees the exact variable the CLI looked for.
   */
  datasourceVars?: string[];
}

function requireUrl(config: ResolvedConfig, options: RequireUrlOptions = {}): string {
  if (!config.url) {
    error('No database URL provided.');
    newline();
    console.log(`  ${dim('Set it in one of these ways:')}`);
    console.log(`    ${dim('1.')} Add ${cyan('url')} to ${cyan('turbine.config.ts')}`);
    // .env auto-load needs Node 20.12+ (process.loadEnvFile); be honest below it.
    const envFileNote =
      typeof process.loadEnvFile === 'function' ? '(auto-loaded)' : '(needs Node 20.12+ to auto-load)';
    console.log(
      `    ${dim('2.')} Set ${cyan('DATABASE_URL')} in your environment or a ${cyan('.env')} file ${dim(envFileNote)}`,
    );
    console.log(`    ${dim('3.')} Pass ${cyan('--url')} flag`);
    const vars = options.datasourceVars ?? [];
    if (vars.length > 0) {
      const list = vars.map((v) => cyan(v)).join(', ');
      const plural = vars.length > 1 ? 'these variables' : 'this variable';
      console.log(
        `    ${dim('4.')} Set ${list} ${dim(`(${plural}, declared by your schema.prisma datasource, ${vars.length > 1 ? 'are' : 'is'} unset)`)}`,
      );
    }
    newline();
    process.exit(1);
  }
  return config.url;
}

async function loadSchemaFile(schemaFile: string): Promise<SchemaDef> {
  const absPath = resolve(schemaFile);
  if (!existsSync(absPath)) {
    error(`Schema file not found: ${schemaFile}`);
    console.log(`  ${dim('Create one with:')} ${cyan('turbine init')}`);
    process.exit(1);
  }

  // If this is a TypeScript file, ensure the tsx ESM loader is registered
  // before we attempt the dynamic import. Without this, Node throws
  // ERR_UNKNOWN_FILE_EXTENSION for `.ts`.
  if (needsTsLoader(absPath)) {
    const status = await registerTsLoader();
    if (status === 'missing' || status === 'unsupported' || status === 'failed') {
      failMissingTsLoader(schemaFile, status);
    }
  }

  try {
    const fileUrl = pathToFileURL(absPath).href;
    const mod = await import(fileUrl);
    // Unwrap the same CJS-interop double-wrapped default that bites config files
    // in a "type": "commonjs" project under the tsx loader (see
    // unwrapModuleDefault). Without this, `mod.default ?? mod` reads
    // `{ default: schemaDef }` and `.tables` is undefined.
    const schema = unwrapModuleDefault(mod) as SchemaDef | undefined;
    if (!schema?.tables) {
      error('Schema file must export a SchemaDef with a "tables" property.');
      process.exit(1);
    }
    return schema;
  } catch (err) {
    error(`Failed to load schema file: ${schemaFile}`);
    if (err instanceof Error) {
      console.log(`  ${dim(err.message)}`);
      // If the error is the classic ERR_UNKNOWN_FILE_EXTENSION, give a hint.
      if (err.message.includes('ERR_UNKNOWN_FILE_EXTENSION') || err.message.includes('Unknown file extension')) {
        newline();
        console.log(
          `  ${dim('Hint: install')} ${cyan('tsx')} ${dim('to load .ts files:')} ${cyan('npm install --save-dev tsx')}`,
        );
      }
      printCjsHintIfApplicable(err);
    }
    process.exit(1);
  }
}

/**
 * When a config/schema import blows up with the CommonJS-vs-ESM interop error
 * (`Cannot require() ES Module` / `ERR_REQUIRE_ESM`), the root cause is almost
 * always a project whose `package.json` lacks `"type": "module"`: tsx transpiles
 * the `.ts` file to CJS and then can't `require()` Turbine's ESM build. Point the
 * user at the one-line fix instead of leaving them with a raw Node stack trace.
 */
function printCjsHintIfApplicable(err: Error): void {
  const msg = err.message;
  if (
    msg.includes('ERR_REQUIRE_ESM') ||
    msg.includes('require() of ES Module') ||
    msg.includes('Cannot require() ES Module')
  ) {
    newline();
    console.log(
      `  ${dim('Hint: add')} ${cyan('"type": "module"')} ${dim('to your')} ${cyan('package.json')}${dim('.')}`,
    );
    console.log(
      `  ${dim('Turbine is an ESM package; without it, Node/tsx tries to')} ${cyan('require()')} ${dim('it and fails.')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// .env loading (CLI-only: the library never reads .env files)
// ---------------------------------------------------------------------------

/** Where a resolved `DATABASE_URL` came from, after the `.env` load. */
export type DotEnvProvenance = 'shell' | 'dotenv' | 'none';

/** Structured outcome of {@link loadDotEnvForCli}. */
export interface DotEnvLoadResult {
  /** A `.env` file was present in the working directory. */
  fileExists: boolean;
  /** The `.env` was actually read into the environment. */
  loaded: boolean;
  /** A `.env` exists but this runtime cannot auto-load it (Node < 20.12). */
  unsupported: boolean;
  /** Where `DATABASE_URL` ended up coming from once the load settled. */
  databaseUrlProvenance: DotEnvProvenance;
  /** Set when the loader threw (e.g. EACCES / a directory named `.env`). */
  loadError?: string;
}

/**
 * Load a local `.env` into `process.env` for the CLI, mirroring what
 * `node --env-file=.env` does. Loaded UNCONDITIONALLY when a `.env` is present,
 * so every variable it defines (not just `DATABASE_URL`) reaches the config
 * file and user scripts.
 *
 * A pre-existing variable ALWAYS wins: `process.loadEnvFile()` never overrides
 * an already-set variable, so a real shell/CI `DATABASE_URL` beats the file.
 * Provenance is tracked so callers can warn when an `.env`-sourced
 * `DATABASE_URL` silently overrides a differing `url` in `turbine.config.ts`:
 * `DATABASE_URL` is `'dotenv'`-sourced only when it was absent before the load
 * and present after.
 *
 * `process.loadEnvFile` is Node 20.12+. Turbine's engines allow `>=20.0.0`, so
 * on older runtimes this no-ops with `unsupported: true` (never throws). A
 * loader that throws (unreadable file, a directory named `.env`) is caught and
 * surfaced as `loadError`, never a raw unhandled rejection. Deliberately
 * CLI-only: the library must never read files.
 *
 * Dependencies are injectable purely so this is unit-testable without mutating
 * the real process environment.
 */
export function loadDotEnvForCli(
  deps: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    fileExists?: (path: string) => boolean;
    loadEnvFile?: ((path: string) => void) | null;
  } = {},
): DotEnvLoadResult {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const fileExists = deps.fileExists ?? existsSync;
  const envPath = join(cwd, '.env');

  const hadUrlBefore = Boolean(env.DATABASE_URL);
  const shellOrNone: DotEnvProvenance = hadUrlBefore ? 'shell' : 'none';

  if (!fileExists(envPath)) {
    return { fileExists: false, loaded: false, unsupported: false, databaseUrlProvenance: shellOrNone };
  }

  const loader =
    deps.loadEnvFile !== undefined
      ? deps.loadEnvFile
      : typeof process.loadEnvFile === 'function'
        ? process.loadEnvFile.bind(process)
        : null;
  if (!loader) {
    return { fileExists: true, loaded: false, unsupported: true, databaseUrlProvenance: shellOrNone };
  }

  try {
    loader(envPath);
  } catch (err) {
    return {
      fileExists: true,
      loaded: false,
      unsupported: false,
      databaseUrlProvenance: shellOrNone,
      loadError: err instanceof Error ? err.message : String(err),
    };
  }

  // `.env`-sourced only if DATABASE_URL was absent before and present after.
  const provenance: DotEnvProvenance = hadUrlBefore ? 'shell' : env.DATABASE_URL ? 'dotenv' : 'none';
  return { fileExists: true, loaded: true, unsupported: false, databaseUrlProvenance: provenance };
}

/**
 * Decide whether to warn that an `.env`-sourced `DATABASE_URL` is overriding a
 * differing, non-empty `url` in the config file. Pure so it is unit-testable.
 *
 * Precedence is unchanged (`.env` `DATABASE_URL` still wins), this only decides
 * whether that override is silent or loud. We warn ONLY when all hold:
 *   - no CLI `--url` override (an explicit override is the user's clear intent),
 *   - `DATABASE_URL` came from `.env` (shell-exported stays silent, as before),
 *   - the config file has a non-empty `url`, and
 *   - the two URLs actually differ.
 *
 * Returns the warning message (URLs redacted), or `null` for no warning.
 */
export function dotEnvUrlConflictWarning(input: {
  provenance: DotEnvProvenance;
  envUrl: string | undefined;
  fileConfigUrl: string | undefined;
  overrideUrl: string | undefined;
}): string | null {
  if (input.overrideUrl) return null;
  if (input.provenance !== 'dotenv') return null;
  const fileUrl = input.fileConfigUrl?.trim();
  if (!fileUrl) return null;
  if (!input.envUrl) return null;
  if (fileUrl === input.envUrl) return null;
  return (
    `DATABASE_URL from .env (${redactUrl(input.envUrl)}) is overriding the url in your config file ` +
    `(${redactUrl(fileUrl)}). Using the .env value. Remove DATABASE_URL from .env, or unset the config url, ` +
    `to silence this.`
  );
}

/** Package managers we can name an exact install command for. */
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/**
 * Detect the consumer's package manager from its lockfile, defaulting to npm.
 * Used only to print an exact, copy-pasteable install command.
 *
 * @internal exported for tests.
 */
export function detectPackageManager(cwd = process.cwd()): PackageManager {
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(cwd, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(cwd, 'bun.lockb')) || existsSync(join(cwd, 'bun.lock'))) return 'bun';
  return 'npm';
}

/**
 * The exact "add tsx as a dev dependency" command for a package manager.
 *
 * @internal exported for tests.
 */
export function tsxInstallCommand(pm: PackageManager): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm add -D tsx';
    case 'yarn':
      return 'yarn add -D tsx';
    case 'bun':
      return 'bun add -d tsx';
    default:
      return 'npm install --save-dev tsx';
  }
}

/**
 * The heads-up `turbine init` prints when it has just scaffolded TypeScript
 * files and `tsx` is not resolvable: without it the CLI cannot load them, and
 * the very next command the user runs dies on "Cannot load TypeScript file".
 * Pure (returns the lines, prints nothing) so it can be asserted in tests.
 *
 * @internal exported for tests.
 */
export function tsxRequiredNotice(tsFiles: string[], installCommand: string): string[] {
  return [
    `Turbine needs ${cyan('tsx')} to load the TypeScript files just created:`,
    ...tsFiles.map((f) => `    ${dim(symbols.dot)} ${cyan(f)}`),
    '',
    `  ${dim('Install it as a dev dependency:')}`,
    `    ${cyan(installCommand)}`,
    '',
    `  ${dim('Without it, the next Turbine command fails with')} ${dim('"Cannot load TypeScript file".')}`,
  ];
}

/**
 * Read the consumer's `package.json` `"type"` field. Returns `'module'` for an
 * ESM project, `'commonjs'` for an explicit or absent (defaulted) CommonJS
 * project, and `'none'` when there is no readable/parseable package.json.
 */
export function detectConsumerModuleType(cwd = process.cwd()): 'module' | 'commonjs' | 'none' {
  const pkgPath = join(cwd, 'package.json');
  if (!existsSync(pkgPath)) return 'none';
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { type?: unknown };
    return pkg.type === 'module' ? 'module' : 'commonjs';
  } catch {
    return 'none';
  }
}

// ---------------------------------------------------------------------------
// Command: init: sequenced, interactive project bootstrap
// ---------------------------------------------------------------------------

/** A single step in the `turbine init` flow. */
export type InitStepId = 'config' | 'schema' | 'seed-file' | 'push' | 'generate' | 'seed-run';

/** What the planner decided to do with a step. */
export type InitStepAction = 'run' | 'prompt' | 'skip';

/** Why a step was skipped (only set when `action` is `skip`). */
export type InitStepSkipReason =
  | 'exists'
  | 'flag'
  | 'no-url'
  | 'unreachable'
  | 'no-seed-file'
  | 'non-interactive'
  | 'default-no';

export interface InitPlanStep {
  id: InitStepId;
  action: InitStepAction;
  /** Prompt default; also the value used to decide auto-run under `--yes`. */
  defaultYes: boolean;
  skipReason?: InitStepSkipReason;
}

/** Detected project state (all IO done by the caller). */
export interface InitPlanState {
  configExists: boolean;
  schemaExists: boolean;
  seedFileExists: boolean;
  hasUrl: boolean;
  dbReachable: boolean;
}

/** Effective flags for the planner. */
export interface InitPlanFlags {
  yes: boolean;
  force: boolean;
  interactive: boolean;
  skipSchema: boolean;
  skipSeed: boolean;
  skipPush: boolean;
  skipGenerate: boolean;
}

/**
 * Pure step planner for `turbine init`. Given the detected project state and the
 * effective flags, decide for each step whether to run it, prompt for it, or
 * skip it (and why). No IO: every input is precomputed by the caller: so the
 * whole decision matrix is unit-testable without a TTY or a database.
 *
 * Three modes:
 *  - `prompt`      (interactive TTY, no `--yes`): scaffold + DB steps are prompted.
 *  - `auto-yes`    (`--yes`): accept each step's default; the yes-defaults run.
 *  - `auto-legacy` (non-TTY, no `--yes`): reproduce the pre-existing init
 *    behavior. Scaffold files + generate run; push + seed-run do not.
 *
 * Steps that create files (config, schema, seed) are skipped when the file
 * already exists, so re-runs are safe. DB steps (push, generate, seed-run) are
 * skipped when there is no URL or the database is unreachable.
 */
export function planInitSteps(state: InitPlanState, flags: InitPlanFlags): InitPlanStep[] {
  const mode: 'prompt' | 'auto-yes' | 'auto-legacy' =
    flags.interactive && !flags.yes ? 'prompt' : flags.yes ? 'auto-yes' : 'auto-legacy';

  const steps: InitPlanStep[] = [];

  // config: core scaffold, never prompted.
  steps.push(
    state.configExists && !flags.force
      ? { id: 'config', action: 'skip', defaultYes: true, skipReason: 'exists' }
      : { id: 'config', action: 'run', defaultYes: true },
  );

  // Scaffold files (schema, seed): created by default; prompted interactively.
  const scaffold = (id: InitStepId, exists: boolean, skipFlag: boolean): InitPlanStep => {
    if (skipFlag) return { id, action: 'skip', defaultYes: true, skipReason: 'flag' };
    if (exists) return { id, action: 'skip', defaultYes: true, skipReason: 'exists' };
    return { id, action: mode === 'prompt' ? 'prompt' : 'run', defaultYes: true };
  };
  steps.push(scaffold('schema', state.schemaExists, flags.skipSchema));
  steps.push(scaffold('seed-file', state.seedFileExists, flags.skipSeed));

  // seed-run needs a seed file: either one that already exists, or one this run
  // is about to create.
  const seedWillExist = state.seedFileExists || steps.find((s) => s.id === 'seed-file')?.action !== 'skip';

  // DB steps: need a reachable database.
  const dbStep = (
    id: InitStepId,
    skipFlag: boolean,
    opts: { legacyRun: boolean; defaultYes: boolean; extraSkip?: InitStepSkipReason },
  ): InitPlanStep => {
    const { defaultYes } = opts;
    if (skipFlag) return { id, action: 'skip', defaultYes, skipReason: 'flag' };
    if (!state.hasUrl) return { id, action: 'skip', defaultYes, skipReason: 'no-url' };
    if (!state.dbReachable) return { id, action: 'skip', defaultYes, skipReason: 'unreachable' };
    if (opts.extraSkip) return { id, action: 'skip', defaultYes, skipReason: opts.extraSkip };
    if (mode === 'prompt') return { id, action: 'prompt', defaultYes };
    if (mode === 'auto-yes') {
      return defaultYes
        ? { id, action: 'run', defaultYes }
        : { id, action: 'skip', defaultYes, skipReason: 'default-no' };
    }
    // auto-legacy
    return opts.legacyRun
      ? { id, action: 'run', defaultYes }
      : { id, action: 'skip', defaultYes, skipReason: 'non-interactive' };
  };

  steps.push(dbStep('push', flags.skipPush, { legacyRun: false, defaultYes: true }));
  steps.push(dbStep('generate', flags.skipGenerate, { legacyRun: true, defaultYes: true }));
  steps.push(
    dbStep('seed-run', flags.skipSeed, {
      legacyRun: false,
      defaultYes: false,
      extraSkip: seedWillExist ? undefined : 'no-seed-file',
    }),
  );

  return steps;
}

/** Prompt for a yes/no answer on an interactive TTY. */
async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const raw = (await rl.question(`  ${question} ${dim(suffix)} `)).trim().toLowerCase();
    if (raw === '') return defaultYes;
    return raw === 'y' || raw === 'yes';
  } finally {
    rl.close();
  }
}

/** Probe database reachability with a short-lived connection. Never throws. */
async function probeDatabase(url: string): Promise<boolean> {
  try {
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    await client.end();
    return true;
  } catch {
    return false;
  }
}

const INIT_SEED_TEMPLATE = `/**
 * Turbine seed file
 *
 * Run with: npx turbine seed
 */

import { defineSeed } from 'turbine-orm';

export default defineSeed(async (db) => {
  console.log('Seeding database...');

  // Add your seed data here:
  // await db.raw\`INSERT INTO users (email, name) VALUES (\${'admin@example.com'}, \${'Admin'})\`;

  console.log('Done!');
});
`;

const INIT_SCHEMA_TEMPLATE = `/**
 * Turbine schema definition
 *
 * Define your database schema in TypeScript.
 * Use \`npx turbine push\` to sync it to your database.
 *
 * @see https://turbineorm.dev
 */

import { defineSchema } from 'turbine-orm';

export default defineSchema({
  // Example:
  // users: {
  //   id: { type: 'serial', primaryKey: true },
  //   email: { type: 'text', notNull: true, unique: true },
  //   name: { type: 'text', notNull: true },
  //   created_at: { type: 'timestamp', default: 'NOW()' },
  // },
});
`;

/** Create supporting directories + .gitignore entries (unconditional, unprompted). */
function ensureInitScaffoldDirs(config: ResolvedConfig): void {
  const migrDir = config.migrationsDir;
  if (!existsSync(migrDir)) {
    mkdirSync(migrDir, { recursive: true });
    writeFileSync(`${migrDir}/.gitkeep`, '', 'utf-8');
    success(`Created ${cyan(`${migrDir}/`)}`);
  }

  if (!existsSync(config.out)) {
    mkdirSync(config.out, { recursive: true });
    success(`Created ${cyan(`${config.out}/`)}`);
  }

  const gitignorePath = '.gitignore';
  if (existsSync(gitignorePath)) {
    const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
    const additions: string[] = [];
    if (!gitignoreContent.includes('generated/turbine')) additions.push('generated/turbine/');
    if (!gitignoreContent.includes('turbine.config.ts')) additions.push('turbine.config.ts');
    if (additions.length > 0) {
      appendFileSync(gitignorePath, `\n# Turbine generated client & config\n${additions.join('\n')}\n`);
      success(`Added ${cyan(additions.join(', '))} to ${cyan('.gitignore')}`);
    }
  }
}

function writeInitSchemaTemplate(config: ResolvedConfig): void {
  const schemaDir = dirname(config.schemaFile);
  if (schemaDir && !existsSync(schemaDir)) mkdirSync(schemaDir, { recursive: true });
  writeFileSync(config.schemaFile, INIT_SCHEMA_TEMPLATE, 'utf-8');
  success(`Created ${cyan(config.schemaFile)}`);
}

function writeInitSeedTemplate(seedFilePath: string): void {
  const seedDir = dirname(seedFilePath);
  if (seedDir && !existsSync(seedDir)) mkdirSync(seedDir, { recursive: true });
  writeFileSync(seedFilePath, INIT_SEED_TEMPLATE, 'utf-8');
  success(`Created ${cyan(seedFilePath)}`);
}

/** Push the code-first schema to the database, preserving the destructive typed confirm. */
async function runInitPush(config: ResolvedConfig, url: string): Promise<void> {
  if (!existsSync(config.schemaFile)) {
    warn(`No schema file at ${cyan(config.schemaFile)}: skipping push.`);
    return;
  }
  const schemaDef = await loadSchemaFile(config.schemaFile);
  const spinner = new Spinner('Computing schema diff').start();
  const diff = await schemaDiff(schemaDef, url);
  if (diff.statements.length === 0) {
    spinner.succeed('Database already in sync: nothing to push');
    return;
  }
  spinner.succeed(`Found ${bold(String(diff.statements.length))} change(s) to apply`);

  const pushSpinner = new Spinner('Applying schema').start();
  try {
    const result = await schemaPush(schemaDef, url, { precomputedDiff: diff });
    pushSpinner.succeed(`Applied ${bold(String(result.statementsExecuted))} statement(s)`);
  } catch (err) {
    if (!(err instanceof DestructivePushRefusal)) throw err;
    pushSpinner.stop();
    if (!(await confirmDestructive(err.message))) {
      warn('Push aborted: no schema changes were applied.');
      return;
    }
    const result = await schemaPush(schemaDef, url, { allowDestructive: true, precomputedDiff: diff });
    success(`Applied ${bold(String(result.statementsExecuted))} statement(s)`);
  }
}

/** Introspect the database and generate the typed client. */
async function runInitGenerate(config: ResolvedConfig, url: string): Promise<void> {
  const spinner = new Spinner('Introspecting database').start();
  try {
    const schema = await introspect({
      connectionString: url,
      schema: config.schema,
      include: config.include.length ? config.include : undefined,
      exclude: config.exclude.length ? config.exclude : undefined,
      relationNames: config.relationNames,
    });
    spinner.succeed(`Found ${bold(String(Object.keys(schema.tables).length))} tables`);

    const genSpinner = new Spinner('Generating TypeScript client').start();
    const result = generate({ schema, outDir: config.out, connectionString: url });
    genSpinner.succeed(`Generated ${bold(String(result.files.length))} files to ${cyan(`${config.out}/`)}`);
  } catch (err) {
    spinner.fail('Could not generate client');
    if (err instanceof Error) console.log(`  ${dim(redactUrl(err.message))}`);
    info(`Run generation later with: ${cyan('npx turbine generate')}`);
  }
}

/** Run the seed file. */
async function runInitSeed(config: ResolvedConfig): Promise<void> {
  const seedFile = resolveSeedFile(config);
  if (!seedFile || !existsSync(seedFile)) {
    warn('No seed file found: skipping seed run.');
    return;
  }
  const spinner = new Spinner('Running seed file').start();
  try {
    await runSeedPlan(getSeedExecutionPlan(seedFile), config);
    spinner.succeed('Seed completed');
  } catch (err) {
    spinner.fail('Seed failed');
    if (err instanceof Error) console.log(`  ${dim(redactUrl(err.message))}`);
  }
}

/** Human label for a step, used in prompts and skip messages. */
function initStepLabel(id: InitStepId): string {
  switch (id) {
    case 'config':
      return 'config file';
    case 'schema':
      return 'schema file';
    case 'seed-file':
      return 'seed file';
    case 'push':
      return 'schema push';
    case 'generate':
      return 'client generation';
    case 'seed-run':
      return 'seed run';
  }
}

/** Report a skipped step with its reason. Existence skips are the quiet common case. */
function reportInitSkip(step: InitPlanStep): void {
  const label = initStepLabel(step.id);
  switch (step.skipReason) {
    case 'exists':
      info(`${label} already exists ${dim('- skipped')}`);
      break;
    case 'flag':
      console.log(`  ${dim(`${symbols.dot} ${label} skipped (flag)`)}`);
      break;
    case 'no-url':
      console.log(`  ${dim(`${symbols.dot} ${label} skipped (no database URL)`)}`);
      break;
    case 'unreachable':
      console.log(`  ${dim(`${symbols.dot} ${label} skipped (database unreachable)`)}`);
      break;
    case 'no-seed-file':
      console.log(`  ${dim(`${symbols.dot} ${label} skipped (no seed file)`)}`);
      break;
    case 'non-interactive':
      console.log(`  ${dim(`${symbols.dot} ${label} skipped (non-interactive: pass --yes to run it)`)}`);
      break;
    case 'default-no':
      console.log(`  ${dim(`${symbols.dot} ${label} skipped (default no)`)}`);
      break;
    default:
      console.log(`  ${dim(`${symbols.dot} ${label} skipped`)}`);
  }
}

/** The interactive prompt question for a promptable step. */
function initPromptQuestion(step: InitPlanStep, config: ResolvedConfig, seedFilePath: string): string {
  switch (step.id) {
    case 'schema':
      return `Create a starter schema file (${config.schemaFile})?`;
    case 'seed-file':
      return `Create a starter seed file (${seedFilePath})?`;
    case 'push':
      return 'Push your schema to the database now?';
    case 'generate':
      return 'Generate the typed client from the database now?';
    case 'seed-run':
      return 'Run the seed file now?';
    default:
      return `Run ${initStepLabel(step.id)}?`;
  }
}

/**
 * The one-line connection heads-up `turbine init` opens with.
 *
 * @internal exported for tests.
 */
export interface InitEnvNotice {
  kind: 'success' | 'info';
  message: string;
}

/**
 * Decide which connection notice `turbine init` prints. Pure so the whole
 * decision matrix is testable.
 *
 * "No DATABASE_URL found in environment" is reserved for the case where NO
 * source supplied one: printing it while happily using `--url` (or a config
 * `url`) reads like a failure the user then goes looking for.
 *
 * @internal exported for tests.
 */
export function initEnvNotice(input: {
  envUrl: string | undefined;
  hasEnvFile: boolean;
  hasEnvLocal: boolean;
  canAutoLoadEnv: boolean;
  flagUrl: string | undefined;
  configUrl: string | undefined;
}): InitEnvNotice {
  if (input.envUrl) {
    return { kind: 'success', message: `Detected ${cyan('DATABASE_URL')} in the environment` };
  }
  if (input.hasEnvFile && !input.canAutoLoadEnv) {
    return {
      kind: 'info',
      message: `Found ${cyan('.env')} ${dim('(this Node version cannot auto-load it. Upgrade to Node 20.12+ or export')} ${cyan('DATABASE_URL')}${dim(')')}`,
    };
  }
  if (input.hasEnvFile) {
    // .env exists but did not provide DATABASE_URL; if it had, the auto-load
    // in main() would have populated envUrl above.
    return {
      kind: 'info',
      message: `Found ${cyan('.env')} ${dim('(no')} ${cyan('DATABASE_URL')} ${dim('set in it yet)')}`,
    };
  }
  if (input.hasEnvLocal) {
    return {
      kind: 'info',
      message: `Found ${cyan('.env.local')} ${dim('(note: Turbine only auto-loads')} ${cyan('.env')}${dim(')')}`,
    };
  }
  if (input.flagUrl) {
    return { kind: 'success', message: `Using the connection string passed with ${cyan('--url')}` };
  }
  if (input.configUrl) {
    return { kind: 'success', message: `Using the ${cyan('url')} from your config file` };
  }
  return { kind: 'info', message: `No ${cyan('DATABASE_URL')} found in environment` };
}

async function cmdInit(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  header('Initializing Turbine project');

  // Detect environment. main() has already auto-loaded a local `.env` into
  // process.env (when DATABASE_URL was not otherwise set), so these messages
  // describe the real, post-load state, no more "if set" hand-waving.
  const envUrl = process.env.DATABASE_URL;
  const hasEnvFile = existsSync('.env');
  const hasEnvLocal = existsSync('.env.local');
  // On Node < 20.12 (no process.loadEnvFile) main() could not auto-load .env, so
  // we cannot claim it "has no DATABASE_URL"; we simply could not read it.
  const canAutoLoadEnv = typeof process.loadEnvFile === 'function';

  const envNotice = initEnvNotice({
    envUrl,
    hasEnvFile,
    hasEnvLocal,
    canAutoLoadEnv,
    flagUrl: args.url,
    configUrl: config.url,
  });
  if (envNotice.kind === 'success') success(envNotice.message);
  else info(envNotice.message);
  newline();

  // Heads-up (not an edit) about the consumer's module system. A CommonJS
  // project (`npm init -y` default, or no "type" field) works fine now that the
  // config loader unwraps the CJS-interop double-wrapped default, but ESM is the
  // smoother path for a TypeScript config file.
  const moduleType = detectConsumerModuleType();
  if (moduleType === 'commonjs') {
    info(`Your ${cyan('package.json')} is a CommonJS project ${dim('(no')} ${cyan('"type": "module"')}${dim(').')}`);
    console.log(
      `  ${dim('Turbine works either way. For the smoothest TypeScript config experience, consider adding')} ${cyan('"type": "module"')}${dim('.')}`,
    );
    newline();
  }

  // Resolve the effective URL and detect current project state.
  const url = args.url ?? envUrl ?? config.url;
  const hasUrl = Boolean(url);
  const interactive = Boolean(process.stdin.isTTY);
  const yes = args.yes === true;
  // Where init scaffolds the seed file. A root-level ./seed.ts from an older
  // init still counts, so a re-run never scaffolds a second seed file.
  const seedFilePath = config.seedFile ?? (existsSync('./seed.ts') ? './seed.ts' : DEFAULT_INIT_SEED_FILE);
  const configPath = findConfigFile();

  const state: InitPlanState = {
    configExists: Boolean(configPath),
    schemaExists: existsSync(config.schemaFile),
    seedFileExists: existsSync(seedFilePath),
    hasUrl,
    dbReachable: false,
  };

  // Probe the database once, up front, so the planner can decide the DB steps.
  // Skip the probe entirely when every DB step is already flag-skipped.
  const anyDbStepPossible = !(args.skipPush && args.skipGenerate && args.skipSeed);
  if (hasUrl && anyDbStepPossible) {
    const probe = new Spinner('Checking database connection').start();
    state.dbReachable = await probeDatabase(url);
    if (state.dbReachable) probe.succeed('Database is reachable');
    else probe.info('Database not reachable: push / generate / seed steps will be skipped');
  }

  const flags: InitPlanFlags = {
    yes,
    force: args.force === true,
    interactive,
    skipSchema: args.skipSchema === true,
    skipSeed: args.skipSeed === true,
    skipPush: args.skipPush === true,
    skipGenerate: args.skipGenerate === true,
  };
  const plan = planInitSteps(state, flags);
  const degraded = !interactive && !yes;

  // Supporting dirs + .gitignore, regardless of prompts (unchanged behavior).
  ensureInitScaffoldDirs(config);
  newline();

  // TypeScript files this run actually created: they drive the tsx heads-up below.
  const tsFilesWritten: string[] = [];

  // Execute the plan in order. `run` proceeds; `prompt` asks; `skip` reports.
  for (const step of plan) {
    if (step.action === 'skip') {
      reportInitSkip(step);
      continue;
    }
    const shouldRun =
      step.action === 'run' ? true : await promptYesNo(initPromptQuestion(step, config, seedFilePath), step.defaultYes);
    if (!shouldRun) {
      info(`Skipped ${initStepLabel(step.id)}`);
      continue;
    }

    switch (step.id) {
      case 'config':
        writeFileSync('turbine.config.ts', configTemplate(args.url ?? undefined), 'utf-8');
        success(state.configExists ? `Overwrote ${cyan('turbine.config.ts')}` : `Created ${cyan('turbine.config.ts')}`);
        tsFilesWritten.push('turbine.config.ts');
        break;
      case 'schema':
        writeInitSchemaTemplate(config);
        if (needsTsLoader(config.schemaFile)) tsFilesWritten.push(config.schemaFile);
        break;
      case 'seed-file':
        writeInitSeedTemplate(seedFilePath);
        if (needsTsLoader(seedFilePath)) tsFilesWritten.push(seedFilePath);
        break;
      case 'push':
        await runInitPush(config, url);
        break;
      case 'generate':
        await runInitGenerate(config, url);
        break;
      case 'seed-run':
        await runInitSeed(config);
        break;
    }
  }

  // Scaffolding .ts files and staying silent about tsx is how a fresh project
  // hits "Cannot load TypeScript file" on its very next command. Warn now, name
  // the exact install command, and never install anything ourselves.
  const tsxMissing = tsFilesWritten.length > 0 && !canResolveTsx();
  if (tsxMissing) {
    newline();
    const [headline, ...rest] = tsxRequiredNotice(tsFilesWritten, tsxInstallCommand(detectPackageManager()));
    warn(headline ?? '');
    for (const line of rest) console.log(line);
  }

  if (degraded) {
    newline();
    info('Non-interactive shell: interactive prompts were skipped.');
    console.log(
      `  ${dim('Re-run in a terminal, pass')} ${cyan('--yes')} ${dim('to accept defaults, or use')} ${cyan('--skip-*')} ${dim('flags to control each step.')}`,
    );
  }

  // Next steps
  newline();
  divider();
  newline();
  console.log(`  ${bold('Next steps:')}`);
  newline();

  if (!url) {
    console.log(`  ${dim('1.')} Set your database URL in ${cyan('turbine.config.ts')}`);
    if (!hasEnvFile && !hasEnvLocal) {
      console.log(
        `     ${dim('or create a')} ${cyan('.env')} ${dim('file with')} ${cyan('DATABASE_URL=postgres://...')}`,
      );
    }
    console.log(`  ${dim('2.')} Run ${cyan('npx turbine generate')} to introspect your DB`);
    // Only when the fuller heads-up above did not already run (nothing scaffolded).
    if (!tsxMissing && !canResolveTsx()) {
      console.log(
        `     ${dim('Note: the TypeScript config requires')} ${cyan('tsx')}: ${cyan(tsxInstallCommand(detectPackageManager()))}`,
      );
    }
  } else {
    console.log(`  ${dim('1.')} Import the generated client:`);
    console.log(`     ${cyan(`import { turbine } from './${config.out.replace('./', '')}';`)}`);
    newline();
    console.log(`  ${dim('2.')} Create a connection and query:`);
    console.log(`     ${dim('const db = turbine();')}`);
    console.log(`     ${dim('const users = await db.users.findMany();')}`);
  }

  newline();
  console.log(`  ${dim('3.')} Create migrations: ${cyan('npx turbine migrate create <name>')}`);
  console.log(`  ${dim('4.')} Run migrations:    ${cyan('npx turbine migrate up')}`);
  console.log(`  ${dim('5.')} Seed your database: ${cyan('npx turbine seed')}`);
  newline();
}

// ---------------------------------------------------------------------------
// Command: generate (pull)
// ---------------------------------------------------------------------------

async function cmdGenerate(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);
  const startTime = performance.now();

  // Guard: `schema` is the Postgres NAMESPACE to introspect (default `public`),
  // NOT the path to your schema-builder file, that goes in `schemaFile`. If the
  // configured `schema` looks like a file path, introspection would silently
  // match zero tables and emit an empty client. Fail loudly instead.
  if (!args.allowEmpty && looksLikeSchemaFilePath(config.schema)) {
    error(`The "schema" option looks like a file path: ${cyan(config.schema)}`);
    newline();
    console.log(
      `  ${dim('"schema" is the Postgres schema NAME to introspect')} ${dim('(default:')} ${cyan('public')}${dim(').')}`,
    );
    console.log(`  ${dim('The path to your defineSchema() file belongs in')} ${cyan('schemaFile')}${dim('.')}`);
    newline();
    console.log(`  ${dim('Fix your')} ${cyan('turbine.config.ts')}${dim(':')}`);
    console.log(
      `    ${green('schema:')} ${cyan("'public'")}${dim(",       // or omit, introspects the 'public' schema")}`,
    );
    console.log(
      `    ${green('schemaFile:')} ${cyan(`'${config.schema}'`)}${dim(', // your defineSchema() file (used by `turbine push`)')}`,
    );
    newline();
    console.log(
      `  ${dim('Re-run with')} ${cyan('--allow-empty')} ${dim('to introspect this literal schema name anyway.')}`,
    );
    newline();
    process.exit(1);
  }

  label('Database', redactUrl(url));
  label('Schema', config.schema);
  label('Output', config.out);
  newline();

  // Introspect
  const spinner = new Spinner('Introspecting database schema').start();

  const skippedInternalTables: string[] = [];
  const schema = await introspect({
    connectionString: url,
    schema: config.schema,
    include: config.include.length ? config.include : undefined,
    exclude: config.exclude.length ? config.exclude : undefined,
    relationNames: config.relationNames,
    includeViews: args.includeViews,
    legacyToManyUniques: config.legacyToManyUniques,
    onDefaultTableExclusion: (tables) => skippedInternalTables.push(...tables),
  });

  const tableNames = Object.keys(schema.tables);
  const totalColumns = Object.values(schema.tables).reduce((sum, t) => sum + t.columns.length, 0);
  const totalRelations = Object.values(schema.tables).reduce((sum, t) => sum + Object.keys(t.relations).length, 0);

  spinner.succeed(
    `Found ${bold(String(tableNames.length))} tables, ${bold(String(totalColumns))} columns, ${bold(String(totalRelations))} relations`,
  );

  // F12: make the default bookkeeping-table exclusions discoverable rather than
  // silent. `include` re-adds any of them byte-for-byte.
  for (const t of skippedInternalTables) {
    console.log(`    ${dim(`${symbols.teeEnd} skipped internal table ${t} (add it to include to keep it)`)}`);
  }

  // Guard: zero tables means the generated client would be empty. That is almost
  // always a misconfiguration (wrong `schema`, an include/exclude that filtered
  // everything, or a database with no tables yet) rather than intent. Fail loudly
  // instead of silently emitting an empty typed client.
  if (tableNames.length === 0 && !args.allowEmpty) {
    newline();
    error(`Introspection matched 0 tables in schema ${cyan(config.schema)}, refusing to generate an empty client.`);
    newline();
    console.log(`  ${dim('Common causes:')}`);
    console.log(
      `    ${dim('•')} ${cyan('schema')} ${dim('points at the wrong Postgres namespace')} ${dim('(it is the schema NAME, default')} ${cyan('public')}${dim(').')}`,
    );
    console.log(
      `    ${dim('•')} ${dim('You meant to set')} ${cyan('schemaFile')} ${dim('(your defineSchema() file), not')} ${cyan('schema')}${dim('.')}`,
    );
    console.log(`    ${dim('•')} ${cyan('include')}/${cyan('exclude')} ${dim('filtered out every table.')}`);
    console.log(
      `    ${dim('•')} ${dim('The database has no tables yet, run')} ${cyan('turbine push')} ${dim('or a migration first.')}`,
    );
    newline();
    console.log(
      `  ${dim('If an empty client is genuinely what you want, re-run with')} ${cyan('--allow-empty')}${dim('.')}`,
    );
    newline();
    process.exit(1);
  }

  // Print table summary
  if (args.verbose) {
    newline();
    for (const tbl of Object.values(schema.tables)) {
      const relCount = Object.keys(tbl.relations).length;
      const pk = tbl.primaryKey.join(', ') || '(none)';
      console.log(
        `  ${symbols.tee} ${bold(tbl.name)} ${dim(`${tbl.columns.length} cols, PK: ${pk}`)}${relCount > 0 ? dim(`, ${relCount} rels`) : ''}`,
      );
    }
    newline();
  }

  if (Object.keys(schema.enums).length > 0) {
    info(`Enums: ${Object.keys(schema.enums).join(', ')}`);
  }

  // Generate
  const genSpinner = new Spinner('Generating TypeScript client').start();

  const result = generate({
    schema,
    outDir: config.out,
    connectionString: url,
    zod: args.zod,
    noTimestamp: args.noTimestamp,
    importExtension: config.importExtension,
    keepColumnNames: config.keepColumnNames,
  });

  genSpinner.succeed(`Generated ${bold(String(result.files.length))} files in ${elapsed(startTime)}`);

  // List files
  for (const file of result.files) {
    console.log(`    ${dim(symbols.teeEnd)} ${cyan(`${result.outDir}/${file}`)}`);
  }

  // Usage hint
  newline();
  divider();
  newline();
  console.log(`  ${bold('Usage:')}`);
  newline();
  console.log(`  ${cyan(`import { turbine } from './${config.out.replace('./', '')}';`)}`);
  console.log(`  ${dim('const db = turbine({ connectionString: process.env.DATABASE_URL });')}`);
  console.log(`  ${dim('const user = await db.users.findUnique({ where: { id: 1 } });')}`);
  newline();
}

// ---------------------------------------------------------------------------
// migrate-from-prisma
// ---------------------------------------------------------------------------

/**
 * `turbine migrate-from-prisma --schema prisma/schema.prisma` parses a Prisma
 * schema, resolve its models/fields/relations/compound-uniques against the live
 * database (unless `--no-db`), and emit (a) a Markdown resolution report and
 * (b) a typed `prisma-map.ts` name map next to the generated client.
 *
 * NOTE: within THIS command `--schema` names the Prisma schema FILE (not the
 * Postgres namespace, which the rest of the CLI's `--schema` means). The
 * Postgres namespace is `public` here; multi-schema (`@@schema`) is unsupported
 * in v1 and listed as a parser note in the report.
 */
/** Outcome of {@link resolveMigrateFromPrismaUrl}. */
export interface MigrateFromPrismaUrl {
  /** The connection string to use, or undefined when none could be found. */
  url?: string;
  /** Where it came from: the normal CLI resolution, or the Prisma datasource. */
  source: 'config' | 'datasource' | 'none';
  /** Datasource detail, set only when `source` is `'datasource'`. */
  datasource?: ResolvedPrismaDatasourceUrl;
  /** Datasource `env(...)` variable names that were declared but unset. */
  missingVariables: string[];
}

/**
 * Pick the connection string for `migrate-from-prisma`.
 *
 * `configUrl` is what {@link resolveConfig} already produced (`--url`, then
 * `DATABASE_URL`, then `turbine.config.ts`) and always wins: an explicit flag
 * must never be overridden by a value declared in someone else's schema file.
 * Only when that is empty do we fall back to the `datasource` block, which
 * removes the flag a project with a non-standard variable name would otherwise
 * pass on every run.
 */
export function resolveMigrateFromPrismaUrl(
  configUrl: string | undefined,
  ast: Pick<PrismaSchemaAst, 'datasources'>,
  env: Record<string, string | undefined>,
): MigrateFromPrismaUrl {
  const lookup = resolvePrismaDatasourceUrl(ast, env);
  if (configUrl) return { url: configUrl, source: 'config', missingVariables: lookup.missingVariables };
  if (lookup.resolved) {
    return {
      url: lookup.resolved.url,
      source: 'datasource',
      datasource: lookup.resolved,
      missingVariables: lookup.missingVariables,
    };
  }
  return { source: 'none', missingVariables: lookup.missingVariables };
}

async function cmdMigrateFromPrisma(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();

  // `--schema` is the Prisma schema file path in this command.
  const prismaPath = resolve(args.schema ?? 'prisma/schema.prisma');
  if (!existsSync(prismaPath)) {
    error(`Prisma schema file not found: ${cyan(prismaPath)}`);
    newline();
    console.log(
      `  ${dim('Point at it with')} ${cyan('--schema <path/to/schema.prisma>')} ${dim('(default: prisma/schema.prisma).')}`,
    );
    newline();
    process.exit(1);
  }

  // Parse (fatal only on a construct we must understand).
  const source = readFileSync(prismaPath, 'utf-8');
  let ast: ReturnType<typeof parsePrismaSchema>;
  try {
    ast = parsePrismaSchema(source);
  } catch (err) {
    if (err instanceof PrismaParseError) {
      newline();
      error(`Could not parse ${cyan(prismaPath)}`);
      console.log(`  ${red(err.message)}`);
      newline();
      process.exit(1);
    }
    throw err;
  }

  label('Prisma schema', prismaPath);
  label('Models', String(ast.models.length));
  label('Enums', String(ast.enums.length));

  // Resolve against the live database, unless --no-db (parse-only).
  let schemaMeta: Awaited<ReturnType<typeof introspect>> | null = null;
  let url: string | undefined;
  if (args.noDb) {
    info('Parse-only mode (--no-db): names will not be resolved.');
  } else {
    // The schema.prisma datasource is the LAST resort for the connection string,
    // below `--url`, `DATABASE_URL`, and `turbine.config.ts`.
    const resolvedUrl = resolveMigrateFromPrismaUrl(config.url, ast, process.env);
    if (resolvedUrl.source === 'datasource' && resolvedUrl.datasource) {
      const { variable, datasource: dsName, key } = resolvedUrl.datasource;
      const origin = variable ? `${cyan(variable)} via datasource "${dsName}"` : `datasource "${dsName}" ${key}`;
      info(`Using the connection string declared by your Prisma schema (${origin}).`);
    }
    url = resolvedUrl.url ?? requireUrl(config, { datasourceVars: resolvedUrl.missingVariables });
    label('Database', redactUrl(url));
    const spinner = new Spinner('Introspecting database schema').start();
    schemaMeta = await introspect({
      connectionString: url,
      // The Postgres NAMESPACE is fixed to `public` here (`--schema` names the
      // Prisma file, not the namespace).
      schema: 'public',
      // Prisma `view` models resolve against introspected views.
      includeViews: true,
      // Inherit the shared bookkeeping-table exclusions (Turbine + Prisma).
      exclude: [...new Set([...config.exclude, ...DEFAULT_EXCLUDED_TABLES])],
      relationNames: config.relationNames,
    });
    spinner.succeed(`Introspected ${bold(String(Object.keys(schemaMeta.tables).length))} tables`);
  }
  newline();

  // `--keep-column-names` makes the generated client key fields by raw DB column
  // names; resolve the name map against the same transformed schema so the
  // emitted PRISMA_MAP field values agree with the client (D).
  const result = resolvePrismaSchema(ast, schemaMeta, { keepColumnNames: config.keepColumnNames });

  // Console summary.
  header('Resolution');
  for (const line of summaryLines(result)) {
    const marker = line.includes('[UNRESOLVED]') ? red(symbols.cross) : green(symbols.check);
    console.log(`  ${marker} ${line}`);
  }
  newline();

  // Write outputs into the generate outDir.
  const outDir = resolve(config.out);
  const rel = relative(process.cwd(), outDir);
  if (rel.startsWith('..') || resolve(rel) !== outDir) {
    error(`Output directory must be within the project root. Got: ${config.out}`);
    newline();
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const reportPath = join(outDir, 'prisma-migration-report.md');
  writeFileSync(
    reportPath,
    formatPrismaReport(result, { schemaPath: prismaPath, noTimestamp: args.noTimestamp }),
    'utf-8',
  );
  console.log(`  ${dim(symbols.teeEnd)} ${cyan(reportPath)} ${dim('(report)')}`);

  if (!args.noDb && schemaMeta) {
    const mapPath = join(outDir, 'prisma-map.ts');
    writeFileSync(mapPath, generatePrismaMap(result.map, { noTimestamp: args.noTimestamp }), 'utf-8');
    console.log(`  ${dim(symbols.teeEnd)} ${cyan(mapPath)} ${dim('(typed name map)')}`);

    // Always emit the standard generated client alongside the report + name map.
    // It is built from the live introspected metadata, so unresolved Prisma
    // items never block it; a partially resolved run (--allow-partial) still
    // gets a working client (C). `--keep-column-names` flows through so the
    // client's field names match the name map (D).
    const gen = generate({
      schema: schemaMeta,
      outDir: config.out,
      connectionString: url,
      noTimestamp: args.noTimestamp,
      importExtension: config.importExtension,
      keepColumnNames: config.keepColumnNames,
    });
    for (const file of gen.files) {
      console.log(`  ${dim(symbols.teeEnd)} ${cyan(join(outDir, file))} ${dim('(client)')}`);
    }
  }
  newline();

  // Exit non-zero when anything is UNRESOLVED, unless --allow-partial.
  if (result.hasUnresolved && !args.allowPartial) {
    warn('Some items could not be resolved (see the report). Re-run with --allow-partial to accept a partial map.');
    newline();
    process.exit(1);
  }

  if (args.noDb) {
    info(`Parse-only report written. Re-run without ${cyan('--no-db')} against your database to resolve names.`);
  } else {
    success('Prisma name map generated.');
  }
  newline();
}

// ---------------------------------------------------------------------------
// Command: push
// ---------------------------------------------------------------------------

async function cmdPush(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);

  label('Database', redactUrl(url));
  label('Schema file', config.schemaFile);
  newline();

  const schemaDef = await loadSchemaFile(config.schemaFile);
  const tableCount = Object.keys(schemaDef.tables).length;
  info(`Schema defines ${bold(String(tableCount))} tables`);

  // Compute diff
  const diffSpinner = new Spinner('Computing schema diff').start();
  const diff = await schemaDiff(schemaDef, url);

  if (diff.statements.length === 0 && diff.drop.length === 0) {
    diffSpinner.succeed('Database is already in sync');
    newline();
    return;
  }

  diffSpinner.succeed('Found changes');
  newline();

  // Show what will happen
  if (diff.create.length > 0) {
    console.log(`  ${green('+ Create')} ${bold(String(diff.create.length))} table(s):`);
    for (const t of diff.create) {
      console.log(`    ${green(symbols.arrowRight)} ${t.name}`);
    }
    newline();
  }

  if (diff.alter.length > 0) {
    console.log(`  ${yellow('~ Alter')} ${bold(String(diff.alter.length))} table(s):`);
    for (const a of diff.alter) {
      console.log(`    ${yellow(symbols.arrowRight)} ${a.table}`);
      for (const col of a.columns) {
        const actionLabel =
          col.action === 'add'
            ? green('+ add')
            : col.action === 'drop'
              ? red('- drop')
              : yellow(`~ ${col.action.replace('_', ' ')}`);
        console.log(`      ${actionLabel} ${col.column}`);
      }
    }
    newline();
  }

  if (diff.drop.length > 0) {
    console.log(`  ${red('- Extra tables')} in database (not in schema):`);
    for (const t of diff.drop) {
      console.log(`    ${dim(symbols.arrowRight)} ${t} ${dim('(not dropped automatically)')}`);
    }
    newline();
  }

  // Show SQL
  if (diff.statements.length > 0) {
    console.log(`  ${bold('SQL to execute:')}`);
    newline();
    for (const stmt of diff.statements) {
      for (const line of stmt.split('\n')) {
        console.log(`  ${dim(symbols.vertLine)} ${cyan(line)}`);
      }
      console.log(`  ${dim(symbols.vertLine)}`);
    }
    newline();
  }

  // Surface any non-fatal diff warnings (e.g. undeclared DB indexes, enum
  // removals) the diff refuses to apply automatically.
  if (diff.warnings && diff.warnings.length > 0) {
    for (const w of diff.warnings) warn(w);
    newline();
  }

  if (args.dryRun) {
    info('Dry run, no changes applied.');
    newline();
    return;
  }

  if (args.allowDestructive) {
    warn('--allow-destructive is set: data-destroying schema changes WILL run.');
    newline();
  }

  // Execute (gated): schemaPush throws on destructive statements unless allowed.
  // Pass the diff computed above as `precomputedDiff` so schemaPush applies the
  // EXACT statements just displayed and confirmed, with no re-diff between confirm
  // and apply (the TOCTOU window where a concurrent schema change could alter
  // the applied set). Both the initial attempt and the post-confirmation retry
  // reuse `diff`, so the confirmed plan and the applied plan are identical.
  const pushSpinner = new Spinner('Applying changes').start();
  let result: Awaited<ReturnType<typeof schemaPush>>;
  try {
    result = await schemaPush(schemaDef, url, { allowDestructive: args.allowDestructive, precomputedDiff: diff });
  } catch (err) {
    if (!(err instanceof DestructivePushRefusal)) throw err;
    pushSpinner.stop();
    if (!(await confirmDestructive(err.message))) {
      error('Aborted: no changes were applied and no data was touched.');
      newline();
      process.exit(1);
    }
    pushSpinner.start();
    result = await schemaPush(schemaDef, url, { allowDestructive: true, precomputedDiff: diff });
  }
  pushSpinner.succeed(`Applied ${bold(String(result.statementsExecuted))} statement(s)`);

  if (result.tablesCreated.length > 0) {
    success(`Created: ${result.tablesCreated.join(', ')}`);
  }
  if (result.tablesAltered.length > 0) {
    success(`Altered: ${result.tablesAltered.join(', ')}`);
  }

  newline();
  info(`Run ${cyan('npx turbine generate')} to update your TypeScript types.`);
  newline();
}

// ---------------------------------------------------------------------------
// Command: migrate
// ---------------------------------------------------------------------------

async function cmdMigrate(args: CliArgs, config: ResolvedConfig): Promise<void> {
  const sub = args.subcommand;

  if (!sub || sub === 'help') {
    banner();
    console.log(`  ${bold('turbine migrate')} ${dim(', SQL-first migration system')}`);
    newline();
    console.log(`  ${bold('Commands:')}`);
    console.log(`    ${cyan('create <name>')}             Create a new migration file`);
    console.log(`    ${cyan('create <name> --auto')}      Auto-generate from schema diff`);
    console.log(`    ${cyan('create <name> --from-diff')} Generate from schema diff, destructive statements flagged`);
    console.log(`    ${cyan('create <name> --recipe')}    Scaffold a named recipe (e.g. backfill)`);
    console.log(`    ${cyan('up')}                       Apply pending migrations`);
    console.log(`    ${cyan('deploy')}                   Apply pending migrations without prompts`);
    console.log(`    ${cyan('down')}                     Rollback last migration`);
    console.log(`    ${cyan('status')}                   Show migration status`);
    newline();
    console.log(`  ${bold('Options:')}`);
    console.log(`    ${cyan('--auto')}             Auto-generate UP/DOWN SQL from schema diff (destructive flagged)`);
    console.log(`    ${cyan('--from-diff')}        Generate from schema diff, destructive statements flagged inline`);
    console.log(`    ${cyan('--recipe <name>')}    Scaffold a sanctioned migration pattern`);
    console.log(`    ${cyan('--step, -n')}         Number of migrations to apply/rollback`);
    console.log(`    ${cyan('--dry-run')}          Show SQL without executing`);
    console.log(`    ${cyan('--allow-destructive')} Run data-destroying statements without prompting`);
    console.log(
      `    ${cyan('--allow-drift')}      Bypass checksum validation on ${cyan('up')} / ${cyan('deploy')} ${dim('(advanced)')}`,
    );
    newline();
    console.log(`  ${bold('Recipes')} ${dim('(--recipe):')}`);
    for (const [key, recipe] of Object.entries(MIGRATION_RECIPES)) {
      console.log(`    ${cyan(key)}  ${dim(recipe.description)}`);
    }
    newline();
    console.log(`  ${bold('Examples:')}`);
    console.log(`    ${dim('npx turbine migrate create add_users_table')}`);
    console.log(`    ${dim('npx turbine migrate create add_email_index --auto')}`);
    console.log(`    ${dim('npx turbine migrate create sync_schema --from-diff')}`);
    console.log(`    ${dim('npx turbine migrate create backfill_full_name --recipe backfill')}`);
    console.log(`    ${dim('npx turbine migrate up')}`);
    console.log(`    ${dim('npx turbine migrate deploy --dry-run')}`);
    console.log(`    ${dim('npx turbine migrate down --step 2')}`);
    newline();
    return;
  }

  switch (sub) {
    case 'create':
      await cmdMigrateCreate(args, config);
      break;
    case 'up':
      await cmdMigrateUp(args, config);
      break;
    case 'deploy':
      await cmdMigrateDeploy(args, config);
      break;
    case 'down':
      await cmdMigrateDown(args, config);
      break;
    case 'status':
    case 'list':
      await cmdMigrateStatus(args, config);
      break;
    default:
      error(`Unknown migrate subcommand: ${sub}`);
      console.log(`  ${dim('Run')} ${cyan('npx turbine migrate help')} ${dim('for usage.')}`);
      process.exit(1);
  }
}

async function cmdMigrateCreate(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const name = args.positional[0];
  if (!name) {
    error('Migration name is required.');
    newline();
    console.log(`  ${dim('Usage:')} ${cyan('npx turbine migrate create <name>')}`);
    console.log(`  ${dim('Example:')} ${cyan('npx turbine migrate create add_users_table')}`);
    console.log(`  ${dim('Auto:')}    ${cyan('npx turbine migrate create my_change --auto')}`);
    newline();
    process.exit(1);
  }

  // The scaffold strategies each own the file body, so combining them is
  // ambiguous. Refuse up front (before any of the strategy blocks run).
  if (args.fromDiff && args.recipe) {
    error('--from-diff cannot be combined with --recipe.');
    console.log(`  ${dim('Pick one: --from-diff generates from the schema diff, --recipe scaffolds a pattern.')}`);
    newline();
    process.exit(1);
  }
  if (args.fromDiff && args.auto) {
    error('--from-diff cannot be combined with --auto.');
    console.log(`  ${dim('Both generate from the schema diff; --from-diff also flags destructive statements.')}`);
    newline();
    process.exit(1);
  }

  if (args.auto) {
    // Auto-generate migration from schema diff
    const url = requireUrl(config);
    label('Database', redactUrl(url));
    label('Schema file', config.schemaFile);
    newline();

    const schemaDef = await loadSchemaFile(config.schemaFile);
    const diffSpinner = new Spinner('Computing schema diff').start();
    const diff = await schemaDiff(schemaDef, url);

    if (diff.statements.length === 0) {
      diffSpinner.succeed('Database is already in sync: nothing to migrate');
      newline();
      return;
    }

    diffSpinner.succeed(`Found ${bold(String(diff.statements.length))} change(s)`);
    newline();

    // Route through buildDiffMigrationBody so any destructive statement (a lossy
    // ALTER COLUMN ... TYPE, or a DROP COLUMN for a column removed from the
    // schema) is flagged inline in the file, matching --from-diff. A
    // destructive-only diff therefore produces a real, flagged migration instead
    // of the old "already in sync" false negative.
    const body = buildDiffMigrationBody(diff);
    const file = createMigration(config.migrationsDir, name, { up: body.up, down: body.down });
    const relPath = relative(process.cwd(), file.path);

    success(`Created auto-migration: ${bold(file.filename)}`);
    newline();
    console.log(`  ${dim('File:')} ${cyan(relPath)}`);
    newline();

    // Show summary of changes
    if (diff.create.length > 0) {
      console.log(
        `  ${green('+ Create')} ${diff.create.length} table(s): ${diff.create.map((t) => t.name).join(', ')}`,
      );
    }
    if (diff.alter.length > 0) {
      console.log(`  ${yellow('~ Alter')} ${diff.alter.length} table(s):`);
      for (const a of diff.alter) {
        for (const col of a.columns) {
          const actionLabel =
            col.action === 'add'
              ? green('+ add')
              : col.action === 'drop'
                ? red('- drop')
                : col.action === 'add_unique'
                  ? green('+ unique')
                  : col.action === 'drop_unique'
                    ? red('- unique')
                    : yellow(`~ ${col.action.replace(/_/g, ' ')}`);
          console.log(`    ${actionLabel} ${a.table}.${col.column}`);
        }
      }
    }
    newline();

    // Loudly flag any destructive statements written into the file (same as
    // --from-diff). They stay intact so `migrate up` still refuses them by
    // default, but the operator must know they are there before running.
    const destructiveCount = body.destructiveUp.length + body.destructiveDown.length;
    if (destructiveCount > 0) {
      warn(`This migration contains ${bold(String(destructiveCount))} DESTRUCTIVE statement(s), flagged in the file.`);
      for (const h of body.destructiveUp) {
        console.log(`    ${red(symbols.warning)} ${dim('UP')}   [${h.kind}] ${h.target}`);
      }
      for (const h of body.destructiveDown) {
        console.log(`    ${red(symbols.warning)} ${dim('DOWN')} [${h.kind}] ${h.target}`);
      }
      newline();
      console.log(
        `  ${dim('`migrate up` refuses destructive statements by default: confirm interactively or pass')} ${cyan('--allow-destructive')}${dim('.')}`,
      );
      newline();
    }

    if (diff.warnings && diff.warnings.length > 0) {
      for (const w of diff.warnings) warn(w);
      newline();
    }

    console.log(`  ${dim('Review the migration, then run:')}`);
    console.log(`  ${cyan('npx turbine migrate up')}`);
    newline();
    return;
  }

  if (args.fromDiff) {
    // Load the code-first schema (same file `push` uses). loadSchemaFile exits
    // with a clear message when the project has no schema-builder file.
    const url = requireUrl(config);
    label('Database', redactUrl(url));
    label('Schema file', config.schemaFile);
    newline();

    const schemaDef = await loadSchemaFile(config.schemaFile);

    const diffSpinner = new Spinner('Computing schema diff').start();
    const diff = await schemaDiff(schemaDef, url);

    if (diff.statements.length === 0) {
      diffSpinner.succeed('Database is already in sync: nothing to migrate');
      newline();
      return;
    }

    diffSpinner.succeed(`Found ${bold(String(diff.statements.length))} change(s)`);
    newline();

    const body = buildDiffMigrationBody(diff);
    const file = createMigration(config.migrationsDir, name, { up: body.up, down: body.down });
    const relPath = relative(process.cwd(), file.path);

    success(`Created diff migration: ${bold(file.filename)}`);
    newline();
    console.log(`  ${dim('File:')} ${cyan(relPath)}`);
    newline();

    // Summarize the changes, mirroring --auto's output.
    if (diff.create.length > 0) {
      console.log(
        `  ${green('+ Create')} ${diff.create.length} table(s): ${diff.create.map((t) => t.name).join(', ')}`,
      );
    }
    if (diff.alter.length > 0) {
      console.log(`  ${yellow('~ Alter')} ${diff.alter.length} table(s):`);
      for (const a of diff.alter) {
        for (const col of a.columns) {
          const actionLabel =
            col.action === 'add'
              ? green('+ add')
              : col.action === 'drop'
                ? red('- drop')
                : col.action === 'add_unique'
                  ? green('+ unique')
                  : col.action === 'drop_unique'
                    ? red('- unique')
                    : yellow(`~ ${col.action.replace(/_/g, ' ')}`);
          console.log(`    ${actionLabel} ${a.table}.${col.column}`);
        }
      }
    }
    newline();

    // Loudly flag destructive statements written into the file. They stay in the
    // migration (so `migrate up`'s gate still refuses them by default) but the
    // operator must know they are there before running.
    const destructiveCount = body.destructiveUp.length + body.destructiveDown.length;
    if (destructiveCount > 0) {
      warn(`This migration contains ${bold(String(destructiveCount))} DESTRUCTIVE statement(s), flagged in the file.`);
      for (const h of body.destructiveUp) {
        console.log(`    ${red(symbols.warning)} ${dim('UP')}   [${h.kind}] ${h.target}`);
      }
      for (const h of body.destructiveDown) {
        console.log(`    ${red(symbols.warning)} ${dim('DOWN')} [${h.kind}] ${h.target}`);
      }
      newline();
      console.log(
        `  ${dim('`migrate up` refuses destructive statements by default: confirm interactively or pass')} ${cyan('--allow-destructive')}${dim('.')}`,
      );
      newline();
    }

    if (diff.warnings && diff.warnings.length > 0) {
      for (const w of diff.warnings) warn(w);
      newline();
    }

    console.log(`  ${dim('Review the migration, then run:')}`);
    console.log(`  ${cyan('npx turbine migrate up')}`);
    newline();
    return;
  }

  if (args.recipe) {
    if (!MIGRATION_RECIPES[args.recipe]) {
      error(`Unknown migration recipe: ${args.recipe}`);
      newline();
      console.log(`  ${dim('Available recipes:')}`);
      for (const [key, recipe] of Object.entries(MIGRATION_RECIPES)) {
        console.log(`    ${cyan(key)}  ${dim(recipe.description)}`);
      }
      newline();
      process.exit(1);
    }
    const file = createMigration(config.migrationsDir, name, undefined, { recipe: args.recipe });
    const relPath = relative(process.cwd(), file.path);

    success(`Created ${args.recipe} migration: ${bold(file.filename)}`);
    newline();
    console.log(`  ${dim('File:')} ${cyan(relPath)}`);
    newline();
    console.log(`  ${dim('Fill in the commented placeholders, then run:')}`);
    console.log(`  ${cyan('npx turbine migrate up')}`);
    newline();
    return;
  }

  const file = createMigration(config.migrationsDir, name);
  const relPath = relative(process.cwd(), file.path);

  success(`Created migration: ${bold(file.filename)}`);
  newline();
  console.log(`  ${dim('File:')} ${cyan(relPath)}`);
  newline();
  console.log(`  ${dim('Edit the file to add your SQL, then run:')}`);
  console.log(`  ${cyan('npx turbine migrate up')}`);
  newline();
}

async function cmdMigrateUp(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);

  label('Database', redactUrl(url));
  label('Migrations', config.migrationsDir);
  newline();

  const allFiles = listMigrationFiles(config.migrationsDir);
  if (allFiles.length === 0) {
    warn('No migration files found.');
    console.log(`  ${dim('Create one with:')} ${cyan('npx turbine migrate create <name>')}`);
    newline();
    return;
  }

  // Big, loud warning when bypassing drift detection, this is a deliberately
  // dangerous operation and the user should see it on every invocation.
  if (args.allowDrift) {
    warn('--allow-drift is set, checksum validation is DISABLED for this run.');
    console.log(`  ${dim('Applied migrations may have been modified or deleted on disk.')}`);
    console.log(`  ${dim('Proceed only if you are intentionally rewriting migration history.')}`);
    newline();
  }

  if (args.allowDestructive) {
    warn('--allow-destructive is set, data-destroying statements in migrations WILL run.');
    newline();
  }

  const spinner = new Spinner('Applying migrations').start();

  // A no-transaction migration (CREATE INDEX CONCURRENTLY) can wait a long time
  // on other transactions and otherwise looks hung. Stop the spinner and print
  // a loud notice the moment one is about to run.
  const onNoTransaction = (file: MigrationFile): void => {
    spinner.stop();
    warn(`Running ${bold(file.filename)} WITHOUT a transaction (-- turbine:no-transaction).`);
    console.log(`  ${dim('Each statement runs on its own. A mid-file failure leaves earlier statements')}`);
    console.log(`  ${dim('applied and the migration UNRECORDED, so every statement must be idempotent.')}`);
    console.log(`  ${dim('CREATE INDEX CONCURRENTLY can wait on long-running transactions: not a hang.')}`);
    newline();
  };

  let result: Awaited<ReturnType<typeof migrateUp>>;
  try {
    result = await migrateUp(url, config.migrationsDir, {
      step: args.step,
      allowDrift: args.allowDrift,
      allowDestructive: args.allowDestructive,
      onNoTransaction,
    });
  } catch (err) {
    if (!isDestructiveRefusal(err)) throw err;
    spinner.stop();
    if (!(await confirmDestructive((err as Error).message))) {
      error('Aborted, no migrations were applied and no data was touched.');
      newline();
      process.exit(1);
    }
    spinner.start();
    result = await migrateUp(url, config.migrationsDir, {
      step: args.step,
      allowDrift: args.allowDrift,
      allowDestructive: true,
      onNoTransaction,
    });
  }

  if (result.applied.length === 0 && result.errors.length === 0) {
    spinner.succeed('All migrations are up to date');
    newline();
    return;
  }

  if (result.applied.length > 0) {
    spinner.succeed(`Applied ${bold(String(result.applied.length))} migration(s)`);
    for (const file of result.applied) {
      console.log(`    ${green(symbols.check)} ${file.filename}`);
    }
  }

  warnOutOfOrder(result.outOfOrder);

  if (result.errors.length > 0) {
    spinner.fail('Migration failed');
    for (const { file, error: msg } of result.errors) {
      console.log(`    ${red(symbols.cross)} ${file.filename}`);
      console.log(`      ${dim(msg)}`);
    }
    newline();
    process.exit(1);
  }

  newline();
}

/** Print a one-line warning for each migration applied out of timestamp order. */
function warnOutOfOrder(outOfOrder: OutOfOrderApply[]): void {
  if (outOfOrder.length === 0) return;
  newline();
  for (const o of outOfOrder) {
    warn(`Applied ${bold(o.applied)} out of order (older than already-applied ${bold(o.newestPrior)}).`);
  }
}

export function buildMigrateDeployOptions(args: CliArgs): {
  allowDrift: boolean;
  allowDestructive: true;
  step: undefined;
} {
  return {
    allowDrift: args.allowDrift === true,
    allowDestructive: true,
    step: undefined,
  };
}

/**
 * Print the itemized, classified destructive-statement report as a NOTICE.
 * `deploy` proceeds by design (the gate ran at author time), but it must not run
 * data-destroying SQL in total silence; the notice ends that zero-ceremony hole.
 */
function printDestructiveNotice(offenders: DestructiveOffender[]): void {
  warn('NOTICE: this deploy runs DESTRUCTIVE statement(s):');
  for (const o of offenders) {
    console.log(`    ${red(symbols.warning)} ${o.file}`);
    for (const h of o.hits) {
      console.log(`      ${dim('-')} [${h.kind}] ${h.target} ${dim(DESTRUCTIVE_KIND_LABEL[h.kind])}`);
    }
  }
  newline();
}

async function cmdMigrateDeploy(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);

  label('Database', redactUrl(url));
  label('Migrations', config.migrationsDir);
  newline();

  const spinner = new Spinner('Checking pending migrations').start();
  const plan = await inspectMigrationDeploy(url, config.migrationsDir);
  spinner.stop();

  // Drift handling: honor --allow-drift exactly like `up`. Without it, block;
  // with it, warn loudly and proceed.
  if (plan.mismatches.length > 0) {
    if (!args.allowDrift) {
      error('Deploy blocked by migration drift');
      newline();
      for (const line of formatChecksumMismatchError(plan.mismatches).split('\n')) {
        console.log(`  ${line.replace('[turbine] ', '')}`);
      }
      newline();
      process.exit(1);
    }
    warn('--allow-drift is set: checksum validation is DISABLED for this deploy.');
    console.log(`  ${dim('Applied migrations may have been modified or deleted on disk.')}`);
    newline();
  }

  if (args.dryRun) {
    if (plan.pending.length === 0) {
      info('No pending migrations');
      newline();
      return;
    }

    info(`${bold(String(plan.pending.length))} pending migration(s)`);
    for (const file of plan.pending) {
      console.log(`    ${yellow(symbols.dot)} ${file.filename}`);
    }
    // Surface destructive statements even in a dry run so CI can see them.
    const destructive = collectUpDestructive(plan.pending);
    if (destructive.length > 0) {
      newline();
      printDestructiveNotice(destructive);
    }
    newline();
    return;
  }

  // Destructive notice before applying (deploy still proceeds by design).
  const destructive = collectUpDestructive(plan.pending);
  if (destructive.length > 0) printDestructiveNotice(destructive);

  const runSpinner = new Spinner('Deploying migrations').start();
  const result = await migrateDeploy(url, config.migrationsDir, { allowDrift: args.allowDrift });

  if (result.applied.length === 0 && result.errors.length === 0) {
    runSpinner.succeed('0 applied, all migrations are up to date');
    newline();
    return;
  }

  if (result.applied.length > 0) {
    runSpinner.succeed(`${bold(String(result.applied.length))} applied`);
    for (const file of result.applied) {
      console.log(`    ${green(symbols.check)} ${file.filename}`);
    }
  }

  warnOutOfOrder(result.outOfOrder);

  if (result.errors.length > 0) {
    runSpinner.fail('Deploy failed');
    for (const { file, error: msg } of result.errors) {
      console.log(`    ${red(symbols.cross)} ${file.filename}`);
      console.log(`      ${dim(msg)}`);
    }
    newline();
    process.exit(1);
  }

  newline();
}

/** True when the error is migrate up/down's destructive-statement refusal. */
function isDestructiveRefusal(err: unknown): boolean {
  return err instanceof Error && err.message.includes('DESTRUCTIVE');
}

/**
 * Triple confirmation for destructive migrations:
 *   1. show the full itemized report (statement kinds + targets),
 *   2. require typing the literal phrase `destroy my data`,
 *   3. require a final explicit `yes`.
 * Non-interactive shells (CI, pipes) can never pass this, they must use the
 * explicit `--allow-destructive` flag instead. Anything but exact answers aborts.
 */
async function confirmDestructive(report: string): Promise<boolean> {
  newline();
  error('DESTRUCTIVE MIGRATION DETECTED');
  newline();
  for (const line of report.split('\n'))
    console.log(`  ${line.includes('[turbine]') ? line.replace('[turbine] ', '') : line}`);
  newline();

  if (!process.stdin.isTTY) {
    console.log(`  ${dim('Non-interactive shell: rerun with')} ${cyan('--allow-destructive')} ${dim('to proceed.')}`);
    newline();
    return false;
  }

  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`  ${yellow('This will permanently destroy data. There is no undo.')}`);
    const phrase = await rl.question(`  Type ${bold('destroy my data')} to continue, anything else to abort: `);
    if (phrase.trim() !== 'destroy my data') return false;
    const finalAnswer = await rl.question(
      `  Final confirmation, apply the destructive statements above? Type ${bold('yes')}: `,
    );
    return finalAnswer.trim() === 'yes';
  } finally {
    rl.close();
  }
}

async function cmdMigrateDown(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);

  label('Database', redactUrl(url));
  label('Migrations', config.migrationsDir);
  newline();

  const spinner = new Spinner('Rolling back migration(s)').start();

  let result: Awaited<ReturnType<typeof migrateDown>>;
  try {
    result = await migrateDown(url, config.migrationsDir, {
      step: args.step ?? 1,
      allowDestructive: args.allowDestructive,
    });
  } catch (err) {
    if (!isDestructiveRefusal(err)) throw err;
    spinner.stop();
    if (!(await confirmDestructive((err as Error).message))) {
      error('Aborted, nothing was rolled back and no data was touched.');
      newline();
      process.exit(1);
    }
    spinner.start();
    result = await migrateDown(url, config.migrationsDir, {
      step: args.step ?? 1,
      allowDestructive: true,
    });
  }

  if (result.rolledBack.length === 0 && result.errors.length === 0) {
    spinner.succeed('No migrations to roll back');
    newline();
    return;
  }

  if (result.rolledBack.length > 0) {
    spinner.succeed(`Rolled back ${bold(String(result.rolledBack.length))} migration(s)`);
    for (const file of result.rolledBack) {
      console.log(`    ${yellow(symbols.arrowRight)} ${file.filename}`);
    }
  }

  if (result.errors.length > 0) {
    spinner.fail('Rollback failed');
    for (const { file, error: msg } of result.errors) {
      console.log(`    ${red(symbols.cross)} ${file.filename}`);
      console.log(`      ${dim(msg)}`);
    }
    newline();
    process.exit(1);
  }

  newline();
}

async function cmdMigrateStatus(_args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);

  label('Database', redactUrl(url));
  label('Migrations', config.migrationsDir);
  newline();

  const allFiles = listMigrationFiles(config.migrationsDir);
  if (allFiles.length === 0) {
    warn('No migration files found.');
    console.log(`  ${dim('Create one with:')} ${cyan('npx turbine migrate create <name>')}`);
    newline();
    return;
  }

  const statuses = await migrateStatus(url, config.migrationsDir);

  const appliedCount = statuses.filter((s) => s.applied).length;
  const pendingCount = statuses.filter((s) => !s.applied).length;

  info(
    `${bold(String(appliedCount))} applied, ${pendingCount > 0 ? yellow(bold(String(pendingCount))) : bold(String(pendingCount))} pending`,
  );
  newline();

  // Applied migrations whose file was deleted from disk (distinct from an
  // on-disk edit). Counted in "applied" above; surfaced with their own banner.
  const missingCount = statuses.filter((s) => s.missingFile).length;
  if (missingCount > 0) {
    warn(`${bold(String(missingCount))} applied migration(s) are missing from disk!`);
    console.log(`  ${dim('The history table records them, but their .sql file is gone.')}`);
    console.log(
      `  ${dim('Restore the file(s) before running')} ${cyan('migrate up')} ${dim('or')} ${cyan('migrate deploy')}${dim('.')}`,
    );
    newline();
  }

  // Check for checksum mismatches (on-disk edits only; missing files above).
  const driftCount = statuses.filter((s) => s.checksumValid === false && !s.missingFile).length;
  if (driftCount > 0) {
    warn(`${bold(String(driftCount))} migration(s) have been modified after application!`);
    console.log(`  ${dim('Applied migrations should be immutable. Modifying them can cause drift.')}`);
    newline();
  }

  // Format as table
  const headers = ['Status', 'Migration', 'Applied at'];
  const rows = statuses.map((s) => {
    let status: string;
    if (s.missingFile) {
      status = red(`${symbols.warning} Missing file`);
    } else if (s.applied && s.checksumValid === false) {
      status = red(`${symbols.warning} Drifted`);
    } else if (s.applied) {
      status = green(`${symbols.check} Applied`);
    } else {
      status = yellow(`${symbols.dot} Pending`);
    }
    return [
      status,
      s.file.filename,
      s.appliedAt
        ? dim(
            s.appliedAt
              .toISOString()
              .replace('T', ' ')
              .replace(/\.\d+Z$/, ' UTC'),
          )
        : dim('-'),
    ];
  });

  console.log(formatTable(headers, rows));
  newline();

  if (pendingCount > 0) {
    console.log(`  ${dim('Run')} ${cyan('npx turbine migrate up')} ${dim('to apply pending migrations.')}`);
    newline();
  }
}

// ---------------------------------------------------------------------------
// Command: seed
// ---------------------------------------------------------------------------

export type SeedExecutionPlan =
  | { kind: 'tsx'; command: 'npx'; args: string[] }
  | { kind: 'js'; file: string }
  | { kind: 'sql'; file: string };

export function getSeedExecutionPlan(seedFile: string): SeedExecutionPlan {
  const ext = extname(seedFile).toLowerCase();
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') {
    return { kind: 'tsx', command: 'npx', args: ['tsx', seedFile] };
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { kind: 'js', file: seedFile };
  }
  if (ext === '.sql') {
    return { kind: 'sql', file: seedFile };
  }
  throw new Error(`Unsupported seed file extension: ${ext || '(none)'}. Use seed.ts, seed.js, or seed.sql.`);
}

async function runSeedPlan(plan: SeedExecutionPlan, config: ResolvedConfig): Promise<void> {
  const oldDatabaseUrl = process.env.DATABASE_URL;
  if (config.url) process.env.DATABASE_URL = config.url;

  try {
    if (plan.kind === 'tsx') {
      if (!canResolveTsx()) {
        throw new Error('TypeScript seed files require tsx, install tsx or use seed.js/seed.sql.');
      }
      // The seed runs in a child process, so we cannot observe its callback
      // directly. Hand it a sentinel path: `defineSeed`'s runner writes the file
      // only after a callback executes to completion. If the child exits cleanly
      // but the sentinel never appears, the seed module loaded without running
      // anything: a silent no-op we must report as a failure, not success.
      const sentinelDir = mkdtempSync(join(tmpdir(), 'turbine-seed-'));
      const sentinel = join(sentinelDir, 'ran');
      const { execFileSync } = await import('node:child_process');
      try {
        execFileSync(plan.command, plan.args, {
          stdio: 'inherit',
          env: {
            ...process.env,
            DATABASE_URL: config.url || process.env.DATABASE_URL,
            TURBINE_SEED_SENTINEL: sentinel,
          },
        });
        if (!existsSync(sentinel)) {
          throw new Error(
            'The seed file completed without running a seed callback. ' +
              'Make sure it calls defineSeed(async (db) => { ... }) at the top level.',
          );
        }
      } finally {
        rmSync(sentinelDir, { recursive: true, force: true });
      }
      return;
    }

    if (plan.kind === 'js') {
      const mod = await import(pathToFileURL(plan.file).href);
      if (typeof mod.default !== 'function') {
        throw new Error(
          'The seed file has no callable default export. ' +
            'Export your seed with `export default defineSeed(async (db) => { ... })`.',
        );
      }
      await mod.default();
      return;
    }

    const url = requireUrl(config);
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query(readFileSync(plan.file, 'utf-8'));
    } finally {
      await client.end();
    }
  } finally {
    if (oldDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = oldDatabaseUrl;
    }
  }
}

async function cmdSeed(_args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();

  const seedFile = resolveSeedFile(config);
  label('Seed file', seedFile ? relative(process.cwd(), seedFile) || seedFile : '(not found)');
  newline();

  if (!seedFile || !existsSync(seedFile)) {
    error(`Seed file not found.`);
    newline();
    console.log(
      `  ${dim('Create one of:')} ${cyan('seed.ts')}${dim(',')} ${cyan('seed.js')}${dim(',')} ${cyan('seed.sql')}`,
    );
    console.log(`  ${dim('Or set')} ${cyan('seed')} ${dim('in')} ${cyan('turbine.config.ts')}`);
    newline();
    process.exit(1);
  }

  const spinner = new Spinner('Running seed file').start();

  try {
    await runSeedPlan(getSeedExecutionPlan(seedFile), config);
    spinner.succeed('Seed completed');
  } catch (err) {
    spinner.fail('Seed failed');
    if (err instanceof Error) {
      console.log(`  ${dim(redactUrl(err.message))}`);
    }
    newline();
    process.exit(1);
  }

  newline();
}

// ---------------------------------------------------------------------------
// Command: status
// ---------------------------------------------------------------------------

async function cmdStatus(_args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);

  label('Database', redactUrl(url));
  label('Schema', config.schema);
  newline();

  const spinner = new Spinner('Introspecting database').start();

  const schema = await introspect({
    connectionString: url,
    schema: config.schema,
    include: config.include.length ? config.include : undefined,
    exclude: config.exclude.length ? config.exclude : undefined,
    relationNames: config.relationNames,
  });

  const tableNames = Object.keys(schema.tables);
  spinner.succeed(`Found ${bold(String(tableNames.length))} tables`);
  newline();

  for (const tbl of Object.values(schema.tables)) {
    const relCount = Object.keys(tbl.relations).length;
    const _pk = tbl.primaryKey.join(', ') || dim('(none)');

    console.log(`  ${bold(cyan(tbl.name))}`);

    for (let i = 0; i < tbl.columns.length; i++) {
      const col = tbl.columns[i]!;
      const isLast = i === tbl.columns.length - 1 && relCount === 0;
      const prefix = isLast ? symbols.teeEnd : symbols.tee;
      const nullable = col.nullable ? dim('?') : '';
      const def = col.hasDefault ? dim(' (default)') : '';
      const pkLabel = tbl.primaryKey.includes(col.name) ? ` ${magenta('PK')}` : '';
      console.log(
        `    ${dim(prefix)} ${col.field}${nullable}: ${green(col.tsType)}${pkLabel}${def}  ${gray(`${symbols.arrow} ${col.pgType}`)}`,
      );
    }

    const rels = Object.entries(tbl.relations);
    if (rels.length > 0) {
      for (let i = 0; i < rels.length; i++) {
        const [relName, rel] = rels[i]!;
        const isLast = i === rels.length - 1;
        const prefix = isLast ? symbols.teeEnd : symbols.tee;
        const relColor = rel.type === 'hasMany' ? blue : yellow;
        const fkDisplay = Array.isArray(rel.foreignKey) ? rel.foreignKey.join(', ') : rel.foreignKey;
        console.log(
          `    ${dim(prefix)} ${relColor(relName)} ${dim(symbols.arrow)} ${rel.to} ${dim(`(${rel.type}, FK: ${fkDisplay})`)}`,
        );
      }
    }

    newline();
  }

  if (Object.keys(schema.enums).length > 0) {
    console.log(`  ${bold('Enums:')}`);
    for (const [enumName, labels] of Object.entries(schema.enums)) {
      console.log(`    ${cyan(enumName)}: ${labels.map((l) => green(`'${l}'`)).join(dim(' | '))}`);
    }
    newline();
  }
}

// ---------------------------------------------------------------------------
// Command: doctor, relation/index health check
// ---------------------------------------------------------------------------

/** A topology finding paired with its cost-aware score. */
interface DoctorFinding {
  missing: MissingRelationIndex;
  score: ScoredMissingIndex;
}

/** Human labels + tier ordering for the three triage buckets. */
const TIER_ORDER: IndexTier[] = ['take-freely', 'take-deliberately', 'scrutinize'];
const TIER_LABEL: Record<IndexTier, string> = {
  'take-freely': 'TAKE FREELY',
  'take-deliberately': 'TAKE DELIBERATELY',
  scrutinize: 'SCRUTINIZE',
};

/** Build the `CREATE INDEX` for a finding, honoring the partial-null suggestion. */
function doctorCreateSql(f: DoctorFinding, opts: { concurrently: boolean }): string {
  return buildCreateIndexSql(f.missing.table, f.missing.columns, f.missing.indexName, {
    concurrently: opts.concurrently,
    partialNotNull: f.score.partialNotNull,
  });
}

/** The commented recipe prepended to a CONCURRENTLY fix migration's UP body. */
const CONCURRENTLY_RECIPE_COMMENT = [
  '-- CREATE INDEX CONCURRENTLY builds without holding a write lock, but it cannot',
  '-- run inside a transaction (that is why this file carries the',
  '-- "-- turbine:no-transaction" directive above). Read before applying:',
  '--',
  '--   1. Idempotency is required. This migration is recorded only after ALL',
  '--      statements succeed; a mid-file failure leaves earlier indexes built and',
  '--      the migration unrecorded, so a rerun must be safe. IF NOT EXISTS keeps',
  '--      each CREATE idempotent.',
  '--   2. The INVALID-index trap. A CREATE INDEX CONCURRENTLY that fails partway',
  '--      leaves an INVALID index behind. On rerun, IF NOT EXISTS SKIPS that',
  '--      corpse (the name already exists), so the index is never actually built.',
  '--      Fix: DROP INDEX CONCURRENTLY the invalid index, then rerun. Run',
  '--      "turbine doctor" to list invalid indexes.',
  '--   3. Locking. CREATE INDEX CONCURRENTLY waits for every transaction that can',
  '--      see the table to finish. A long-running transaction makes it wait and',
  '--      makes "migrate up" look hung. For bounded waits, SET lock_timeout /',
  '--      statement_timeout in a psql session.',
].join('\n');

async function cmdDoctor(args: CliArgs, config: ResolvedConfig): Promise<void> {
  const jsonMode = args.json === true;
  const url = requireUrl(config);

  if (!jsonMode) {
    banner();
    label('Database', redactUrl(url));
    label('Schema', config.schema);
    newline();
  }

  const spinner = jsonMode ? null : new Spinner('Introspecting database').start();

  const schema = await introspect({
    connectionString: url,
    schema: config.schema,
    include: config.include.length ? config.include : undefined,
    exclude: config.exclude.length ? config.exclude : undefined,
  });

  const missing = findMissingRelationIndexes(schema);

  // Collect live statistics. The collector reads whole-schema indexes (for
  // invalid-index detection) plus per-table stats + probed-column null_frac.
  const probedColumns: ProbedColumn[] = [];
  for (const m of missing) {
    if (m.columns.length === 1 && m.columns[0] !== undefined) {
      probedColumns.push({ table: m.table, column: m.columns[0] });
    }
  }

  // Plan-divergence candidates are the columns that ARE indexed, so their tables
  // are usually disjoint from the missing-index set: both lists feed the same
  // one-connection snapshot rather than opening a second read.
  const divergenceOn = args.noPlanDivergence !== true;
  const divergenceColumns = divergenceOn ? collectDivergenceCandidateColumns(schema) : [];
  // The columns a finding could ORDER BY, read alongside the candidates: the
  // size of an unindexed-filter flip turns on the ORDER column's correlation,
  // not the filter column's, and reading only the latter is how an earlier
  // revision printed a statistic about the wrong column.
  const divergenceOrderColumns = divergenceOn ? collectDivergenceOrderColumns(schema) : [];
  const probedTables = [...new Set(missing.map((m) => m.table))];
  const statsTables = [...new Set([...probedTables, ...divergenceColumns.map((c) => c.table)])];
  const distributionColumns = [...divergenceColumns, ...divergenceOrderColumns];

  let snapshot: StatsSnapshot;
  try {
    snapshot = await collectStatsSnapshot({
      connectionString: url,
      schema: config.schema,
      tables: statsTables,
      columns: probedColumns,
      distributionColumns,
    });
  } catch (err) {
    snapshot = {
      available: false,
      statsReset: null,
      statsAgeDays: null,
      tables: {},
      indexes: [],
      nullFrac: {},
      notices: [`statistics collection failed: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  // Table-heat boost: read _turbine_metrics (app DB or --metrics-url) and use
  // per-model heat as an extra benefit signal. Best-effort; a missing table just
  // means "heat boosting unavailable" and the triage continues without it.
  const heat =
    probedTables.length > 0
      ? await collectTableHeatSafe(args.metricsUrl ?? url, probedTables)
      : { available: false, tables: {}, notice: null };

  const invalid = findInvalidIndexes(snapshot);
  const usable = isSnapshotUsable(snapshot);
  const findings: DoctorFinding[] = missing.map((m) => ({
    missing: m,
    score: scoreMissingIndex(m, snapshot, heat.tables[m.table]),
  }));

  // "doctor learns to subtract": report-only drop suggestions, never a migration.
  const unusedRan = args.unused === true;
  const auditRan = args.audit === true;
  const minScans = args.minScans;
  // Never suggest dropping an index that still serves a relation probe: the
  // missing-index half of this very report demands it.
  const relationProbes = collectRelationProbeColumns(schema);
  const unused = unusedRan ? findUnusedIndexes(snapshot, { minScans, relationProbes }) : [];
  const redundant = unusedRan ? findRedundantIndexes(snapshot) : [];
  const audit = auditRan
    ? auditDoctorIndexes(snapshot, collectDoctorProbeIndexNames(schema), { minScans, relationProbes })
    : [];

  const subtract: DoctorSubtractReport = { unusedRan, auditRan, minScans, unused, redundant, audit };

  // Plan divergence has its OWN freshness gate. The cost tiers require a
  // trustworthy stats_reset age because they normalize write counters by it;
  // this check reads no counter, only pg_stats, whose freshness is ANALYZE. A
  // cluster with a NULL stats_reset (the default) must still get the check.
  const scored: PlanDivergenceReport =
    divergenceOn && snapshot.available
      ? findPlanDivergence(schema, snapshot)
      : { findings: [], notices: [], candidatesConsidered: 0, consideredIndexed: 0, consideredUnindexed: 0 };

  // Statistics can say how bad a flip WOULD be; only the planner can say whether
  // it is reachable. The `unindexed-filter` branch shipped in 0.57 without that
  // question answered, and a measured sample of 13 findings held up only 6 times,
  // so every one
  // of its findings is now put to a plan-only EXPLAIN. Nothing is executed, and a
  // probe that fails keeps its finding rather than dropping it.
  const flipProbe =
    divergenceOn && scored.findings.some(needsFlipProbe)
      ? await probePlanFlips({ connectionString: url, schema: config.schema, findings: scored.findings })
      : emptyFlipProbeResult();
  const divergence = applyFlipVerdicts(scored, flipProbe);

  if (jsonMode) {
    spinner?.stop();
    console.log(
      JSON.stringify(
        buildDoctorJson({ schema, findings, invalid, snapshot, usable, heat, subtract, divergence, args }),
        null,
        2,
      ),
    );
    return;
  }

  await renderDoctorHuman({
    spinner: spinner!,
    schema,
    findings,
    invalid,
    snapshot,
    usable,
    heat,
    subtract,
    divergence,
    args,
    config,
  });
}

/** Best-effort table-heat read: any failure degrades to unavailable, never throws. */
async function collectTableHeatSafe(connectionString: string, models: string[]): Promise<TableHeatResult> {
  try {
    return await collectTableHeat({ connectionString, models });
  } catch (err) {
    return {
      available: false,
      tables: {},
      notice: `heat boosting is unavailable (reading _turbine_metrics failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}).`,
    };
  }
}

/** The report-only "subtract" findings, grouped so the CLI and JSON share one shape. */
interface DoctorSubtractReport {
  unusedRan: boolean;
  auditRan: boolean;
  minScans: number | undefined;
  unused: UnusedIndex[];
  redundant: RedundantIndex[];
  audit: DoctorIndexAudit[];
}

/**
 * The stable, versioned JSON contract (schemaVersion: 1). Fields are only ever
 * added, never removed or repurposed, so a parser never breaks on an upgrade.
 */
function buildDoctorJson(ctx: {
  schema: SchemaMetadata;
  findings: DoctorFinding[];
  invalid: ReturnType<typeof findInvalidIndexes>;
  snapshot: StatsSnapshot;
  usable: boolean;
  heat: TableHeatResult;
  subtract: DoctorSubtractReport;
  divergence: PlanDivergenceReport;
  args: CliArgs;
}): Record<string, unknown> {
  const concurrently = ctx.args.noConcurrently !== true;
  const out: Record<string, unknown> = {
    schemaVersion: 1,
    scannedTables: Object.keys(ctx.schema.tables).length,
    stats: {
      available: ctx.snapshot.available,
      usable: ctx.usable,
      statsReset: ctx.snapshot.statsReset ? ctx.snapshot.statsReset.toISOString() : null,
      statsAgeDays: ctx.snapshot.statsAgeDays,
      notices: ctx.snapshot.notices,
    },
    heat: {
      available: ctx.heat.available,
      notice: ctx.heat.notice,
    },
    thresholds: STATS_THRESHOLDS,
    findings: ctx.findings.map((f) => ({
      table: f.missing.table,
      columns: f.missing.columns,
      indexName: f.missing.indexName,
      tier: f.score.tier,
      reasons: f.score.reasons,
      metrics: f.score.metrics,
      hotWarning: f.score.hotWarning,
      partialNotNull: f.score.partialNotNull,
      heatBoosted: f.score.heatBoosted,
      probes: f.missing.probes,
      createSql: doctorCreateSql(f, { concurrently }),
      dropSql: buildDropIndexSql(f.missing.indexName, { concurrently }),
    })),
    invalidIndexes: ctx.invalid,
  };

  // The keys below are ALWAYS present under `schemaVersion: 1`: a declared
  // schema version that changes shape by flag forces every consumer to write
  // `json.unused ?? []`. Which subtraction scans actually ran is reported as
  // data (`ran`), not as the presence or absence of a key.
  out.subtraction = {
    unusedRan: ctx.subtract.unusedRan,
    auditRan: ctx.subtract.auditRan,
    minScans: ctx.subtract.minScans ?? null,
  };
  out.unused = ctx.subtract.unusedRan ? ctx.subtract.unused : [];
  out.redundant = ctx.subtract.unusedRan ? ctx.subtract.redundant : [];
  out.audit = ctx.subtract.auditRan ? ctx.subtract.audit : [];
  out.invalid = ctx.invalid;
  // Always an array, never absent: a consumer must not have to write `?? []`
  // just because the section was skipped or found nothing.
  out.planDivergence = ctx.divergence.findings;
  out.planDivergenceNotices = ctx.divergence.notices;
  // How large the scored population was, and how it split. A consumer counting
  // findings alone cannot tell "considered and clean" from "never looked", and
  // the unindexed half of that population did not exist before.
  out.planDivergenceScored = {
    considered: ctx.divergence.candidatesConsidered,
    indexed: ctx.divergence.consideredIndexed,
    unindexed: ctx.divergence.consideredUnindexed,
    // Whether the unindexed findings above were put to the planner, and how many
    // it refuted. `flipProbed: false` means they are statistics-only and carry
    // 0.57's precision, so a consumer can tell a verified list from an unverified
    // one instead of inferring it from the count.
    flipProbed: ctx.divergence.flipProbed === true,
    flipRefuted: ctx.divergence.flipRefuted ?? 0,
  };
  return out;
}

async function renderDoctorHuman(ctx: {
  spinner: Spinner;
  schema: SchemaMetadata;
  findings: DoctorFinding[];
  invalid: ReturnType<typeof findInvalidIndexes>;
  snapshot: StatsSnapshot;
  usable: boolean;
  heat: TableHeatResult;
  subtract: DoctorSubtractReport;
  divergence: PlanDivergenceReport;
  args: CliArgs;
  config: ResolvedConfig;
}): Promise<void> {
  const { spinner, schema, findings, invalid, snapshot, usable, heat, subtract, divergence, args, config } = ctx;

  spinner.succeed(`Scanned ${bold(String(Object.keys(schema.tables).length))} tables`);

  const subtractRan = subtract.unusedRan || subtract.auditRan;
  const nothingToAdd = findings.length === 0 && invalid.length === 0 && divergence.findings.length === 0;
  const nothingToSubtract =
    subtract.unused.length === 0 && subtract.redundant.length === 0 && subtract.audit.length === 0;

  if (nothingToAdd && (!subtractRan || nothingToSubtract)) {
    if (subtractRan) {
      success('No never-scanned or redundant indexes found, and no invalid indexes were found');
    } else {
      success('Every relation probe is backed by an index, and no invalid indexes were found');
    }
    newline();
    return;
  }

  // One column, one place. An unindexed filter column that ALSO diverges is one
  // problem with one remedy (the index), so the divergence evidence renders as
  // an extra block on the missing-index finding rather than as a second,
  // unrelated-looking entry in the cached-plan section.
  const attached = attachDivergenceToMissingIndexes(findings, divergence);

  if (findings.length > 0) {
    warn(`Found ${bold(String(findings.length))} unindexed relation probe(s)`);
    newline();
    console.log(`  ${dim('Turbine loads relations as correlated subqueries: the child table is probed')}`);
    console.log(`  ${dim('once per parent row, so an unindexed FK costs a full table scan PER PARENT.')}`);
    newline();

    if (usable) {
      renderTiers(findings, snapshot, args, attached);
    } else {
      renderTopologyFallback(findings, snapshot, attached);
    }

    // Heat honesty: one line when the workload-heat boost could not be sourced.
    if (!heat.available && heat.notice) {
      console.log(`  ${dim(`Note: ${heat.notice}`)}`);
      newline();
    }
  }

  renderInvalidIndexes(invalid);
  renderPlanDivergence(divergence, attached);

  if (subtract.unusedRan) {
    renderUnusedIndexes(subtract.unused, subtract.minScans, snapshot);
    renderRedundantIndexes(subtract.redundant);
  }
  if (subtract.auditRan) {
    renderDoctorAudit(subtract.audit, subtract.minScans, snapshot);
  }

  if (findings.length > 0) {
    if (args.fix) {
      renderFixMigration(findings, config, args);
    } else {
      console.log(`  ${dim('Generate a fix migration with:')} ${cyan('npx turbine doctor --fix')}`);
      console.log(`  ${dim('Machine-readable report:')} ${cyan('npx turbine doctor --json')}`);
      newline();
    }
  }
}

/** Shared caveat block: what an idx_scan of zero does and does not prove. */
function renderUnusedCaveats(minScans: number | undefined, snapshot: StatsSnapshot): void {
  const ageLabel = snapshot.statsAgeDays !== null ? `${Math.round(snapshot.statsAgeDays)}d` : 'unknown';
  const threshold = minScans ?? STATS_THRESHOLDS.unusedMinScans;
  console.log(`  ${dim(`Usage counters are since the last stats reset (${ageLabel} ago).`)}`);
  console.log(`  ${dim(`Caveats: counters zero on a stats reset or crash; a read replica's index scans NEVER feed`)}`);
  console.log(
    `  ${dim(`the primary's counters, so an index only a replica uses looks dead here. Threshold: idx_scan < ${threshold}.`)}`,
  );
  console.log(
    `  ${dim('Primary-key, unique, exclusion, and replica-identity indexes are excluded. Nothing here is auto-dropped.')}`,
  );
  console.log(
    `  ${dim('Indexes that still serve a relation Turbine probes are withheld: this report demands those.')}`,
  );
  // The cost section refuses to SCORE on stats this young; prescribing drops off
  // the same counters in the next section would be the report contradicting
  // itself. Say so where the advice is, not only where the scoring is.
  if (snapshot.statsAgeDays !== null && snapshot.statsAgeDays < STATS_THRESHOLDS.minStatsAgeDays) {
    console.log(
      `  ${yellow(`Statistics are only ${ageLabel} old, below the ${STATS_THRESHOLDS.minStatsAgeDays}d floor this report uses to score cost.`)}`,
    );
    console.log(`  ${yellow('Treat everything below as a list to investigate, not advice to act on: an index your')}`);
    console.log(`  ${yellow('workload simply has not reached yet looks identical to a dead one.')}`);
  }
  newline();
}

/** doctor --unused: never-scanned indexes with DROP suggestions (report-only). */
function renderUnusedIndexes(unused: UnusedIndex[], minScans: number | undefined, snapshot: StatsSnapshot): void {
  if (unused.length === 0) return;
  const total = unused.reduce((sum, u) => sum + (u.sizeBytes ?? 0), 0);
  warn(`Found ${bold(String(unused.length))} never-scanned index(es) (${formatBytes(total)} reclaimable).`);
  renderUnusedCaveats(minScans, snapshot);
  for (const u of unused) {
    console.log(
      `  ${yellow(symbols.warning)} ${bold(cyan(u.table))} ${dim(`(${u.columns.join(', ') || '?'})`)}  ${gray(`${u.indexName} · ${u.idxScan} scans · ${formatBytes(u.sizeBytes)}`)}`,
    );
    // A functional / partial / non-btree index is not a plain `(col)` rebuild:
    // say what it actually is before anyone runs the DROP.
    if (u.caveat) console.log(`    ${dim(symbols.tee)} ${yellow(u.caveat)}`);
    console.log(`    ${dim(symbols.teeEnd)} ${green(u.dropSql)}`);
    newline();
  }
}

/** doctor --unused: redundant leading-prefix indexes with DROP suggestions (report-only). */
function renderRedundantIndexes(redundant: RedundantIndex[]): void {
  if (redundant.length === 0) return;
  const total = redundant.reduce((sum, r) => sum + (r.sizeBytes ?? 0), 0);
  warn(`Found ${bold(String(redundant.length))} redundant index(es) (${formatBytes(total)} reclaimable).`);
  console.log(
    `  ${dim('Each is a leading prefix of a wider index that already serves the same lookups. Report-only, never auto-dropped.')}`,
  );
  newline();
  for (const r of redundant) {
    console.log(
      `  ${yellow(symbols.warning)} ${bold(cyan(r.table))} ${dim(`(${r.columns.join(', ')})`)}  ${gray(`${r.indexName} · ${formatBytes(r.sizeBytes)}`)}`,
    );
    console.log(`    ${dim(symbols.tee)} covered by ${blue(r.coveredBy)} ${dim(`(${r.coveredByColumns.join(', ')})`)}`);
    console.log(`    ${dim(symbols.teeEnd)} ${green(r.dropSql)}`);
    newline();
  }
}

/** doctor --audit: doctor's own previously-suggested indexes now never scanned. */
function renderDoctorAudit(audit: DoctorIndexAudit[], minScans: number | undefined, snapshot: StatsSnapshot): void {
  if (audit.length === 0) {
    success('No doctor-suggested index is going unused');
    newline();
    return;
  }
  warn(
    `doctor previously suggested these indexes; ${bold(String(audit.length))} have never been scanned since the stats reset.`,
  );
  renderUnusedCaveats(minScans, snapshot);
  for (const a of audit) {
    const tag = a.ambiguous ? red(' [ambiguous: truncated name collides with another column set]') : '';
    console.log(
      `  ${yellow(symbols.warning)} ${bold(cyan(a.table))} ${dim(`(${a.columns.join(', ') || '?'})`)}  ${gray(`${a.indexName} · ${a.idxScan} scans · ${formatBytes(a.sizeBytes)}`)}${tag}`,
    );
    if (a.ambiguous) {
      console.log(
        `    ${dim(symbols.tee)} ${dim('the 63-byte name maps to more than one probe column set; confirm before dropping')}`,
      );
    }
    if (a.stillProbed) {
      console.log(
        `    ${dim(symbols.teeEnd)} ${dim('kept: a relation in your schema still probes these columns, so dropping it would')}`,
      );
      console.log(`      ${dim('reappear as a missing-index finding in this same report.')}`);
    } else if (a.dropSql) {
      console.log(`    ${dim(symbols.teeEnd)} ${green(a.dropSql)}`);
    }
    newline();
  }
  console.log(`  ${dim('Consider dropping the ones you confirm are unused. Nothing here is auto-dropped.')}`);
  newline();
}

/**
 * The `unindexed-filter` divergence findings that belong ON a missing-index
 * finding, keyed by that finding's `table\u0000column`.
 *
 * A branch-B finding says "this column has no index AND the missing index is
 * also a cached-plan hazard". Whenever the same run's index advisor already
 * names the column, that is ONE problem with ONE remedy, so it is rendered as
 * evidence on that finding. The rare leftovers (a column served only by a
 * partial or expression index, so the advisor considers the probe covered while
 * the planner has no plain btree path) keep their own entry in the cached-plan
 * section, because there is no missing-index finding to hang them on.
 */
type AttachedDivergence = Map<string, PlanDivergenceFinding>;

function attachDivergenceToMissingIndexes(
  findings: DoctorFinding[],
  divergence: PlanDivergenceReport,
): AttachedDivergence {
  const byColumn = new Map<string, PlanDivergenceFinding>();
  for (const d of divergence.findings) {
    if (d.branch !== 'unindexed-filter') continue;
    byColumn.set(`${d.table}\u0000${d.column}`, d);
  }
  const attached: AttachedDivergence = new Map();
  for (const f of findings) {
    // Single-column probes only: a composite probe's index is not the thing the
    // single-column divergence model reasons about.
    if (f.missing.columns.length !== 1 || f.missing.columns[0] === undefined) continue;
    const key = `${f.missing.table}\u0000${f.missing.columns[0]}`;
    const d = byColumn.get(key);
    if (d) attached.set(key, d);
  }
  return attached;
}

/** The key a missing-index finding is looked up by in {@link AttachedDivergence}. */
function attachKey(f: DoctorFinding): string {
  return `${f.missing.table}\u0000${f.missing.columns[0] ?? ''}`;
}

/**
 * The cached-plan evidence block printed UNDER a missing-index finding.
 *
 * It never recommends `forceCustomPlan`: the remedy is the index the same
 * finding already prints, and recommending a per-query plan-cache override for a
 * missing index would be advice to paper over a table scan.
 */
/**
 * How big an `unindexed-filter` flip is, and under what condition, as plain
 * lines both branch-B renderers print.
 *
 * The condition is not decoration. The generic plan's cost is one heap fetch per
 * index entry, so the ratio is the table's rows-per-page when the heap is not in
 * `orderColumn` order and ~1x when it is: 80x and 1.2x on two fixtures identical
 * in every scored input. An earlier revision printed the ratio unconditionally
 * and quoted the FILTER column's correlation next to a sentence about the ORDER
 * column's physical order, so the one field offered as the reader's escape hatch
 * was measured on the wrong column.
 */
function divergenceAmplificationLines(d: PlanDivergenceFinding): string[] {
  const amp = divInt(d.worstCaseAmplification ?? 0);
  const corr = d.orderColumnCorrelation;
  const corrLabel =
    corr === null || corr === undefined
      ? `no pg_stats correlation available for "${d.orderColumn}"`
      : `correlation ${corr.toFixed(5)} on "${d.orderColumn}"`;
  if (d.heapNearlyOrdered === true) {
    return [
      `The size of that flip turns on the heap's physical order, and THIS heap is in near-exact`,
      `"${d.orderColumn}" order (${corrLabel}), so consecutive index entries hit the`,
      `same pinned page: measured ~1x, not the ~${amp}x an unordered heap reads. Most likely this`,
      `one is not costing you anything today. It is also one sampled statistic away from the`,
      `much worse reading, so measure rather than assume in either direction.`,
    ];
  }
  return [
    `That costs ~${amp}x the buffers of the seq scan, because each index entry is its own heap`,
    `fetch (${corrLabel}). The one shape that reads ~1x instead is a heap`,
    `in near-exact "${d.orderColumn}" order; two pages of local disorder already reads ~41x.`,
  ];
}

function renderDivergenceEvidence(d: PlanDivergenceFinding): void {
  const tuples = divInt(d.tuplesWalked ?? d.rows);
  console.log(
    `    ${dim(symbols.tee)} ${yellow('cached-plan risk:')} this unindexed filter column can also flip a cached plan.`,
  );
  console.log(
    `      ${dim(`${divInt(d.rows)} rows in ${divInt(d.pages)} pages, rarest value ~${divInt(d.rarestBucket)} rows, below the assumed LIMIT ${d.assumedLimit}.`)}`,
  );
  console.log(
    `      ${dim(`Without the index the good plan is a seq scan (${divInt(d.pages)} pages); a promoted generic`)}`,
  );
  console.log(
    `      ${dim(`plan cannot see the value is rare, keeps the ordered "${d.orderColumn}" walk, and reads`)}`,
  );
  console.log(`      ${dim(`up to ~${tuples} tuples before it fills the LIMIT.`)}`);
  console.log(`      ${dim('Postgres promotes this shape exactly when the workload keeps asking for the rare')}`);
  console.log(`      ${dim('value: that is the case where the custom plan is expensive enough for the generic')}`);
  console.log(`      ${dim('estimate to look cheaper.')}`);
  for (const line of divergenceAmplificationLines(d)) console.log(`      ${dim(line)}`);
  console.log(`      ${dim('Adding the index above is the fix. Confirm first if you want to:')}`);
  for (const line of d.diagnosticSql.split('\n')) {
    console.log(`        ${green(line)}`);
  }
  console.log(`      ${dim('After adding this index, re-run doctor. This column is expected to reappear as a')}`);
  console.log(`      ${dim('sparse-value finding in the cached-plan section. That later finding is exposure, not')}`);
  console.log(`      ${dim('a regression: the index makes the good plan much cheaper, which is why the ratio it')}`);
  console.log(`      ${dim('quotes is larger, and on a measured fixture it is also what stops Postgres from')}`);
  console.log(`      ${dim('promoting the generic plan at all. Treat the reappearance as the normal end state;')}`);
  console.log(`      ${dim("use the diagnostic block's generic_plans counter to decide whether anything more is")}`);
  console.log(`      ${dim('warranted.')}`);
}

/** Cost-aware tiered output: three sections, each finding annotated with its numbers. */
function renderTiers(
  findings: DoctorFinding[],
  snapshot: StatsSnapshot,
  _args: CliArgs,
  attached: AttachedDivergence,
): void {
  const ageLabel = snapshot.statsAgeDays !== null ? `${Math.round(snapshot.statsAgeDays)}d` : 'unknown';
  console.log(
    `  ${dim(`Cost triage based on live statistics (stats reset ${ageLabel} ago). Thresholds: tiny < ${STATS_THRESHOLDS.tinyTableRows.toLocaleString()} rows,`)}`,
  );
  console.log(
    `  ${dim(`"real" write rate >= ${STATS_THRESHOLDS.highWritesPerDay.toLocaleString()}/day, "many" indexes >= ${STATS_THRESHOLDS.manyIndexes}.`)}`,
  );
  newline();

  const tierColor: Record<IndexTier, (s: string) => string> = {
    'take-freely': green,
    'take-deliberately': yellow,
    scrutinize: red,
  };

  for (const tier of TIER_ORDER) {
    const inTier = findings
      .filter((f) => f.score.tier === tier)
      .sort((a, b) => b.score.benefitScore - a.score.benefitScore);
    if (inTier.length === 0) continue;

    console.log(`  ${bold(tierColor[tier](`${TIER_LABEL[tier]} (${inTier.length})`))}`);
    newline();
    for (const f of inTier) {
      renderFinding(f, { concurrently: true, withReasons: true, divergence: attached.get(attachKey(f)) });
    }
  }
}

/** Degraded output: today's size-sorted topology report when stats are absent/young. */
function renderTopologyFallback(
  findings: DoctorFinding[],
  snapshot: StatsSnapshot,
  attached: AttachedDivergence,
): void {
  warn('Statistics unavailable or too young to score cost: showing size-sorted topology only.');
  for (const notice of snapshot.notices) console.log(`  ${dim(`- ${notice}`)}`);
  if (snapshot.statsAgeDays !== null && snapshot.statsAgeDays < STATS_THRESHOLDS.minStatsAgeDays) {
    console.log(
      `  ${dim(`- statistics were reset less than ${STATS_THRESHOLDS.minStatsAgeDays} day(s) ago; write rates are not yet meaningful.`)}`,
    );
  }
  newline();

  const sorted = [...findings].sort((a, b) => (b.score.metrics.rows ?? 0) - (a.score.metrics.rows ?? 0));
  for (const f of sorted) {
    renderFinding(f, { concurrently: false, withReasons: false, divergence: attached.get(attachKey(f)) });
  }
}

/** Render one finding: table + columns, probing relations, reasons, and the create SQL. */
function renderFinding(
  f: DoctorFinding,
  opts: { concurrently: boolean; withReasons: boolean; divergence?: PlanDivergenceFinding },
): void {
  const m = f.missing;
  const rows = f.score.metrics.rows;
  const rowsLabel = rows !== null ? `~${rows.toLocaleString()} rows` : 'row count unknown';
  const sizeLabel = f.score.metrics.sizeBytes !== null ? `, ${formatBytes(f.score.metrics.sizeBytes)}` : '';
  console.log(
    `  ${yellow(symbols.warning)} ${bold(cyan(m.table))} ${dim(`(${m.columns.join(', ')})`)}  ${gray(`${rowsLabel}${sizeLabel}`)}`,
  );
  for (const p of m.probes) {
    console.log(`    ${dim(symbols.tee)} probed by ${p.from}.${blue(p.relation)} ${dim(`(${p.type})`)}`);
  }
  if (opts.withReasons) {
    for (const reason of f.score.reasons) {
      console.log(`    ${dim(symbols.tee)} ${dim(reason)}`);
    }
  }
  const last = opts.divergence ? symbols.tee : symbols.teeEnd;
  console.log(`    ${dim(last)} ${green(doctorCreateSql(f, { concurrently: opts.concurrently }))}`);
  if (opts.divergence) renderDivergenceEvidence(opts.divergence);
  newline();
}

/** The invalid-index report section (a failed CONCURRENTLY build leaves these behind). */
function renderInvalidIndexes(invalid: ReturnType<typeof findInvalidIndexes>): void {
  if (invalid.length === 0) return;
  warn(`Found ${bold(String(invalid.length))} INVALID index(es) (a failed CREATE INDEX CONCURRENTLY leaves these).`);
  console.log(`  ${dim('IF NOT EXISTS skips an invalid index on rerun, so it never rebuilds. Drop it, then rerun:')}`);
  newline();
  for (const idx of invalid) {
    console.log(
      `  ${red(symbols.warning)} ${bold(cyan(idx.table))} ${dim(`(${idx.columns.join(', ') || '?'})`)}  ${gray(idx.indexName)}`,
    );
    console.log(`    ${dim(symbols.teeEnd)} ${green(idx.dropSql)}`);
    newline();
  }
}

/**
 * The release in which `turbine-orm/prisma-compat` began forwarding Turbine-only
 * query options (`forceCustomPlan` among them) to the core client.
 *
 * Printed rather than assumed, and the sentence stays even after that release:
 * doctor's audience routinely runs a CLI newer than the library pinned in the
 * app, and on an older library the option is accepted and silently ignored.
 */
const COMPAT_PASSTHROUGH_VERSION = '0.57.0';

/**
 * The gates + scored-population footer. Split out because it is printed from two
 * places: the normal section, and the case where every finding was attached to a
 * missing-index finding instead.
 */
function renderDivergenceGates(divergence: PlanDivergenceReport): void {
  const t = PLAN_DIVERGENCE_THRESHOLDS;
  console.log(
    `  ${dim(`Gates, indexed column: the wrong plan must walk >= ${t.minWalkPages} pages and >= ${Math.round(t.minWalkFraction * 100)}% of the table.`)}`,
  );
  console.log(
    `  ${dim(`Gates, unindexed column: the rarest value must hold fewer rows than the limit, and the wrong`)}`,
  );
  console.log(
    `  ${dim(`plan must walk >= ${t.minGenericTupleWalk.toLocaleString('en-US')} tuples. Assumed LIMIT ${t.assumedLimit} throughout.`)}`,
  );
  console.log(
    `  ${dim(`${divergence.candidatesConsidered} column(s) were scored (${divergence.consideredIndexed} indexed, ${divergence.consideredUnindexed} unindexed). That population is relation-probe`)}`,
  );
  console.log(`  ${dim('and leading-index columns only: a filter column that is neither is not covered. Skip this')}`);
  console.log(`  ${dim('section with --no-plan-divergence.')}`);
  // Say whether the unindexed findings were verified, and what verification
  // removed. Statistics can only say how bad a flip would be; a plan-only EXPLAIN
  // says whether the planner can reach it at all.
  if (divergence.flipProbed === true) {
    const refuted = divergence.flipRefuted ?? 0;
    const wereRefuted = refuted === 1 ? '1 was refuted' : `${refuted} were refuted`;
    console.log(
      `  ${dim(`Every unindexed finding was put to the planner (EXPLAIN, nothing executed); ${wereRefuted}`)}`,
    );
    console.log(`  ${dim('because the generic plan keeps the same sequential scan, so no flip is reachable.')}`);
  } else if (divergence.consideredUnindexed > 0) {
    console.log(
      `  ${dim('Unindexed findings are UNVERIFIED here: the planner probe did not run, so some may name a')}`,
    );
    console.log(`  ${dim('divergence the planner would never choose.')}`);
  }
}

/** Round to a whole number and group it, for the divergence report's estimates. */
function divInt(n: number): string {
  if (!Number.isFinite(n)) return 'unbounded';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * The plan-divergence section: columns whose value distribution can flip a
 * cached plan. Finding-only by design, there is no `--fix` for it: the fix is
 * application code (scope the plan-cache mode to the affected reads), and the
 * index that looks like a fix is measured NOT to be one.
 */
function renderPlanDivergence(divergence: PlanDivergenceReport, attached: AttachedDivergence): void {
  const { notices } = divergence;
  // Anything already rendered as evidence on a missing-index finding is NOT
  // repeated here: one column, one problem, one remedy.
  const rendered = new Set(attached.values());
  const findings = divergence.findings.filter((f) => !rendered.has(f));
  // Every divergence finding was attached above, so this section has no entries
  // of its own. The pointer, the gates and the scored population still belong in
  // the report: they are output of THIS check, and a reader must be able to tell
  // "considered and clean" from "never looked".
  //
  // Printed BEFORE the notices rather than inside an early return: an early
  // return that also required `notices.length === 0` dropped both blocks
  // whenever any candidate lacked a pg_stats row, which is the normal reason a
  // notice exists.
  if (findings.length === 0 && rendered.size > 0) {
    console.log(
      `  ${dim(`Cached-plan divergence: ${rendered.size} finding(s), shown with the index findings above.`)}`,
    );
    renderDivergenceGates(divergence);
    newline();
  }
  if (findings.length === 0 && notices.length === 0) return;

  if (findings.length > 0) {
    warn(`${bold(String(findings.length))} column(s) whose value distribution can flip a cached plan`);
    newline();
    console.log(
      `  ${dim('Postgres may promote a named prepared statement to a GENERIC plan from its sixth execution,')}`,
    );
    console.log(`  ${dim('but only when the generic plan is not ESTIMATED to cost more than the average custom')}`);
    console.log(`  ${dim('plan. A generic plan cannot see your values: it estimates "col = $1" as rows /')}`);
    console.log(`  ${dim('n_distinct and an unknown LIMIT as 10% of the child estimate. When those defaults')}`);
    console.log(`  ${dim('land on the other side of a plan boundary from the real value, the plan flips.')}`);
    newline();
  }

  const analyzedLabel = (f: PlanDivergenceFinding): string =>
    f.lastAnalyze === null
      ? 'last ANALYZE unknown'
      : `last analyzed ${Math.max(0, Math.round((Date.now() - f.lastAnalyze.getTime()) / 86_400_000))}d ago`;

  for (const f of findings) {
    if (f.branch === 'unindexed-filter') {
      // Only reached when the column has no missing-index finding to hang this
      // on (an index that exists but cannot serve the equality: partial,
      // expression, or non-btree). The remedy is still an index, not a
      // plan-cache setting, so this entry never suggests forceCustomPlan.
      console.log(
        `  ${yellow(symbols.warning)} ${bold(cyan(`${f.table}.${f.column}`))}  ${gray('UNINDEXED-FILTER FLIP')}`,
      );
      console.log(
        `    ${dim(symbols.tee)} ${divInt(f.rows)} rows in ${divInt(f.pages)} pages, rarest value ~${bold(divInt(f.rarestBucket))} rows, below the assumed LIMIT ${f.assumedLimit}`,
      );
      console.log(
        `    ${dim(symbols.tee)} no index serves ${f.column} = $1, so the good plan is a seq scan (${divInt(f.pages)} pages);`,
      );
      console.log(
        `      ${dim(`a promoted generic plan keeps the ordered "${f.orderColumn}" walk and reads up to ~${divInt(f.tuplesWalked ?? f.rows)} tuples`)}`,
      );
      console.log(`      ${dim('before it fills the LIMIT.')}`);
      for (const line of divergenceAmplificationLines(f)) console.log(`      ${dim(line)}`);
      console.log(
        `    ${dim(symbols.tee)} ${dim(`filter-column correlation ${f.correlation.toFixed(2)}, ${analyzedLabel(f)}`)}`,
      );
      console.log(
        `    ${dim(symbols.tee)} ${dim('the fix is an index that can serve this equality. A partial or expression index')}`,
      );
      console.log(`      ${dim('on the column does not: the planner has no path for the bare predicate. A hash')}`);
      console.log(`      ${dim('index does, and a column served by one is scored by the other rule instead.')}`);
      console.log(`    ${dim(symbols.teeEnd)} ${dim('confirm with YOUR values before changing anything:')}`);
      for (const line of f.diagnosticSql.split('\n')) {
        console.log(`      ${green(line)}`);
      }
      newline();
      continue;
    }

    console.log(`  ${yellow(symbols.warning)} ${bold(cyan(`${f.table}.${f.column}`))}  ${gray('SPARSE-VALUE FLIP')}`);
    console.log(
      `    ${dim(symbols.tee)} generic estimate ${bold(divInt(f.genericEstimate))} rows ${dim(`(${divInt(f.rows)} rows / ${divInt(f.distinctValues)} distinct values)`)}`,
    );
    console.log(
      `    ${dim(symbols.tee)} rarest value bucket ${bold(divInt(f.rarestBucket))} rows ${dim('(pg_stats most_common_freqs / residual bucket)')}`,
    );
    console.log(
      `    ${dim(symbols.tee)} crossover ${bold(divInt(f.crossoverRows ?? 0))} rows ${dim(`(sqrt(limit ${f.assumedLimit} x ${divInt(f.pages)} pages); ${divInt(f.crossoverRowsWide ?? 0)} at limit ${f.thresholds.wideLimit})`)}`,
    );
    console.log(
      `    ${dim(symbols.tee)} ${dim(`values below the crossover: ${divInt(f.valuesBelowCrossover ?? 0)} of ${divInt(f.distinctValues)}, filter-column correlation ${f.correlation.toFixed(2)}, ${analyzedLabel(f)}`)}`,
    );
    console.log(
      `    ${dim(symbols.tee)} for such a value the generic plan walks ~${bold(divInt(f.walkPages ?? 0))} of ${divInt(f.pages)} pages ${dim(`(${Math.round((f.walkFraction ?? 0) * 100)}% of the table)`)}`,
    );
    console.log(`      ${dim(`for reads shaped WHERE ${f.column} = $1 ORDER BY ${f.orderColumn} LIMIT $n,`)}`);
    console.log(`      ${dim("where the custom plan reads only that value's own rows.")}`);
    console.log(
      `    ${dim(symbols.tee)} ${dim('No amplification figure is printed, deliberately. This models how many rows a')}`,
    );
    console.log(`      ${dim('value has, not WHERE they sit in the heap, and the second half can move the')}`);
    console.log(`      ${dim('real cost by an order of magnitude. Measure it instead:')}`);
    console.log(`    ${dim(symbols.teeEnd)} ${dim('confirm with YOUR values before changing anything:')}`);
    for (const line of f.diagnosticSql.split('\n')) {
      console.log(`      ${green(line)}`);
    }
    newline();
  }

  if (findings.length > 0) {
    const first = findings.find((f) => f.branch === 'sparse-value');
    console.log(`  ${bold('What to do, in order:')}`);
    console.log(`    1. Check that this shape is promoted AT ALL. Step 1 of the block above: while`);
    console.log(`       ${dim('generic_plans is 0, Postgres is planning with your real values and there is nothing')}`);
    console.log(`       ${dim('to fix. A finding is exposure, not an incident, and many shapes never promote.')}`);
    console.log(`    2. If it does promote, compare the two plans. Both SETs matter: without them a`);
    console.log(`       ${dim('repeated seq scan resumes where the last one stopped and a catastrophic case reads')}`);
    console.log(`       ${dim('as harmless.')}`);
    if (first) {
      // The OPTION is named first and both call shapes follow, so no step
      // assumes which client the reader is holding. The compat example uses
      // Prisma's `take`: printing `limit` there would be a second wrong
      // instruction, since `limit` is a Turbine spelling compat does not read.
      console.log(`    3. If the flip is real, scope the fix to those reads with ${cyan('forceCustomPlan')}. It`);
      console.log(`       ${dim('withholds the prepared-statement NAME for that one query, so the driver re-parses')}`);
      console.log(`       ${dim('it every execution and it is always planned with the real values. No GUC, no SET')}`);
      console.log(`       ${dim('LOCAL, no transaction, no extra round trip.')}`);
      // Hanging indent rather than an alignment that pretends to line up: the
      // call's own width depends on the table name, so a fixed padding column
      // misaligns on every schema but the one it was written against.
      const args = `where: { ${first.columnField}: value }, orderBy: { ${first.orderColumnField}: 'asc' },`;
      // The accessor is the camelCase FIELD spelling, not the raw table name:
      // TurbineClient and the code generator both define table accessors through
      // snakeToCamel, so `db.user_session` is undefined on every
      // snake_case schema. The finding's own `columnField` / `orderColumnField`
      // are already field-space for the same reason.
      console.log(`       ${dim('On the core client:')}`);
      console.log(`         ${cyan(`db.${snakeToCamel(first.table)}.findMany({`)}`);
      console.log(`           ${cyan(args)}`);
      console.log(`           ${cyan('limit: 20, forceCustomPlan: true,')}`);
      console.log(`         ${cyan('})')}`);
      console.log(`       ${dim("Through turbine-orm/prisma-compat, the same option on the delegate call (Prisma's")}`);
      console.log(`       ${dim('`take`, not `limit`). The Prisma MODEL name is not knowable from the schema side,')}`);
      console.log(`       ${dim('so substitute your own:')}`);
      console.log(`         ${cyan('compat.<Model>.findMany({')}`);
      console.log(`           ${cyan(args)}`);
      console.log(`           ${cyan('take: 20, forceCustomPlan: true,')}`);
      console.log(`         ${cyan('})')}`);
      console.log(
        `       ${dim(`The compat passthrough requires turbine >= ${COMPAT_PASSTHROUGH_VERSION}. On an older version the option`)}`,
      );
      console.log(`       ${dim('is accepted and ignored there, so confirm at the wire with the same')}`);
      console.log(`       ${dim('pg_prepared_statements check in step 1 rather than assuming it took effect.')}`);
      console.log(`    4. Reaching for a database-wide plan_cache_mode is not the fix, whichever client you`);
      console.log(`       ${dim('use. There are measured shapes where a generic plan is dramatically better: an')}`);
      console.log(`       ${dim('unordered LIMIT over a value whose rows are packed at the end of the heap reads')}`);
      console.log(`       ${dim('4,262 buffers under a custom plan against 71 under a generic one. That fixture is')}`);
      console.log(`       ${dim('printed in full at turbineorm.dev/relations, so the number is checkable rather')}`);
      console.log(`       ${dim('than asserted. Pinning every statement')}`);
      console.log(
        `       ${dim('in one direction trades this finding for its mirror image. That applies equally to')}`,
      );
      console.log(`       ${dim("Turbine's client-level `planCacheMode` and to a SET or ALTER ROLE applied outside")}`);
      console.log(`       ${dim('Turbine.')}`);
      console.log(`    5. A composite index on (${first.column}, ${first.orderColumn}) makes the GOOD plan better. It`);
      console.log(
        `       ${dim('does NOT stop the generic plan from choosing the other one, and it can widen the gap.')}`,
      );
      console.log(`       ${dim('Add it for the custom-plan win, not as a fix for this finding.')}`);
    }
    // Stated separately because the first remedy genuinely differs by branch: an
    // UNINDEXED column's flip is fixed by the index, and a per-query plan-cache
    // override there would only paper over a table scan.
    if (findings.some((f) => f.branch === 'unindexed-filter')) {
      console.log(
        `    ${first ? 6 : 3}. A finding on an UNINDEXED column has a different FIRST remedy: add an index that`,
      );
      console.log(`       ${dim('serves the equality, then re-run doctor and re-score. The index moves the')}`);
      console.log(`       ${dim('divergence in both directions at once (it makes the good plan much cheaper, which')}`);
      console.log(
        `       ${dim('widens the ratio, and on a measured fixture it also stopped Postgres promoting the')}`,
      );
      console.log(`       ${dim('generic plan at all), so do not assume the finding is closed by adding it.')}`);
    }
    newline();
    console.log(`  ${dim('This finding is derived from statistics, not from your traffic: it says the DISTRIBUTION')}`);
    console.log(`  ${dim('admits a damaging flip, not that a query is running one today. It cannot see where a')}`);
    console.log(`  ${dim('value physically sits in the heap, so a clean report is not evidence of immunity, and')}`);
    console.log(`  ${dim('a column that is neither an FK nor indexed is not in the scored population at all.')}`);
    renderDivergenceGates(divergence);
    newline();
  }

  if (notices.length > 0) {
    console.log(`  ${dim('Not scored for cached-plan divergence (statistics missing):')}`);
    for (const n of notices) {
      console.log(`    ${dim(`- ${n.table}.${n.column}: ${n.reason}`)}`);
    }
    newline();
  }
}

/** Write the --fix migration (CONCURRENTLY + directive by default; plain with --no-concurrently). */
function renderFixMigration(findings: DoctorFinding[], config: ResolvedConfig, args: CliArgs): void {
  const concurrently = args.noConcurrently !== true;
  const up = findings.map((f) => doctorCreateSql(f, { concurrently })).join('\n');
  const down = findings.map((f) => buildDropIndexSql(f.missing.indexName, { concurrently })).join('\n');

  let file: MigrationFile;
  if (concurrently) {
    file = createMigration(
      config.migrationsDir,
      'add_relation_fk_indexes',
      { up: `${CONCURRENTLY_RECIPE_COMMENT}\n\n${up}`, down },
      { header: '-- turbine:no-transaction' },
    );
  } else {
    file = createMigration(config.migrationsDir, 'add_relation_fk_indexes', { up, down });
  }

  success(`Created migration: ${bold(file.filename)}`);
  newline();
  if (concurrently) {
    console.log(`  ${dim('This is a')} ${cyan('no-transaction')} ${dim('migration (CREATE INDEX CONCURRENTLY).')}`);
    console.log(`  ${dim('Review it, then apply with:')} ${cyan('npx turbine migrate up')}`);
    console.log(
      `  ${dim('For a plain in-transaction migration instead, use')} ${cyan('doctor --fix --no-concurrently')}`,
    );
  } else {
    console.log(`  ${dim('Review it, then apply with:')} ${cyan('npx turbine migrate up')}`);
    console.log(
      `  ${dim('For large, hot tables prefer the CONCURRENTLY form (drop')} ${cyan('--no-concurrently')}${dim(').')}`,
    );
  }
  newline();
}

// ---------------------------------------------------------------------------
// Loopback host gate (Studio / Observe)
// ---------------------------------------------------------------------------

/**
 * True when `host` is a loopback address Studio/Observe may bind without
 * `--allow-remote`. Accepts IPv4, IPv6, and the common bracket form.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

// ---------------------------------------------------------------------------
// Command: studio, local read-only web UI
// ---------------------------------------------------------------------------

async function cmdStudio(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const demo = args.demo === true;
  // Demo mode is self-contained (seeded in-memory database), so it never needs
  // a DATABASE_URL. The placeholder is only used for display.
  const url = demo ? 'demo://in-memory' : requireUrl(config);

  const port = args.port ?? 4983;
  const host = args.host ?? '127.0.0.1';
  const openBrowser = !args.noOpen;

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.log(red(`✗ invalid port: ${args.port}`));
    process.exit(1);
  }

  // Non-loopback binds require an explicit --allow-remote opt-in. Studio has
  // only a random session token, exposing it on a LAN interface is foot-gun
  // territory, so we refuse rather than warn-and-proceed.
  if (!isLoopbackHost(host)) {
    if (!args.allowRemote) {
      error(`Studio refuses to bind to ${yellow(host)} without ${cyan('--allow-remote')}.`);
      newline();
      console.log(`  ${dim('Loopback only by default')} ${dim('(127.0.0.1, localhost, ::1).')}`);
      console.log(`  ${dim('Pass')} ${cyan('--allow-remote')} ${dim('to opt in to network exposure.')}`);
      newline();
      process.exit(1);
    }
    console.log(
      warn(
        `Studio is binding to ${yellow(host)}, this is NOT loopback. ` +
          `Anyone on your network who can reach this port + guess the session token can read your database.`,
      ),
    );
  }

  const spinner = new Spinner(demo ? 'Seeding demo dataset' : 'Introspecting database').start();
  let studio: {
    dispose: () => Promise<void>;
    authToken: string;
    url: string;
    piiTags: { path: string; applied: number } | null;
  };
  try {
    studio = await startStudio({
      url,
      schema: config.schema,
      port,
      host,
      openBrowser,
      include: config.include.length ? config.include : undefined,
      exclude: config.exclude.length ? config.exclude : undefined,
      // Demo boots read-only + PII redacted; the flags are ignored in demo mode
      // (the in-UI switcher controls modes live).
      write: args.write === true,
      showPii: args.showPii === true,
      demo,
      metadataDir: config.out,
    });
    spinner.succeed(demo ? 'Demo Studio is running' : 'Studio is running');
  } catch (err) {
    spinner.fail(`Failed to start Studio: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (demo) {
    newline();
    console.log(
      box(
        [
          `${bold('Turbine Studio')}  ${dim('DEMO MODE (seeded in-memory sample database)')}`,
          '',
          `  ${cyan('URL:')}    ${bold(studio.url)}`,
          `  ${cyan('Data:')}   seeded sample dataset (users, posts, comments, orgs)`,
          `  ${cyan('Modes:')}  switch Read-only / Show PII / Write live from inside the UI`,
          '',
          dim('Nothing you do here is saved anywhere. The database lives only in'),
          dim('memory: every launch starts fresh and restarts reset all edits.'),
          dim('Open the URL above (it carries a one-time session token).'),
          dim('Press Ctrl+C to stop.'),
        ].join('\n'),
        { title: bold(cyan('Studio · demo')), padding: 1 },
      ),
    );
    newline();
  } else {
    // Loud startup warnings for the opt-in modes that widen Studio's surface.
    if (args.write) {
      newline();
      console.log(
        warn(
          'WRITE MODE is ON. Studio can update, insert, and delete single rows in ' +
            `${redactUrl(url)}. Every change is committed directly to your database.`,
        ),
      );
    }
    if (args.showPii) {
      newline();
      console.log(warn('--show-pii is ON. PII-tagged column values are shown UNREDACTED in Studio.'));
    }

    // PII tags are a code-first declaration; introspection never infers them.
    // Say plainly whether any reached this session, so nobody assumes a
    // redaction guarantee that has nothing to act on.
    if (!args.showPii) {
      newline();
      if (studio.piiTags && studio.piiTags.applied > 0) {
        console.log(
          `  ${dim('PII redaction:')} ${studio.piiTags.applied} tagged column(s) from ${dim(studio.piiTags.path)}`,
        );
      } else {
        console.log(
          warn(
            'No PII-tagged columns found, so nothing will be redacted. Tags are declared in code ' +
              `(defineSchema \`pii: true\`) and read from generated metadata in ${config.out}; ` +
              'introspection alone never infers them. Run `turbine generate` after tagging.',
          ),
        );
      }
    }

    newline();
    console.log(
      box(
        [
          `${bold('Turbine Studio')}  ${dim(args.write ? 'local UI (WRITE MODE)' : 'local read-only UI')}`,
          '',
          `  ${cyan('URL:')}    ${bold(studio.url)}`,
          `  ${cyan('Schema:')} ${config.schema}`,
          `  ${cyan('DB:')}     ${redactUrl(url)}`,
          `  ${cyan('Mode:')}   ${args.write ? red('read-write (single-row)') : 'read-only'}`,
          '',
          dim('Open the URL above in your browser. It includes a one-time session'),
          dim('token that gets set as an HttpOnly cookie on first load.'),
          dim('Press Ctrl+C to stop.'),
        ].join('\n'),
        { title: bold(cyan('Studio')), padding: 1 },
      ),
    );
    newline();
  }

  // Wait forever until SIGINT/SIGTERM, then dispose cleanly.
  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log(dim('\n  shutting down…'));
      try {
        await studio.dispose();
      } catch {
        /* ignore */
      }
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

// ---------------------------------------------------------------------------
// Command: mcp, read-only JSON-RPC stdio server
// ---------------------------------------------------------------------------

async function cmdMcp(_args: CliArgs, config: ResolvedConfig): Promise<void> {
  const url = requireUrl(config);
  await runMcpServer({
    url,
    schema: config.schema,
    migrationsDir: config.migrationsDir,
    metadataDir: config.out,
    include: config.include.length ? config.include : undefined,
    exclude: config.exclude.length ? config.exclude : undefined,
  });
}

// ---------------------------------------------------------------------------
// Command: observe
// ---------------------------------------------------------------------------

async function cmdObserve(args: CliArgs): Promise<void> {
  banner();

  const url = process.env.TURBINE_OBSERVE_URL;
  if (!url) {
    error('TURBINE_OBSERVE_URL environment variable is required for the observe command.');
    newline();
    console.log(`  ${dim('Set it to the Postgres connection string where metrics are stored.')}`);
    console.log(`  ${dim('Example:')} ${cyan('TURBINE_OBSERVE_URL=postgres://... npx turbine observe')}`);
    newline();
    process.exit(1);
  }

  const port = args.port ?? 4984;
  const host = args.host ?? '127.0.0.1';
  const openBrowser = !args.noOpen;

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.log(red(`✗ invalid port: ${args.port}`));
    process.exit(1);
  }

  // Non-loopback binds require an explicit --allow-remote opt-in (same model
  // as Studio). Refuse without the flag; warn loudly when opted in.
  if (!isLoopbackHost(host)) {
    if (!args.allowRemote) {
      error(`Observe refuses to bind to ${yellow(host)} without ${cyan('--allow-remote')}.`);
      newline();
      console.log(`  ${dim('Loopback only by default')} ${dim('(127.0.0.1, localhost, ::1).')}`);
      console.log(`  ${dim('Pass')} ${cyan('--allow-remote')} ${dim('to opt in to network exposure.')}`);
      newline();
      process.exit(1);
    }
    console.log(
      warn(
        `Observe is binding to ${yellow(host)}, this is NOT loopback. ` +
          `Anyone on your network who can reach this port + guess the session token can read your metrics.`,
      ),
    );
  }

  const spinner = new Spinner('Connecting to metrics database').start();
  let handle: { dispose: () => Promise<void>; url: string };
  try {
    handle = await startObserve({ url, port, host, openBrowser });
    spinner.succeed('Observe dashboard is running');
  } catch (err) {
    spinner.fail(`Failed to start Observe: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  newline();
  console.log(
    box(
      [
        `${bold('Turbine Observe')}  ${dim(', query metrics dashboard')}`,
        '',
        `  ${cyan('URL:')}  ${bold(handle.url)}`,
        '',
        dim('Open the URL above in your browser. Press Ctrl+C to stop.'),
      ].join('\n'),
      { title: bold(cyan('Observe')), padding: 1 },
    ),
  );
  newline();

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log(dim('\n  shutting down…'));
      try {
        await handle.dispose();
      } catch {
        /* ignore */
      }
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

// ---------------------------------------------------------------------------
// Subcommand help
// ---------------------------------------------------------------------------

function showSubcommandHelp(command: string): boolean {
  const helpMap: Record<string, () => void> = {
    init: showInitHelp,
    generate: showGenerateHelp,
    pull: showGenerateHelp,
    'migrate-from-prisma': showMigrateFromPrismaHelp,
    push: showPushHelp,
    migrate: showMigrateHelp,
    migration: showMigrateHelp,
    seed: showSeedHelp,
    status: showStatusHelp,
    mcp: showMcpHelp,
  };
  const fn = helpMap[command];
  if (fn) {
    fn();
    return true;
  }
  return false;
}

function showInitHelp(): void {
  banner();
  console.log(`  ${bold('turbine init')}, Initialize a Turbine project`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine init ${dim('[options]')}`);
  newline();
  console.log(`  Sequenced, interactive bootstrap. Detects project state and runs only`);
  console.log(`  the needed steps: writes ${cyan('turbine.config.ts')}, offers a starter schema +`);
  console.log(`  seed file, and (when a reachable database is configured) offers to push`);
  console.log(`  the schema, generate the typed client, and run the seed file.`);
  newline();
  console.log(`  ${dim('Re-runs skip completed steps. A non-interactive shell runs the safe')}`);
  console.log(`  ${dim('scaffold + generate steps only; pass --yes to accept every default.')}`);
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}   Postgres connection string to embed in config`);
  console.log(`    ${cyan('--force, -f')}        Overwrite existing config file`);
  console.log(`    ${cyan('--yes, -y')}          Accept every step's default (non-interactive)`);
  console.log(`    ${cyan('--skip-schema')}      Don't create the starter schema file`);
  console.log(`    ${cyan('--skip-seed')}        Don't create the seed file or run the seed`);
  console.log(`    ${cyan('--skip-push')}        Don't push the schema to the database`);
  console.log(`    ${cyan('--skip-generate')}    Don't generate the typed client`);
  newline();
}

function showGenerateHelp(): void {
  banner();
  console.log(`  ${bold('turbine generate')}, Introspect database and generate TypeScript types`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine generate ${dim('[options]')}`);
  newline();
  console.log(`  Connects to your database, reads the schema, and generates:`);
  console.log(`    ${dim('•')} ${cyan('types.ts')}   , Entity interfaces, Create/Update input types`);
  console.log(`    ${dim('•')} ${cyan('metadata.ts')}, Runtime schema metadata`);
  console.log(`    ${dim('•')} ${cyan('index.ts')}   , Configured client with typed table accessors`);
  console.log(`    ${dim('•')} ${cyan('zod.ts')}     , Zod schemas ${dim('(with --zod)')}`);
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}       Postgres connection string`);
  console.log(
    `    ${cyan('--out, -o')} ${dim('<dir>')}       Output directory ${dim('(default: ./generated/turbine)')}`,
  );
  console.log(`    ${cyan('--schema, -s')} ${dim('<name>')}   Postgres schema ${dim('(default: public)')}`);
  console.log(`    ${cyan('--include')} ${dim('<tables>')}    Comma-separated tables to include`);
  console.log(`    ${cyan('--exclude')} ${dim('<tables>')}    Comma-separated tables to exclude`);
  console.log(
    `    ${cyan('--zod')}                 Also emit ${cyan('zod.ts')} validation schemas ${dim('(needs the zod dep)')}`,
  );
  console.log(`    ${cyan('--include-views')}       Include views + materialized views as read-only entities`);
  console.log(
    `    ${cyan('--no-timestamp')}        Omit the ${dim('Generated at:')} header line ${dim('(reproducible, diff-stable output)')}`,
  );
  console.log(
    `    ${cyan('--import-ext')} ${dim('<mode>')}    Sibling-import extension: ${cyan('js')} / ${cyan('none')} / ${cyan('auto')} ${dim('(default: auto)')}`,
  );
  console.log(
    `    ${cyan('--keep-column-names')}   Keep raw DB column names as field names ${dim('(snake_case, not camelCase)')}`,
  );
  console.log(
    `    ${cyan('--legacy-to-many-uniques')} Emit ${cyan('hasMany')} for unique-FK children ${dim('(pre-0.41 shape; default flips to hasOne)')}`,
  );
  console.log(`    ${cyan('--allow-empty')}         Generate even when introspection matches 0 tables`);
  newline();
}

function showMigrateFromPrismaHelp(): void {
  banner();
  console.log(`  ${bold('turbine migrate-from-prisma')} - Map a Prisma schema onto a Turbine client`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine migrate-from-prisma ${dim('--schema prisma/schema.prisma [options]')}`);
  newline();
  console.log(`  Parses your ${cyan('schema.prisma')}, resolves models/fields/relations/compound`);
  console.log(`  uniques against the live database, and writes into the output directory:`);
  console.log(`    ${dim('•')} ${cyan('prisma-migration-report.md')} - per-model resolution + unresolved items`);
  console.log(`    ${dim('•')} ${cyan('prisma-map.ts')}              - typed PRISMA_MAP name map`);
  newline();
  console.log(`  ${dim('Note:')} here ${cyan('--schema')} names the Prisma FILE (not the Postgres namespace).`);
  console.log(
    `  ${dim('Note:')} with no ${cyan('--url')} / ${cyan('DATABASE_URL')} / config ${cyan('url')}, the connection string`,
  );
  console.log(`        declared by your ${cyan('datasource')} block is used (including its ${cyan('env("...")')}).`);
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(
    `    ${cyan('--schema')} ${dim('<file>')}     Path to schema.prisma ${dim('(default: prisma/schema.prisma)')}`,
  );
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}     Postgres connection string ${dim('(unless --no-db)')}`);
  console.log(`    ${cyan('--out, -o')} ${dim('<dir>')}     Output directory ${dim('(default: ./generated/turbine)')}`);
  console.log(`    ${cyan('--no-db')}             Parse-only: write the report without resolving names`);
  console.log(`    ${cyan('--allow-partial')}     Exit 0 even when some items are UNRESOLVED`);
  console.log(`    ${cyan('--no-timestamp')}      Omit the ${dim('Generated:')} lines ${dim('(reproducible output)')}`);
  newline();
  console.log(`  ${bold('Examples:')}`);
  console.log(
    `    ${dim('$')} DATABASE_URL=postgres://... npx turbine migrate-from-prisma --schema prisma/schema.prisma`,
  );
  console.log(`    ${dim('$')} npx turbine migrate-from-prisma --schema prisma/schema.prisma --no-db`);
  newline();
}

function showPushHelp(): void {
  banner();
  console.log(`  ${bold('turbine push')}, Apply schema-builder definitions to database`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine push ${dim('[options]')}`);
  newline();
  console.log(`  Reads your ${cyan('turbine/schema.ts')} file, diffs against the live database,`);
  console.log(`  and applies CREATE/ALTER statements.`);
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}   Postgres connection string`);
  console.log(`    ${cyan('--dry-run')}          Show SQL without executing`);
  console.log(
    `    ${cyan('--allow-destructive')} Skip the interactive confirmation for data-destroying statements ${dim('(CI)')}`,
  );
  console.log(`    ${cyan('--verbose, -v')}      Show detailed output`);
  newline();
}

function showMigrateHelp(): void {
  banner();
  console.log(`  ${bold('turbine migrate')}, SQL migration management`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine migrate ${cyan('<subcommand>')} ${dim('[options]')}`);
  newline();
  console.log(`  ${bold('Subcommands:')}`);
  console.log(`    ${cyan('create')} ${dim('<name>')}   Create a new migration file`);
  console.log(`    ${cyan('up')}              Apply pending migrations`);
  console.log(`    ${cyan('deploy')}          Apply pending migrations without prompts`);
  console.log(`    ${cyan('down')}            Rollback last migration`);
  console.log(`    ${cyan('status')}          Show applied/pending migrations`);
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}   Postgres connection string`);
  console.log(`    ${cyan('--auto')}            Auto-generate UP/DOWN SQL from schema diff ${dim('(create only)')}`);
  console.log(
    `    ${cyan('--from-diff')}       Generate from schema diff, flagging destructive statements ${dim('(create only)')}`,
  );
  console.log(
    `    ${cyan('--recipe')} ${dim('<name>')}   Scaffold a sanctioned migration pattern ${dim('(create only, e.g. backfill)')}`,
  );
  console.log(`    ${cyan('--step, -n')} ${dim('<N>')}    Number of migrations to apply/rollback`);
  console.log(`    ${cyan('--dry-run')}         Show SQL without executing`);
  console.log(`    ${cyan('--allow-drift')}     Bypass checksum validation ${dim('(migrate up only, advanced)')}`);
  console.log(
    `    ${cyan('--allow-destructive')} Run data-destroying migration statements without the interactive confirm`,
  );
  console.log(`    ${cyan('--verbose, -v')}     Show detailed output`);
  newline();
  console.log(`  ${bold('Examples:')}`);
  console.log(`    ${dim('$')} npx turbine migrate create add_users_table`);
  console.log(`    ${dim('$')} npx turbine migrate create add_email_index --auto`);
  console.log(`    ${dim('$')} npx turbine migrate create sync_schema --from-diff`);
  console.log(`    ${dim('$')} npx turbine migrate create backfill_full_name --recipe backfill`);
  console.log(`    ${dim('$')} npx turbine migrate up`);
  console.log(`    ${dim('$')} npx turbine migrate deploy --dry-run`);
  console.log(`    ${dim('$')} npx turbine migrate down --step 2`);
  console.log(`    ${dim('$')} npx turbine migrate status`);
  newline();
}

function showSeedHelp(): void {
  banner();
  console.log(`  ${bold('turbine seed')}, Run seed file`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine seed ${dim('[options]')}`);
  newline();
  console.log(`  Runs the seed file specified in ${cyan('turbine.config.ts')}`);
  console.log(`  ${dim('or the first default candidate: ./seed.ts, ./seed.js, ./seed.sql')}`);
  newline();
  console.log(
    `  ${dim('TypeScript seeds run with')} ${cyan('npx tsx')} ${dim('and can export')} ${cyan('defineSeed(fn)')}${dim('.')}`,
  );
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}   Postgres connection string`);
  newline();
}

function showStatusHelp(): void {
  banner();
  console.log(`  ${bold('turbine status')}, Show database schema summary`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine status ${dim('[options]')}`);
  newline();
  console.log(`  Introspects your database and displays tables, columns,`);
  console.log(`  types, relations, and indexes.`);
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}       Postgres connection string`);
  console.log(`    ${cyan('--schema, -s')} ${dim('<name>')}   Postgres schema ${dim('(default: public)')}`);
  newline();
}

function showMcpHelp(): void {
  banner();
  console.log(`  ${bold('turbine mcp')}, Start read-only MCP server over stdio`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine mcp ${dim('[options]')}`);
  newline();
  console.log(`  Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout and exposes`);
  console.log(`  schema, migration status, doctor, EXPLAIN, and sample-row tools.`);
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}       Postgres connection string`);
  console.log(`    ${cyan('--schema, -s')} ${dim('<name>')}   Postgres schema ${dim('(default: public)')}`);
  console.log(`    ${cyan('--include')} ${dim('<tables>')}    Comma-separated tables to include`);
  console.log(`    ${cyan('--exclude')} ${dim('<tables>')}    Comma-separated tables to exclude`);
  newline();
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  banner();

  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine ${cyan('<command>')} ${dim('[options]')}`);
  newline();

  console.log(`  ${bold('Commands:')}`);
  console.log(`    ${cyan('init')}               Initialize a Turbine project`);
  console.log(`    ${cyan('generate')} ${dim('| pull')}    Introspect database ${symbols.arrow} generate types`);
  console.log(
    `    ${cyan('migrate-from-prisma')} Map a schema.prisma onto Turbine ${dim('(report + typed name map)')}`,
  );
  console.log(`    ${cyan('push')}               Apply schema definitions to database`);
  console.log(`    ${cyan('migrate')} ${dim('<sub>')}      SQL migration management`);
  console.log(`      ${dim('create <name>')}    Create a new migration file`);
  console.log(`      ${dim('up')}               Apply pending migrations`);
  console.log(`      ${dim('deploy')}           Apply pending migrations without prompts`);
  console.log(`      ${dim('down')}             Rollback last migration`);
  console.log(`      ${dim('status')}           Show applied/pending migrations`);
  console.log(`    ${cyan('seed')}               Run seed file`);
  console.log(`    ${cyan('status')} ${dim('| info')}      Show schema summary`);
  console.log(
    `    ${cyan('doctor')}             Index + cached-plan triage ${dim('(--fix, --json, --unused, --audit)')}`,
  );
  console.log(
    `    ${cyan('studio')}             Launch local read-only web UI ${dim('(--write for writes, --demo for a sample DB)')}`,
  );
  console.log(`    ${cyan('mcp')}                Start read-only MCP server over stdio`);
  console.log(`    ${cyan('observe')}            Launch metrics dashboard ${dim('(requires TURBINE_OBSERVE_URL)')}`);
  newline();

  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}      Postgres connection string`);
  console.log(
    `    ${cyan('--out, -o')} ${dim('<dir>')}      Output directory ${dim('(default: ./generated/turbine)')}`,
  );
  console.log(`    ${cyan('--schema, -s')} ${dim('<name>')}  Postgres schema ${dim('(default: public)')}`);
  console.log(`    ${cyan('--include')} ${dim('<tables>')}   Comma-separated tables to include`);
  console.log(`    ${cyan('--exclude')} ${dim('<tables>')}   Comma-separated tables to exclude`);
  console.log(`    ${cyan('--dry-run')}            Show SQL without executing`);
  console.log(`    ${cyan('--verbose, -v')}        Show detailed output`);
  console.log(`    ${cyan('--force, -f')}          Overwrite existing files`);
  newline();

  console.log(`  ${bold('Migrate options:')}`);
  console.log(`    ${cyan('--auto')}               Auto-generate UP/DOWN SQL from schema diff ${dim('(create)')}`);
  console.log(
    `    ${cyan('--from-diff')}          Generate from schema diff, destructive statements flagged ${dim('(create)')}`,
  );
  console.log(
    `    ${cyan('--recipe')} ${dim('<name>')}       Scaffold a named migration recipe, e.g. backfill ${dim('(create)')}`,
  );
  console.log(`    ${cyan('--step, -n')} ${dim('<N>')}       Number of migrations to apply/rollback`);
  console.log(
    `    ${cyan('--allow-destructive')}  Run data-destroying statements without prompting ${dim('(up/down/push)')}`,
  );
  console.log(
    `    ${cyan('--allow-drift')}        Bypass checksum validation on ${cyan('migrate up')} / ${cyan('deploy')} ${dim('(advanced)')}`,
  );
  newline();

  console.log(`  ${bold('Init options:')}`);
  console.log(`    ${cyan('--yes, -y')}            Accept every step's default (non-interactive)`);
  console.log(`    ${cyan('--skip-schema')}        Don't scaffold the schema file`);
  console.log(`    ${cyan('--skip-seed')}          Don't scaffold or run the seed file`);
  console.log(`    ${cyan('--skip-push')}          Don't offer to push the schema to the database`);
  console.log(`    ${cyan('--skip-generate')}      Don't offer to generate the typed client`);
  newline();

  console.log(`  ${bold('Studio / observe options:')}`);
  console.log(`    ${cyan('--port')} ${dim('<n>')}           HTTP port ${dim('(default: 4983 studio, 4984 observe)')}`);
  console.log(`    ${cyan('--host')} ${dim('<addr>')}        Bind address ${dim('(default: 127.0.0.1)')}`);
  console.log(`    ${cyan('--no-open')}            Don't auto-open the browser`);
  console.log(`    ${cyan('--allow-remote')}       Allow non-loopback --host ${dim('(refused without this flag)')}`);
  console.log(
    `    ${cyan('--write')}              Studio: enable single-row update/insert/delete ${dim('(read-only by default)')}`,
  );
  console.log(
    `    ${cyan('--show-pii')}           Studio: show PII-tagged values unredacted ${dim('(redacted by default)')}`,
  );
  console.log(
    `    ${cyan('--demo')}               Studio: launch with a seeded in-memory sample database ${dim('(no DATABASE_URL needed; nothing is saved)')}`,
  );
  newline();

  console.log(`  ${bold('Config file:')}`);
  console.log(`    ${dim('Create')} ${cyan('turbine.config.ts')} ${dim('with')} ${cyan('npx turbine init')}`);
  console.log(`    ${dim('CLI flags override config file values.')}`);
  newline();

  console.log(`  ${bold('Examples:')}`);
  console.log(`    ${dim('$')} npx turbine init --url postgres://user:pass@host/db`);
  console.log(`    ${dim('$')} DATABASE_URL=postgres://... npx turbine generate`);
  console.log(`    ${dim('$')} npx turbine migrate create add_users_table`);
  console.log(`    ${dim('$')} npx turbine migrate up`);
  console.log(`    ${dim('$')} npx turbine migrate deploy --dry-run`);
  console.log(`    ${dim('$')} npx turbine push --dry-run`);
  newline();
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

function showVersion(): void {
  // Walk up from the running script to find the turbine-orm package.json.
  // Using process.argv[1] instead of import.meta.url so the same code compiles
  // cleanly for both the ESM and CJS builds.
  try {
    // Resolve symlinks first: `npx turbine` runs via node_modules/.bin/turbine,
    // a symlink whose dirname would walk the CONSUMER's tree and never find
    // turbine-orm's package.json (printing no version number at all).
    let entry = process.argv[1] ?? '';
    try {
      entry = realpathSync(entry);
    } catch {
      // keep the raw path if realpath fails (e.g. deleted cwd)
    }
    let dir = dirname(entry);
    for (let i = 0; i < 6; i++) {
      const candidate = resolve(dir, 'package.json');
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string };
        if (pkg.name === 'turbine-orm') {
          console.log(`turbine-orm v${pkg.version ?? '?'}`);
          return;
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    console.log(`turbine-orm`);
  } catch {
    console.log(`turbine-orm`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  // Quick exits that don't need config
  if (args.command === 'help' || args.command === '--help' || args.command === '-h') {
    showHelp();
    return;
  }
  // Subcommand help: e.g. `turbine migrate --help`
  if (args.help) {
    if (showSubcommandHelp(args.command)) return;
    showHelp();
    return;
  }
  if (args.command === 'version' || args.command === '--version' || args.command === '-V') {
    showVersion();
    return;
  }

  // Load a local `.env` so `DATABASE_URL` (and every other var it defines) is
  // available to the config file, to `turbine()` in user scripts, and to command
  // resolution: exactly what the quickstart promises. A pre-existing env var
  // always wins. Surfaces the honest state when the file cannot be read.
  const dotEnv = loadDotEnvForCli();
  if (dotEnv.loadError) {
    warn(`Could not read ${cyan('.env')}: ${dotEnv.loadError}. Continuing without it.`);
  } else if (dotEnv.fileExists && dotEnv.unsupported) {
    warn(
      `Found ${cyan('.env')} but this Node version cannot auto-load it. ` +
        `Upgrade to Node 20.12+ or export ${cyan('DATABASE_URL')} yourself.`,
    );
  }

  const overrides: CliOverrides = {
    url: args.url,
    out: args.out,
    schema: args.schema,
    include: args.include,
    exclude: args.exclude,
    importExtension: args.importExtension,
    keepColumnNames: args.keepColumnNames,
    legacyToManyUniques: args.legacyToManyUniques,
  };

  // Resolve the config file (skipped entirely for config-free invocations such
  // as `studio --demo`). A config that exists but fails to import is surfaced
  // loudly (with a name + the underlying error) instead of being swallowed and
  // later misreported as a missing database URL.
  const { config, fileConfig, loadError } = await bootstrapCliConfig(args, overrides);
  if (loadError && args.command !== 'init') {
    const underlying = loadError.error instanceof Error ? loadError.error.message : String(loadError.error);
    warn(`Could not load ${cyan(loadError.filename)}: ${underlying}`);
    if (loadError.error instanceof Error) printCjsHintIfApplicable(loadError.error);
    newline();
  }

  // Warn (don't change precedence) when an .env-sourced DATABASE_URL is silently
  // overriding a differing, non-empty url in the config file (a wrong-database
  // hazard for push/migrate/seed). Shell-exported DATABASE_URL stays silent.
  const urlConflict = dotEnvUrlConflictWarning({
    provenance: dotEnv.databaseUrlProvenance,
    envUrl: process.env.DATABASE_URL,
    fileConfigUrl: fileConfig.url,
    overrideUrl: overrides.url,
  });
  if (urlConflict && args.command !== 'init') {
    warn(urlConflict);
    newline();
  }

  try {
    switch (args.command) {
      case 'init':
        await cmdInit(args, config);
        break;

      case 'generate':
      case 'gen':
      case 'g':
      case 'pull':
        await cmdGenerate(args, config);
        break;

      case 'migrate-from-prisma':
        await cmdMigrateFromPrisma(args, config);
        break;

      case 'push':
        await cmdPush(args, config);
        break;

      case 'migrate':
      case 'migration':
      case 'm':
        await cmdMigrate(args, config);
        break;

      case 'seed':
      case 's':
        await cmdSeed(args, config);
        break;

      case 'status':
      case 'info':
        await cmdStatus(args, config);
        break;

      case 'doctor':
        await cmdDoctor(args, config);
        break;

      case 'studio':
        await cmdStudio(args, config);
        break;

      case 'mcp':
        await cmdMcp(args, config);
        break;

      case 'observe':
        await cmdObserve(args);
        break;

      default:
        error(`Unknown command: ${bold(args.command)}`);
        newline();
        console.log(`  ${dim('Run')} ${cyan('npx turbine help')} ${dim('for available commands.')}`);
        newline();
        process.exit(1);
    }
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('ECONNREFUSED') || err.message.includes('connection')) {
        newline();
        error(`Could not connect to database`);
        console.log(`  ${dim(redactUrl(err.message))}`);
        newline();
        console.log(`  ${dim('Check that:')}`);
        console.log(`    ${dim('1.')} Your database is running`);
        console.log(`    ${dim('2.')} The connection string is correct`);
        console.log(`    ${dim('3.')} Network/firewall allows the connection`);
      } else if (err.message.includes('authentication')) {
        newline();
        error(`Authentication failed`);
        console.log(`  ${dim(redactUrl(err.message))}`);
      } else if (err.message.includes('does not exist')) {
        newline();
        error(`Database or schema not found`);
        console.log(`  ${dim(redactUrl(err.message))}`);
      } else {
        newline();
        error(redactUrl(err.message));
        if (args.verbose && err.stack) {
          newline();
          console.log(dim(redactUrl(err.stack)));
        }
      }
    } else {
      newline();
      error(`Unexpected error: ${redactUrl(String(err))}`);
    }
    newline();
    process.exit(1);
  }
}

function isCliEntry(): boolean {
  // Decide from process.argv[1] instead of import.meta.url so the same code
  // compiles cleanly for both the ESM and CJS builds (see showVersion above).
  // The CLI runs via the bin shim ("turbine"), the built output
  // (dist/[cjs/]cli/index.{js,cjs}), or tsx on the source (src/cli/index.ts).
  // Test files import this module with their own path in argv[1], which never
  // matches these shapes.
  const entry = process.argv[1];
  if (!entry) return false;
  let real = entry;
  try {
    real = realpathSync(entry);
  } catch {
    real = resolve(entry);
  }
  const base = basename(real);
  if (base === 'turbine' || base === 'turbine-orm') return true;
  const isIndexFile = base === 'index.js' || base === 'index.cjs' || base === 'index.ts';
  return isIndexFile && basename(dirname(real)) === 'cli';
}

if (isCliEntry()) {
  void main();
}

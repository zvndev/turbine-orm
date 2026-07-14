#!/usr/bin/env node
/**
 * turbine-orm CLI
 *
 * Commands:
 *   turbine init                  — Initialize a Turbine project
 *   turbine generate | pull       — Introspect database and generate TypeScript types
 *   turbine push                  — Apply schema-builder definitions to database
 *   turbine migrate create <name> — Create a new SQL migration file
 *   turbine migrate up            — Apply pending migrations
 *   turbine migrate deploy        — Apply pending migrations without prompts
 *   turbine migrate down          — Rollback last migration
 *   turbine migrate status        — Show migration status
 *   turbine seed                  — Run seed file
 *   turbine status                — Show schema summary
 *   turbine doctor                — Check relations for missing FK indexes (--fix emits migration)
 *   turbine studio                — Launch local read-only web UI
 *   turbine mcp                   — Start read-only MCP server over JSON-RPC stdio
 *   turbine observe               — Launch metrics dashboard (requires TURBINE_OBSERVE_URL)
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx turbine generate
 *   npx turbine init --url postgres://...
 *   npx turbine migrate create add_users_table
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../generate.js';
import { findMissingRelationIndexes } from '../index-advisor.js';
import { introspect } from '../introspect.js';
import type { SchemaDef } from '../schema-builder.js';
import { schemaDiff, schemaPush } from '../schema-sql.js';
import type { CliOverrides, ResolvedConfig } from './config.js';
import {
  configTemplate,
  findConfigFile,
  loadConfigResult,
  looksLikeSchemaFilePath,
  resolveConfig,
  resolveSeedFile,
  unwrapModuleDefault,
} from './config.js';
import { canResolveTsx, getTsLoaderError, needsTsLoader, registerTsLoader } from './loader.js';
import { runMcpServer } from './mcp.js';
import {
  createMigration,
  inspectMigrationDeploy,
  listMigrationFiles,
  migrateDeploy,
  migrateDown,
  migrateStatus,
  migrateUp,
} from './migrate.js';
import { startObserve } from './observe.js';
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
// Argument parsing (zero deps — just process.argv)
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
  allowDrift?: boolean;
  allowEmpty?: boolean;
  allowDestructive?: boolean;
  fix?: boolean;
  // generate flags
  zod?: boolean;
  includeViews?: boolean;
  /** Omit the `Generated at:` header line for reproducible (diff-stable) output. */
  noTimestamp?: boolean;
  // studio / observe flags
  port?: number;
  host?: string;
  noOpen?: boolean;
  /** Opt-in to bind Studio/Observe on a non-loopback host. */
  allowRemote?: boolean;
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
      case '--allow-drift':
        result.allowDrift = true;
        break;
      case '--allow-empty':
        result.allowEmpty = true;
        break;
      case '--fix':
        result.fix = true;
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
      case '--allow-destructive':
        result.allowDestructive = true;
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
// TypeScript loader — user-facing error helper
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
    // cause — telling the user to install tsx here would be a misdiagnosis.
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
// Helpers
// ---------------------------------------------------------------------------

function requireUrl(config: ResolvedConfig): string {
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
// Command: init
// ---------------------------------------------------------------------------

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

  if (envUrl) {
    success(`Detected ${cyan('DATABASE_URL')} in the environment`);
  } else if (hasEnvFile && !canAutoLoadEnv) {
    info(
      `Found ${cyan('.env')} ${dim('(this Node version cannot auto-load it. Upgrade to Node 20.12+ or export')} ${cyan('DATABASE_URL')}${dim(')')}`,
    );
  } else if (hasEnvFile) {
    // .env exists but did not provide DATABASE_URL; if it had, the auto-load
    // in main() would have populated envUrl above.
    info(`Found ${cyan('.env')} ${dim('(no')} ${cyan('DATABASE_URL')} ${dim('set in it yet)')}`);
  } else if (hasEnvLocal) {
    info(`Found ${cyan('.env.local')} ${dim('(note: Turbine only auto-loads')} ${cyan('.env')}${dim(')')}`);
  } else {
    info(`No ${cyan('DATABASE_URL')} found in environment`);
  }
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

  const configPath = findConfigFile();

  // Create config file
  if (configPath && !args.force) {
    warn(`Config file already exists: ${dim(configPath)}`);
    console.log(`  ${dim('Run with')} ${cyan('--force')} ${dim('to overwrite')}`);
  } else {
    const urlForConfig = args.url ?? undefined;
    const configContent = configTemplate(urlForConfig);
    writeFileSync('turbine.config.ts', configContent, 'utf-8');
    if (configPath) {
      success(`Overwrote ${cyan('turbine.config.ts')}`);
    } else {
      success(`Created ${cyan('turbine.config.ts')}`);
    }
  }

  // Create migrations directory
  const migrDir = config.migrationsDir;
  if (!existsSync(migrDir)) {
    mkdirSync(migrDir, { recursive: true });
    // Create .gitkeep
    writeFileSync(`${migrDir}/.gitkeep`, '', 'utf-8');
    success(`Created ${cyan(`${migrDir}/`)}`);
  } else {
    info(`Migrations dir already exists: ${dim(migrDir)}`);
  }

  // Create output directory
  if (!existsSync(config.out)) {
    mkdirSync(config.out, { recursive: true });
    success(`Created ${cyan(`${config.out}/`)}`);
  }

  // Create seed file template
  const initSeedFile = config.seedFile ?? './seed.ts';
  const seedDir = dirname(initSeedFile);
  if (!existsSync(initSeedFile)) {
    if (!existsSync(seedDir)) {
      mkdirSync(seedDir, { recursive: true });
    }
    writeFileSync(
      initSeedFile,
      `/**
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
`,
      'utf-8',
    );
    success(`Created ${cyan(initSeedFile)}`);
  }

  // Create schema builder template
  if (!existsSync(config.schemaFile)) {
    const schemaDir = config.schemaFile.substring(0, config.schemaFile.lastIndexOf('/'));
    if (!existsSync(schemaDir)) {
      mkdirSync(schemaDir, { recursive: true });
    }
    writeFileSync(
      config.schemaFile,
      `/**
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
`,
      'utf-8',
    );
    success(`Created ${cyan(config.schemaFile)}`);
  }

  // Add .gitignore entries for generated output and config (may contain connection strings)
  const gitignorePath = '.gitignore';
  if (existsSync(gitignorePath)) {
    const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
    const additions: string[] = [];
    if (!gitignoreContent.includes('generated/turbine')) {
      additions.push('generated/turbine/');
    }
    if (!gitignoreContent.includes('turbine.config.ts')) {
      additions.push('turbine.config.ts');
    }
    if (additions.length > 0) {
      appendFileSync(gitignorePath, `\n# Turbine generated client & config\n${additions.join('\n')}\n`);
      success(`Added ${cyan(additions.join(', '))} to ${cyan('.gitignore')}`);
    }
  }

  // If we have a URL, run initial generate
  const url = args.url ?? envUrl ?? config.url;
  if (url) {
    newline();
    divider();
    newline();

    const spinner = new Spinner('Introspecting database').start();
    try {
      const schema = await introspect({
        connectionString: url,
        schema: config.schema,
        include: config.include.length ? config.include : undefined,
        exclude: config.exclude.length ? config.exclude : undefined,
      });

      const tableCount = Object.keys(schema.tables).length;
      spinner.succeed(`Found ${bold(String(tableCount))} tables`);

      const genSpinner = new Spinner('Generating TypeScript client').start();
      const result = generate({ schema, outDir: config.out, connectionString: url });
      genSpinner.succeed(`Generated ${bold(String(result.files.length))} files to ${cyan(`${config.out}/`)}`);
    } catch (err) {
      spinner.fail('Could not connect to database');
      if (err instanceof Error) {
        console.log(`  ${dim(redactUrl(err.message))}`);
      }
      newline();
      info(`You can run generation later with: ${cyan('npx turbine generate')}`);
    }
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
    if (!canResolveTsx()) {
      console.log(
        `     ${dim('Note: the TypeScript config requires')} ${cyan('tsx')} ${dim('—')} ${cyan('npm install --save-dev tsx')}`,
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
  // NOT the path to your schema-builder file — that goes in `schemaFile`. If the
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
      `    ${green('schema:')} ${cyan("'public'")}${dim(",       // or omit — introspects the 'public' schema")}`,
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

  const schema = await introspect({
    connectionString: url,
    schema: config.schema,
    include: config.include.length ? config.include : undefined,
    exclude: config.exclude.length ? config.exclude : undefined,
    includeViews: args.includeViews,
  });

  const tableNames = Object.keys(schema.tables);
  const totalColumns = Object.values(schema.tables).reduce((sum, t) => sum + t.columns.length, 0);
  const totalRelations = Object.values(schema.tables).reduce((sum, t) => sum + Object.keys(t.relations).length, 0);

  spinner.succeed(
    `Found ${bold(String(tableNames.length))} tables, ${bold(String(totalColumns))} columns, ${bold(String(totalRelations))} relations`,
  );

  // Guard: zero tables means the generated client would be empty. That is almost
  // always a misconfiguration (wrong `schema`, an include/exclude that filtered
  // everything, or a database with no tables yet) rather than intent. Fail loudly
  // instead of silently emitting an empty typed client.
  if (tableNames.length === 0 && !args.allowEmpty) {
    newline();
    error(`Introspection matched 0 tables in schema ${cyan(config.schema)} — refusing to generate an empty client.`);
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
      `    ${dim('•')} ${dim('The database has no tables yet — run')} ${cyan('turbine push')} ${dim('or a migration first.')}`,
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

  if (args.dryRun) {
    info('Dry run — no changes applied.');
    newline();
    return;
  }

  // Execute
  const pushSpinner = new Spinner('Applying changes').start();
  const result = await schemaPush(schemaDef, url);
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
    console.log(`  ${bold('turbine migrate')} ${dim('— SQL-first migration system')}`);
    newline();
    console.log(`  ${bold('Commands:')}`);
    console.log(`    ${cyan('create <name>')}         Create a new migration file`);
    console.log(`    ${cyan('create <name> --auto')}  Auto-generate from schema diff`);
    console.log(`    ${cyan('up')}                    Apply pending migrations`);
    console.log(`    ${cyan('deploy')}                Apply pending migrations without prompts`);
    console.log(`    ${cyan('down')}                  Rollback last migration`);
    console.log(`    ${cyan('status')}                Show migration status`);
    newline();
    console.log(`  ${bold('Options:')}`);
    console.log(`    ${cyan('--auto')}           Auto-generate UP/DOWN SQL from schema diff`);
    console.log(`    ${cyan('--step, -n')}       Number of migrations to apply/rollback`);
    console.log(`    ${cyan('--dry-run')}        Show SQL without executing`);
    console.log(
      `    ${cyan('--allow-drift')}    Bypass checksum validation on ${cyan('migrate up')} ${dim('(advanced)')}`,
    );
    newline();
    console.log(`  ${bold('Examples:')}`);
    console.log(`    ${dim('npx turbine migrate create add_users_table')}`);
    console.log(`    ${dim('npx turbine migrate create add_email_index --auto')}`);
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
      diffSpinner.succeed('Database is already in sync — nothing to migrate');
      newline();
      return;
    }

    diffSpinner.succeed(`Found ${bold(String(diff.statements.length))} change(s)`);
    newline();

    const upSQL = diff.statements.join('\n');
    const downSQL = diff.reverseStatements.join('\n');
    const file = createMigration(config.migrationsDir, name, { up: upSQL, down: downSQL });
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

    console.log(`  ${dim('Review the migration, then run:')}`);
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

  // Big, loud warning when bypassing drift detection — this is a deliberately
  // dangerous operation and the user should see it on every invocation.
  if (args.allowDrift) {
    warn('--allow-drift is set — checksum validation is DISABLED for this run.');
    console.log(`  ${dim('Applied migrations may have been modified or deleted on disk.')}`);
    console.log(`  ${dim('Proceed only if you are intentionally rewriting migration history.')}`);
    newline();
  }

  if (args.allowDestructive) {
    warn('--allow-destructive is set — data-destroying statements in migrations WILL run.');
    newline();
  }

  const spinner = new Spinner('Applying migrations').start();

  let result: Awaited<ReturnType<typeof migrateUp>>;
  try {
    result = await migrateUp(url, config.migrationsDir, {
      step: args.step,
      allowDrift: args.allowDrift,
      allowDestructive: args.allowDestructive,
    });
  } catch (err) {
    if (!isDestructiveRefusal(err)) throw err;
    spinner.stop();
    if (!(await confirmDestructive((err as Error).message))) {
      error('Aborted — no migrations were applied and no data was touched.');
      newline();
      process.exit(1);
    }
    spinner.start();
    result = await migrateUp(url, config.migrationsDir, {
      step: args.step,
      allowDrift: args.allowDrift,
      allowDestructive: true,
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

export function buildMigrateDeployOptions(_args: CliArgs): {
  allowDrift: false;
  allowDestructive: true;
  step: undefined;
} {
  return {
    allowDrift: false,
    allowDestructive: true,
    step: undefined,
  };
}

async function cmdMigrateDeploy(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);

  label('Database', redactUrl(url));
  label('Migrations', config.migrationsDir);
  newline();

  if (args.dryRun) {
    const spinner = new Spinner('Checking pending migrations').start();
    const plan = await inspectMigrationDeploy(url, config.migrationsDir);
    if (plan.mismatches.length > 0) {
      spinner.fail('Deploy blocked by migration drift');
      for (const mismatch of plan.mismatches) {
        const reason = mismatch.type === 'missing' ? 'deleted from disk' : 'modified on disk';
        console.log(`    ${red(symbols.cross)} ${mismatch.name}.sql ${dim(`(${reason})`)}`);
      }
      newline();
      process.exit(1);
    }

    if (plan.pending.length === 0) {
      spinner.succeed('No pending migrations');
      newline();
      return;
    }

    spinner.succeed(`${bold(String(plan.pending.length))} pending migration(s)`);
    for (const file of plan.pending) {
      console.log(`    ${yellow(symbols.dot)} ${file.filename}`);
    }
    newline();
    return;
  }

  const spinner = new Spinner('Deploying migrations').start();
  const result = await migrateDeploy(url, config.migrationsDir);

  if (result.applied.length === 0 && result.errors.length === 0) {
    spinner.succeed('0 applied — all migrations are up to date');
    newline();
    return;
  }

  if (result.applied.length > 0) {
    spinner.succeed(`${bold(String(result.applied.length))} applied`);
    for (const file of result.applied) {
      console.log(`    ${green(symbols.check)} ${file.filename}`);
    }
  }

  if (result.errors.length > 0) {
    spinner.fail('Deploy failed');
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
 * Non-interactive shells (CI, pipes) can never pass this — they must use the
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
      `  Final confirmation — apply the destructive statements above? Type ${bold('yes')}: `,
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
      error('Aborted — nothing was rolled back and no data was touched.');
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

  // Check for checksum mismatches
  const driftCount = statuses.filter((s) => s.checksumValid === false).length;
  if (driftCount > 0) {
    warn(`${bold(String(driftCount))} migration(s) have been modified after application!`);
    console.log(`  ${dim('Applied migrations should be immutable. Modifying them can cause drift.')}`);
    newline();
  }

  // Format as table
  const headers = ['Status', 'Migration', 'Applied at'];
  const rows = statuses.map((s) => {
    let status: string;
    if (s.applied && s.checksumValid === false) {
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
        : dim('—'),
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
        throw new Error('TypeScript seed files require tsx — install tsx or use seed.js/seed.sql.');
      }
      const { execFileSync } = await import('node:child_process');
      execFileSync(plan.command, plan.args, {
        stdio: 'inherit',
        env: {
          ...process.env,
          DATABASE_URL: config.url || process.env.DATABASE_URL,
        },
      });
      return;
    }

    if (plan.kind === 'js') {
      const mod = await import(pathToFileURL(plan.file).href);
      if (typeof mod.default === 'function') {
        await mod.default();
      }
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
// Command: doctor — relation/index health check
// ---------------------------------------------------------------------------

async function cmdDoctor(args: CliArgs, config: ResolvedConfig): Promise<void> {
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
  });

  const missing = findMissingRelationIndexes(schema);

  if (missing.length === 0) {
    spinner.succeed('Every relation probe is backed by an index');
    newline();
    return;
  }

  spinner.succeed(`Scanned ${bold(String(Object.keys(schema.tables).length))} tables`);
  warn(`Found ${bold(String(missing.length))} unindexed relation probe(s)`);
  newline();

  // Row counts put the findings in severity order: a missing index on a 300-row
  // table is noise; on a 300K-row table it is the whole page load.
  const rowCounts = new Map<string, number>();
  {
    const { Pool } = (await import('pg')).default;
    const pool = new Pool({ connectionString: url, max: 1 });
    try {
      const tables = [...new Set(missing.map((m) => m.table))];
      const res = await pool.query<{ relname: string; reltuples: string }>(
        `SELECT c.relname, c.reltuples::bigint::text AS reltuples
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = ANY($2)`,
        [config.schema, tables],
      );
      for (const row of res.rows) rowCounts.set(row.relname, Math.max(0, Number(row.reltuples)));
    } finally {
      await pool.end();
    }
  }

  missing.sort((a, b) => (rowCounts.get(b.table) ?? 0) - (rowCounts.get(a.table) ?? 0));

  console.log(`  ${dim('Turbine loads relations as correlated subqueries — the child table is probed')}`);
  console.log(`  ${dim('once per parent row, so an unindexed FK costs a full table scan PER PARENT.')}`);
  newline();

  for (const m of missing) {
    const rows = rowCounts.get(m.table);
    const rowsLabel = rows !== undefined ? `~${rows.toLocaleString()} rows` : 'row count unknown';
    console.log(
      `  ${yellow(symbols.warning)} ${bold(cyan(m.table))} ${dim(`(${m.columns.join(', ')})`)}  ${gray(rowsLabel)}`,
    );
    for (const p of m.probes) {
      console.log(`    ${dim(symbols.tee)} probed by ${p.from}.${blue(p.relation)} ${dim(`(${p.type})`)}`);
    }
    console.log(`    ${dim(symbols.teeEnd)} ${green(m.createSql)}`);
    newline();
  }

  if (args.fix) {
    const up = missing.map((m) => m.createSql).join('\n');
    const down = missing.map((m) => m.dropSql).join('\n');
    const file = createMigration(config.migrationsDir, 'add_relation_fk_indexes', { up, down });
    success(`Created migration: ${bold(file.filename)}`);
    newline();
    console.log(`  ${dim('Review it, then apply with:')} ${cyan('npx turbine migrate up')}`);
    console.log(
      `  ${dim('Large, hot tables: consider running the statements manually with')} ${cyan('CREATE INDEX CONCURRENTLY')}`,
    );
    console.log(`  ${dim('(cannot run inside a transaction, so it is not emitted in the migration).')}`);
    newline();
  } else {
    console.log(`  ${dim('Generate a fix migration with:')} ${cyan('npx turbine doctor --fix')}`);
    newline();
  }
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
// Command: studio — local read-only web UI
// ---------------------------------------------------------------------------

async function cmdStudio(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);

  const port = args.port ?? 4983;
  const host = args.host ?? '127.0.0.1';
  const openBrowser = !args.noOpen;

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    console.log(red(`✗ invalid port: ${args.port}`));
    process.exit(1);
  }

  // Non-loopback binds require an explicit --allow-remote opt-in. Studio has
  // only a random session token — exposing it on a LAN interface is foot-gun
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
        `Studio is binding to ${yellow(host)} — this is NOT loopback. ` +
          `Anyone on your network who can reach this port + guess the session token can read your database.`,
      ),
    );
  }

  const spinner = new Spinner('Introspecting database').start();
  let studio: { dispose: () => Promise<void>; authToken: string; url: string };
  try {
    studio = await startStudio({
      url,
      schema: config.schema,
      port,
      host,
      openBrowser,
      include: config.include.length ? config.include : undefined,
      exclude: config.exclude.length ? config.exclude : undefined,
    });
    spinner.succeed(`Studio is running`);
  } catch (err) {
    spinner.fail(`Failed to start Studio: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  newline();
  console.log(
    box(
      [
        `${bold('Turbine Studio')}  ${dim('— local read-only UI')}`,
        '',
        `  ${cyan('URL:')}    ${bold(studio.url)}`,
        `  ${cyan('Schema:')} ${config.schema}`,
        `  ${cyan('DB:')}     ${redactUrl(url)}`,
        '',
        dim('Open the URL above in your browser. It includes a one-time session'),
        dim('token that gets set as an HttpOnly cookie on first load.'),
        dim('Press Ctrl+C to stop.'),
      ].join('\n'),
      { title: bold(cyan('Studio')), padding: 1 },
    ),
  );
  newline();

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
// Command: mcp — read-only JSON-RPC stdio server
// ---------------------------------------------------------------------------

async function cmdMcp(_args: CliArgs, config: ResolvedConfig): Promise<void> {
  const url = requireUrl(config);
  await runMcpServer({
    url,
    schema: config.schema,
    migrationsDir: config.migrationsDir,
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
        `Observe is binding to ${yellow(host)} — this is NOT loopback. ` +
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
        `${bold('Turbine Observe')}  ${dim('— query metrics dashboard')}`,
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
  console.log(`  ${bold('turbine init')} — Initialize a Turbine project`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine init ${dim('[options]')}`);
  newline();
  console.log(`  Creates ${cyan('turbine.config.ts')}, migrations directory, seed file template,`);
  console.log(`  and schema file template.`);
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}   Postgres connection string to embed in config`);
  console.log(`    ${cyan('--force, -f')}        Overwrite existing config file`);
  newline();
}

function showGenerateHelp(): void {
  banner();
  console.log(`  ${bold('turbine generate')} — Introspect database and generate TypeScript types`);
  newline();
  console.log(`  ${bold('Usage:')}`);
  console.log(`    npx turbine generate ${dim('[options]')}`);
  newline();
  console.log(`  Connects to your database, reads the schema, and generates:`);
  console.log(`    ${dim('•')} ${cyan('types.ts')}    — Entity interfaces, Create/Update input types`);
  console.log(`    ${dim('•')} ${cyan('metadata.ts')} — Runtime schema metadata`);
  console.log(`    ${dim('•')} ${cyan('index.ts')}    — Configured client with typed table accessors`);
  console.log(`    ${dim('•')} ${cyan('zod.ts')}      — Zod schemas ${dim('(with --zod)')}`);
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
  console.log(`    ${cyan('--allow-empty')}         Generate even when introspection matches 0 tables`);
  newline();
}

function showPushHelp(): void {
  banner();
  console.log(`  ${bold('turbine push')} — Apply schema-builder definitions to database`);
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
  console.log(`    ${cyan('--verbose, -v')}      Show detailed output`);
  newline();
}

function showMigrateHelp(): void {
  banner();
  console.log(`  ${bold('turbine migrate')} — SQL migration management`);
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
  console.log(`    ${cyan('--step, -n')} ${dim('<N>')}    Number of migrations to apply/rollback`);
  console.log(`    ${cyan('--dry-run')}         Show SQL without executing`);
  console.log(`    ${cyan('--allow-drift')}     Bypass checksum validation ${dim('(migrate up only — advanced)')}`);
  console.log(
    `    ${cyan('--allow-destructive')} Run data-destroying migration statements without the interactive confirm`,
  );
  console.log(`    ${cyan('--verbose, -v')}     Show detailed output`);
  newline();
  console.log(`  ${bold('Examples:')}`);
  console.log(`    ${dim('$')} npx turbine migrate create add_users_table`);
  console.log(`    ${dim('$')} npx turbine migrate create add_email_index --auto`);
  console.log(`    ${dim('$')} npx turbine migrate up`);
  console.log(`    ${dim('$')} npx turbine migrate deploy --dry-run`);
  console.log(`    ${dim('$')} npx turbine migrate down --step 2`);
  console.log(`    ${dim('$')} npx turbine migrate status`);
  newline();
}

function showSeedHelp(): void {
  banner();
  console.log(`  ${bold('turbine seed')} — Run seed file`);
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
  console.log(`  ${bold('turbine status')} — Show database schema summary`);
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
  console.log(`  ${bold('turbine mcp')} — Start read-only MCP server over stdio`);
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
    `    ${cyan('doctor')}             Check relations for missing FK indexes ${dim('(--fix emits migration)')}`,
  );
  console.log(`    ${cyan('studio')}             Launch local read-only web UI`);
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
  console.log(`    ${cyan('--step, -n')} ${dim('<N>')}       Number of migrations to apply/rollback`);
  console.log(
    `    ${cyan('--allow-drift')}        Bypass checksum validation on ${cyan('migrate up')} ${dim('(advanced)')}`,
  );
  newline();

  console.log(`  ${bold('Studio / observe options:')}`);
  console.log(`    ${cyan('--port')} ${dim('<n>')}           HTTP port ${dim('(default: 4983 studio, 4984 observe)')}`);
  console.log(`    ${cyan('--host')} ${dim('<addr>')}        Bind address ${dim('(default: 127.0.0.1)')}`);
  console.log(`    ${cyan('--no-open')}            Don't auto-open the browser`);
  console.log(`    ${cyan('--allow-remote')}       Allow non-loopback --host ${dim('(refused without this flag)')}`);
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

  // Load config file. A config that exists but fails to import is surfaced
  // loudly (with a name + the underlying error) instead of being swallowed and
  // later misreported as a missing database URL.
  const { config: fileConfig, loadError } = await loadConfigResult();
  if (loadError && args.command !== 'init') {
    const underlying = loadError.error instanceof Error ? loadError.error.message : String(loadError.error);
    warn(`Could not load ${cyan(loadError.filename)}: ${underlying}`);
    if (loadError.error instanceof Error) printCjsHintIfApplicable(loadError.error);
    newline();
  }

  const overrides: CliOverrides = {
    url: args.url,
    out: args.out,
    schema: args.schema,
    include: args.include,
    exclude: args.exclude,
  };

  const config = resolveConfig(fileConfig, overrides);

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

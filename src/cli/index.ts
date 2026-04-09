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
 *   turbine migrate down          — Rollback last migration
 *   turbine migrate status        — Show migration status
 *   turbine seed                  — Run seed file
 *   turbine status                — Show schema summary
 *   turbine studio                — Launch local read-only web UI
 *
 * Usage:
 *   DATABASE_URL=postgres://... npx turbine generate
 *   npx turbine init --url postgres://...
 *   npx turbine migrate create add_users_table
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generate } from '../generate.js';
import { introspect } from '../introspect.js';
import type { SchemaDef } from '../schema-builder.js';
import { schemaDiff, schemaPush } from '../schema-sql.js';
import type { CliOverrides, ResolvedConfig } from './config.js';
import { configTemplate, findConfigFile, loadConfig, resolveConfig } from './config.js';
import { needsTsLoader, registerTsLoader } from './loader.js';
import { createMigration, listMigrationFiles, migrateDown, migrateStatus, migrateUp } from './migrate.js';
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

interface CliArgs {
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
  // studio flags
  port?: number;
  host?: string;
  noOpen?: boolean;
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
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
function failMissingTsLoader(filePath: string, reason: 'missing' | 'unsupported'): never {
  newline();
  error(`Cannot load TypeScript file: ${filePath}`);
  newline();
  if (reason === 'unsupported') {
    console.log(`  ${dim('Your Node.js version does not support')} ${cyan('module.register()')}.`);
    console.log(
      `  ${dim('Upgrade to Node.js')} ${cyan('20.6+')} ${dim('or use a')} ${cyan('.js')} ${dim('/')} ${cyan('.mjs')} ${dim('config file.')}`,
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
    console.log(`    ${dim('2.')} Set ${cyan('DATABASE_URL')} environment variable`);
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
    if (status === 'missing' || status === 'unsupported') {
      failMissingTsLoader(schemaFile, status);
    }
  }

  try {
    const fileUrl = pathToFileURL(absPath).href;
    const mod = await import(fileUrl);
    const schema: SchemaDef = mod.default ?? mod;
    if (!schema.tables) {
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
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Command: init
// ---------------------------------------------------------------------------

async function cmdInit(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  header('Initializing Turbine project');

  // Detect environment
  const envUrl = process.env.DATABASE_URL;
  const hasEnvFile = existsSync('.env');
  const hasEnvLocal = existsSync('.env.local');

  if (envUrl) {
    success(`Detected ${cyan('DATABASE_URL')} in environment`);
  } else if (hasEnvLocal) {
    info(`Found ${cyan('.env.local')} — Turbine will use ${cyan('DATABASE_URL')} from it if set`);
  } else if (hasEnvFile) {
    info(`Found ${cyan('.env')} — Turbine will use ${cyan('DATABASE_URL')} from it if set`);
  } else {
    info(`No ${cyan('DATABASE_URL')} found in environment`);
  }
  newline();

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
  const seedDir = config.seedFile.substring(0, config.seedFile.lastIndexOf('/'));
  if (!existsSync(config.seedFile)) {
    if (!existsSync(seedDir)) {
      mkdirSync(seedDir, { recursive: true });
    }
    writeFileSync(
      config.seedFile,
      `/**
 * Turbine seed file
 *
 * Run with: npx turbine seed
 */

// import { turbine } from '${config.out.replace('./', '')}';
//
// const db = turbine({ connectionString: process.env.DATABASE_URL });
//
// async function seed() {
//   console.log('Seeding database...');
//
//   // Add your seed data here:
//   // await db.users.create({ data: { email: 'admin@example.com', name: 'Admin' } });
//
//   console.log('Done!');
//   await db.disconnect();
// }
//
// seed();
`,
      'utf-8',
    );
    success(`Created ${cyan(config.seedFile)}`);
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
  //   created_at: { type: 'timestamptz', default: 'NOW()' },
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
  });

  const tableNames = Object.keys(schema.tables);
  const totalColumns = Object.values(schema.tables).reduce((sum, t) => sum + t.columns.length, 0);
  const totalRelations = Object.values(schema.tables).reduce((sum, t) => sum + Object.keys(t.relations).length, 0);

  spinner.succeed(
    `Found ${bold(String(tableNames.length))} tables, ${bold(String(totalColumns))} columns, ${bold(String(totalRelations))} relations`,
  );

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

  const spinner = new Spinner('Applying migrations').start();

  const result = await migrateUp(url, config.migrationsDir, {
    step: args.step,
    allowDrift: args.allowDrift,
  });

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

async function cmdMigrateDown(args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();
  const url = requireUrl(config);

  label('Database', redactUrl(url));
  label('Migrations', config.migrationsDir);
  newline();

  const spinner = new Spinner('Rolling back migration(s)').start();

  const result = await migrateDown(url, config.migrationsDir, {
    step: args.step ?? 1,
  });

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

async function cmdSeed(_args: CliArgs, config: ResolvedConfig): Promise<void> {
  banner();

  const seedFile = resolve(config.seedFile);
  label('Seed file', config.seedFile);
  newline();

  if (!existsSync(seedFile)) {
    error(`Seed file not found: ${config.seedFile}`);
    newline();
    console.log(`  ${dim('Create one with:')} ${cyan('npx turbine init')}`);
    console.log(`  ${dim('Or set a custom path in')} ${cyan('turbine.config.ts')}`);
    newline();
    process.exit(1);
  }

  const spinner = new Spinner('Running seed file').start();

  try {
    // Use child_process to run the seed file via tsx or node
    const { execFileSync } = await import('node:child_process');

    // Try tsx first (most compatible with .ts files), fall back to node --experimental-strip-types
    const runners = [
      { cmd: 'npx', args: ['tsx', seedFile], name: 'tsx' },
      { cmd: 'node', args: ['--experimental-strip-types', seedFile], name: 'node' },
    ];

    let ran = false;
    for (const runner of runners) {
      try {
        execFileSync(runner.cmd, runner.args, {
          stdio: 'inherit',
          env: {
            ...process.env,
            DATABASE_URL: config.url || process.env.DATABASE_URL,
          },
        });
        ran = true;
        break;
      } catch (err) {
        // If tsx not found, try next runner
        if (err instanceof Error && 'status' in err && err.status === null) {
          continue;
        }
        throw err;
      }
    }

    if (!ran) {
      throw new Error('Could not find tsx or compatible Node.js version to run .ts files');
    }

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
        console.log(
          `    ${dim(prefix)} ${relColor(relName)} ${dim(symbols.arrow)} ${rel.to} ${dim(`(${rel.type}, FK: ${rel.foreignKey})`)}`,
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

  // Refuse to bind anything other than loopback unless explicitly overridden.
  // This is deliberate: Studio has no real authentication beyond a random
  // session token, so exposing it on a LAN interface is foot-gun territory.
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
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
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}       Postgres connection string`);
  console.log(
    `    ${cyan('--out, -o')} ${dim('<dir>')}       Output directory ${dim('(default: ./generated/turbine)')}`,
  );
  console.log(`    ${cyan('--schema, -s')} ${dim('<name>')}   Postgres schema ${dim('(default: public)')}`);
  console.log(`    ${cyan('--include')} ${dim('<tables>')}    Comma-separated tables to include`);
  console.log(`    ${cyan('--exclude')} ${dim('<tables>')}    Comma-separated tables to exclude`);
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
  console.log(`    ${cyan('down')}            Rollback last migration`);
  console.log(`    ${cyan('status')}          Show applied/pending migrations`);
  newline();
  console.log(`  ${bold('Options:')}`);
  console.log(`    ${cyan('--url, -u')} ${dim('<url>')}   Postgres connection string`);
  console.log(`    ${cyan('--step, -n')} ${dim('<N>')}    Number of migrations to apply/rollback`);
  console.log(`    ${cyan('--dry-run')}          Show SQL without executing`);
  console.log(`    ${cyan('--allow-drift')}      Bypass checksum validation ${dim('(migrate up only — advanced)')}`);
  console.log(`    ${cyan('--verbose, -v')}      Show detailed output`);
  newline();
  console.log(`  ${bold('Examples:')}`);
  console.log(`    ${dim('$')} npx turbine migrate create add_users_table`);
  console.log(`    ${dim('$')} npx turbine migrate up`);
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
  console.log(`  ${dim('(default: ./turbine/seed.ts)')}`);
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
  console.log(`    ${cyan('generate')} ${dim('| pull')}   Introspect database ${symbols.arrow} generate types`);
  console.log(`    ${cyan('push')}               Apply schema definitions to database`);
  console.log(`    ${cyan('migrate')} ${dim('<sub>')}     SQL migration management`);
  console.log(`      ${dim('create <name>')}     Create a new migration file`);
  console.log(`      ${dim('up')}               Apply pending migrations`);
  console.log(`      ${dim('down')}             Rollback last migration`);
  console.log(`      ${dim('status')}           Show applied/pending migrations`);
  console.log(`    ${cyan('seed')}               Run seed file`);
  console.log(`    ${cyan('status')} ${dim('| info')}     Show schema summary`);
  console.log(`    ${cyan('studio')}             Launch local read-only web UI`);
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

  console.log(`  ${bold('Studio options:')}`);
  console.log(`    ${cyan('--port')} ${dim('<n>')}           HTTP port ${dim('(default: 4983)')}`);
  console.log(`    ${cyan('--host')} ${dim('<addr>')}        Bind address ${dim('(default: 127.0.0.1)')}`);
  console.log(`    ${cyan('--no-open')}            Don't auto-open the browser`);
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
    let dir = dirname(process.argv[1] ?? '');
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

  // If the user has a TypeScript config file, register the tsx ESM loader
  // before we attempt to import it. Otherwise Node throws
  // ERR_UNKNOWN_FILE_EXTENSION for `.ts`.
  const configPath = findConfigFile();
  if (needsTsLoader(configPath)) {
    const status = await registerTsLoader();
    if (status === 'missing' || status === 'unsupported') {
      failMissingTsLoader(configPath ?? 'turbine.config.ts', status);
    }
  }

  // Load config file
  let fileConfig = {};
  try {
    fileConfig = await loadConfig();
  } catch (err) {
    if (args.command !== 'init') {
      warn(`Could not load config: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const overrides: CliOverrides = {
    url: args.url,
    out: args.out,
    schema: args.schema,
    include: args.include,
    exclude: args.exclude,
  };

  const config = resolveConfig(fileConfig, overrides);

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

      case 'studio':
        await cmdStudio(args, config);
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

main();
